// src/managers/inventory.js
// Reads your Funding account USDC balance.
// spendable = free to use; onHold = locked in pending orders (e.g. open sell orders).

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

module.exports = { getSpendableUsdc, getUsdcBalances };