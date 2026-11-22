// src/managers/executor.js
// Takes decisions from decision.js and applies them to Bybit.
// Read-modify-write with verify-after-write.
// DRY_RUN=true (default): logs what would be sent, never edits an ad.

const { client } = require('../bybit/client');
const { getAdState } = require('./decision');
const config = require('../config');

// ── Edit throttle tracking ────────────────────────────────
// Bybit: max 10 edits per 5 minutes per ad.
const editLog = new Map(); // adId -> [timestamps]

function canEdit(adId) {
  const now = Date.now();
  const windowStart = now - 5 * 60 * 1000;
  const history = (editLog.get(adId) || []).filter((t) => t > windowStart);

  if (history.length >= 10) {
    return { allowed: false, countInWindow: history.length };
  }
  return { allowed: true, countInWindow: history.length };
}

function recordEdit(adId) {
  const history = editLog.get(adId) || [];
  history.push(Date.now());
  editLog.set(adId, history);
}

// ── Apply one edit ────────────────────────────────────────
async function applyEdit(adState, newPrice, newQuantity, priceChanged, quantityChanged) {
  const adId = adState.id;

  // Rate limit check
  const rate = canEdit(adId);
  if (!rate.allowed) {
    return {
      ok: false,
      adId,
      reason: 'rate_limit',
      countInWindow: rate.countInWindow,
    };
  }

  // Sanity guard: refuse large single-step price moves
  if (priceChanged && adState.price > 0) {
    const movePct = (Math.abs(newPrice - adState.price) / adState.price) * 100;
    if (movePct > config.safety.maxPriceMovePct) {
      console.error(
        `[executor] REFUSED ad ${adId}: price ${adState.price} -> ${newPrice} ` +
        `is a ${movePct.toFixed(2)}% move (limit ${config.safety.maxPriceMovePct}%)`
      );
      return { ok: false, adId, reason: 'price_move_too_large' };
    }
  }

  // Build full parameter set (Bybit requires all fields on update)
  const params = {
    id: adId,
    priceType: adState.priceType ? String(adState.priceType) : '0',
    premium: adState.premium || '',
    price: priceChanged ? String(newPrice) : String(adState.price),
    quantity: quantityChanged ? String(newQuantity) : String(adState.quantity),
    minAmount: String(adState.minAmount),
    maxAmount: String(adState.maxAmount),
    remark: adState.remark || '',
    tradingPreferenceSet: adState.tradingPreferenceSet || {},
    paymentIds: adState.payments || [],
    actionType: 'MODIFY',
    paymentPeriod: String(adState.paymentPeriod || '15'),
  };

  // Dry run: show exactly what would be sent, then stop
  if (config.dryRun) {
    console.log(
      `[executor] DRY_RUN — would update ad ${adId}: ` +
      `price ${adState.price} -> ${params.price}, ` +
      `quantity ${adState.quantity} -> ${params.quantity}`
    );
    console.log('[executor] DRY_RUN params:', JSON.stringify(params));
    return { ok: true, adId, action: 'dry_run', newPrice, newQuantity };
  }

  try {
    const res = await client.updateAd(params);
    const code = res && (res.ret_code ?? res.retCode);
    if (code !== undefined && code !== 0) {
      const msg = res.ret_msg ?? res.retMsg ?? '';
      console.error(`[executor] updateAd rejected for ad ${adId}: ${code} ${msg}`);
      return { ok: false, adId, reason: 'update_failed', error: `${code} ${msg}` };
    }
    recordEdit(adId);
  } catch (err) {
    console.error(`[executor] updateAd failed for ad ${adId}:`, err.message);
    return { ok: false, adId, reason: 'update_failed', error: err.message };
  }

  // Verify
  let after;
  try {
    after = await getAdState(adId);
  } catch (err) {
    return { ok: false, adId, reason: 'verify_fetch_failed', error: err.message };
  }

  const priceOk = !priceChanged || Math.abs(after.price - newPrice) < 0.001;
  const qtyOk = !quantityChanged || Math.abs(after.quantity - newQuantity) < 0.001;

  if (!priceOk || !qtyOk) {
    return {
      ok: false,
      adId,
      reason: 'verify_failed',
      expected: { price: newPrice, quantity: newQuantity },
      actual: { price: after.price, quantity: after.quantity },
    };
  }

  return {
    ok: true,
    adId,
    action: priceChanged && quantityChanged ? 'price_and_quantity'
          : priceChanged ? 'price_only'
          : 'quantity_only',
    newPrice: after.price,
    newQuantity: after.quantity,
  };
}

// ── Apply a decision ──────────────────────────────────────
async function applyDecision(decision, adState) {
  if (decision.action === 'SKIP') {
    return { ok: true, adId: decision.adId, action: 'skipped', reason: decision.reason };
  }

  if (decision.action === 'BLOCK') {
    return {
      ok: true,
      adId: decision.adId,
      action: 'blocked',
      reason: decision.reason,
      targetPrice: decision.targetPrice,
      floor: decision.floor,
      shortfall: decision.shortfall,
    };
  }

  if (decision.action === 'EDIT') {
    return applyEdit(
      adState,
      decision.newPrice,
      decision.newQuantity,
      decision.priceChanged,
      decision.quantityChanged
    );
  }

  return { ok: false, adId: decision.adId, reason: 'unknown_action' };
}

module.exports = {
  canEdit,
  recordEdit,
  applyEdit,
  applyDecision,
};