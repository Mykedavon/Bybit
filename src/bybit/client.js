// src/bybit/client.js
// The only file that talks to Bybit.

const { P2P } = require('bybit-p2p-sdk');
const axios = require('axios');
const crypto = require('crypto'); // Built-in Node.js module
require('dotenv').config();

const p2p = new P2P({
  apiKey: process.env.BYBIT_API_KEY,
  apiSecret: process.env.BYBIT_API_SECRET,
  recvWindow: 30000,
  timeout: 15000,
  testnet: false,
});

// --- Helper for Raw Bybit Calls (Session ID) ---
async function rawBybitPost(path, body) {
  const timestamp = Date.now().toString();
  const recvWindow = '5000';
  const apiKey = process.env.BYBIT_API_KEY;
  const apiSecret = process.env.BYBIT_API_SECRET;
  
  // Bybit V5 Signature: timestamp + apiKey + recvWindow + rawBody
  const signPayload = timestamp + apiKey + recvWindow + JSON.stringify(body);
  const signature = crypto
    .createHmac('sha256', apiSecret)
    .update(signPayload)
    .digest('hex');

  const response = await axios.post(`https://api.bybit.com${path}`, body, {
    headers: {
      'X-BAPI-API-KEY': apiKey,
      'X-BAPI-SIGN': signature,
      'X-BAPI-SIGN-TYPE': '2',
      'X-BAPI-TIMESTAMP': timestamp,
      'X-BAPI-RECV-WINDOW': recvWindow,
      'Content-Type': 'application/json',
    },
  });
  return response.data;
}

const client = {
  // ── Ads ────────────────────────────────────────────────────
  getOnlineAds: (params) => {
    const { token, tokenId, limit, size, side, ...rest } = params;
    return p2p.getOnlineAds({
      tokenId: tokenId || token,
      side: String(side),
      size: String(size || limit || 10),
      ...rest,
    });
  },
  getAdInfo: (itemId) => p2p.getAdDetails({ itemId: String(itemId) }),
  updateAd: (params) => p2p.updateAd(params),

  // ── Orders & Wallet ────────────────────────────────────────
  getMyOrders: (params) => p2p.getOrders(params),
  getWalletBalance: (accountType, coin) => p2p.getCurrentBalance({ accountType, coin }),

  // ── Chat (Hybrid SDK + Raw) ────────────────────────────────
  // Custom method to fetch sessionId via raw HTTP
  getChatSessionId: async (userMaskId) => {
    const data = await rawBybitPost('/v5/p2p/chat/session/getSessionId', {
      userMaskId: String(userMaskId),
    });
    return data.result; // Should contain { sessionId: '...' }
  },
  
  // SDK methods for sending/receiving
  sendChatMessage: (params) => p2p.sendChatMessage(params),
  getChatMessages: (params) => p2p.getChatMessages(params),
};

module.exports = { client };