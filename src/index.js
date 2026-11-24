// src/index.js
// Entry point. Runs the sell bot cycle.

require('dotenv').config();

const http = require('http');
const config = require('./config');
const telegram = require('./telegram/bot');
const inventory = require('./managers/inventory');
const sellManager = require('./managers/sellManager');
const decision = require('./managers/decision');
const executor = require('./managers/executor');
const buyerMessaging = require('./managers/buyerMessaging');

// ── Health server (lets Render see an open port) ──────────
function startHealthServer() {
  const port = process.env.PORT || 10000;
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
  });
  server.listen(port, '0.0.0.0', () => {
    console.log(`[health] listening on ${port}`);
  });
  return server;
}

const { startAutoBuyScheduler } = require('./managers/autoBuyManager');
const { startBuyOrderMessaging } = require('./managers/buyOrderMessaging');

// inside startup:
startAutoBuyScheduler();
startBuyOrderMessaging();

// Pings our own public URL so the free plan does not put us to sleep.
function startKeepAwake() {
  const url = process.env.RENDER_EXTERNAL_URL;
  if (!url) return;
  setInterval(async () => {
    try {
      await fetch(url);
    } catch (err) {
      console.log('[keepawake] ping failed:', err.message);
    }
  }, 10 * 60 * 1000);
  console.log('[keepawake] self-ping every 10 min');
}

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
      const soft = ['no_genuine_competitor', 'no_ads_returned'];
      if (soft.includes(sellCycleResult.reason)) {
        console.log(`[cycle] skipped: ${sellCycleResult.reason}`);
      } else {
        recordFailure(
          'sellManager',
          `${sellCycleResult.reason || 'unknown'}${sellCycleResult.error ? ' (' + sellCycleResult.error + ')' : ''}`
        );
      }
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

  const ad1Exec = await executor.applyDecision(evalResult.ad1, evalResult.ad1State);
  const ad2Exec = await executor.applyDecision(evalResult.ad2, evalResult.ad2State);

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

  console.log(
    `[cycle] ad 1: ${ad1Exec.action || ad1Exec.reason} | ad 2: ${ad2Exec.action || ad2Exec.reason} | spendable ${Number(spendable).toFixed(2)} | failures ${consecutiveFailures}`
  );

  if (ad1Exec.ok && ad2Exec.ok) {
    resetFailures();
  }

  if (consecutiveFailures >= config.failures.alertThreshold) {
    await telegram.sendFailureAlert(failureMessages.slice()).catch(() => {});
    consecutiveFailures = 0;
    failureMessages.length = 0;
  }
}

// ── Order polling (own timer, separate from repricing) ────
const ORDER_POLL_SECONDS = Number(process.env.ORDER_POLL_SECONDS) || 10;
let orderPollRunning = false;
let ordersSeeded = false;
const seenOrders = new Set();

// New orders are logged only (no Telegram message)
async function announceOrder(order) {
  console.log(`[orders] new order ${order.id}`);
}

async function pollOrders() {
  if (orderPollRunning) return;
  orderPollRunning = true;

  try {
    const raw = await require('./bybit/client').client.getMyOrders({
      side: '1',
      status: '10',
      page: '1',
      size: '20',
    });
    const code = raw.ret_code ?? raw.retCode;
    if (code !== undefined && code !== 0) {
      throw new Error(`getMyOrders failed: ${code} ${raw.ret_msg ?? raw.retMsg ?? ''}`);
    }
    const orders = (raw.result || raw).items || [];

    // First poll after startup: note existing orders in the log
    if (!ordersSeeded) {
      orders.forEach((o) => seenOrders.add(String(o.id)));
      ordersSeeded = true;
      console.log(`[orders] first poll: ${orders.length} open order(s) already pending`);
    }

    const msgMode = buyerMessaging.mode();

    for (const order of orders) {
      const id = String(order.id);

      if (!seenOrders.has(id)) {
        seenOrders.add(id);
        await announceOrder(order);
      }

      // Auto-messages pause in Manual mode
      if (msgMode !== 'off' && !telegram.isManual()) {
        const r = await buyerMessaging.sendInitialMessages(order);
        if (r.reason === 'gave_up' && r.error) {
          await telegram.send(
            config.telegram.chatId,
            `⚠️ Could not message the buyer on order ${id}: ${r.error}\nHandle the chat manually on Bybit.`
          );
        }
        await buyerMessaging.checkBuyerReply(order);
      }
    }
  } catch (err) {
    console.log('[orders] poll error:', err.message);
  } finally {
    orderPollRunning = false;
  }
}

// ── Cycle loop ────────────────────────────────────────────
let cycleTimer = null;
let orderTimer = null;
let cycleRunning = false;

async function runCycleSafe() {
  if (cycleRunning) {
    console.log('[cycle] previous cycle still running — skipped');
    return;
  }
  cycleRunning = true;
  try {
    await runCycle();
  } catch (err) {
    console.error('[cycle] uncaught:', err.message);
  } finally {
    cycleRunning = false;
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
function launchTelegramWithTimeout(ms = 15000) {
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
  console.log(
    config.dryRun
      ? '[startup] MODE: DRY_RUN — no ads will be edited'
      : '[startup] MODE: LIVE — ads WILL be edited'
  );
  console.log(`[startup] BUYER_MESSAGING: ${buyerMessaging.mode()}`);

  // 0. Open the port first so Render marks the deploy healthy quickly
  const healthServer = startHealthServer();
  startKeepAwake();

  // 1. Run first cycle FIRST — before Telegram
  await runCycleSafe();

  // 2. Telegram in background with timeout — never blocks trading
  launchTelegramWithTimeout(15000)
    .then(() => console.log('[startup] telegram launched'))
    .catch((err) => console.error('[startup] telegram failed:', err.message));

  // 3. Start the cycle timer
  cycleTimer = setInterval(runCycleSafe, config.timing.cycleSeconds * 1000);
  console.log(`[startup] cycle running every ${config.timing.cycleSeconds}s`);

  // 4. Order polling on its own, faster timer
  pollOrders();
  orderTimer = setInterval(pollOrders, ORDER_POLL_SECONDS * 1000);
  console.log(`[startup] order polling every ${ORDER_POLL_SECONDS}s`);

  // 5. Daily report check every 30s
  setInterval(maybeSendDailyReport, 30 * 1000);

  // 6. Graceful shutdown
  const shutdown = (sig) => {
    console.log(`[shutdown] received ${sig}`);
    if (cycleTimer) clearInterval(cycleTimer);
    if (orderTimer) clearInterval(orderTimer);
    try { telegram.stop(); } catch (_) {}
    try { healthServer.close(); } catch (_) {}
    setTimeout(() => process.exit(0), 500);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[fatal]', err);
  process.exit(1);
});