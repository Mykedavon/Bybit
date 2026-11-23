// src/managers/executor.js
// Takes decisions from decision.js and applies them to Bybit.
// Read-modify-write with verify-after-write.
// DRY_RUN=true: logs what would be sent, never edits an ad.
//
// Bybit answers "Request parameter error" (10001) without naming the field,
// so updates use a short ladder of safe parameter variants (see buildParams).
// Payment method ids come from the ad's own paymentTerms (item info),
// because the "payments" list on an ad holds payment TYPE ids, which the
// update endpoint rejects (ErrCode 912300013).

const { client } = require('../bybit/client');
const { p2pPost } = require('../bybit/p2pRaw');
const { getAdState } = require('./decision');
const config = require('../config');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const floor2 = (n) => Math.floor(Number(n) * 100) / 100;

const FIRST_VARIANT = 1; // variant 0 (original format) is known to be rejected
const LAST_VARIANT = 3;
const ERROR_COOLDOWN_MS = 5 * 60 * 1000;
const PAYMENT_CACHE_MS = 10 * 60 * 1000;

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
const paymentCache = new Map();   // adId -> { ids, at }

// ── Retry on Bybit rate limit (ErrCode 10006) ─────────────
async function callWithRateRetry(label, fn, attempts = 4) {
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fn();
      const code = res && (res.ret_code ?? res.retCode);
      if (code === 10006 && i < attempts) {
        console.log(`[executor] ${label} rate limited, retry ${i}/${attempts - 1} in ${3 * i}s`);
        await sleep(3000 * i);
        continue;
      }
      return res;
    } catch (err) {
      const limited = String(err.message || '').includes('10006');
      if (!limited || i === attempts) throw err;
      console.log(`[executor] ${label} rate limited (thrown), retry ${i}/${attempts - 1} in ${3 * i}s`);
      await sleep(3000 * i);
    }
  }
}

// ── Payment method ids for this ad (from its own paymentTerms) ──
async function getPaymentIds(adId, force = false) {
  const cached = paymentCache.get(adId);
  if (!force && cached && Date.now() - cached.at < PAYMENT_CACHE_MS) return cached.ids;

  const info = await callWithRateRetry(`item info ${adId}`, () =>
    p2pPost('/v5/p2p/item/info', { itemId: adId })
  );
  const terms = Array.isArray(info.paymentTerms) ? info.paymentTerms : [];
  const ids = terms
    .map((t) => (t && t.id !== undefined && t.id !== null ? String(t.id) : ''))
    .filter(Boolean);

  if (ids.length === 0) {
    throw new Error('ad item info has no paymentTerms');
  }

  paymentCache.set(adId, { ids, at: Date.now() });
  console.log(
    `[executor] ad ${adId} payment methods: ` +
    terms.map((t) => `${t.id}(type ${t.paymentType})`).join(', ')
  );
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

// ── Build the update request for a given variant ──────────
function buildParams(variant, adState, price, quantity, paymentIds) {
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
    paymentIds,
    actionType: 'MODIFY',
    paymentPeriod: String(adState.paymentPeriod || '15'),
  };

  if (variant >= 1) {
    // Fixed price: blank premium; preference values as strings
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

// ── Send one update (retries only on rate limits) ─────────
async function sendUpdate(adId, params) {
  const res = await callWithRateRetry(`updateAd ${adId}`, () => client.updateAd(params));
  const code = res && (res.ret_code ?? res.retCode);
  if (code !== undefined && code !== 0) {
    throw new Error(`${res.ret_msg ?? res.retMsg ?? 'error'} (ErrCode: ${code})`);
  }
}

// ── Diagnostics after a rejected update ───────────────────
async function dumpDiagnostics(adId, params) {
  console.error('[executor] DIAG request sent:', JSON.stringify(params));
  try {
    const info = await p2pPost('/v5/p2p/item/info', { itemId: adId });
    const keys = [
      'id', 'status', 'isOnline', 'itemType', 'priceType', 'price', 'premium',
      'quantity', 'lastQuantity', 'frozenQuantity', 'executedQuantity',
      'minAmount', 'maxAmount', 'paymentPeriod', 'payments',
    ];
    const picked = {};
    keys.forEach((k) => { picked[k] = info[k]; });
    picked.paymentTerms = (info.paymentTerms || []).map((t) => `${t.id}(type ${t.paymentType})`);
    console.error('[executor] DIAG ad state on Bybit:', JSON.stringify(picked));
  } catch (err) {
    console.error('[executor] DIAG could not read ad info:', err.message);
  }
}

// ── Apply one edit ────────────────────────────────────────
async function applyEdit(adState, newPrice, newQuantity, priceChanged, quantityChanged) {
  const adId = adState.id;

  // Cooling down after a rejected request
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

  // The ad's own payment methods (never guessed)
  let paymentIds;
  try {
    paymentIds = await getPaymentIds(adId);
  } catch (err) {
    console.error(`[executor] ad ${adId}: cannot read payment methods: ${err.message}`);
    return { ok: false, adId, reason: 'payment_ids_unavailable', error: err.message };
  }

  let v = workingVariant.get(adId) ?? FIRST_VARIANT;

  // Dry run: show exactly what would be sent, then stop
  if (config.dryRun) {
    const params = buildParams(v, adState, price, quantity, paymentIds);
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
  let refreshedPayments = false;

  while (v <= LAST_VARIANT) {
    const params = buildParams(v, adState, price, quantity, paymentIds);

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
      const msg = String(err.message || '');
      console.error(`[executor] updateAd failed for ad ${adId} (variant ${v}): ${msg}`);

      // Payment method not found: re-read the ad's payment methods once, retry same variant
      if (msg.includes('912300013') && !refreshedPayments) {
        refreshedPayments = true;
        paymentCache.delete(adId);
        try {
          paymentIds = await getPaymentIds(adId, true);
        } catch (e) {
          lastErr = e;
          break;
        }
        continue;
      }

      // Parameter error: try the next variant
      if (msg.includes('10001')) {
        v += 1;
        continue;
      }

      break;
    }
  }

  if (!sent) {
    const msg = String((lastErr && lastErr.message) || '');
    if (msg.includes('10001') || msg.includes('912300013')) {
      cooldownUntil.set(adId, Date.now() + ERROR_COOLDOWN_MS);
      console.error(`[executor] ad ${adId}: request rejected — pausing edits for 5 minutes`);
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