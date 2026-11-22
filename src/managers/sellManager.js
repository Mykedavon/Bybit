// src/managers/sellManager.js
// The sell-side decision maker.
// Fetches market, filters genuine competitors, computes target prices,
// applies profit floor, and returns a decision for each ad.
// Does NOT call updateAd directly — the caller (index.js) will do that.

const { client } = require('../bybit/client');
const { fetchLiveSellAds } = require('../bybit/market');
const config = require('../config');

// ── Filter: is this ad from a genuine competitor? ─────────
function isGenuine(ad) {
  const rate = Number(ad.completionRate) || 0;
  const orders = Number(ad.recentOrders) || 0;
  return rate >= config.competitor.minCompletionRate &&
         orders >= config.competitor.minOrders30d;
}

// ── Exclude your own ads from the competitor list ─────────
function excludeOwnAds(ads) {
  const myIds = [config.ads.sellAd1Id, config.ads.sellAd2Id];
  return ads.filter((ad) => !myIds.includes(String(ad.id)));
}

// ── Find the cheapest among a filtered list ───────────────
function findCheapest(ads) {
  if (ads.length === 0) return null;
  return ads.reduce((min, ad) =>
    Number(ad.price) < Number(min.price) ? ad : min
  );
}

// ── Compute target price for one ad ───────────────────────
// Returns { targetPrice, cheapest, reason }
function computeTarget(competitorPool) {
  const cheapest = findCheapest(competitorPool);
  if (!cheapest) {
    return { targetPrice: null, reason: 'no_genuine_competitor' };
  }
  const target = Number(cheapest.price) - config.pricing.undercutNgn;
  return {
    targetPrice: Number(target.toFixed(2)),
    cheapest: {
      price: Number(cheapest.price),
      nickName: cheapest.nickName || 'unknown',
      quantity: Number(cheapest.quantity) || 0,
    },
    reason: 'ok',
  };
}

// ── Main cycle: fetch, filter, decide ─────────────────────
async function runSellCycle() {
  console.log('[sell] cycle started');

  let marketAds;
  try {
    marketAds = await fetchLiveSellAds();
  } catch (err) {
    return { ok: false, reason: 'market_fetch_failed', error: err.message };
  }

  if (!marketAds || marketAds.length === 0) {
    return { ok: false, reason: 'no_ads_returned' };
  }

  // Exclude own ads
  const competitors = excludeOwnAds(marketAds);
  console.log(`[sell] ${competitors.length} competitors after excluding own ads`);

  // Filter genuine
  const genuine = competitors.filter(isGenuine);
  console.log(`[sell] ${genuine.length} genuine competitors after filter`);

  if (genuine.length === 0) {
    return { ok: false, reason: 'no_genuine_competitor' };
  }

  // ── Ad 1: general market ──────────────────────────────
  const ad1Target = computeTarget(genuine);

  // ── Ad 2: bulk market (filter by quantity) ────────────
  const bulkPool = genuine.filter(
    (ad) => Number(ad.quantity) >= config.pricing.bulkMinQuantity
  );
  console.log(`[sell] ${bulkPool.length} bulk competitors (>= ${config.pricing.bulkMinQuantity} USDC)`);
  const ad2Target = computeTarget(bulkPool);

  return {
    ok: true,
    ad1: {
      adId: config.ads.sellAd1Id,
      ...ad1Target,
    },
    ad2: {
      adId: config.ads.sellAd2Id,
      ...ad2Target,
    },
  };
}

module.exports = {
  isGenuine,
  excludeOwnAds,
  findCheapest,
  computeTarget,
  runSellCycle,
};