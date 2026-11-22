// src/managers/buyerMessaging.js
// Opening messages + feedback message for new sell orders.
// Uses Bybit's current chat API (session id -> send_v1 / listpage_v1).
// BUYER_MESSAGING: "on" (default) | "dry" (log only) | "off"

const { p2pPost } = require('../bybit/p2pRaw');
const config = require('../config');

const mode = () => {
  const v = String(process.env.BUYER_MESSAGING || 'on').trim().toLowerCase();
  return v === 'off' || v === 'dry' ? v : 'on';
};
const msg1 = () => (process.env.BUYER_MSG_1 || '').trim();
const msg2 = () => (process.env.BUYER_MSG_2 || '').trim();
const feedbackMsg = () => (process.env.FEEDBACK_MSG || '').trim();

// Read the buyer's chat for a reply at most this often, per order
const REPLY_CHECK_MS = (Number(process.env.REPLY_CHECK_SECONDS) || 20) * 1000;

const AFFIRMATION_WORDS = [
  'hold for payment', 'paying now', 'ok', 'okay', 'alright',
  'okay boss', 'alright boss', 'sharp', 'no problem', 'on it',
];
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const AFFIRMATION_RE = new RegExp(`\\b(${AFFIRMATION_WORDS.map(escapeRe).join('|')})\\b`, 'i');

function isAffirmation(text) {
  return !!text && AFFIRMATION_RE.test(String(text));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── State (in memory; chat history is checked too, so restarts are safe) ──
const sessionCache = new Map();   // orderId -> { sessionId, buyerNick }
const progress = new Map();       // orderId -> number of opening messages sent
const historyChecked = new Set();
const initialDone = new Set();
const gaveUp = new Set();
const failCount = new Map();
const feedbackSent = new Set();
const affirmationDetected = new Set();
const lastReplyCheck = new Map();
const dryLogged = new Set();

// Retry on Bybit rate limit (ErrCode 10006)
async function withRetry(label, fn, attempts = 4) {
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      const limited = String(err.message || '').includes('10006');
      if (!limited || i === attempts) throw err;
      console.log(`[buyerMsg] ${label} rate limited, retry ${i}/${attempts - 1} in ${3 * i}s`);
      await sleep(3000 * i);
    }
  }
}

async function getSession(order) {
  const id = String(order.id);
  if (sessionCache.has(id)) return sessionCache.get(id);

  let maskId = order.targetUserMaskId;
  let nick = order.targetNickName;

  // The order list may not include the counterparty mask id, so ask for the detail
  if (!maskId) {
    const detail = await withRetry('order info', () =>
      p2pPost('/v5/p2p/order/info', { orderId: id })
    );
    maskId = detail.targetUserMaskId;
    nick = nick || detail.targetNickName;
  }
  if (!maskId) throw new Error(`No targetUserMaskId for order ${id}`);

  const s = await withRetry('session id', () =>
    p2pPost('/v5/p2p/chat/session/getSessionId', { userMaskId: maskId })
  );
  const entry = { sessionId: s.sessionId, buyerNick: nick || null };
  sessionCache.set(id, entry);
  return entry;
}

async function readMessages(order) {
  const { sessionId } = await getSession(order);
  const res = await withRetry('read messages', () =>
    p2pPost('/v5/p2p/chat/message/listpage_v1', { lastId: 0, limit: 30, sessionId })
  );

  // A session is per counterparty, so ignore messages from before this order
  const since = Number(order.createDate) || 0;

  return (res.messages || [])
    .map((m) => {
      let content = '';
      try { content = JSON.parse(m.message).content || ''; } catch (_) { content = String(m.message || ''); }
      return {
        nick: m.sendUserNickName,
        content,
        createDate: Number(m.createDate) || 0,
      };
    })
    .filter((m) => !since || m.createDate >= since);
}

