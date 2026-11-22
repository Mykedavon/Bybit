// src/bybit/market.js
// Fetches live USDC sell ads from Bybit and normalizes the fields
// the rest of the bot relies on. No filtering. No decisions.

const { client } = require('./client');
const config = require('../config');

let loggedKeys = false;

const RATE_LIMIT_CODE = 10006;

async function fetchLiveSellAds() {
  let response;

  // Retry a few times if Bybit says "too many visits"
  for (let attempt = 1; attempt <= 3; attempt++) {
    response = await client.getOnlineAds({
      tokenId: config.market.coin,
      currencyId: config.market.fiat,
      side: '1', // 1 = sell ads
      size: config.market.fetchCount,
    });

    const code = response.ret_code ?? response.retCode;
    if (code === RATE_LIMIT_CODE && attempt < 3) {
      console.log(`[market] rate limited, retry ${attempt}/2 in ${2 * attempt}s`);
      await new Promise((r) => setTimeout(r, 2000 * attempt));
      continue;
    }
    break;
  }

  // Surface API-level errors instead of silently returning nothing
  const code = response.ret_code ?? response.retCode;
  if (code !== undefined && code !== 0) {
    const msg = response.ret_msg ?? response.retMsg ?? '';
    throw new Error(`getOnlineAds failed: ${code} ${msg}`);
  }

  const result = response.result || response;
  const items = result.items || [];

  // One-time log so the real field names can be verified
  if (!loggedKeys && items[0]) {
    console.log('[market] sample ad keys:', Object.keys(items[0]).join(','));
    loggedKeys = true;
  }

  console.log(`[market] fetched ${items.length} live sell ads`);

  return items.map((ad) => {
    const rawRate = Number(ad.recentExecuteRate);
    const rate = Number.isNaN(rawRate) ? 0 : rawRate;
    return {
      ...ad,
      // Normalize to a fraction (handles 98 or 0.98)
      completionRate: rate > 1 ? rate / 100 : rate,
      recentOrders: Number(ad.recentOrderNum) || 0,
      // Use remaining quantity if provided, otherwise the listed quantity
      quantity: Number(ad.lastQuantity ?? ad.quantity) || 0,
    };
  });
}

module.exports = { fetchLiveSellAds };