// src/managers/autoBuyManager.js
// Monitors spendable USDC and manages BUY_AD_1_ID:
// - When spendable < 200 USDC and buy ad is offline/pending, activates it with
//   quantity = (AUTO_BUY_TARGET_USDC - spendable), e.g., 620 - 150 = 470 USDC.
// - Checks the buy market every 5 minutes from posting while active, adjusting
//   only the price (until remaining quantity value drops below minAmount and
//   Bybit automatically takes the ad offline/pending).
// - Filters buy ads for reliable traders with >= 35 USDC available and whose
//   fiat range covers 50,000 NGN (minAmount <= 50000 <= maxAmount).
// - Takes the top 10 highest-priced buy ads, computes their average, and bids
//   #1 + 0.01 when #1/#2/#3 are within ₦1.00 (and #1 isn't an expensive outlier),
//   otherwise bids #2 + 0.01 to sit cleanly in 2nd place.

const { client } = require('../bybit/client');
const { fetchLiveBuyAds } = require('../bybit/market');
const { scheduleP2P } = require('../bybit/p2pRaw');
const { getSpendableUsdc } = require('./inventory');
const config = require('../config');

const floor2 = (n) => Math.floor(Number(n) * 100 + 1e-9) / 100;

const paymentCache = new Map(); // adId -> { ids, at }
const PAYMENT_CACHE_MS = 10 * 60 * 1000;

let timer = null;
let running = false;

function runP2P(fn) {
  return typeof scheduleP2P === 'function' ? scheduleP2P(fn) : fn();
}

