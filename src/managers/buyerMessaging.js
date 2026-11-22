// src/managers/buyerMessaging.js
const { client } = require('../bybit/client');
const config = require('../config');

const messagedOrders = new Set();
const feedbackSent = new Set();
const affirmationDetected = new Set();

const AFFIRMATION_WORDS = [
  'hold for payment', 'paying now', 'ok', 'okay', 'alright',
  'okay boss', 'alright boss', 'sharp', 'no problem', 'on it',
];

function isAffirmation(text) {
  if (!text) return false;
  const lower = String(text).toLowerCase();
  return AFFIRMATION_WORDS.some((w) => lower.includes(w));
}

// Helper to get session ID from order object
async function getSessionIdFromOrder(order) {
  // Bybit order detail usually has 'targetUserMaskId' for the counterparty
  const userMaskId = order.targetUserMaskId; 
  if (!userMaskId) throw new Error('No targetUserMaskId in order');
  
  const session = await client.getChatSessionId(userMaskId);
  return session.sessionId;
}

async function sendOrderMessage(order, text) {
  const sessionId = await getSessionIdFromOrder(order);
  await client.sendChatMessage({
    orderId: String(order.id),
    sessionId,
    message: text,
    contentType: 'str',
  });
}

async function readOrderMessages(order) {
  const sessionId = await getSessionIdFromOrder(order);
  const raw = await client.getChatMessages({
    orderId: String(order.id),
    sessionId,
    page: '1',
    size: '20',
  });
  const data = raw.result || raw;
  return data.items || data.messages || [];
}

async function sendInitialMessages(order) {
  const orderId = order.id;
  if (messagedOrders.has(orderId)) return { sent: false, reason: 'already_sent' };

  const delayMs = config.timing.buyerMsgDelaySeconds * 1000;
  await new Promise((r) => setTimeout(r, delayMs));

  try {
    await sendOrderMessage(order, process.env.BUYER_MSG_1);
    await sendOrderMessage(order, process.env.BUYER_MSG_2);
    messagedOrders.add(orderId);
    console.log(`[buyerMsg] 2 messages sent to order ${orderId}`);
    return { sent: true };
  } catch (err) {
    console.error(`[buyerMsg] failed for ${orderId}:`, err.message);
    return { sent: false, reason: 'send_failed', error: err.message };
  }
}

async function checkBuyerReply(order) {
  const orderId = order.id;
  if (!messagedOrders.has(orderId)) return { skipped: 'not_messaged_yet' };
  if (affirmationDetected.has(orderId)) return { skipped: 'already_affirmed' };

  let messages;
  try {
    messages = await readOrderMessages(order);
  } catch (err) {
    return { ok: false, reason: 'read_failed', error: err.message };
  }

  const buyerSaid = messages
    .filter((m) => m.senderType !== 'seller' && m.senderType !== 'self')
    .map((m) => m.content || m.message || '')
    .filter(Boolean);

  const hit = buyerSaid.find(isAffirmation);
  if (!hit) return { ok: true, affirmed: false };

  affirmationDetected.add(orderId);

  if (!feedbackSent.has(orderId)) {
    try {
      await sendOrderMessage(order, process.env.FEEDBACK_MSG);
      feedbackSent.add(orderId);
      console.log(`[buyerMsg] feedback sent to order ${orderId}`);
    } catch (err) {
      return { ok: false, affirmed: true, reason: 'feedback_failed', error: err.message };
    }
  }
  return { ok: true, affirmed: true, matchedText: hit };
}

module.exports = {
  isAffirmation,
  sendInitialMessages,
  checkBuyerReply,
};