// Returns true if actually sent, false in dry mode
async function sendText(order, text, tag) {
  const id = String(order.id);

  if (mode() === 'dry') {
    const key = `${id}:${tag}`;
    if (!dryLogged.has(key)) {
      dryLogged.add(key);
      console.log(`[buyerMsg] DRY would send ${tag} to order ${id}: ${text.slice(0, 60)}`);
    }
    return false;
  }

  const { sessionId } = await getSession(order);
  await withRetry('send message', () =>
    p2pPost('/v5/p2p/chat/message/send_v1', {
      message: text,
      contentType: 'str',
      sessionId,
      orderId: id,
    })
  );
  return true;
}

async function sendInitialMessages(order) {
  const id = String(order.id);
  if (initialDone.has(id)) return { sent: false, reason: 'already_sent' };
  if (gaveUp.has(id)) return { sent: false, reason: 'gave_up' };

  const texts = [msg1(), msg2()].filter(Boolean);
  if (texts.length === 0) {
    if (!dryLogged.has('no_templates')) {
      dryLogged.add('no_templates');
      console.log('[buyerMsg] BUYER_MSG_1 is empty — nothing to send');
    }
    return { sent: false, reason: 'no_templates' };
  }

  try {
    // Restart safety: skip if the opening message is already in this order's chat
    if (!historyChecked.has(id)) {
      const history = await readMessages(order);
      historyChecked.add(id);
      if (history.some((m) => m.content.trim() === texts[0])) {
        initialDone.add(id);
        console.log(`[buyerMsg] order ${id} already has the opening message — skipping`);
        return { sent: false, reason: 'already_in_chat' };
      }
    }

    let done = progress.get(id) || 0;
    if (done === 0 && mode() === 'on') {
      await sleep(config.timing.buyerMsgDelaySeconds * 1000);
    }

    while (done < texts.length) {
      const sent = await sendText(order, texts[done], `msg${done + 1}`);
      if (!sent) return { sent: false, reason: 'dry_run' };
      done += 1;
      progress.set(id, done);
      console.log(`[buyerMsg] opening message ${done}/${texts.length} sent to order ${id}`);
    }

    initialDone.add(id);
    return { sent: true };
  } catch (err) {
    const n = (failCount.get(id) || 0) + 1;
    failCount.set(id, n);
    console.error(`[buyerMsg] failed for ${id} (attempt ${n}/3):`, err.message);
    if (n >= 3) {
      gaveUp.add(id);
      return { sent: false, reason: 'gave_up', error: err.message };
    }
    return { sent: false, reason: 'send_failed', error: err.message };
  }
}

async function checkBuyerReply(order) {
  const id = String(order.id);
  if (!initialDone.has(id)) return { skipped: 'not_messaged_yet' };
  if (affirmationDetected.has(id)) return { skipped: 'already_affirmed' };

  // Keep API usage low: read the chat at most every REPLY_CHECK_MS per order
  const now = Date.now();
  if (now - (lastReplyCheck.get(id) || 0) < REPLY_CHECK_MS) return { skipped: 'throttled' };
  lastReplyCheck.set(id, now);

  let messages;
  let session;
  try {
    session = await getSession(order);
    messages = await readMessages(order);
  } catch (err) {
    return { ok: false, reason: 'read_failed', error: err.message };
  }

  // Buyer messages only: match the buyer's nickname when known,
  // otherwise exclude our own templates
  const mine = new Set([msg1(), msg2(), feedbackMsg()].filter(Boolean));
  const buyerSaid = messages
    .filter((m) => (session.buyerNick ? m.nick === session.buyerNick : !mine.has(m.content.trim())))
    .map((m) => m.content)
    .filter(Boolean);

  const hit = buyerSaid.find(isAffirmation);
  if (!hit) return { ok: true, affirmed: false };

  affirmationDetected.add(id);

  if (feedbackMsg() && !feedbackSent.has(id)) {
    try {
      const sent = await sendText(order, feedbackMsg(), 'feedback');
      if (sent) {
        feedbackSent.add(id);
        console.log(`[buyerMsg] feedback sent to order ${id}`);
      }
    } catch (err) {
      affirmationDetected.delete(id); // try again next check
      return { ok: false, affirmed: true, reason: 'feedback_failed', error: err.message };
    }
  }
  return { ok: true, affirmed: true, matchedText: hit };
}

module.exports = {
  mode,
  isAffirmation,
  sendInitialMessages,
  checkBuyerReply,
};