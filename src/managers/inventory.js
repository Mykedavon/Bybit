// src/managers/inventory.js
// Reads your Funding account USDC balance and pending buy-order USDC.
// spendable = free to use; onHold = locked in pending orders (e.g. open sell orders).
// getPendingBuyIncomingUsdc = USDC still on its way to you from open buy orders.

const { client } = require('../bybit/client');
const config = require('../config');

async function getUsdcBalances() {
  const raw = await client.getWalletBalance('FUND');
  const result = raw.result || raw;

  // Bybit returns either .balance or .list depending on version
  const coins = result.balance || result.list || result.coins || [];

  const usdc = coins.find((c) => c.coin === config.market.coin);
  if (!usdc) {
    console.log(`[inventory] no ${config.market.coin} found in Funding account`);
    return { spendable: 0, onHold: 0, total: 0 };
  }

  // transferBalance = spendable (not frozen)
  // walletBalance = total (includes frozen)
  const spendable = Number(usdc.transferBalance) || 0;
  const walletTotal = Number(usdc.walletBalance);
  const total = Number.isFinite(walletTotal) && walletTotal >= spendable ? walletTotal : spendable;
  const onHold = Number((total - spendable).toFixed(6));

  return { spendable, onHold, total };
}

async function getSpendableUsdc() {
  const { spendable } = await getUsdcBalances();

  console.log(`[inventory] spendable ${config.market.coin}: ${spendable}`);

  return spendable;
}

// Order statuses where the trade is still open (coins not yet in your wallet):
// 5 waiting for chain, 10 waiting for payment, 20 waiting for release,
// 30 appealing, 60 paying, 100 objectioning, 110 waiting to raise an objection
const OPEN_BUY_STATUSES = new Set(['5', '10', '20', '30', '60', '100', '110']);

async function getPendingBuyIncomingUsdc() {
  const response = await client.getMyOrders({
    side: '0', // 0 = buy orders
    page: '1',
    size: '30',
  });

  const code = response && (response.ret_code ?? response.retCode);
  if (code !== undefined && code !== 0) {
    throw new Error(`${response.ret_msg ?? response.retMsg ?? 'error'} (ErrCode: ${code})`);
  }

  const result = response.result || response;
  const items = result.items || [];

  let incoming = 0;
  for (const o of items) {
    if (o.tokenId !== config.market.coin) continue;
    if (!OPEN_BUY_STATUSES.has(String(o.status))) continue;

    // notifyTokenQuantity = coin quantity. Fallback: amount is fiat when it is
    // much bigger than the price, otherwise it is already the coin quantity.
    let qty = Number(o.notifyTokenQuantity);
    if (!Number.isFinite(qty) || qty <= 0) {
      const amount = Number(o.amount) || 0;
      const price = Number(o.price) || 0;
      qty = price > 0 && amount > price ? amount / price : amount;
    }
    incoming += qty;
  }

  return Number(incoming.toFixed(6));
}

module.exports = { getSpendableUsdc, getUsdcBalances, getPendingBuyIncomingUsdc };