// src/managers/decision.js
// Combines ranked competitor targets with separate safety floors and ad state.
// Ad 2 safety: weighted average buy + MIN_PROFIT_PER_USDC (env)
// Ad 1 safety: ad 2's margin reduced by AD1_MARGIN_DISCOUNT_PCT (env, default 10%)
// If a competitor's undercut target is below safety, skip that competitor
// and select the next competitor that can be safely undercut.
// Ad 2 also must stay above ad 1 by a gap, so it picks the next competitor
// it can undercut above that level.

const { client } = require('../bybit/client');
const { scheduleP2P } = require('../bybit/p2pRaw');
const { fetchCompletedBuys, weightedAvgBuyPrice } = require('../bybit/orders');
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
        console.log(
          `[decision] ${label} rate limited, retry ${i}/${attempts - 1} in ${(delayMs / 1000).toFixed(1)}s`
        );
        await sleep(delayMs);
        continue;
      }

      return res;
    } catch (err) {
      const limited = err.code === 10006 || String(err.message || '').includes('10006');
      if (!limited || i === attempts) throw err;

      const delayMs = 3000 * i + Math.floor(Math.random() * 700);
      console.log(
        `[decision] ${label} rate limited (thrown), retry ${i}/${attempts - 1} in ${(delayMs / 1000).toFixed(1)}s`
      );
      await sleep(delayMs);
    }
  }
}

// ── Read current ad state ─────────────────────────────────
async function getAdState(adId) {
  const response = await withRetry(`getAdInfo ${adId}`, () => client.getAdInfo(adId));
  const data = response.result || response;

  const total = Number(data.quantity);
  const hasLast =
    data.lastQuantity !== undefined &&
    data.lastQuantity !== null &&
    data.lastQuantity !== '';
  const remaining = hasLast ? Number(data.lastQuantity) : total;

  return {
    id: adId,
    price: Number(data.price) || 0,
    quantity: Number.isFinite(total) ? total : 0,
    lastQuantity: Number.isFinite(remaining) ? remaining : 0,
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

// ── Safety margins (from .env) ─────────────────────────────
// Ad 2 margin = AD2_MARGIN_NGN if set, otherwise MIN_PROFIT_PER_USDC (default 10).
// Ad 1 margin = ad 2 margin reduced by AD1_MARGIN_DISCOUNT_PCT (default 10,
// so 10 -> 9). Set the discount to 0 to give both ads the same margin.
function getMargins() {
  const ad2 = Number(process.env.AD2_MARGIN_NGN);
  const disc = Number(process.env.AD1_MARGIN_DISCOUNT_PCT);
  const base = Number(config.profit.minProfitPerUsdc);
  const fallback = Number.isFinite(base) && base > 0 ? base : 10;
  const ad2Margin = Number.isFinite(ad2) && ad2 > 0 ? ad2 : fallback;
  const discPct = Number.isFinite(disc) && disc >= 0 && disc < 100 ? disc : 10;
  const ad1Margin = Number((ad2Margin * (1 - discPct / 100)).toFixed(2));
  return { ad1Margin, ad2Margin };
}

// ── Weighted-average buy-price cache ───────────────────────
const FLOOR_TTL_MS = 5 * 60 * 1000;
const FLOOR_STALE_MAX_MS = 30 * 60 * 1000;

let floorCache = {
  at: 0,
  weightedAvg: null,
  ad1Floor: null,
  ad2Floor: null,
};

async function getProfitFloor() {
  const age = Date.now() - floorCache.at;

  if (floorCache.at && age < FLOOR_TTL_MS) {
    return floorCache;
  }

  try {
    const buys = await withRetry('completed buys', () => fetchCompletedBuys());
    const weightedAvg = weightedAvgBuyPrice(buys);

    const { ad1Margin, ad2Margin } = getMargins();
    const ad1Floor = weightedAvg === null ? null : Number((weightedAvg + ad1Margin).toFixed(2));
    const ad2Floor = weightedAvg === null ? null : Number((weightedAvg + ad2Margin).toFixed(2));

    floorCache = {
      at: Date.now(),
      weightedAvg,
      ad1Floor,
      ad2Floor,
    };

    return floorCache;
  } catch (err) {
    if (floorCache.at && age < FLOOR_STALE_MAX_MS) {
      console.log(
        `[decision] buys fetch failed (${err.message}) — reusing weighted average from ${Math.round(age / 1000)}s ago`
      );
      return floorCache;
    }

    throw err;
  }
}

// ── Keep the two ads' prices apart (Ad 2 always >= Ad 1) ──
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
    console.log(
      `[decision] Bybit rejected the price gap — ad 2 will now sit ₦${separationNgn()} above ad 1`
    );
  } else {
    console.log(
      '[decision] Bybit rejected the price gap again at the widest setting — check the ads manually'
    );
  }
}

// Safety net: ad 2 must never be cheaper than ad 1 or too close to it.
function separateTargets(t1, t2) {
  if (!t1 || !t2) return t2;
  if (t1.targetPrice === null || t1.targetPrice === undefined) return t2;
  if (t2.targetPrice === null || t2.targetPrice === undefined) return t2;

  const sep = separationNgn();
  const minAd2Price = Number((t1.targetPrice + sep).toFixed(2));

  if (t2.targetPrice < minAd2Price - 1e-9) {
    console.log(
      `[decision] ad 2 target ${t2.targetPrice} is below/too close to ad 1 (${t1.targetPrice}) — using ${minAd2Price}`
    );

    return {
      ...t2,
      targetPrice: minAd2Price,
      reason: 'ad_separation',
    };
  }

  return t2;
}

