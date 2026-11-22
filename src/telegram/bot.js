// src/telegram/bot.js
// All Telegram behavior: mode button, alerts, warnings, reports.
// Message retention rules are handled here.

const { Telegraf, Markup } = require('telegraf');
const config = require('../config');

const bot = new Telegraf(config.telegram.botToken);

// ── Bot mode state ────────────────────────────────────────
// 'auto' or 'manual'. Resets to 'auto' on restart (per spec).
let mode = 'auto';
let panelMessageId = null;

function getMode() { return mode; }
function isManual() { return mode === 'manual'; }

// ── Message tracking for deletions ────────────────────────
const timers = new Map(); // key -> timeout handle

function scheduleDelete(chatId, messageId, ms) {
  const key = `${chatId}:${messageId}`;
  if (timers.has(key)) clearTimeout(timers.get(key));
  const t = setTimeout(async () => {
    try { await bot.telegram.deleteMessage(chatId, messageId); } catch (_) {}
    timers.delete(key);
  }, ms);
  timers.set(key, t);
}

async function send(chatId, text, options = {}, deleteAfterMs = 0) {
  const msg = await bot.telegram.sendMessage(chatId, text, options);
  if (deleteAfterMs > 0) scheduleDelete(chatId, msg.message_id, deleteAfterMs);
  return msg;
}

// ── Mode button panel ─────────────────────────────────────
function buildPanel() {
  const label = mode === 'auto' ? 'Sell Bot: Auto ✅' : 'Sell Bot: Manual ⏸️';
  return Markup.inlineKeyboard([
    [Markup.button.callback(label, 'toggle_mode')],
  ]);
}

async function sendPanel() {
  const chatId = config.telegram.chatId;
  const text = 'Sell Bot control panel.\nTap the button to switch mode.';
  const msg = await bot.telegram.sendMessage(chatId, text, buildPanel());
  panelMessageId = msg.message_id;
  try { await bot.telegram.pinChatMessage(chatId, msg.message_id); } catch (_) {}
  return msg;
}

async function refreshPanel() {
  if (!panelMessageId) return;
  try {
    await bot.telegram.editMessageReplyMarkup(
      config.telegram.chatId,
      panelMessageId,
      undefined,
      buildPanel().reply_markup
    );
  } catch (_) {
    await sendPanel();
  }
}

// ── Toggle handler ────────────────────────────────────────
bot.action('toggle_mode', async (ctx) => {
  mode = mode === 'auto' ? 'manual' : 'auto';
  await ctx.answerCbQuery(mode === 'auto' ? 'Auto mode' : 'Manual mode');
  await refreshPanel();
});

// ── Profit floor warning ──────────────────────────────────
// Deleted and replaced each cycle. Separate from other messages.
let lastProfitFloorMsgId = null;

async function sendProfitFloorWarning(adLabel, targetPrice, floor, shortfall) {
  // Delete previous warning first
  if (lastProfitFloorMsgId) {
    try {
      await bot.telegram.deleteMessage(config.telegram.chatId, lastProfitFloorMsgId);
    } catch (_) {}
    lastProfitFloorMsgId = null;
  }

  const text =
    `⚠️ *Profit Floor Block* — ${adLabel}\n` +
    `Target: ₦${targetPrice}\n` +
    `Floor: ₦${floor}\n` +
    `Shortfall: ₦${shortfall}\n` +
    `Ad NOT edited.`;

  const msg = await bot.telegram.sendMessage(config.telegram.chatId, text, {
    parse_mode: 'Markdown',
  });
  lastProfitFloorMsgId = msg.message_id;
}

async function clearProfitFloorWarning() {
  if (lastProfitFloorMsgId) {
    try {
      await bot.telegram.deleteMessage(config.telegram.chatId, lastProfitFloorMsgId);
    } catch (_) {}
    lastProfitFloorMsgId = null;
  }
}

// ── Failure alert ─────────────────────────────────────────
async function sendFailureAlert(lines) {
  const text = `🔴 *Bot Failure Alert*\n\n${lines.join('\n')}`;
  const ms = config.failures.retentionHours * 60 * 60 * 1000;
  await send(config.telegram.chatId, text, { parse_mode: 'Markdown' }, ms);
}

// ── Cancellation blame alert ──────────────────────────────
async function sendCancellationAlert(orderId, reason) {
  const text =
    `🚫 *Cancellation Blame Detected*\n\n` +
    `Order: \`${orderId}\`\n` +
    `Reason: ${reason}\n\n` +
    `API cannot auto-reject for sellers. Handle manually on Bybit.`;
  const fiveHours = 5 * 60 * 60 * 1000;
  await send(config.telegram.chatId, text, { parse_mode: 'Markdown' }, fiveHours);
}

// ── Daily report ──────────────────────────────────────────
async function sendDailyReport(stats) {
  const text =
    `📊 *Daily Report* — ${stats.date}\n\n` +
    `Trades: ${stats.totalTrades}\n` +
    `USDC bought: ${stats.totalBought}\n` +
    `USDC sold: ${stats.totalSold}\n` +
    `Avg buy: ₦${stats.avgBuy}\n` +
    `Avg sell: ₦${stats.avgSell}\n` +
    `Profit: ₦${stats.profit}`;
  return send(config.telegram.chatId, text, { parse_mode: 'Markdown' });
}

// ── Monthly report ────────────────────────────────────────
async function sendMonthlyReport(stats) {
  const text =
    `📊 *Monthly Report* — ${stats.month}\n\n` +
    `Trades: ${stats.totalTrades}\n` +
    `USDC bought: ${stats.totalBought}\n` +
    `USDC sold: ${stats.totalSold}\n` +
    `Avg buy: ₦${stats.avgBuy}\n` +
    `Avg sell: ₦${stats.avgSell}\n` +
    `Profit: ₦${stats.profit}`;
  return send(config.telegram.chatId, text, { parse_mode: 'Markdown' });
}

// ── Launch ────────────────────────────────────────────────
async function launch() {
  await bot.launch();
  await sendPanel();
  console.log('[telegram] launched, panel sent');
}

function stop() {
  try { bot.stop('SIGTERM'); } catch (_) {}
}

module.exports = {
  bot,
  launch,
  stop,
  getMode,
  isManual,
  send,
  sendPanel,
  sendProfitFloorWarning,
  clearProfitFloorWarning,
  sendFailureAlert,
  sendCancellationAlert,
  sendDailyReport,
  sendMonthlyReport,
};