// src/managers/executor.js
// Takes decisions from decision.js and applies them to Bybit.
// Read-modify-write with verify-after-write.
// DRY_RUN=true: logs what would be sent, never edits an ad.
//
// Bybit answers "Request parameter error" (10001) without naming the field,
// so updates are tried as a short ladder of safe parameter variants
// (see buildParams). The variant that works is remembered per ad.

const { client } = require('../bybit/client');
const { p2pPost } = require('../bybit/p2pRaw');
const { getAdState } = require('./decision');
const config = require('../config');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const floor2 = (n) => Math.floor(Number(n) * 100) / 100;

const LAST_VARIANT = 3;
const PARAM_ERROR_COOLDOWN_MS = 5 * 60 * 1000;

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

// ── Per-ad memory ─────────────────────────────────────────
const workingVariant = new Map(); // adId -> variant that last succeeded
const cooldownUntil = new Map();  // adId -> timestamp
const originalMax = new Map();    // adId -> max order amount first seen

function normalizePrefs(prefs) {
  const out = {};
  for (const [k, v] of Object.entries(prefs || {})) {
    if (v === null || v === undefined) continue;
    out[k] = String(v);
  }
  return out;
}

// ── Build the update request for a given variant ──────────
function buildParams(variant, adState, price, quantity) {
  const adId = adState.id;
  if (!originalMax.has(adId)) originalMax.set(adId, Number(adState.maxAmount));

  const params = {
    id: adId,
    priceType: adState.priceType ? String(adState.priceType) : '0',
    premium: adState.premium || '',
    price: String(price),
    quantity: String(quantity),
    minAmount: String(adState.minAmount),
    maxAmount: String(adState.maxAmount),
    remark: adState.remark || '',
    tradingPreferenceSet: adState.tradingPreferenceSet || {},
    paymentIds: adState.payments || [],
    actionType: 'MODIFY',
    paymentPeriod: String(adState.paymentPeriod || '15'),
  };

  if (variant >= 1) {
    if (params.priceType === '0') params.premium = '';
    params.tradingPreferenceSet = normalizePrefs(params.tradingPreferenceSet);
  }

  if (variant >= 2) {
    params.quantity = String(floor2(quantity));
  }

  if (variant >= 3) {
    // The max order amount cannot exceed what the ad can actually fill,
    // and is never raised above the original value.
    const fillable = Math.floor(Number(price) * floor2(quantity));
    const ceiling = Number.isFinite(originalMax.get(adId)) ? originalMax.get(adId) : fillable;
    params.maxAmount = String(Math.min(ceiling, fillable));
  }

  return params;
}

// ── Send one update, retrying only on rate limits (10006) ─
async function sendUpdate(adId, params) {
  const attempts = 4;
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await client.updateAd(params);
      const code = res && (res.ret_code ?? res.retCode);
      if (code === 10006 && i < attempts) {
        console.log(`[executor] ad ${adId} rate limited, retry ${i}/${attempts - 1} in ${3 * i}s`);
        await sleep(3000 * i);
        continue;
      }
      if (code !== undefined && code !== 0) {
        throw new Error(`${res.ret_msg ?? res.retMsg ?? 'error'} (ErrCode: ${code})`);
      }
      return;
    } catch (err) {
      const limited = String(err.message || '').includes('10006');
      if (!limited || i === attempts) throw err;
      console.log(`[executor] ad ${adId} rate limited (thrown), retry ${i}/${attempts - 1} in ${3 * i}s`);
      await sleep(3000 * i);
    }
  }
}

// ── Diagnostics after a parameter error ───────────────────
async function dumpDiagnostics(adId, params) {
  console.error('[executor] DIAG request sent:', JSON.stringify(params));
  try {
    const info = await p2pPost('/v5/p2p/item/info', { itemId: adId });
    const d = info.item || info;
    const keys = [
      'id', 'status', 'isOnline', 'itemType', 'priceType', 'price', 'premium',
      'quantity', 'lastQuantity', 'frozenQuantity', 'executedQuantity',
      'minAmount', 'maxAmount', 'paymentPeriod',
    ];
    const picked = {};
    keys.forEach((k) => { picked[k] = d[k]; });
    console.error('[executor] DIAG ad state on Bybit:', JSON.stringify(picked));
  } catch (err) {
    console.error('[executor] DIAG could not read ad info:', err.message);
  }
}

// ── Apply one edit ────────────────────────────────────────
async function applyEdit(adState, newPrice, newQuantity, priceChanged, quantityChanged) {
  const adId = adState.id;

  // Cooling down after a parameter error
  if (Date.now() < (cooldownUntil.get(adId) || 0)) {
    return { ok: false, adId, reason: 'cooldown_after_error' };
  }

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

  const price = priceChanged ? newPrice : adState.price;
  const quantity = quantityChanged ? newQuantity : adState.quantity;
  const startVariant = workingVariant.get(adId) || 0;

  // Dry run: show exactly what would be sent, then stop
  if (config.dryRun) {
    const params = buildParams(startVariant, adState, price, quantity);
    console.log(
      `[executor] DRY_RUN — would update ad ${adId}: ` +
      `price ${adState.price} -> ${params.price}, ` +
      `quantity ${adState.quantity} -> ${params.quantity}`
    );
    console.log('[executor] DRY_RUN params:', JSON.stringify(params));
    return { ok: true, adId, action: 'dry_run', newPrice, newQuantity };
  }

  // Try the variants, starting from the one that worked last time
  let sent = null;
  let lastErr = null;
  let lastParams = null;

  for (let v = startVariant; v <= LAST_VARIANT; v++) {
    const params = buildParams(v, adState, price, quantity);

    // Variant 3 only makes sense if the ad can still fill its minimum order
    if (v === LAST_VARIANT && Number(params.maxAmount) < Number(adState.minAmount)) break;

    lastParams = params;
    try {
      await sendUpdate(adId, params);
      recordEdit(adId);
      workingVariant.set(adId, v);
      sent = params;
      console.log(`[executor] ad ${adId} updated (variant ${v})`);
      break;
    } catch (err) {
      lastErr = err;
      console.error(`[executor] updateAd failed for ad ${adId} (variant ${v}): ${err.message}`);
      // Only a parameter error is worth trying another variant for
      if (!String(err.message || '').includes('10001')) break;
    }
  }

  if (!sent) {
    if (lastErr && String(lastErr.message || '').includes('10001')) {
      cooldownUntil.set(adId, Date.now() + PARAM_ERROR_COOLDOWN_MS);
      console.error(`[executor] ad ${adId}: all variants rejected — pausing edits for 5 minutes`);
      await dumpDiagnostics(adId, lastParams);
    }
    return {
      ok: false,
      adId,
      reason: 'update_failed',
      error: lastErr ? lastErr.message : 'no_variant_applicable',
    };
  }

  // Verify
  let after;
  try {
    after = await getAdState(adId);
  } catch (err) {
    return { ok: false, adId, reason: 'verify_fetch_failed', error: err.message };
  }

  const sentQty = Number(sent.quantity);
  const priceOk = !priceChanged || Math.abs(after.price - newPrice) < 0.001;
  const qtyOk = !quantityChanged || Math.abs(after.quantity - sentQty) < 0.001;

  if (!priceOk || !qtyOk) {
    return {
      ok: false,
      adId,
      reason: 'verify_failed',
      expected: { price: newPrice, quantity: sentQty },
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