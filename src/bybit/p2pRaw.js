// src/bybit/p2pRaw.js
// Minimal signed POST helper for Bybit P2P endpoints (standard V5 HMAC signing).

const crypto = require('crypto');
const config = require('../config');

const BASE_URL = process.env.BYBIT_P2P_BASE_URL || 'https://api.bybit.com';
const RECV_WINDOW = '5000';

async function p2pPost(path, body = {}) {
  const payload = JSON.stringify(body);
  const timestamp = String(Date.now());
  const sign = crypto
    .createHmac('sha256', config.bybit.apiSecret)
    .update(timestamp + config.bybit.apiKey + RECV_WINDOW + payload)
    .digest('hex');

  const res = await fetch(BASE_URL + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-BAPI-API-KEY': config.bybit.apiKey,
      'X-BAPI-TIMESTAMP': timestamp,
      'X-BAPI-SIGN': sign,
      'X-BAPI-RECV-WINDOW': RECV_WINDOW,
    },
    body: payload,
  });

  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch (_) {
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  }

  const code = json.ret_code ?? json.retCode;
  if (code !== undefined && code !== 0) {
    throw new Error(`${json.ret_msg ?? json.retMsg ?? 'error'} (ErrCode: ${code})`);
  }
  return json.result ?? json;
}

module.exports = { p2pPost };