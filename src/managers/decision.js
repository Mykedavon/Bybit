// src/managers/decision.js
// Combines target prices with profit floor and current ad state.
// Returns one decision per ad: EDIT, SKIP, or BLOCK.

const { client } = require('../bybit/client');
const { fetchCompletedBuys, weightedAvgBuyPrice, profitFloor } = require('../bybit/orders');
const config = require('../config');

// ── Read current ad state ─────────────────────────────────
async function getAdState(adId) {
  const response = await client.getAdInfo(adId);
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

// ── Decide for one ad ─────────────────────────────────────
// Inputs:
//   adState: current ad from Bybit
//   target: { targetPrice, reason }
//   spendable: available USDC balance
//   floor: profit floor price
// Output:
//   { action: 'EDIT'|'SKIP'|'BLOCK', ... }
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

  // ── Check profit floor ────────────────────────────────
  if (floor !== null && target.targetPrice < floor) {
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
// Inputs:
//   sellCycleResult: output of sellManager.runSellCycle()
//   spendable: available USDC
// Output:
//   { ad1: decision, ad2: decision, floor, weightedAvg }
async function evaluateBothAds(sellCycleResult, spendable) {
  // Get profit floor
  const buys = await fetchCompletedBuys();
  const weightedAvg = weightedAvgBuyPrice(buys);
  const floor = profitFloor(weightedAvg);

  console.log(`[decision] weighted avg buy: ${weightedAvg ? weightedAvg.toFixed(2) : 'N/A'}`);
  console.log(`[decision] profit floor: ${floor ? floor.toFixed(2) : 'N/A'}`);

  // Read both ads
  const ad1State = await getAdState(config.ads.sellAd1Id);
  const ad2State = await getAdState(config.ads.sellAd2Id);

  // Decide
  const ad1Decision = decideForAd(ad1State, sellCycleResult.ad1, spendable, floor);
  const ad2Decision = decideForAd(ad2State, sellCycleResult.ad2, spendable, floor);

  return {
    ad1: ad1Decision,
    ad2: ad2Decision,
    floor,
    weightedAvg,
  };
}

module.exports = {
  getAdState,
  decideForAd,
  evaluateBothAds,
};