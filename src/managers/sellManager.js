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

// ── Optional: print the market list (set LOG_MARKET_ADS=true) ──
// Prints only when the list changes, so the console is not flooded.
let lastMarketSig = null;

function logMarketAds(marketAds) {
  const on = String(process.env.LOG_MARKET_ADS || '').toLowerCase() === 'true';
  if (!on) return;

  const myIds = [config.ads.sellAd1Id, config.ads.sellAd2Id].map(String);
  const rows = [...marketAds]
    .filter((ad) => Number.isFinite(Number(ad.price)))
    .sort((a, b) => Number(a.price) - Number(b.price))
    .slice(0, 10);

  const sig = rows.map((ad) => `${ad.id}:${ad.price}:${Math.round(Number(ad.quantity) || 0)}`).join('|');
  if (sig === lastMarketSig) return;
  lastMarketSig = sig;

  console.log('[market list] latest 10 sell ads (cheapest first):');
  rows.forEach((ad, i) => {
    const mine = myIds.includes(String(ad.id));
    const rate = Number(ad.completionRate);
    const ok =
      (Number(ad.completionRate) || 0) >= config.competitor.minCompletionRate &&
      (Number(ad.recentOrders) || 0) >= config.competitor.minOrders30d;
    console.log(
      `  ${String(i + 1).padStart(2)}. ₦${Number(ad.price).toFixed(2)} | ${String(Math.round(Number(ad.quantity) || 0)).padStart(5)} USDC | ` +
        `${mine ? 'YOUR AD' : (ad.nickName || 'unknown')}` +
        (mine ? '' : ` | ${Number.isFinite(rate) ? rate : '?'}% done, ${ad.recentOrders ?? '?'} orders${ok ? '' : ' (filtered out)'}`)
    );
  });
}

// ── Main cycle: fetch, filter, prepare candidates ────────
async function runSellCycle() {
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

  logMarketAds(marketAds);

  // Are our own ads in Bybit's market list? (Bybit hides ads priced too far below
  // the rest of the market; a hidden ad is missing from this list.)
  const listedIds = new Set(marketAds.map((ad) => String(ad.id)));
  const listedPrices = marketAds.map((ad) => Number(ad.price)).filter((n) => Number.isFinite(n));
  const visibility = {
    ad1: listedIds.has(String(config.ads.sellAd1Id)),
    ad2: listedIds.has(String(config.ads.sellAd2Id)),
    listedMax: listedPrices.length ? Math.max(...listedPrices) : 0,
  };

  // Exclude own ads
  const competitors = excludeOwnAds(marketAds);

  // Filter genuine competitors
  const genuine = competitors.filter(isGenuine);

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
    `[sell] ${competitors.length} competitors → ${genuine.length} genuine → ${bulkPool.length} bulk (≥ ${config.pricing.bulkMinQuantity} USDC) | ` +
      `your ads in market list: ad 1 ${visibility.ad1 ? 'yes' : 'NO'}, ad 2 ${visibility.ad2 ? 'yes' : 'NO'}`
  );

  const ad2Target = computeTarget(bulkPool);

  return {
    ok: true,
    visibility,

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