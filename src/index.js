// src/index.js
// Entry point. Runs the sell bot cycle.

require('dotenv').config();

const config = require('./config');
const telegram = require('./telegram/bot');
const inventory = require('./managers/inventory');
const sellManager = require('./managers/sellManager');
const decision = require('./managers/decision');
const executor = require('./managers/executor');
const buyerMessaging = require('./managers/buyerMessaging');

// ── Failure tracking ──────────────────────────────────────
let consecutiveFailures = 0;
const failureMessages = [];

function resetFailures() {
  if (consecutiveFailures > 0) {
    console.log(`[cycle] recovered after ${consecutiveFailures} failures`);
  }
  consecutiveFailures = 0;
  failureMessages.length = 0;
}

function recordFailure(label, error) {
  consecutiveFailures++;
  failureMessages.push(`• ${label}: ${error}`);
  console.log(`[cycle] failure ${consecutiveFailures}: ${label} — ${error}`);
}

// ── Single sell cycle ─────────────────────────────────────
async function runCycle() {
  console.log('[cycle] start');

  if (telegram.isManual()) {
    console.log('[cycle] manual mode — skipped');
    return;
  }

  let spendable;
  let sellCycleResult;

  try {
    spendable = await inventory.getSpendableUsdc();
  } catch (err) {
    recordFailure('inventory', err.message);
    return;
  }

  try {
    sellCycleResult = await sellManager.runSellCycle();
    if (!sellCycleResult.ok) {
      recordFailure('sellManager', sellCycleResult.reason || 'unknown');
      return;
    }
  } catch (err) {
    recordFailure('sellManager', err.message);
    return;
  }

  let evalResult;
  try {
    evalResult = await decision.evaluateBothAds(sellCycleResult, spendable);
  } catch (err) {
    recordFailure('decision', err.message);
    return;
  }

  const ad1State = await decision.getAdState(config.ads.sellAd1Id);
  const ad2State = await decision.getAdState(config.ads.sellAd2Id);

  const ad1Exec = await executor.applyDecision(evalResult.ad1, ad1State);
  const ad2Exec = await executor.applyDecision(evalResult.ad2, ad2State);

  if (evalResult.ad1.action === 'BLOCK' && evalResult.ad1.reason === 'below_profit_floor') {
    await telegram.sendProfitFloorWarning(
      'Ad 1',
      evalResult.ad1.targetPrice,
      evalResult.ad1.floor,
      evalResult.ad1.shortfall
    ).catch(() => {});
  } else if (evalResult.ad2.action === 'BLOCK' && evalResult.ad2.reason === 'below_profit_floor') {
    await telegram.sendProfitFloorWarning(
      'Ad 2',
      evalResult.ad2.targetPrice,
      evalResult.ad2.floor,
      evalResult.ad2.shortfall
    ).catch(() => {});
  } else {
    await telegram.clearProfitFloorWarning().catch(() => {});
  }

  if (!ad1Exec.ok) {
    recordFailure('Ad 1 edit', ad1Exec.reason || ad1Exec.error || 'unknown');
  }
  if (!ad2Exec.ok) {
    recordFailure('Ad 2 edit', ad2Exec.reason || ad2Exec.error || 'unknown');
  }

  console.log('[cycle] done', {
    ad1: ad1Exec.action || ad1Exec.reason,
    ad2: ad2Exec.action || ad2Exec.reason,
    spendable,
    failures: consecutiveFailures,
  });

  if (ad1Exec.ok && ad2Exec.ok) {
    resetFailures();
  }

  if (consecutiveFailures >= config.failures.alertThreshold) {
    await telegram.sendFailureAlert(failureMessages.slice()).catch(() => {});
    consecutiveFailures = 0;
    failureMessages.length = 0;
  }
}

// ── Buyer order monitoring ────────────────────────────────
async function monitorBuyerOrders() {
  if (telegram.isManual()) return;

  try {
    const raw = await require('./bybit/client').client.getMyOrders({
      side: '1',
      status: '10',
      page: '1',
      size: '20',
    });
    const result = raw.result || raw;
    const orders = result.items || [];

    for (const order of orders) {
      await buyerMessaging.sendInitialMessages(order);
      await buyerMessaging.checkBuyerReply(order);
    }
  } catch (err) {
    console.log('[buyerMonitor] error:', err.message);
  }
}

// ── Cycle loop ────────────────────────────────────────────
let cycleTimer = null;

async function runCycleSafe() {
  try {
    await runCycle();
    await monitorBuyerOrders();
  } catch (err) {
    console.error('[cycle] uncaught:', err.message);
  }
}

// ── Daily report ──────────────────────────────────────────
let lastReportDay = null;
async function maybeSendDailyReport() {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Africa/Lagos' }));
  const today = now.toDateString();
  if (now.getHours() === 23 && now.getMinutes() === 50 && lastReportDay !== today) {
    lastReportDay = today;
    console.log('[report] daily report sent');
    await telegram.sendDailyReport({
      date: today,
      totalTrades: '—',
      totalBought: '—',
      totalSold: '—',
      avgBuy: '—',
      avgSell: '—',
      profit: '—',
    }).catch(() => {});
  }
}

// ── Telegram launch with timeout (never blocks bot) ───────
function launchTelegramWithTimeout(ms = 10000) {
  return Promise.race([
    telegram.launch(),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('telegram launch timeout')), ms)
    ),
  ]);
}

// ── Startup ───────────────────────────────────────────────
async function main() {
  console.log('[startup] loading config…');

  // 1. Run first cycle FIRST — before Telegram
  await runCycleSafe();

  // 2. Telegram in background with timeout — never blocks trading
  launchTelegramWithTimeout(10000)
    .then(() => console.log('[startup] telegram launched'))
    .catch((err) => console.error('[startup] telegram failed:', err.message));

  // 3. Start the cycle timer
  cycleTimer = setInterval(runCycleSafe, config.timing.cycleSeconds * 1000);
  console.log(`[startup] cycle running every ${config.timing.cycleSeconds}s`);

  // 4. Daily report check every 30s
  setInterval(maybeSendDailyReport, 30 * 1000);

  // 5. Graceful shutdown
  const shutdown = (sig) => {
    console.log(`[shutdown] received ${sig}`);
    if (cycleTimer) clearInterval(cycleTimer);
    try { telegram.stop(); } catch (_) {}
    setTimeout(() => process.exit(0), 500);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[fatal]', err);
  process.exit(1);
});