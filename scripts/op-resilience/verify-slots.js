// Sanity-check the storage slot map against the live local deployment.
// Usage: npx hardhat run --network localhost scripts/op-resilience/verify-slots.js
const { ethers } = require('hardhat');
const fs = require('fs');
const path = require('path');
const { verifySlots } = require('./storage');

async function main() {
    const ADDR = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../src/config/local-addresses.json')));
    const v6 = await ethers.getContractAt('AgentLiquidityMarketplaceV6', ADDR.agentLiquidityMarketplace_v6);
    const checks = await verifySlots(v6, BigInt(ADDR._testAccounts.agentAId), ADDR._testAccounts.lender1);
    console.log('All slots verified:', checks.length);
    for (const c of checks) console.log(' ', c.name, '=', c.want);
}
main().catch(e => { console.error(e.message); process.exit(1); });
