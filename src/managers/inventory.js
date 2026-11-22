// src/managers/inventory.js
// Reads your Funding account USDC balance.
// Returns spendable amount only (frozen excluded).

const { client } = require('../bybit/client');
const config = require('../config');

async function getSpendableUsdc() {
  const raw = await client.getWalletBalance('FUND');
  const result = raw.result || raw;

  // Bybit returns either .balance or .list depending on version
  const coins = result.balance || result.list || result.coins || [];

  const usdc = coins.find((c) => c.coin === config.market.coin);
  if (!usdc) {
    console.log(`[inventory] no ${config.market.coin} found in Funding account`);
    return 0;
  }

  // transferBalance = spendable (not frozen)
  // walletBalance = total (includes frozen)
  const spendable = Number(usdc.transferBalance) || 0;

  console.log(`[inventory] spendable ${config.market.coin}: ${spendable}`);

  return spendable;
}

module.exports = { getSpendableUsdc };