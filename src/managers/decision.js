// src/managers/decision.js
// Combines target prices with profit floor and current ad state.
// Returns one decision per ad: EDIT, SKIP, or BLOCK.
//
// Quantity note: on Bybit an ad has "quantity" (total size, including what
// already sold) and "lastQuantity" (what is still available). The balance
// is compared against lastQuantity.

const { client } = require('../bybit/client');
const { scheduleP2P } = require('../bybit/p2pRaw');
const { fetchCompletedBuys, weightedAvgBuyPrice, profitFloor } = require('../bybit/orders');
const config = require('../config');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function runP2P(fn) {
  return typeof scheduleP2P === 'function' ? scheduleP2P(fn) : fn();
}

// Retry when Bybit answers "too many visits" (ErrCode 10006)
async function withRetry(label, fn, attempts = 4) {
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await runP2P(fn);
      const code = res && (res.ret_code ?? res.retCode);
      if (code === 10006 && i < attempts) {
        const delayMs = 3000 * i + Math.floor(Math.random() * 700);
        console.log(`[decision] ${label} rate limited, retry ${i}/${attempts - 1} in ${(delayMs / 1000).toFixed(1)}s`);
        await sleep(delayMs);
        continue;
      }
      return res;
    } catch (err) {
      const limited = err.code === 10006 || String(err.message || '').includes('10006');
      if (!limited || i === attempts) throw err;
      const delayMs = 3000 * i + Math.floor(Math.random() * 700);
      console.log(`[decision] ${label} rate limited (thrown), retry ${i}/${attempts - 1} in ${(delayMs / 1000).toFixed(1)}s`);
      await sleep(delayMs);
    }
  }
}

// ── Read current ad state ─────────────────────────────────
async function getAdState(adId) {
  const response = await withRetry(`getAdInfo ${adId}`, () => client.getAdInfo(adId));
  const data = response.result || response;

  const total = Number(data.quantity);
  const hasLast = data.lastQuantity !== undefined && data.lastQuantity !== null && data.lastQuantity !== '';
  const remaining = hasLast ? Number(data.lastQuantity) : total;

  return {
    id: adId,
    price: Number(data.price) || 0,
    quantity: Number.isFinite(total) ? total : 0,           // total ad size
    lastQuantity: Number.isFinite(remaining) ? remaining : 0, // still available
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

// ── Keep the two ads' prices apart ────────────────────────
// Bybit rejects two of your own ads at (nearly) the same price (ErrCode 90043)
// and does not say how far apart they must be. Ad 2 starts a small gap below
// ad 1; each time Bybit rejects the gap, the executor calls noteCollision()
// and the next cycle uses a wider one. AD_PRICE_SEPARATION_NGN sets the start.
const SEPARATION_STEPS = [0.25, 0.5, 1, 1.5, 2, 3];

function initialStep() {
  const env = Number(process.env.AD_PRICE_SEPARATION_NGN);
  if (!Number.isFinite(env) || env <= 0) return 0;
  const i = SEPARATION_STEPS.findIndex((s) => s >= env);
  return i === -1 ? SEPARATION_STEPS.length - 1 : i;
}

let separationStep = initialStep();

function separationNgn() {
  return SEPARATION_STEPS[separationStep];
}

function noteCollision() {
  if (separationStep < SEPARATION_STEPS.length - 1) {
    separationStep += 1;
    console.log(`[decision] Bybit rejected the price gap — ad 2 will now sit ₦${separationNgn()} below ad 1`);
  } else {
    console.log('[decision] Bybit rejected the price gap again at the widest setting — check the ads manually');
  }
}

// If ad 2's target is within the separation of ad 1's, ad 2 goes below ad 1.
function separateTargets(t1, t2) {
  if (!t1 || !t2) return t2;
  if (t1.targetPrice === null || t1.targetPrice === undefined) return t2;
  if (t2.targetPrice === null || t2.targetPrice === undefined) return t2;

  const sep = separationNgn();
  if (Math.abs(t1.targetPrice - t2.targetPrice) < sep - 1e-9) {
    const adjusted = Number((t1.targetPrice - sep).toFixed(2));
    console.log(
      `[decision] ad 2 target ${t2.targetPrice} is too close to ad 1 (${t1.targetPrice}) — using ${adjusted}`
    );
    return { ...t2, targetPrice: adjusted };
  }
  return t2;
}

// ── Decide for one ad ─────────────────────────────────────
// Output: { action: 'EDIT'|'SKIP'|'BLOCK', ... }
function decideForAd(adState, target, spendable, floor) {
  const currentQty = adState.lastQuantity; // what is still listed

  const result = {
    adId: adState.id,
    currentPrice: adState.price,
    currentQuantity: currentQty,
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
  const quantityChanged = Math.abs(currentQty - spendable) > 0.01;

  // Nothing to change
  if (!priceChanged && !quantityChanged) {
    return { ...result, action: 'SKIP', reason: 'no_change_needed' };
  }

  // Zero balance safety: never zero the ad
  if (spendable === 0 && currentQty > 0) {
    return { ...result, action: 'SKIP', reason: 'zero_balance_safety' };
  }

  return {
    ...result,
    action: 'EDIT',
    newPrice: priceChanged ? target.targetPrice : adState.price,
    newQuantity: quantityChanged ? spendable : currentQty,
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

  // Read both ads once per cycle (small gap between calls)
  const ad1State = await getAdState(config.ads.sellAd1Id);
  await sleep(400);
  const ad2State = await getAdState(config.ads.sellAd2Id);

  // Decide
  const ad2Target = separateTargets(sellCycleResult.ad1, sellCycleResult.ad2);
  const ad1Decision = decideForAd(ad1State, sellCycleResult.ad1, spendable, floor);
  const ad2Decision = decideForAd(ad2State, ad2Target, spendable, floor);

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
  noteCollision,
};