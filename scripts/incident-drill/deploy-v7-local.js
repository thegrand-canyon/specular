// Deploy the REAL V7 stack (AgentRegistryV2 + ReputationManagerV4 +
// AgentLiquidityMarketplaceV62 + AgentCreditFaucet + MockUSDC) to a LOCAL hardhat
// node, at the lever values read live from Arc mainnet on 2026-09-23
// (scripts/incident-drill/read-live-levers.js), and build a baseline state the
// invariant monitor can be pointed at.
//
// Writes src/config/local-addresses.json, which is the file
// forensics/monitor/v6-invariants.js reads for V6_MONITOR_NETWORK=local. The
// marketplace goes under the key the monitor defaults to
// (`agentLiquidityMarketplace_v6`) so the monitor runs UNMODIFIED.
//
// Usage: npx hardhat run --network localhost scripts/incident-drill/deploy-v7-local.js

const { ethers } = require('hardhat');
const fs = require('fs');
const path = require('path');
const { USDC, DAY, advance, u } = require('./lib');

const ROOT = path.resolve(__dirname, '..', '..');

// Live Arc-mainnet levers, block 22287733, read 2026-09-23.
const LIVE = {
    platformFeeRate: 100,
    minSupplyAmount: USDC(10),
    minHoldForReputationReward: DAY,
    bindBorrowToPoolCreator: true,
    reputationRateLimit: [5, DAY],
    faucetClaimAmount: USDC(1),
    faucetMaxEligibleAgentId: 100,
};

