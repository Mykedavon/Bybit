// src/bybit/orders.js
// Fetches your completed USDC buy orders.
// Used to calculate weighted average buy price (profit floor).

const { client } = require('./client');
const config = require('../config');

// ── Fetch completed buy orders for a coin ─────────────────
async function fetchCompletedBuys(limit = config.profit.weightedAvgBuyCount) {
  const response = await client.getMyOrders({
    side: '0',       // 0 = buy
    status: '50',    // 50 = finished
    page: '1',
    size: String(Math.max(limit, 20)),
  });

  const result = response.result || response;
  const items = result.items || [];

  // Filter to USDC only, sort by newest first
  const usdcBuys = items
    .filter((o) => o.tokenId === config.market.coin)
    .sort((a, b) => Number(b.createDate) - Number(a.createDate));

  const latest = usdcBuys.slice(0, limit);

  console.log(`[orders] fetched ${latest.length} recent USDC buys`);

  return latest;
}

// ── Calculate weighted average buy price ──────────────────
// weighted_avg = sum(amount × price) / sum(amount)
function weightedAvgBuyPrice(buys) {
  if (!buys || buys.length === 0) return null;

  let totalNgn = 0;
  let totalUsdc = 0;

  for (const b of buys) {
    const amount = Number(b.amount) || 0;
    const price = Number(b.price) || 0;
    totalNgn += amount * price;
    totalUsdc += amount;
  }

  if (totalUsdc === 0) return null;
  return totalNgn / totalUsdc;
}

// ── Profit floor ──────────────────────────────────────────
function profitFloor(weightedAvg) {
  if (weightedAvg === null) return null;
  return weightedAvg + config.profit.minProfitPerUsdc;
}

module.exports = {
  fetchCompletedBuys,
  weightedAvgBuyPrice,
  profitFloor,
};