// src/bybit/market.js
// Fetches live USDC sell ads from Bybit.
// No filtering. No decisions. Just fetch and return.

const { client } = require('./client');
const config = require('../config');

async function fetchLiveSellAds() {
  const response = await client.getOnlineAds({
    tokenId: config.market.coin,
    currencyId: config.market.fiat,
    side: '1', // 1 = sell ads
    size: config.market.fetchCount,
  });

  // The SDK wraps the data in { ret_code, result: {...} }
  const result = response.result || response;
  const items = result.items || [];

  console.log(`[market] fetched ${items.length} live sell ads`);

  return items;
}

module.exports = { fetchLiveSellAds };