async function main() {
    const signers = await ethers.getSigners();
    const [owner, agentA, agentB, lender1, lender2, lender3] = signers;

    const registry = await (await ethers.getContractFactory('AgentRegistryV2')).deploy();
    const rep = await (await ethers.getContractFactory('ReputationManagerV4')).deploy(await registry.getAddress());
    const usdc = await (await ethers.getContractFactory('MockUSDC')).deploy();
    const v6 = await (await ethers.getContractFactory('AgentLiquidityMarketplaceV62')).deploy(
        await registry.getAddress(), await rep.getAddress(), await usdc.getAddress());
    const faucet = await (await ethers.getContractFactory('AgentCreditFaucet')).deploy(
        await registry.getAddress(), await usdc.getAddress());

    await (await rep.authorizePool(await v6.getAddress())).wait();

    // Levers exactly as they are on Arc mainnet today.
    await (await v6.setPlatformFeeRate(LIVE.platformFeeRate)).wait();
    await (await v6.setMinSupplyAmount(LIVE.minSupplyAmount)).wait();
    await (await v6.setMinHoldForReputationReward(LIVE.minHoldForReputationReward)).wait();
    await (await v6.setBindBorrowToPoolCreator(LIVE.bindBorrowToPoolCreator)).wait();
    await (await rep.setReputationRateLimit(...LIVE.reputationRateLimit)).wait();
    await (await faucet.setClaimAmount(LIVE.faucetClaimAmount)).wait();
    await (await faucet.setMaxEligibleAgentId(LIVE.faucetMaxEligibleAgentId)).wait();
    // Mainnet has migrationFinalized == true (F-08 closed at deploy). Mirror it —
    // scenario 4 depends on seedPool/seedPosition being provably dead.
    await (await v6.setMigrationFinalized()).wait();
    await (await usdc.mint(await faucet.getAddress(), USDC(19))).wait();

    const fund = async (w, amt = USDC(2_000_000)) => {
        await (await usdc.mint(w.address, amt)).wait();
        await (await usdc.connect(w).approve(await v6.getAddress(), ethers.MaxUint256)).wait();
    };
    for (const w of signers.slice(0, 15)) await fund(w);

    const onboard = async w => {
        await (await registry.connect(w).register('ipfs://agent', [])).wait();
        const id = await registry.addressToAgentId(w.address);
        await (await rep.connect(w)['initializeReputation()']()).wait();
        await (await v6.connect(w).createAgentPool()).wait();
        return id;
    };
    const idA = await onboard(agentA);
    const idB = await onboard(agentB);

    // Third-party lenders (minSupplyAmount = 10 USDC gates a NEW slot).
    await (await v6.connect(lender1).supplyLiquidity(idA, USDC(5000))).wait();
    await (await v6.connect(lender2).supplyLiquidity(idA, USDC(3000))).wait();
    await (await v6.connect(lender3).supplyLiquidity(idB, USDC(2000))).wait();

    // Agent A: one loan taken and repaid on time (books interest + platform fees),
    // one left ACTIVE. Score 100 ⇒ tier 0 ⇒ 100 % collateral, ladder floor 100 USDC.
    await (await v6.connect(agentA).requestLoan(USDC(100), 7)).wait();     // loan 1
    await advance(7 * DAY - 900);
    await (await v6.connect(agentA).repayLoan(1)).wait();
    await (await v6.connect(agentA).requestLoan(USDC(100), 7)).wait();     // loan 2 -> ACTIVE
    // Agent B: one ACTIVE loan
    await (await v6.connect(agentB).requestLoan(USDC(100), 14)).wait();    // loan 3 -> ACTIVE

    const addresses = {
        network: 'local',
        chainId: 31337,
        rpcUrl: 'http://127.0.0.1:8545',
        agentRegistryV2: await registry.getAddress(),
        reputationManagerV4: await rep.getAddress(),
        // The monitor's default marketplace key — keep the name so v6-invariants.js
        // runs unmodified against the V6.2 deployment.
        agentLiquidityMarketplace_v6: await v6.getAddress(),
        agentLiquidityMarketplace_v62: await v6.getAddress(),
        agentCreditFaucet: await faucet.getAddress(),
        usdc: await usdc.getAddress(),
        deployer: owner.address,
        marketplaceVersion: await v6.VERSION(),
        reputationVersion: await rep.VERSION(),
        deployedAt: new Date().toISOString(),
        _levers: {
            platformFeeRate: Number(await v6.platformFeeRate()),
            minSupplyAmount: u(await v6.minSupplyAmount()),
            minHoldForReputationReward: Number(await v6.minHoldForReputationReward()),
            bindBorrowToPoolCreator: await v6.bindBorrowToPoolCreator(),
            migrationFinalized: await v6.migrationFinalized(),
            maxReputationGainPerWindow: Number(await rep.maxReputationGainPerWindow()),
            reputationGainWindow: Number(await rep.reputationGainWindow()),
            creditMultiple: Number(await rep.creditMultiple()),
            growthStep: u(await rep.growthStep()),
            bootstrapLimit: u(await rep.bootstrapLimit()),
            defaultLockout: Number(await rep.defaultLockout()),
            maxTierLimit: u(await rep.MAX_TIER_LIMIT()),
        },
        _testAccounts: {
            owner: owner.address,
            agentA: agentA.address, agentAId: idA.toString(),
            agentB: agentB.address, agentBId: idB.toString(),
            lender1: lender1.address, lender2: lender2.address, lender3: lender3.address,
        },
    };
    fs.writeFileSync(path.join(ROOT, 'src/config/local-addresses.json'), JSON.stringify(addresses, null, 2));

    const pA = await v6.getAgentPool(idA);
    console.log(JSON.stringify({
        marketplace: addresses.agentLiquidityMarketplace_v6,
        version: addresses.marketplaceVersion, reputation: addresses.reputationVersion,
        levers: addresses._levers,
        poolA: { avail: u(pA[2]), loaned: u(pA[3]), lenders: Number(pA[6]) },
        mpBalance: u(await usdc.balanceOf(await v6.getAddress())),
        fees: u(await v6.accumulatedFees()),
        scoreA: Number(await rep['getReputationScore(uint256)'](idA)),
        creditLimitA: u(await rep.calculateCreditLimit(agentA.address)),
    }, null, 2));
}

main().catch(e => { console.error(e); process.exit(1); });
