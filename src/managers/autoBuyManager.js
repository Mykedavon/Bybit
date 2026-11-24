// src/managers/autoBuyManager.js
// Monitors spendable USDC and manages BUY_AD_1_ID:
// - "Owned" USDC = spendable + USDC on hold in pending sell orders.
//   Wanted buy quantity = AUTO_BUY_TARGET_USDC - owned (recalculated every cycle).
// - When owned < AUTO_BUY_TRIGGER_USDC and the buy ad is offline, or online but
//   stuck below the minimum order, it edits the ad (price from the buy market,
//   wanted quantity) and makes sure it is online (MODIFY for a stuck online ad,
//   ACTIVE relist for an offline one).
// - While the ad is online, every cycle it re-syncs BOTH the price and the quantity
//   (so a cancelled or new sell order is reflected). Bybit takes the ad offline by
//   itself when the remaining value drops below the minimum order.
// - The bot never changes your order limits (min/max): it sends them back as they are.
// - Competitors: reliable traders with enough USDC whose limits cover
//   AUTO_BUY_FILTER_FIAT_NGN. Bids #1 + step when the top 3 are tight, else #2 + step.

const { client } = require('../bybit/client');
const { fetchLiveBuyAds } = require('../bybit/market');
const { scheduleP2P } = require('../bybit/p2pRaw');
const { getUsdcBalances } = require('./inventory');
const config = require('../config');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const floor2 = (n) => Math.floor(Number(n) * 100 + 1e-9) / 100;
const fmt = (n) => (Number.isFinite(Number(n)) ? Number(n).toFixed(2) : 'n/a');

const STATUS_LABEL = { 10: 'online', 20: 'offline', 30: 'completed' };

