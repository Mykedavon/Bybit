// src/managers/buyOrderMessaging.js
// Fast 5-second poller for BUY orders (side === '0'):
// 1. Immediately sends 2 opening review messages as soon as an order is detected
//    as pending coin release (status 20 / buyer marked paid).
// 2. Starts a timer on detection; 5 minutes later, sends 1 randomized release
//    reminder every 1 minute for the next 10 minutes (up to 10 reminders total).
// 3. Stops immediately when the order finishes, cancels, or hits 10 reminders.

const { client } = require('../bybit/client');
const { p2pPost, scheduleP2P } = require('../bybit/p2pRaw');
const config = require('../config');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Bybit P2P order status codes:
// 10 = waiting for buyer payment, 20 = buyer paid / waiting for seller to release coin,
// 30 = appealing, 40 = cancelled, 50 = completed
const PENDING_RELEASE_STATUSES = new Set(['20']);
const TERMINAL_STATUSES = new Set(['40', '50', '60', '70']);

const REMINDER_POOL = [
  'Kindly confirm payment and release the coin when ready. Thank you!',
  'Hello, payment has been made—please confirm and release the USDC when you can.',
  'Hi there, gentle reminder to verify receipt and release the coin. Thanks!',
  'Kindly check your account and release the USDC so we can wrap up. Thank you!',
  'Hello! Just checking in—please confirm payment and release the coin.',
  'Hi, payment is sent. Kindly confirm and release the USDC at your earliest convenience.',
  'Gentle reminder: please confirm payment received and release the coin. Much appreciated!',
  'Hello, kindly verify the transfer and release the USDC when ready. Thank you!',
  'Hi there, please confirm receipt and release the coin so we can complete the trade.',
  'Kindly confirm the payment on your end and release the USDC. Thanks a lot!',
  'Hello! Payment has been completed—kindly confirm and release the coin.',
  'Hi, just following up—please confirm and release the USDC whenever you are ready.',
];

// Per-order state
const sessionCache = new Map();     // orderId -> { sessionId, sellerNick }
const initialSent = new Set();      // orderId
const historyChecked = new Set();   // orderId
const trackedOrders = new Map();    // orderId -> { detectedAt, remindersSent, lastReminderAt, lastReminderIdx }

let timer = null;
let polling = false;

function runP2P(fn) {
  return typeof scheduleP2P === 'function' ? scheduleP2P(fn) : fn();
}

function mode() {
  const m = config.buyMessaging.mode;
  return m === 'off' || m === 'dry' ? m : 'on';
}

async function withRetry(label, fn, attempts = 3) {
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      const limited = err.code === 10006 || String(err.message || '').includes('10006');
      if (!limited || i === attempts) throw err;
      const delayMs = 2000 * i + Math.floor(Math.random() * 500);
      console.log(`[buyMsg] ${label} rate limited, retry ${i}/${attempts - 1} in ${(delayMs / 1000).toFixed(1)}s`);
      await sleep(delayMs);
    }
  }
}

async function getSession(order) {
  const id = String(order.id);
  if (sessionCache.has(id)) return sessionCache.get(id);

  let maskId = order.targetUserMaskId;
  let nick = order.targetNickName;

  if (!maskId) {
    const detail = await withRetry('order info', () =>
      p2pPost('/v5/p2p/order/info', { orderId: id })
    );
    maskId = detail.targetUserMaskId;
    nick = nick || detail.targetNickName;
  }

  if (!maskId) throw new Error(`No targetUserMaskId for buy order ${id}`);

  const s = await withRetry('session id', () =>
    p2pPost('/v5/p2p/chat/session/getSessionId', { userMaskId: maskId })
  );
  const entry = { sessionId: s.sessionId, sellerNick: nick || null };
  sessionCache.set(id, entry);
  return entry;
}

async function readOrderMessages(order) {
  const { sessionId } = await getSession(order);
  const res = await withRetry('read messages', () =>
    p2pPost('/v5/p2p/chat/message/listpage_v1', { lastId: 0, limit: 30, sessionId })
  );

  const since = Number(order.createDate) || 0;
  return (res.messages || [])
    .map((m) => {
      let content = '';
      try {
        content = JSON.parse(m.message).content || '';
      } catch (_) {
        content = String(m.message || '');
      }
      return {
        content,
        createDate: Number(m.createDate) || 0,
      };
    })
    .filter((m) => !since || m.createDate >= since);
}

async function sendChatText(order, text, tag) {
  const id = String(order.id);

  if (mode() === 'dry') {
    console.log(`[buyMsg] DRY_RUN — would send ${tag} to buy order ${id}: ${text}`);
    return false;
  }

  const { sessionId } = await getSession(order);
  await withRetry(`send ${tag}`, () =>
    p2pPost('/v5/p2p/chat/message/send_v1', {
      message: text,
      contentType: 'str',
      sessionId,
      orderId: id,
    })
  );
  return true;
}

