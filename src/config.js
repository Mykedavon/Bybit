// src/config.js
// Loads .env and validates required values.

require('dotenv').config();

const REQUIRED = [
  'BYBIT_API_KEY',
  'BYBIT_API_SECRET',
  'SELL_AD_1_ID',
  'SELL_AD_2_ID',
];

const missing = REQUIRED.filter((k) => !process.env[k] || process.env[k].trim() === '');
if (missing.length > 0) {
  console.error(`[config] Missing required env vars: ${missing.join(', ')}`);
  process.exit(1);
}

const num = (key, fallback) => {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (Number.isNaN(n)) {
    console.error(`[config] ${key} must be a number, got: ${raw}`);
    process.exit(1);
  }
  return n;
};

const str = (key, fallback) => {
  const raw = process.env[key];
  return raw === undefined || raw === '' ? fallback : raw;
};

module.exports = {
  bybit: {
    apiKey: process.env.BYBIT_API_KEY,
    apiSecret: process.env.BYBIT_API_SECRET,
  },

  ads: {
    sellAd1Id: process.env.SELL_AD_1_ID,
    sellAd2Id: process.env.SELL_AD_2_ID,
  },

  market: {
    coin: str('COIN', 'USDC'),
    fiat: str('FIAT', 'NGN'),
    fetchCount: num('MARKET_FETCH_COUNT', 10),
  },

  pricing: {
    undercutNgn: num('UNDERCUT_NGN', 0.05),
    bulkMinQuantity: num('BULK_MIN_QUANTITY', 150),
  },

  competitor: {
    minCompletionRate: num('MIN_COMPLETION_RATE', 0.90),
    minOrders30d: num('MIN_ORDERS_30D', 10),
  },

  profit: {
    weightedAvgBuyCount: num('WEIGHTED_AVG_BUY_COUNT', 12),
    minProfitPerUsdc: num('MIN_PROFIT_PER_USDC', 10),
    // Used only when no buy history exists. 0 = disabled (edits stay blocked).
    manualFloor: num('MANUAL_PROFIT_FLOOR', 0),
  },

  safety: {
    // An edit that moves an ad's price by more than this % is refused.
    maxPriceMovePct: num('MAX_PRICE_MOVE_PCT', 5),
  },

  // LIVE by default. Dry run only happens when DRY_RUN is exactly "true".
  dryRun: str('DRY_RUN', 'false').trim().toLowerCase() === 'true',

  timing: {
    cycleSeconds: num('CYCLE_SECONDS', 60),
    buyerMsgDelaySeconds: num('BUYER_MSG_DELAY_SECONDS', 10),
  },

  telegram: {
    botToken: str('TELEGRAM_BOT_TOKEN', ''),
    chatId: str('TELEGRAM_CHAT_ID', ''),
  },

  failures: {
    alertThreshold: num('FAILURE_ALERT_THRESHOLD', 10),
    retentionHours: num('FAILURE_ALERT_RETENTION_HOURS', 7),
  },
};