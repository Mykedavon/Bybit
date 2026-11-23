
 // src/managers/sellManager.js
// The sell-side decision maker.
// Fetches live market ads, filters genuine competitors, and returns
// ranked targets for Ad 1 (general market) and Ad 2 (bulk market).
// Safety-floor selection is handled by decision.js.

const { fetchLiveSellAds } = require('../bybit/market');
const config = require('../config');

// ── Filter: is this ad from a genuine competitor? ─────────
function isGenuine(ad) {
  const price = Number(ad.price);
  const rate = Number(ad.completionRate) || 0;
  const orders = Number(ad.recentOrders) || 0;

  return Number.isFinite(price) &&
    price > 0 &&
    rate >= config.competitor.minCompletionRate &&
    orders >= config.competitor.minOrders30d;
}

// ── Exclude your own ads from the competitor list ─────────
function excludeOwnAds(ads) {
  const myIds = [config.ads.sellAd1Id, config.ads.sellAd2Id]
    .filter(Boolean)
    .map(String);

  return ads.filter((ad) => !myIds.includes(String(ad.id)));
}

// ── Sort competitors from cheapest to most expensive ──────
function sortByPrice(ads) {
  return ads
    .filter((ad) => Number.isFinite(Number(ad.price)) && Number(ad.price) > 0)
    .sort((a, b) => Number(a.price) - Number(b.price));
}

// ── Build ranked undercut targets ─────────────────────────
function buildCandidates(competitorPool) {
  return sortByPrice(competitorPool).map((ad) => {
    const targetPrice = Number(
      (Number(ad.price) - config.pricing.undercutNgn).toFixed(2)
    );

    return {
      targetPrice,
      competitor: {
        price: Number(ad.price),
        nickName: ad.nickName || 'unknown',
        quantity: Number(ad.quantity) || 0,
      },
    };
  });
}

// ── Legacy-style initial target (lowest competitor) ──────
function computeTarget(competitorPool) {
  const candidates = buildCandidates(competitorPool);
  if (candidates.length === 0) {
    return {
      targetPrice: null,
      candidates: [],
      reason: 'no_genuine_competitor',
    };
  }

  const first = candidates[0];

  return {
    targetPrice: first.targetPrice,
    cheapest: first.competitor,
    candidates,
    reason: 'ok',
  };
}

// ── Main cycle: fetch, filter, prepare candidates ────────
async function runSellCycle() {
  console.log('[sell] cycle started');

  let marketAds;
  try {
    marketAds = await fetchLiveSellAds();
  } catch (err) {
    return {
      ok: false,
      reason: 'market_fetch_failed',
      error: err.message,
    };
  }

  if (!marketAds || marketAds.length === 0) {
    return { ok: false, reason: 'no_ads_returned' };
  }

  // Exclude own ads
  const competitors = excludeOwnAds(marketAds);
  console.log(`[sell] ${competitors.length} competitors after excluding own ads`);

  // Filter genuine competitors
  const genuine = competitors.filter(isGenuine);
  console.log(`[sell] ${genuine.length} genuine competitors after filter`);

  if (genuine.length === 0) {
    return { ok: false, reason: 'no_genuine_competitor' };
  }

  // ── Ad 1: general market ──────────────────────────────
  const ad1Target = computeTarget(genuine);

  // ── Ad 2: bulk market ────────────────────────────────
  const bulkPool = genuine.filter(
    (ad) => Number(ad.quantity) >= config.pricing.bulkMinQuantity
  );

  console.log(
    `[sell] ${bulkPool.length} bulk competitors (>= ${config.pricing.bulkMinQuantity} USDC)`
  );

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
  sortByPrice,
  buildCandidates,
  computeTarget,
  runSellCycle,
};
