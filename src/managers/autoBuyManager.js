// src/managers/autoBuyManager.js
// Monitors spendable USDC and manages BUY_AD_1_ID:
// - When spendable < AUTO_BUY_TRIGGER_USDC and the buy ad is offline, it edits the ad
//   (price from the buy market, quantity = AUTO_BUY_TARGET_USDC - spendable) and
//   relists it as ACTIVE, even if Bybit had taken it offline.
// - While the ad is online it only adjusts the price every AUTO_BUY_POLL_SECONDS.
//   Bybit takes the ad offline by itself when the remaining value drops below the
//   minimum order.
// - Competitors: reliable traders with enough USDC whose limits cover
//   AUTO_BUY_FILTER_FIAT_NGN. Bids #1 + step when the top 3 are tight, else #2 + step.

const { client } = require('../bybit/client');
const { fetchLiveBuyAds } = require('../bybit/market');
const { scheduleP2P } = require('../bybit/p2pRaw');
const { getSpendableUsdc } = require('./inventory');
const config = require('../config');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const floor2 = (n) => Math.floor(Number(n) * 100 + 1e-9) / 100;
const fmt = (n) => (Number.isFinite(Number(n)) ? Number(n).toFixed(2) : 'n/a');

const STATUS_LABEL = { 10: 'online', 20: 'offline', 30: 'completed' };

const paymentCache = new Map(); // adId -> { ids, at }
const PAYMENT_CACHE_MS = 10 * 60 * 1000;

let timer = null;
let running = false;
let lastQuietMsg = null; // repeated "nothing to do" lines are printed once

function runP2P(fn) {
  return typeof scheduleP2P === 'function' ? scheduleP2P(fn) : fn();
}

// Print a "nothing happened" line only when it changes
function logQuiet(msg) {
  if (msg !== lastQuietMsg) {
    console.log(msg);
    lastQuietMsg = msg;
  }
}