// ── Select the first competitor whose undercut is safe ────
// Candidates arrive sorted cheapest-to-most-expensive.
// Safety floor is a restriction, not a price target.
// minPrice (used for ad 2) is ad 1's price plus the gap: competitors whose
// undercut would land below it are skipped too.
// If no competitor can be safely undercut, fall back to the lower bound.
function selectSafeTarget(originalTarget, floor, adLabel, minPrice = null) {
  // Lowest price this ad may take: its safety floor, and (for ad 2) ad 1's price + gap.
  const lowerBound = Math.max(Number(floor) || 0, Number(minPrice) || 0);

  if (!originalTarget || originalTarget.targetPrice === null) {
    return originalTarget || { targetPrice: null, reason: 'no_genuine_competitor' };
  }

  const candidates = Array.isArray(originalTarget.candidates)
    ? originalTarget.candidates
    : null;

  // Compatibility with a target that doesn't contain candidate lists.
  if (!candidates) {
    if (originalTarget.targetPrice >= lowerBound) return originalTarget;

    console.log(
      `[decision] ${adLabel} target ${originalTarget.targetPrice} is below safety ${lowerBound}; using safety fallback`
    );

    return {
      ...originalTarget,
      targetPrice: lowerBound,
      reason: 'safety_floor_fallback',
    };
  }

  const eligible = candidates.find(
    (candidate) => Number(candidate.targetPrice) >= lowerBound
  );

  if (eligible) {
    if (eligible.targetPrice !== candidates[0].targetPrice) {
      console.log(
        `[decision] ${adLabel}: skipped unsafe competitor(s); targeting ${eligible.competitor.price} at ${eligible.targetPrice}`
      );
    }

    return {
      targetPrice: eligible.targetPrice,
      cheapest: eligible.competitor,
      candidates,
      reason: 'safe_competitor_target',
    };
  }

  // No competitor can be safely undercut; stay at the lower bound rather than
  // chasing an unsafe competitor.
  console.log(
    `[decision] ${adLabel}: no safe competitor target found — falling back to ${lowerBound}`
  );

  return {
    targetPrice: lowerBound,
    cheapest: null,
    candidates,
    reason: 'safety_floor_fallback',
  };
}

// ── Decide for one ad ─────────────────────────────────────
// Output: { action: 'EDIT'|'SKIP'|'BLOCK', ... }
function decideForAd(adState, target, spendable, floor) {
  const currentQty = adState.lastQuantity;

  const result = {
    adId: adState.id,
    currentPrice: adState.price,
    currentQuantity: currentQty,
  };

  // No genuine competitor → skip price edit
  if (!target || target.targetPrice === null || target.targetPrice === undefined) {
    return { ...result, action: 'SKIP', reason: target?.reason || 'no_genuine_competitor' };
  }

  // No safety floor available → never edit (fail closed)
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

  // Final safety check
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
    targetReason: target.reason,
  };
}

// ── Main: evaluate both ads ──────────────────────────────
async function evaluateBothAds(sellCycleResult, spendable) {
  const cached = await getProfitFloor();
  const weightedAvg = cached.weightedAvg;

  let ad1Floor = cached.ad1Floor;
  let ad2Floor = cached.ad2Floor;

  // Optional manual floor when no buy history exists.
  // It is used as the safety floor for both ads if weighted average is missing.
  if (weightedAvg === null && config.profit.manualFloor > 0) {
    ad1Floor = config.profit.manualFloor;
    ad2Floor = config.profit.manualFloor;

    console.log(`[decision] using MANUAL_PROFIT_FLOOR: ${config.profit.manualFloor}`);
  }

  console.log(
    `[decision] weighted avg buy: ${weightedAvg !== null ? Number(weightedAvg).toFixed(2) : 'N/A'}`
  );
  const margins = getMargins();
  console.log(
    `[decision] Ad 1 safety floor (+${margins.ad1Margin}): ${ad1Floor !== null ? ad1Floor.toFixed(2) : 'N/A'}`
  );
  console.log(
    `[decision] Ad 2 safety floor (+${margins.ad2Margin}): ${ad2Floor !== null ? ad2Floor.toFixed(2) : 'N/A'}`
  );

  if (ad1Floor === null || ad2Floor === null) {
    console.log('[decision] WARNING: no safety floor available — edits without a floor are blocked');
  }

  // Read both ads once per cycle (small gap between calls)
  const ad1State = await getAdState(config.ads.sellAd1Id);
  await sleep(400);
  const ad2State = await getAdState(config.ads.sellAd2Id);

  // Choose the first safely undercuttable competitor for each ad.
  const ad1Target = selectSafeTarget(sellCycleResult.ad1, ad1Floor, 'Ad 1');

  // Ad 2 must stay above ad 1 by the required gap, so it picks the next
  // competitor it can undercut above that level instead of being pushed up.
  const ad2MinPrice =
    ad1Target && ad1Target.targetPrice !== null && ad1Target.targetPrice !== undefined
      ? Number((ad1Target.targetPrice + separationNgn()).toFixed(2))
      : null;
  const ad2Target = selectSafeTarget(sellCycleResult.ad2, ad2Floor, 'Ad 2', ad2MinPrice);

  // Safety net: keep Ad 2 separated from Ad 1.
  const separatedAd2Target = separateTargets(ad1Target, ad2Target);

  const ad1Decision = decideForAd(ad1State, ad1Target, spendable, ad1Floor);
  const ad2Decision = decideForAd(ad2State, separatedAd2Target, spendable, ad2Floor);

  return {
    ad1: ad1Decision,
    ad2: ad2Decision,
    ad1State,
    ad2State,
    floor: ad2Floor,
    ad1Floor,
    ad2Floor,
    weightedAvg,
  };
}

module.exports = {
  getAdState,
  decideForAd,
  evaluateBothAds,
  noteCollision,
};