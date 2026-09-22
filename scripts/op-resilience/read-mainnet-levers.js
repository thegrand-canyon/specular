// READ-ONLY snapshot of every owner-controlled lever on the Arc mainnet stack,
// for the incident runbook. Sends no transactions.
// Usage: node scripts/op-resilience/read-mainnet-levers.js

const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const A = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/config/arc-mainnet-addresses.json')));
const abi = n => JSON.parse(fs.readFileSync(path.join(ROOT, `artifacts/contracts/core/${n}.sol/${n}.json`))).abi;

(async () => {
    const p = new ethers.JsonRpcProvider(process.env.ARC_MAINNET_RPC_URL || A.rpcUrl, undefined, { batchMaxCount: 1, staticNetwork: true });
    const v6 = new ethers.Contract(A.agentLiquidityMarketplace_v6, abi('AgentLiquidityMarketplaceV6'), p);
    const rep = new ethers.Contract(A.reputationManagerV3, abi('ReputationManagerV3'), p);
    const reg = new ethers.Contract(A.agentRegistryV2, abi('AgentRegistryV2'), p);
    const fau = new ethers.Contract(A.agentCreditFaucet, abi('AgentCreditFaucet'), p);
    const usdc = new ethers.Contract(A.usdc, ['function balanceOf(address) view returns (uint256)'], p);
    const u = v => ethers.formatUnits(v, 6);

    const out = {
        readAt: new Date().toISOString(),
        block: (await p.getBlock('latest')).number,
        marketplace: {
            address: A.agentLiquidityMarketplace_v6,
            version: await v6.VERSION(),
            owner: await v6.owner(),
            pendingOwner: await v6.pendingOwner(),
            paused: await v6.paused(),
            migrationFinalized: await v6.migrationFinalized(),
            platformFeeRateBps: Number(await v6.platformFeeRate()),
            minSupplyAmount: u(await v6.minSupplyAmount()),
            minHoldForReputationReward: Number(await v6.minHoldForReputationReward()),
            bindBorrowToPoolCreator: await v6.bindBorrowToPoolCreator(),
            accumulatedFees: u(await v6.accumulatedFees()),
            usdcBalance: u(await usdc.balanceOf(A.agentLiquidityMarketplace_v6)),
            totalPools: Number(await v6.totalPools()),
            nextLoanId: Number(await v6.nextLoanId()),
            MAX_ACTIVE_LOANS_PER_AGENT: Number(await v6.MAX_ACTIVE_LOANS_PER_AGENT()),
            MAX_LENDERS_PER_POOL: Number(await v6.MAX_LENDERS_PER_POOL()),
            LATE_INTEREST_CAP_days: Number(await v6.LATE_INTEREST_CAP()) / 86400,
        },
        reputation: {
            address: A.reputationManagerV3,
            owner: await rep.owner(),
            marketplaceAuthorized: await rep.authorizedPools(A.agentLiquidityMarketplace_v6),
            onTimeRepaymentBonus: Number(await rep.onTimeRepaymentBonus()),
            defaultPenaltyBase: Number(await rep.defaultPenaltyBase()),
            defaultPenaltyLarge: Number(await rep.defaultPenaltyLarge()),
            largeLoanThreshold: u(await rep.largeLoanThreshold()),
            bonusReferenceAmount: u(await rep.bonusReferenceAmount()),
            maxReputationGainPerWindow: Number(await rep.maxReputationGainPerWindow()),
            reputationGainWindow: Number(await rep.reputationGainWindow()),
        },
        registry: {
            address: A.agentRegistryV2,
            owner: await reg.owner(),
            paused: await reg.paused(),
            totalAgents: Number(await reg.totalAgents()),
        },
        faucet: {
            address: A.agentCreditFaucet,
            owner: await fau.owner(),
            balance: u(await fau.balance()),
            claimAmount: u(await fau.claimAmount()),
            maxEligibleAgentId: Number(await fau.maxEligibleAgentId()),
        },
    };
    console.log(JSON.stringify(out, null, 2));
    const dir = path.join(ROOT, 'forensics/output/testing-2026-09-20');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'arc-mainnet-levers.json'), JSON.stringify(out, null, 2));
})().catch(e => { console.error(e.shortMessage || e.message); process.exit(1); });