function cleanAdId(raw) {
  return String(raw || '').trim().replace(/^['"]|['"]$/g, '');
}

// ── Filters (genuine trader, enough USDC, range covers your size) ──
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
  const avgTop10 = top10.reduce((sum, ad) => sum + Number(ad.price), 0) / top10.length;

  const first = Number(top10[0].price);
  const second = top10[1] ? Number(top10[1].price) : null;
  const third = top10[2] ? Number(top10[2].price) : null;

  const maxSpread = config.autoBuy.maxSpreadNgn; // default 1.00 NGN
  const step = config.autoBuy.outbidStepNgn; // default 0.01 NGN

  let anchorPrice = first;
  let rankTarget = 1;
  let selectionReason = 'top 3 are close together, bidding above #1';

  if (second !== null) {
    const gap1to2 = first - second;
    const gap1to3 = third !== null ? first - third : gap1to2;
    const gap1toAvg = first - avgTop10;

    const top3Tight = gap1to2 <= maxSpread + 1e-9 && gap1to3 <= maxSpread + 1e-9;
    const closeToAvg = gap1toAvg <= maxSpread + 1e-9;

    if (!top3Tight || !closeToAvg) {
      anchorPrice = second;
      rankTarget = 2;
      selectionReason = `#1 (${first}) looks like an outlier vs #2 (${second}) / avg ${avgTop10.toFixed(2)}, bidding above #2`;
    }
  }

  let targetPrice = Number((anchorPrice + step).toFixed(2));

  if (config.autoBuy.maxPriceNgn > 0 && targetPrice > config.autoBuy.maxPriceNgn) {
    targetPrice = Number(config.autoBuy.maxPriceNgn.toFixed(2));
    selectionReason += ` (capped at AUTO_BUY_MAX_PRICE_NGN ${config.autoBuy.maxPriceNgn})`;
  }

  return {
    targetPrice,
    rankTarget,
    reason: selectionReason,
    avgTop10: Number(avgTop10.toFixed(2)),
    firstPrice: first,
    secondPrice: second,
    thirdPrice: third,
    topPrices: top10.slice(0, 5).map((ad) => Number(ad.price)),
  };
}

// ── Read ad info via SDK (retries on rate limit) ──────────
async function fetchBuyAdInfo(adId, attempts = 4) {
  for (let i = 1; i <= attempts; i++) {
    const response = await runP2P(() => client.getAdInfo(adId));
    const code = response && (response.ret_code ?? response.retCode);

    if (code === 10006 && i < attempts) {
      const delayMs = 3000 * i + Math.floor(Math.random() * 700);
      console.log(
        `[autoBuy] getAdInfo rate limited, retry ${i}/${attempts - 1} in ${(delayMs / 1000).toFixed(1)}s`
      );
      await sleep(delayMs);
      continue;
    }

    if (code !== undefined && code !== 0) {
      throw new Error(`${response.ret_msg ?? response.retMsg ?? 'error'} (ErrCode: ${code})`);
    }
    return response.result || response;
  }
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

// actionType: 'MODIFY' edits the ad, 'ACTIVE' relists (re-onlines) it
async function updateBuyAd(adId, info, price, quantity, paymentIds, actionType = 'MODIFY') {
  const cleanQty = floor2(quantity);
  const rawMin = Number(info.minAmount || config.autoBuy.minAmountNgn);
  const rawMax = Number(info.maxAmount || config.autoBuy.maxAmountNgn);
  const fillableFiat = Math.floor(Number(price) * cleanQty);
  const clampedMax =
    Number.isFinite(rawMax) && rawMax > 0
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
    actionType,
    paymentPeriod: String(info.paymentPeriod || '15'),
  };

  if (config.dryRun) {
    console.log(`[autoBuy] DRY_RUN — would send ${actionType}:`, JSON.stringify(params));
    return { ok: true, action: 'dry_run', price, quantity: cleanQty };
  }

  const res = await runP2P(() => client.updateAd(params));
  const code = res && (res.ret_code ?? res.retCode);
  if (code !== undefined && code !== 0) {
    throw new Error(`${res.ret_msg ?? res.retMsg ?? 'error'} (ErrCode: ${code})`);
  }

  return { ok: true, action: 'updated', price, quantity: cleanQty };
}

// ── Main cycle ────────────────────────────────────────────
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
    const online = status === 10; // 10 = online, 20 = offline, 30 = completed
    const trigger = config.autoBuy.triggerBelowUsdc;

    console.log(
      `[autoBuy] spendable ${fmt(spendable)} USDC | buy ad ${STATUS_LABEL[status] || `status ${status}`} ` +
        `(price ${fmt(info.price)}, left ${fmt(info.lastQuantity ?? info.quantity)} USDC) | trigger < ${trigger}`
    );

    // Offline and enough USDC → nothing to do.
    if (!online && spendable >= trigger) {
      logQuiet(
        `[autoBuy] idle: spendable ${fmt(spendable)} is not below ${trigger} and the buy ad is offline`
      );
      return { ok: true, action: 'idle', spendable };
    }
    lastQuietMsg = null;

    step = 'fetchLiveBuyAds';
    const marketBuyAds = await fetchLiveBuyAds(20);
    const others = excludeOwnAds(marketBuyAds);
    const genuine = others.filter(isGenuineBuyer);
    const matched = genuine.filter(matchesBuyMarketFilters);

    step = 'computeBuyTarget';
    const decision = computeBuyTarget(matched);
    if (!decision.targetPrice) {
      console.log(
        `[autoBuy] market: ${marketBuyAds.length} ads, ${genuine.length} genuine, 0 usable (need ≥ ${config.autoBuy.minCompetitorQtyUsdc} USDC and range covering ₦${config.autoBuy.filterFiatNgn}) — skipping`
      );
      return { ok: true, action: 'skipped', reason: decision.reason };
    }

    console.log(
      `[autoBuy] market: ${marketBuyAds.length} ads, ${genuine.length} genuine, ${matched.length} usable | ` +
        `top: ${decision.topPrices.join(', ')} | top-10 avg ${decision.avgTop10}`
    );
    console.log(
      `[autoBuy] target ₦${decision.targetPrice}: ${decision.reason} (+${config.autoBuy.outbidStepNgn})`
    );

    step = 'extractPaymentIds';
    const paymentIds = extractPaymentIds(buyAdId, info);

    // Case 1: ad offline and spendable below trigger → edit and post it ACTIVE
    if (!online) {
      const buyQty = floor2(Math.max(0, config.autoBuy.targetTotalUsdc - spendable));
      const minFillUsdc =
        Number(info.minAmount || config.autoBuy.minAmountNgn) / decision.targetPrice;

      if (buyQty <= 0 || buyQty < minFillUsdc) {
        console.log(
          `[autoBuy] not posting: quantity ${fmt(buyQty)} USDC is below the minimum order (${fmt(minFillUsdc)} USDC)`
        );
        return { ok: true, action: 'skipped', reason: 'qty_below_min_limit' };
      }

      console.log(
        `[autoBuy] posting buy ad: ${config.autoBuy.targetTotalUsdc} target - ${fmt(spendable)} spendable = ${fmt(buyQty)} USDC @ ₦${decision.targetPrice}`
      );

      step = 'updateBuyAd(activate)';
      let res;
      try {
        res = await updateBuyAd(buyAdId, info, decision.targetPrice, buyQty, paymentIds, 'ACTIVE');
      } catch (err) {
        console.log(`[autoBuy] ACTIVE failed (${err.message}) — trying MODIFY, then ACTIVE`);
        await updateBuyAd(buyAdId, info, decision.targetPrice, buyQty, paymentIds, 'MODIFY');
        res = await updateBuyAd(buyAdId, info, decision.targetPrice, buyQty, paymentIds, 'ACTIVE');
      }

      step = 'confirm(activate)';
      const after = await fetchBuyAdInfo(buyAdId);
      const afterStatus = Number(after.status);
      console.log(
        `[autoBuy] after posting: ${STATUS_LABEL[afterStatus] || `status ${afterStatus}`} | ` +
          `price ${fmt(after.price)} | qty ${fmt(after.quantity)} USDC` +
          (afterStatus === 10 ? ' — LIVE' : ' — NOT LIVE, check the ad on Bybit')
      );
      return res;
    }

    // Case 2: ad already online → only adjust price, leave remaining quantity alone
    const currentPrice = Number(info.price) || 0;
    const total = Number(info.quantity);
    const hasLast =
      info.lastQuantity !== undefined && info.lastQuantity !== null && info.lastQuantity !== '';
    const remainingQty = hasLast ? Number(info.lastQuantity) : total;

    if (Math.abs(currentPrice - decision.targetPrice) <= 0.001) {
      logQuiet(
        `[autoBuy] buy ad already at ₦${currentPrice} (${fmt(remainingQty)} USDC left) — no price change needed`
      );
      return { ok: true, action: 'skipped', reason: 'no_price_change_needed' };
    }
    lastQuietMsg = null;

    // Bybit rejects any edit when remaining value is below the minimum order
    // (error 912120023). The ad is about to wind down, so leave it.
    const minOrderNgn = Number(info.minAmount) || config.autoBuy.minAmountNgn;
    const remainingValueNgn = remainingQty * decision.targetPrice;
    if (remainingValueNgn < minOrderNgn) {
      console.log(
        `[autoBuy] leaving ad as is: ${fmt(remainingQty)} USDC left (~₦${Math.floor(remainingValueNgn)}) is below the minimum order ₦${minOrderNgn}`
      );
      return { ok: true, action: 'skipped', reason: 'remaining_below_min_order' };
    }

    step = 'updateBuyAd(price)';
    const res = await updateBuyAd(buyAdId, info, decision.targetPrice, remainingQty, paymentIds);
    console.log(
      `[autoBuy] price changed ₦${currentPrice} → ₦${decision.targetPrice} (${fmt(remainingQty)} USDC left)`
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
    `[autoBuy] scheduler started (every ${config.autoBuy.pollSeconds}s, trigger < ${config.autoBuy.triggerBelowUsdc} USDC, target ${config.autoBuy.targetTotalUsdc} USDC)`
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