function pickRandomReminder(excludeIdx) {
  if (REMINDER_POOL.length === 1) return { text: REMINDER_POOL[0], idx: 0 };
  let idx = Math.floor(Math.random() * REMINDER_POOL.length);
  if (idx === excludeIdx) {
    idx = (idx + 1) % REMINDER_POOL.length;
  }
  return { text: REMINDER_POOL[idx], idx };
}

async function sendImmediateReviewMessages(order) {
  const id = String(order.id);
  if (initialSent.has(id)) return;

  const texts = [
    config.buyMessaging.reviewMsg1.trim(),
    config.buyMessaging.reviewMsg2.trim(),
  ].filter(Boolean);

  if (texts.length === 0) {
    initialSent.add(id);
    return;
  }

  if (!historyChecked.has(id)) {
    const history = await readOrderMessages(order);
    historyChecked.add(id);
    if (history.some((m) => m.content.trim() === texts[0])) {
      initialSent.add(id);
      console.log(`[buyMsg] buy order ${id} already has review message — skipping immediate send`);
      return;
    }
  }

  for (let i = 0; i < texts.length; i++) {
    const sent = await sendChatText(order, texts[i], `review_${i + 1}`);
    if (sent) {
      console.log(`[buyMsg] sent immediate review message ${i + 1}/${texts.length} to buy order ${id}`);
    }
  }

  initialSent.add(id);
}

async function processPendingReleaseOrder(order) {
  const id = String(order.id);
  const now = Date.now();

  let state = trackedOrders.get(id);
  if (!state) {
    state = {
      detectedAt: now,
      remindersSent: 0,
      lastReminderAt: 0,
      lastReminderIdx: -1,
    };
    trackedOrders.set(id, state);
    console.log(`[buyMsg] buy order ${id} detected as pending coin release`);
  }

  // Step 1: Send the 2 immediate review messages once
  if (!initialSent.has(id)) {
    await sendImmediateReviewMessages(order);
  }

  // Step 2: Reminders start 5 minutes after detection, then every 1 minute for 10 minutes (max 10)
  const maxReminders = config.buyMessaging.maxReminders;
  if (state.remindersSent >= maxReminders) return;

  const startDelayMs = config.buyMessaging.reminderStartSeconds * 1000;
  const intervalMs = config.buyMessaging.reminderIntervalSeconds * 1000;
  const elapsedMs = now - state.detectedAt;

  if (elapsedMs < startDelayMs) return;

  const dueForNext =
    state.remindersSent === 0 || now - state.lastReminderAt >= intervalMs;

  if (!dueForNext) return;

  const { text, idx } = pickRandomReminder(state.lastReminderIdx);
  const sent = await sendChatText(order, text, `reminder_${state.remindersSent + 1}`);
  if (sent || mode() === 'dry') {
    state.remindersSent += 1;
    state.lastReminderAt = now;
    state.lastReminderIdx = idx;
    console.log(
      `[buyMsg] reminder ${state.remindersSent}/${maxReminders} sent for buy order ${id}: "${text}"`
    );
  }
}

async function pollBuyOrders() {
  if (polling || mode() === 'off') return;
  polling = true;

  try {
    const res = await withRetry('getMyOrders(buy)', () =>
      runP2P(() =>
        client.getMyOrders({
          side: '0', // 0 = buy orders only
          page: '1',
          size: '20',
        })
      )
    );

    const result = res.result || res;
    const items = result.items || [];
    const activeIds = new Set();

    for (const order of items) {
      const id = String(order.id);
      const status = String(order.status ?? '');

      if (TERMINAL_STATUSES.has(status)) {
        if (trackedOrders.has(id)) {
          trackedOrders.delete(id);
          sessionCache.delete(id);
          console.log(`[buyMsg] buy order ${id} closed (status ${status}) — stopped reminders`);
        }
        continue;
      }

      if (PENDING_RELEASE_STATUSES.has(status)) {
        activeIds.add(id);
        await processPendingReleaseOrder(order);
      }
    }

    // Clean up any tracked order that is no longer active
    for (const trackedId of [...trackedOrders.keys()]) {
      if (!activeIds.has(trackedId)) {
        trackedOrders.delete(trackedId);
        sessionCache.delete(trackedId);
      }
    }
  } catch (err) {
    console.error('[buyMsg] poll error:', err.message);
  } finally {
    polling = false;
  }
}

function startBuyOrderMessaging() {
  if (timer) return;
  const intervalMs = config.buyMessaging.pollSeconds * 1000;
  console.log(
    `[buyMsg] buy order watcher started (every ${config.buyMessaging.pollSeconds}s, ` +
    `reminders start after ${config.buyMessaging.reminderStartSeconds}s, ` +
    `every ${config.buyMessaging.reminderIntervalSeconds}s x ${config.buyMessaging.maxReminders})`
  );

  pollBuyOrders().catch(() => {});
  timer = setInterval(() => {
    pollBuyOrders().catch(() => {});
  }, intervalMs);
}

function stopBuyOrderMessaging() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

module.exports = {
  pollBuyOrders,
  startBuyOrderMessaging,
  stopBuyOrderMessaging,
};