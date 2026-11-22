// src/managers/decision.js
// Combines target prices with profit floor and current ad state.
// Returns one decision per ad: EDIT, SKIP, or BLOCK.

const { client } = require('../bybit/client');
const { fetchCompletedBuys, weightedAvgBuyPrice, profitFloor } = require('../bybit/orders');
const config = require('../config');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Retry when Bybit answers "too many visits" (ErrCode 10006)
async function withRetry(label, fn, attempts = 4) {
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fn();
      const code = res && (res.ret_code ?? res.retCode);
      if (code === 10006 && i < attempts) {
        console.log(`[decision] ${label} rate limited, retry ${i}/${attempts - 1} in ${3 * i}s`);
        await sleep(3000 * i);
        continue;
      }
      return res;
    } catch (err) {
      const limited = String(err.message || '').includes('10006');
      if (!limited || i === attempts) throw err;
      console.log(`[decision] ${label} rate limited (thrown), retry ${i}/${attempts - 1} in ${3 * i}s`);
      await sleep(3000 * i);
    }
  }
}

// ── Read current ad state ─────────────────────────────────
async function getAdState(adId) {
  const response = await withRetry(`getAdInfo ${adId}`, () => client.getAdInfo(adId));
  const data = response.result || response;

  return {
    id: adId,
    price: Number(data.price) || 0,
    quantity: Number(data.quantity) || 0,
    lastQuantity: Number(data.lastQuantity) || 0,
    minAmount: data.minAmount,
    maxAmount: data.maxAmount,
    priceType: data.priceType,
    premium: data.premium,
    remark: data.remark,
    tradingPreferenceSet: data.tradingPreferenceSet,
    payments: data.payments,
    paymentPeriod: data.paymentPeriod,
  };
}

// ── Profit floor (cached) ─────────────────────────────────
// Completed buys change rarely, so fetch at most every 5 minutes.
// If a fetch fails, reuse the last known floor for up to 30 minutes.
const FLOOR_TTL_MS = 5 * 60 * 1000;
const FLOOR_STALE_MAX_MS = 30 * 60 * 1000;
let floorCache = { at: 0, floor: null, weightedAvg: null };

async function getProfitFloor() {
  const age = Date.now() - floorCache.at;
  if (floorCache.at && age < FLOOR_TTL_MS) return floorCache;

  try {
    const buys = await withRetry('completed buys', () => fetchCompletedBuys());
    const weightedAvg = weightedAvgBuyPrice(buys);
    let floor = profitFloor(weightedAvg);
    floor = Number.isFinite(floor) ? floor : null;
    floorCache = { at: Date.now(), floor, weightedAvg };
    return floorCache;
  } catch (err) {
    if (floorCache.at && age < FLOOR_STALE_MAX_MS) {
      console.log(`[decision] buys fetch failed (${err.message}) — reusing floor from ${Math.round(age / 1000)}s ago`);
      return floorCache;
    }
    throw err;
  }
}

// ── Decide for one ad ─────────────────────────────────────
// Output: { action: 'EDIT'|'SKIP'|'BLOCK', ... }
function decideForAd(adState, target, spendable, floor) {
  const result = {
    adId: adState.id,
    currentPrice: adState.price,
    currentQuantity: adState.quantity,
  };

  // No genuine competitor → skip price edit
  if (target.targetPrice === null) {
    return { ...result, action: 'SKIP', reason: target.reason };
  }

  // No profit floor available → never edit (fail closed)
  if (floor === null || floor === undefined) {
    return {
      ...result,
      action: 'BLOCK',
      reason: 'no_profit_floor',
      targetPrice: target.targetPrice,
      floor: null,
      shortfall: null,
    };
  }

  // ── Check profit floor ────────────────────────────────
  if (target.targetPrice < floor) {
    return {
      ...result,
      action: 'BLOCK',
      reason: 'below_profit_floor',
      targetPrice: target.targetPrice,
      floor,
      shortfall: Number((floor - target.targetPrice).toFixed(2)),
    };
  }

  const priceChanged = Math.abs(adState.price - target.targetPrice) > 0.001;
  const quantityChanged = Math.abs(adState.quantity - spendable) > 0.01;

  // Nothing to change
  if (!priceChanged && !quantityChanged) {
    return { ...result, action: 'SKIP', reason: 'no_change_needed' };
  }

  // Zero balance safety: never zero the ad
  if (spendable === 0 && adState.quantity > 0) {
    return { ...result, action: 'SKIP', reason: 'zero_balance_safety' };
  }

  return {
    ...result,
    action: 'EDIT',
    newPrice: priceChanged ? target.targetPrice : adState.price,
    newQuantity: quantityChanged ? spendable : adState.quantity,
    priceChanged,
    quantityChanged,
    targetPrice: target.targetPrice,
    cheapest: target.cheapest,
  };
}

// ── Main: evaluate both ads ──────────────────────────────
// Output: { ad1, ad2, ad1State, ad2State, floor, weightedAvg }
async function evaluateBothAds(sellCycleResult, spendable) {
  const cached = await getProfitFloor();
  const weightedAvg = cached.weightedAvg;
  let floor = cached.floor;

  // Optional manual floor when there is no buy history yet
  if (floor === null && config.profit.manualFloor > 0) {
    floor = config.profit.manualFloor;
    console.log(`[decision] using MANUAL_PROFIT_FLOOR: ${floor}`);
  }

  console.log(`[decision] weighted avg buy: ${weightedAvg ? Number(weightedAvg).toFixed(2) : 'N/A'}`);
  console.log(`[decision] profit floor: ${floor !== null ? floor.toFixed(2) : 'N/A'}`);
  if (floor === null) {
    console.log('[decision] WARNING: no profit floor available — all edits are blocked');
  }

  // Read both ads once per cycle
  const ad1State = await getAdState(config.ads.sellAd1Id);
  const ad2State = await getAdState(config.ads.sellAd2Id);

  // Decide
  const ad1Decision = decideForAd(ad1State, sellCycleResult.ad1, spendable, floor);
  const ad2Decision = decideForAd(ad2State, sellCycleResult.ad2, spendable, floor);

  return {
    ad1: ad1Decision,
    ad2: ad2Decision,
    ad1State,
    ad2State,
    floor,
    weightedAvg,
  };
}

module.exports = {
  getAdState,
  decideForAd,
  evaluateBothAds,
};