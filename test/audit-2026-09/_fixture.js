// Shared fixture for the 2026-09-19 internal audit PoCs.
// Deploys the EXACT Arc-mainnet stack (RegistryV2 + ReputationV3 + MarketplaceV6 +
// Faucet) with the LIVE launch config read back on-chain 2026-09-19:
//   bindBorrowToPoolCreator=true, minHold=86400, minSupply=1e6,
//   rate limit 20 pts/86400s, platformFee=100 bps, faucet cohort 100 / 10 USDC.
//
// CONVENTION: finding PoCs assert the SECURE property, so a FAILING test = CONFIRMED.
// `opts` lets a PoC relax the D1 levers (rateLimit/minHold = 0) purely to farm a
// reputation tier quickly when the tier itself, not the farming, is under test.

const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const USDC = (n) => ethers.parseUnits(n.toString(), 6);
const DAY = 24 * 60 * 60;

async function deployLaunchStack(opts = {}) {
    const signers = await ethers.getSigners();
    const [owner] = signers;
    const registry = await (await ethers.getContractFactory("AgentRegistryV2")).deploy();
    const reputation = await (await ethers.getContractFactory("ReputationManagerV3")).deploy(await registry.getAddress());
    const usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
    const v6 = await (await ethers.getContractFactory("AgentLiquidityMarketplaceV6")).deploy(
        await registry.getAddress(), await reputation.getAddress(), await usdc.getAddress());
    const faucet = await (await ethers.getContractFactory("AgentCreditFaucet")).deploy(
        await registry.getAddress(), await usdc.getAddress());
    await reputation.authorizePool(await v6.getAddress());

    // Live Arc-mainnet levers (verified on-chain 2026-09-19)
    await reputation.setReputationRateLimit(opts.rateLimit ?? 20, DAY);
    await v6.setMinHoldForReputationReward(opts.minHold ?? DAY);
    await v6.setPlatformFeeRate(100);
    await v6.setBindBorrowToPoolCreator(true);
    await v6.setMinSupplyAmount(USDC(1));
    await faucet.setMaxEligibleAgentId(100);
    await faucet.setClaimAmount(USDC(10));
    // NOTE: migrationFinalized is deliberately NOT set — matches live mainnet state.

    async function fund(w, amount = USDC(1_000_000)) {
        await usdc.mint(w.address, amount);
        await usdc.connect(w).approve(await v6.getAddress(), ethers.MaxUint256);
    }
    async function onboardAgent(w, uri = "ipfs://agent") {
        await registry.connect(w).register(uri, []);
        const id = await registry.addressToAgentId(w.address);
        await reputation.connect(w)["initializeReputation()"]();
        await v6.connect(w).createAgentPool();
        return id;
    }
    // Fixed-duration nominal interest, mirrors calculateInterest().
    function interestFor(principal, rateBps, days) {
        const annual = (principal * BigInt(rateBps)) / 10000n;
        return (annual * BigInt(days * DAY)) / BigInt(365 * DAY);
    }
    async function solvent(agentIds) {
        let sumAvail = 0n, sumColl = 0n;
        for (const aid of agentIds) sumAvail += (await v6.getAgentPool(aid)).availableLiquidity;
        const n = await v6.nextLoanId();
        for (let id = 1n; id < n; id++) {
            const l = await v6.loans(id);
            if (Number(l.state) === 1) sumColl += l.collateralAmount;
        }
        const bal = await usdc.balanceOf(await v6.getAddress());
        return { bal, rhs: sumAvail + (await v6.accumulatedFees()) + sumColl };
    }

    return { signers, owner, registry, reputation, usdc, v6, faucet, fund, onboardAgent, interestFor, solvent, USDC, DAY, time };
}

module.exports = { deployLaunchStack, USDC, DAY };
