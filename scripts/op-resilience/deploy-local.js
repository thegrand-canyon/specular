// Deploy the V6.1 Arc-mainnet stack to a LOCAL hardhat node and build a realistic
// baseline state (pools, lenders, active + repaid loans) that the invariant monitor
// can be pointed at. Writes src/config/local-addresses.json.
//
// Usage: npx hardhat run --network localhost scripts/op-resilience/deploy-local.js

const { ethers } = require('hardhat');
const fs = require('fs');
const path = require('path');

const USDC = n => ethers.parseUnits(n.toString(), 6);
const DAY = 24 * 60 * 60;
const ROOT = path.resolve(__dirname, '..', '..');

async function main() {
    const signers = await ethers.getSigners();
    const [owner, agentA, agentB, lender1, lender2, lender3] = signers;

    const registry = await (await ethers.getContractFactory('AgentRegistryV2')).deploy();
    const reputation = await (await ethers.getContractFactory('ReputationManagerV3')).deploy(await registry.getAddress());
    const usdc = await (await ethers.getContractFactory('MockUSDC')).deploy();
    const v6 = await (await ethers.getContractFactory('AgentLiquidityMarketplaceV6')).deploy(
        await registry.getAddress(), await reputation.getAddress(), await usdc.getAddress());
    const faucet = await (await ethers.getContractFactory('AgentCreditFaucet')).deploy(
        await registry.getAddress(), await usdc.getAddress());
    await reputation.authorizePool(await v6.getAddress());

    // Live Arc-mainnet levers (read on-chain 2026-09-19)
    await reputation.setReputationRateLimit(20, DAY);
    await v6.setMinHoldForReputationReward(DAY);
    await v6.setPlatformFeeRate(100);
    await v6.setBindBorrowToPoolCreator(true);
    await v6.setMinSupplyAmount(USDC(1));
    await faucet.setMaxEligibleAgentId(100);
    await faucet.setClaimAmount(USDC(10));

    const fund = async (w, amt = USDC(1_000_000)) => {
        await usdc.mint(w.address, amt);
        await usdc.connect(w).approve(await v6.getAddress(), ethers.MaxUint256);
    };
    for (const w of [owner, agentA, agentB, lender1, lender2, lender3]) await fund(w);

    const onboard = async w => {
        await registry.connect(w).register('ipfs://agent', []);
        const id = await registry.addressToAgentId(w.address);
        await reputation.connect(w)['initializeReputation()']();
        await v6.connect(w).createAgentPool();
        return id;
    };
    const idA = await onboard(agentA);
    const idB = await onboard(agentB);

    // Lenders supply
    await v6.connect(lender1).supplyLiquidity(idA, USDC(5000));
    await v6.connect(lender2).supplyLiquidity(idA, USDC(3000));
    await v6.connect(lender3).supplyLiquidity(idB, USDC(2000));

    // Agent A: one loan taken and repaid (accrues interest + fees), one left ACTIVE
    await v6.connect(agentA).requestLoan(USDC(500), 7);          // loan 1, 100% collateral at score 100
    await ethers.provider.send('evm_increaseTime', [8 * DAY]);
    await ethers.provider.send('evm_mine', []);
    await v6.connect(agentA).repayLoan(1);
    await v6.connect(agentA).requestLoan(USDC(400), 7);          // loan 2 -> ACTIVE
    // Agent B: one ACTIVE loan
    await v6.connect(agentB).requestLoan(USDC(300), 14);          // loan 3 -> ACTIVE

    const addresses = {
        network: 'local',
        chainId: 31337,
        rpcUrl: 'http://127.0.0.1:8545',
        agentRegistryV2: await registry.getAddress(),
        reputationManagerV3: await reputation.getAddress(),
        agentLiquidityMarketplace_v6: await v6.getAddress(),
        agentCreditFaucet: await faucet.getAddress(),
        usdc: await usdc.getAddress(),
        deployer: owner.address,
        marketplaceVersion: 'V6.1 local harness',
        deployedAt: new Date().toISOString(),
        _testAccounts: {
            agentA: agentA.address, agentAId: idA.toString(),
            agentB: agentB.address, agentBId: idB.toString(),
            lender1: lender1.address, lender2: lender2.address, lender3: lender3.address,
        },
    };
    fs.writeFileSync(path.join(ROOT, 'src/config/local-addresses.json'), JSON.stringify(addresses, null, 2));

    const poolA = await v6.getAgentPool(idA);
    console.log(JSON.stringify({
        marketplace: addresses.agentLiquidityMarketplace_v6,
        poolA: { avail: poolA[2].toString(), loaned: poolA[3].toString(), lenders: poolA[6].toString() },
        mpBalance: (await usdc.balanceOf(await v6.getAddress())).toString(),
        fees: (await v6.accumulatedFees()).toString(),
        activeLoanCountA: (await v6.activeLoanCount(idA)).toString(),
    }, null, 2));
}

main().catch(e => { console.error(e); process.exit(1); });
