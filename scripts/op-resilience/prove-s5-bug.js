// Root-cause proof for the §S5 blind spot in the V6.0 monitor.
//
// V6.0 checkS5 did:   mp.activeLoanCount(agent.agentWallet)   // an ADDRESS
// V6.1 declares:      mapping(uint256 => uint256) activeLoanCount   // keyed by agentId
//
// ethers coerces the address into a uint256, so the call reads the slot for
// agentId == uint256(address) — a number no agent will ever have. It returns 0
// every time, for every agent, no matter how corrupt the real counter is. The
// check could not fail.
//
// Usage: npx hardhat run --network localhost scripts/op-resilience/prove-s5-bug.js

const { ethers } = require('hardhat');
const fs = require('fs');
const path = require('path');
const S = require('./storage');

async function main() {
    const ROOT = path.resolve(__dirname, '..', '..');
    const addr = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/config/local-addresses.json')));
    const v6 = await ethers.getContractAt('AgentLiquidityMarketplaceV6', addr.agentLiquidityMarketplace_v6);
    const agentId = BigInt(addr._testAccounts.agentAId);
    const wallet = addr._testAccounts.agentA;

    const snap = await ethers.provider.send('evm_snapshot', []);
    // Engineer the exact §S5 failure the check exists to catch.
    await S.setStorage(addr.agentLiquidityMarketplace_v6, S.mapSlot(agentId, S.SLOT.activeLoanCount), 47);

    const byId = await v6.activeLoanCount(agentId);
    const byAddress = await v6.activeLoanCount(wallet);   // what V6.0's monitor did
    const cap = await v6.MAX_ACTIVE_LOANS_PER_AGENT();

    console.log(JSON.stringify({
        agentId: agentId.toString(),
        agentWallet: wallet,
        addressCoercedToUint256: BigInt(wallet).toString(),
        cap: Number(cap),
        'activeLoanCount(agentId)  [truth]': Number(byId),
        'activeLoanCount(wallet)   [what V6.0 read]': Number(byAddress),
        'V6.0 would have flagged?': Number(byAddress) > Number(cap),
        'V6.1 flags?': Number(byId) > Number(cap),
    }, null, 2));

    await ethers.provider.send('evm_revert', [snap]);
}
main().catch(e => { console.error(e); process.exit(1); });