function cleanAdId(raw) {
  return String(raw || '').trim().replace(/^['"]|['"]$/g, '');
}

// ── Filters matching your Bybit screen (genuine, >= 35 USDC, ₦50,000 range) ──
function isGenuineBuyer(ad) {
  const price = Number(ad.price);
  const rate = Number(ad.completionRate) || 0;
  const orders = Number(ad.recentOrders) || 0;

  return (
    Number.isFinite(price) &&
    price > 0 &&
    rate >= config.competitor.minCompletionRate &&
    orders >= config.competitor.minOrders30d
  );
}

function excludeOwnAds(ads) {
  const myIds = [
    cleanAdId(config.ads.sellAd1Id),
    cleanAdId(config.ads.sellAd2Id),
    cleanAdId(config.ads.buyAd1Id),
  ].filter(Boolean);

  return ads.filter((ad) => !myIds.includes(String(ad.id)));
}

function matchesBuyMarketFilters(ad) {
  const qty = Number(ad.lastQuantity ?? ad.quantity) || 0;
  if (qty < config.autoBuy.minCompetitorQtyUsdc) return false;

  const targetFiat = config.autoBuy.filterFiatNgn;
  const minFiat = Number(ad.minAmount);
  const maxFiat = Number(ad.maxAmount);

  if (Number.isFinite(minFiat) && minFiat > 0 && targetFiat < minFiat) return false;
  if (Number.isFinite(maxFiat) && maxFiat > 0 && targetFiat > maxFiat) return false;

  return true;
}

// ── Top-10 average + #1 vs #2 competitive pricing ─────────
function computeBuyTarget(filteredAds) {
  const sortedDesc = [...filteredAds]
    .filter((ad) => Number.isFinite(Number(ad.price)) && Number(ad.price) > 0)
    .sort((a, b) => Number(b.price) - Number(a.price));

  if (sortedDesc.length === 0) {
    return { targetPrice: null, reason: 'no_matching_buy_competitor' };
  }

  const top10 = sortedDesc.slice(0, 10);
  const avgTop10 =
    top10.reduce((sum, ad) => sum + Number(ad.price), 0) / top10.length;

  const first = Number(top10[0].price);
  const second = top10[1] ? Number(top10[1].price) : null;
  const third = top10[2] ? Number(top10[2].price) : null;

  const maxSpread = config.autoBuy.maxSpreadNgn; // default 1.00 NGN
  const step = config.autoBuy.outbidStepNgn;     // default 0.01 NGN

  let anchorPrice = first;
  let rankTarget = 1;
  let selectionReason = 'top1_tight_market';

  if (second !== null) {
    const gap1to2 = first - second;
    const gap1to3 = third !== null ? first - third : gap1to2;
    const gap1toAvg = first - avgTop10;

    // If #1, #2, #3 are within ₦1 AND #1 is not far above the top-10 average, take #1.
    // Otherwise #1 is an expensive outlier — compete with #2 instead.
    const top3Tight = gap1to2 <= maxSpread + 1e-9 && gap1to3 <= maxSpread + 1e-9;
    const closeToAvg = gap1toAvg <= maxSpread + 1e-9;

    if (!top3Tight || !closeToAvg) {
      anchorPrice = second;
      rankTarget = 2;
      selectionReason = `top1_outlier(${first}_vs_2nd_${second}_avg_${avgTop10.toFixed(2)})`;
    }
  }

  let targetPrice = Number((anchorPrice + step).toFixed(2));

  if (config.autoBuy.maxPriceNgn > 0 && targetPrice > config.autoBuy.maxPriceNgn) {
    targetPrice = Number(config.autoBuy.maxPriceNgn.toFixed(2));
    selectionReason += '_clamped_max_price';
  }

  return {
    targetPrice,
    rankTarget,
    reason: selectionReason,
    avgTop10: Number(avgTop10.toFixed(2)),
    firstPrice: first,
    secondPrice: second,
    thirdPrice: third,
    topCompetitor: {
      price: anchorPrice,
      nickName: (rankTarget === 1 ? top10[0] : top10[1])?.nickName || 'unknown',
    },
  };
}

// ── Read ad info via SDK (matches decision.js) ────────────
async function fetchBuyAdInfo(adId) {
  const response = await runP2P(() => client.getAdInfo(adId));
  const code = response && (response.ret_code ?? response.retCode);
  if (code !== undefined && code !== 0) {
    throw new Error(`${response.ret_msg ?? response.retMsg ?? 'error'} (ErrCode: ${code})`);
  }
  return response.result || response;
}

function extractPaymentIds(adId, info) {
  const cached = paymentCache.get(adId);
  if (cached && Date.now() - cached.at < PAYMENT_CACHE_MS) return cached.ids;

  const terms = Array.isArray(info.paymentTerms) ? info.paymentTerms : [];
  const ids = terms
    .map((t) => (t && t.id !== undefined && t.id !== null ? String(t.id) : ''))
    .filter(Boolean);

  if (ids.length === 0) {
    throw new Error(`buy ad ${adId} has no paymentTerms`);
  }

  paymentCache.set(adId, { ids, at: Date.now() });
  return ids;
}

function normalizePrefs(prefs) {
  const out = {};
  for (const [k, v] of Object.entries(prefs || {})) {
    if (v === null || v === undefined) continue;
    out[k] = String(v);
  }
  return out;
}

async function updateBuyAd(adId, info, price, quantity, paymentIds) {
  const cleanQty = floor2(quantity);
  const rawMin = Number(info.minAmount || config.autoBuy.minAmountNgn);
  const rawMax = Number(info.maxAmount || config.autoBuy.maxAmountNgn);
  const fillableFiat = Math.floor(Number(price) * cleanQty);
  const clampedMax = Number.isFinite(rawMax) && rawMax > 0
    ? Math.min(rawMax, fillableFiat > 0 ? fillableFiat : rawMax)
    : fillableFiat;
  const safeMax = Math.max(Number.isFinite(rawMin) && rawMin > 0 ? rawMin : 50000, clampedMax);

  const params = {
    id: String(adId),
    priceType: info.priceType ? String(info.priceType) : '0',
    premium: '',
    price: String(price),
    quantity: String(cleanQty),
    minAmount: String(Number.isFinite(rawMin) && rawMin > 0 ? rawMin : config.autoBuy.minAmountNgn),
    maxAmount: String(safeMax),
    remark: info.remark || '',
    tradingPreferenceSet: normalizePrefs(info.tradingPreferenceSet),
    paymentIds,
    actionType: 'MODIFY',
    paymentPeriod: String(info.paymentPeriod || '15'),
  };

  if (config.dryRun) {
    console.log(`[autoBuy] DRY_RUN — would update buy ad ${adId}:`, JSON.stringify(params));
    return { ok: true, action: 'dry_run', price, quantity: cleanQty };
  }

  const res = await runP2P(() => client.updateAd(params));
  const code = res && (res.ret_code ?? res.retCode);
  if (code !== undefined && code !== 0) {
    throw new Error(`${res.ret_msg ?? res.retMsg ?? 'error'} (ErrCode: ${code})`);
  }

  return { ok: true, action: 'updated', price, quantity: cleanQty };
}

// ── Main 5-minute cycle ───────────────────────────────────
async function runAutoBuyCycle() {
  if (running) return { ok: true, skipped: 'already_running' };
  const buyAdId = cleanAdId(config.ads.buyAd1Id);
  if (!buyAdId) {
    return { ok: true, skipped: 'no_buy_ad_id_configured' };
  }

  running = true;
  let step = 'init';
  try {
    step = 'getSpendableUsdc';
    const spendable = Number(await getSpendableUsdc());

    step = `fetchBuyAdInfo(${buyAdId})`;
    const info = await fetchBuyAdInfo(buyAdId);
    const status = Number(info.status);
    const online = info.isOnline === true || status === 10;

    // If the buy ad is currently offline/pending AND spendable >= 200 USDC, do nothing.
    if (!online && spendable >= config.autoBuy.triggerBelowUsdc) {
      console.log(
        `[autoBuy] spendable (${spendable}) >= ${config.autoBuy.triggerBelowUsdc} USDC and buy ad is offline — idle`
      );
      return { ok: true, action: 'idle', spendable };
    }

    step = 'fetchLiveBuyAds';
    const marketBuyAds = await fetchLiveBuyAds(20);
    const others = excludeOwnAds(marketBuyAds);
    const genuine = others.filter(isGenuineBuyer);
    const matched = genuine.filter(matchesBuyMarketFilters);

    console.log(
      `[autoBuy] buy ads: total=${marketBuyAds.length}, genuine=${genuine.length}, ` +
      `matched(>=${config.autoBuy.minCompetitorQtyUsdc} USDC & ₦${config.autoBuy.filterFiatNgn})=${matched.length}`
    );

    step = 'computeBuyTarget';
    const decision = computeBuyTarget(matched);
    if (!decision.targetPrice) {
      console.log('[autoBuy] no matching buy competitor found — skipping');
      return { ok: true, action: 'skipped', reason: decision.reason };
    }

    console.log(
      `[autoBuy] top10 avg=${decision.avgTop10}, #1=${decision.firstPrice}, #2=${decision.secondPrice ?? 'N/A'} ` +
      `-> targeting #${decision.rankTarget} at ${decision.targetPrice} (${decision.reason})`
    );

    step = 'extractPaymentIds';
    const paymentIds = extractPaymentIds(buyAdId, info);

    // Case 1: Ad is currently offline/pending and spendable < 200 -> post/activate with (620 - spendable)
    if (!online) {
      const buyQty = floor2(Math.max(0, config.autoBuy.targetTotalUsdc - spendable));
      const minFillUsdc = Number(info.minAmount || config.autoBuy.minAmountNgn) / decision.targetPrice;

      if (buyQty <= 0 || buyQty < minFillUsdc) {
        console.log(
          `[autoBuy] calculated buyQty (${buyQty} USDC) is below minimum order (${minFillUsdc.toFixed(2)} USDC) — skipping`
        );
        return { ok: true, action: 'skipped', reason: 'qty_below_min_limit' };
      }

      step = 'updateBuyAd(activate)';
      const res = await updateBuyAd(buyAdId, info, decision.targetPrice, buyQty, paymentIds);
      console.log(
        `[autoBuy] posted buy ad ${buyAdId}: qty=${buyQty} USDC (${config.autoBuy.targetTotalUsdc} - ${spendable}) @ ₦${decision.targetPrice}`
      );
      return res;
    }

    // Case 2: Ad is already online/active -> only adjust price; leave remaining quantity untouched
    // so partial fills wind down naturally until Bybit takes the ad down to pending.
    const currentPrice = Number(info.price) || 0;
    const total = Number(info.quantity);
    const hasLast = info.lastQuantity !== undefined && info.lastQuantity !== null && info.lastQuantity !== '';
    const remainingQty = hasLast ? Number(info.lastQuantity) : total;

    if (Math.abs(currentPrice - decision.targetPrice) <= 0.001) {
      console.log(`[autoBuy] buy ad ${buyAdId} already at ₦${currentPrice} (rem qty ${remainingQty}) — no price edit needed`);
      return { ok: true, action: 'skipped', reason: 'no_price_change_needed' };
    }

    step = 'updateBuyAd(price)';
    const res = await updateBuyAd(buyAdId, info, decision.targetPrice, remainingQty, paymentIds);
    console.log(
      `[autoBuy] adjusted buy ad ${buyAdId} price: ₦${currentPrice} -> ₦${decision.targetPrice} (rem qty ${remainingQty})`
    );
    return res;
  } catch (err) {
    console.error(`[autoBuy] cycle error at step=${step}:`, err.message);
    return { ok: false, step, error: err.message };
  } finally {
    running = false;
  }
}

function startAutoBuyScheduler() {
  if (timer) return;
  const intervalMs = config.autoBuy.pollSeconds * 1000;
  console.log(
    `[autoBuy] scheduler started (every ${config.autoBuy.pollSeconds}s, trigger < ${config.autoBuy.triggerBelowUsdc} USDC, target = ${config.autoBuy.targetTotalUsdc} - available)`
  );

  setTimeout(() => {
    runAutoBuyCycle().catch(() => {});
  }, 4000);

  timer = setInterval(() => {
    runAutoBuyCycle().catch(() => {});
  }, intervalMs);
}

function stopAutoBuyScheduler() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

module.exports = {
  isGenuineBuyer,
  excludeOwnAds,
  matchesBuyMarketFilters,
  computeBuyTarget,
  runAutoBuyCycle,
  startAutoBuyScheduler,
  stopAutoBuyScheduler,
};