// Quantity changes smaller than this (USDC) are not worth an edit
const QTY_TOLERANCE = 0.5;

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
// Order limits (minAmount / maxAmount) are sent back exactly as they are on Bybit,
// so the bot only ever changes the price and the quantity.
async function updateBuyAd(adId, info, price, quantity, paymentIds, actionType = 'MODIFY') {
  const cleanQty = floor2(quantity);
  const hasLimit = (v) => v !== undefined && v !== null && v !== '' && Number(v) > 0;
  const minAmount = hasLimit(info.minAmount) ? String(info.minAmount) : String(config.autoBuy.minAmountNgn);
  const maxAmount = hasLimit(info.maxAmount) ? String(info.maxAmount) : String(config.autoBuy.maxAmountNgn);

  const params = {
    id: String(adId),
    priceType: info.priceType ? String(info.priceType) : '0',
    premium: '',
    price: String(price),
    quantity: String(cleanQty),
    minAmount,
    maxAmount,
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
    step = 'getUsdcBalances';
    const { spendable, onHold } = await getUsdcBalances();
    const owned = spendable + onHold; // USDC you hold, including pending sell orders
    const desiredQty = floor2(Math.max(0, config.autoBuy.targetTotalUsdc - owned));

    step = `fetchBuyAdInfo(${buyAdId})`;
    const info = await fetchBuyAdInfo(buyAdId);
    const status = Number(info.status);
    const online = status === 10; // 10 = online, 20 = offline, 30 = completed
    const trigger = config.autoBuy.triggerBelowUsdc;

    // An "online" ad whose remaining value is below the minimum order is dead:
    // treat it like an offline ad so it gets reposted when the trigger hits.
    const remainingNow = Number(info.lastQuantity ?? info.quantity) || 0;
    const minOrderNow = Number(info.minAmount) || config.autoBuy.minAmountNgn;
    const stuck = online && remainingNow * (Number(info.price) || 0) < minOrderNow;
    const needsPost = !online || stuck;

    console.log(
      `[autoBuy] USDC: spendable ${fmt(spendable)} + on hold ${fmt(onHold)} = ${fmt(owned)} | ` +
        `wanted buy qty ${config.autoBuy.targetTotalUsdc} - ${fmt(owned)} = ${fmt(desiredQty)} | trigger < ${trigger}`
    );
    console.log(
      `[autoBuy] buy ad ${STATUS_LABEL[status] || `status ${status}`}${stuck ? ' [below minimum order]' : ''} ` +
        `(price ${fmt(info.price)}, left ${fmt(info.lastQuantity ?? info.quantity)} USDC)`
    );

    // Needs posting but you already own enough USDC → nothing to do.
    if (needsPost && owned >= trigger) {
      logQuiet(
        `[autoBuy] idle: owned ${fmt(owned)} is not below ${trigger} and the buy ad is ${stuck ? 'below the minimum order' : 'offline'}`
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

    const lowQty = genuine.filter(
      (ad) => (Number(ad.lastQuantity ?? ad.quantity) || 0) < config.autoBuy.minCompetitorQtyUsdc
    ).length;
    const rangeOut = genuine.length - matched.length - lowQty;
    console.log(
      `[autoBuy] market: ${marketBuyAds.length} ads, ${genuine.length} genuine, ${matched.length} usable ` +
        `(${lowQty} under ${config.autoBuy.minCompetitorQtyUsdc} USDC, ${rangeOut} range excludes ₦${config.autoBuy.filterFiatNgn}) | ` +
        `top usable: ${decision.topPrices.join(', ')} | avg ${decision.avgTop10}`
    );
    console.log(
      `[autoBuy] target ₦${decision.targetPrice}: ${decision.reason} (+${config.autoBuy.outbidStepNgn})`
    );

    step = 'extractPaymentIds';
    const paymentIds = extractPaymentIds(buyAdId, info);

    // Case 1: ad offline (or stuck below the minimum order) and spendable below
    // trigger → edit it and make sure it is online
    if (needsPost) {
      const buyQty = desiredQty;
      const minFillUsdc =
        Number(info.minAmount || config.autoBuy.minAmountNgn) / decision.targetPrice;

      if (buyQty <= 0 || buyQty < minFillUsdc) {
        console.log(
          `[autoBuy] not posting: quantity ${fmt(buyQty)} USDC is below the minimum order (${fmt(minFillUsdc)} USDC)`
        );
        return { ok: true, action: 'skipped', reason: 'qty_below_min_limit' };
      }

      console.log(
        `[autoBuy] posting buy ad: ${config.autoBuy.targetTotalUsdc} target - ${fmt(owned)} owned = ${fmt(buyQty)} USDC @ ₦${decision.targetPrice}`
      );

      step = 'updateBuyAd(post)';
      // Online but stuck below the minimum order → edit quantity/price (MODIFY).
      // Offline → relist (ACTIVE). If the first one fails, try the other.
      const firstAction = online ? 'MODIFY' : 'ACTIVE';
      const otherAction = online ? 'ACTIVE' : 'MODIFY';
      let lastAction = firstAction;
      console.log(
        `[autoBuy] sending ${firstAction} (${online ? 'ad is online but below the minimum order' : 'ad is offline'})`
      );

      let res;
      try {
        res = await updateBuyAd(buyAdId, info, decision.targetPrice, buyQty, paymentIds, firstAction);
      } catch (err) {
        console.log(`[autoBuy] ${firstAction} failed (${err.message}) — trying ${otherAction}`);
        lastAction = otherAction;
        res = await updateBuyAd(buyAdId, info, decision.targetPrice, buyQty, paymentIds, otherAction);
      }

      step = 'confirm(post)';
      let after = await fetchBuyAdInfo(buyAdId);
      if (Number(after.status) !== 10 && lastAction === 'MODIFY') {
        console.log('[autoBuy] ad is still not online after the edit — relisting with ACTIVE');
        await updateBuyAd(buyAdId, info, decision.targetPrice, buyQty, paymentIds, 'ACTIVE');
        after = await fetchBuyAdInfo(buyAdId);
      }
      const afterStatus = Number(after.status);
      console.log(
        `[autoBuy] after posting: ${STATUS_LABEL[afterStatus] || `status ${afterStatus}`} | ` +
          `price ${fmt(after.price)} | USDC left ${fmt(after.lastQuantity ?? after.quantity)} (ad total ${fmt(after.quantity)})` +
          (afterStatus === 10 ? ' — LIVE' : ' — NOT LIVE, check the ad on Bybit')
      );
      return res;
    }

    // Case 2: ad online → keep BOTH price and quantity in sync every cycle
    const currentPrice = Number(info.price) || 0;
    const total = Number(info.quantity);
    const hasLast =
      info.lastQuantity !== undefined && info.lastQuantity !== null && info.lastQuantity !== '';
    const remainingQty = hasLast ? Number(info.lastQuantity) : total;

    const minOrderNgn = Number(info.minAmount) || config.autoBuy.minAmountNgn;
    const priceSame = Math.abs(currentPrice - decision.targetPrice) <= 0.001;

    // Resize to the wanted quantity unless it would fall below the minimum order
    // (then the target is nearly reached and the ad is left to wind down).
    const canResize = desiredQty * decision.targetPrice >= minOrderNgn;
    const qtySame = Math.abs(remainingQty - desiredQty) < QTY_TOLERANCE;
    const newQty = canResize && !qtySame ? desiredQty : remainingQty;
    const qtyChanged = newQty !== remainingQty;

    if (!canResize && !qtySame) {
      logQuiet(
        `[autoBuy] wanted qty ${fmt(desiredQty)} USDC is below the minimum order — target nearly reached, leaving quantity at ${fmt(remainingQty)}`
      );
    }

    if (priceSame && !qtyChanged) {
      logQuiet(
        `[autoBuy] buy ad in sync: ₦${currentPrice}, ${fmt(remainingQty)} USDC (wanted ${fmt(desiredQty)}) — no edit needed`
      );
      return { ok: true, action: 'skipped', reason: 'in_sync' };
    }
    lastQuietMsg = null;

    // Bybit rejects any edit when the value is below the minimum order
    // (error 912120023). The ad is about to wind down, so leave it.
    if (newQty * decision.targetPrice < minOrderNgn) {
      console.log(
        `[autoBuy] leaving ad as is: ${fmt(newQty)} USDC (~₦${Math.floor(newQty * decision.targetPrice)}) is below the minimum order ₦${minOrderNgn}`
      );
      return { ok: true, action: 'skipped', reason: 'below_min_order' };
    }

    step = 'updateBuyAd(sync)';
    const res = await updateBuyAd(buyAdId, info, decision.targetPrice, newQty, paymentIds);
    const changes = [];
    if (!priceSame) changes.push(`price ₦${currentPrice} → ₦${decision.targetPrice}`);
    if (qtyChanged) {
      changes.push(
        `qty ${fmt(remainingQty)} → ${fmt(newQty)} USDC (${config.autoBuy.targetTotalUsdc} - ${fmt(owned)} owned)`
      );
    }
    console.log(`[autoBuy] buy ad updated: ${changes.join(', ')}`);
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