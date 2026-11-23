// src/bybit/p2pRaw.js
// Minimal signed POST helper for Bybit P2P endpoints (standard V5 HMAC signing)
// with global request pacing and jittered rate-limit backoff.

const crypto = require('crypto');
const config = require('../config');

const BASE_URL = process.env.BYBIT_P2P_BASE_URL || 'https://api.bybit.com';
const RECV_WINDOW = '5000';
const MIN_GAP_MS = Number(process.env.BYBIT_P2P_MIN_GAP_MS || 650);
const MAX_RATE_RETRIES = 3;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Global FIFO pacer across all P2P callers ──────────────
let queue = Promise.resolve();
let nextAllowedAt = 0;

function scheduleP2P(fn) {
  const run = async () => {
    const wait = Math.max(0, nextAllowedAt - Date.now());
    if (wait > 0) await sleep(wait);
    nextAllowedAt = Date.now() + MIN_GAP_MS;
    return fn();
  };

  const next = queue.then(run, run);
  queue = next.catch(() => {});
  return next;
}

async function rawPostOnce(path, body) {
  const payload = JSON.stringify(body);
  // Generate timestamp right before sending so queued requests stay fresh
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
    const err = new Error(`${json.ret_msg ?? json.retMsg ?? 'error'} (ErrCode: ${code})`);
    err.code = code;
    throw err;
  }
  return json.result ?? json;
}

async function p2pPost(path, body = {}) {
  for (let attempt = 0; attempt <= MAX_RATE_RETRIES; attempt++) {
    try {
      return await scheduleP2P(() => rawPostOnce(path, body));
    } catch (err) {
      const isRateLimit = err.code === 10006 || String(err.message || '').includes('10006');
      if (!isRateLimit || attempt === MAX_RATE_RETRIES) throw err;

      const jitter = Math.floor(Math.random() * 900);
      const backoffMs = 2500 * (attempt + 1) + jitter;
      // Hold the shared queue briefly so other callers don't hit 10006 during cooldown
      nextAllowedAt = Math.max(nextAllowedAt, Date.now() + backoffMs);
      console.log(
        `[p2pRaw] ${path} rate limited (10006), retry ${attempt + 1}/${MAX_RATE_RETRIES} in ${(backoffMs / 1000).toFixed(1)}s`
      );
      await sleep(backoffMs);
    }
  }
}

module.exports = { p2pPost, scheduleP2P };