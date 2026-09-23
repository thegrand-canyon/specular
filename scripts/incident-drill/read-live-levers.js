// READ-ONLY. Reads every owner-settable lever on the live Arc-mainnet V6.2 + V4
// stack so the local drill can be run at the values that are actually in force.
// Never sends a transaction — there is no signer in this file at all.
const { ethers } = require('ethers');
const fs = require('fs'); const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
const A = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/config/arc-mainnet-addresses.json')));
const RPC = process.env.ARC_MAINNET_RPC_URL || A.rpcUrl;

const MP = ['function VERSION() view returns (string)', 'function owner() view returns (address)', 'function pendingOwner() view returns (address)', 'function paused() view returns (bool)', 'function platformFeeRate() view returns (uint256)', 'function minSupplyAmount() view returns (uint256)', 'function minHoldForReputationReward() view returns (uint256)', 'function bindBorrowToPoolCreator() view returns (bool)', 'function migrationFinalized() view returns (bool)', 'function accumulatedFees() view returns (uint256)', 'function totalPools() view returns (uint256)', 'function nextLoanId() view returns (uint256)', 'function reputationManager() view returns (address)', 'function MAX_LENDERS_PER_POOL() view returns (uint256)', 'function MAX_ACTIVE_LOANS_PER_AGENT() view returns (uint256)'];
const RM = ['function VERSION() view returns (string)', 'function owner() view returns (address)', 'function pendingOwner() view returns (address)', 'function MAX_TIER_LIMIT() view returns (uint256)', 'function tierLimits(uint256) view returns (uint256)', 'function tierCollateralPct(uint256) view returns (uint256)', 'function tierInterestBps(uint256) view returns (uint256)', 'function creditMultiple() view returns (uint256)', 'function growthStep() view returns (uint256)', 'function bootstrapLimit() view returns (uint256)', 'function refDuration() view returns (uint256)', 'function defaultLockout() view returns (uint256)', 'function maxReputationGainPerWindow() view returns (uint256)', 'function reputationGainWindow() view returns (uint256)', 'function onTimeRepaymentBonus() view returns (uint256)', 'function defaultPenaltyBase() view returns (uint256)', 'function defaultPenaltyLarge() view returns (uint256)', 'function largeLoanThreshold() view returns (uint256)', 'function bonusReferenceAmount() view returns (uint256)', 'function latePenaltyBase() view returns (uint256)', 'function latePenaltyPerDay() view returns (uint256)', 'function latePenaltyMax() view returns (uint256)', 'function authorizedPools(address) view returns (bool)'];
const REG = ['function owner() view returns (address)', 'function paused() view returns (bool)', 'function totalAgents() view returns (uint256)'];
const FA = ['function owner() view returns (address)', 'function claimAmount() view returns (uint256)', 'function maxEligibleAgentId() view returns (uint256)', 'function balance() view returns (uint256)'];

(async () => {
    const p = new ethers.JsonRpcProvider(RPC, undefined, { staticNetwork: true });
    const mp = new ethers.Contract(A.agentLiquidityMarketplace_v6, MP, p);
    const rmAddr = await mp.reputationManager();
    const rm = new ethers.Contract(rmAddr, RM, p);
    const reg = new ethers.Contract(A.agentRegistryV2, REG, p);
    const fa = new ethers.Contract(A.agentCreditFaucet, FA, p);
    const g = async (o, k, ...a) => { try { return (await o[k](...a)).toString(); } catch (e) { return `ERR:${(e.shortMessage || e.message || '').slice(0, 60)}`; } };
    const out = {
        rpc: RPC, chainId: Number((await p.getNetwork()).chainId), block: await p.getBlockNumber(),
        marketplace: { address: A.agentLiquidityMarketplace_v6 }, reputation: { address: rmAddr },
        registry: { address: A.agentRegistryV2 }, faucet: { address: A.agentCreditFaucet },
    };
    for (const k of ['VERSION', 'owner', 'pendingOwner', 'paused', 'platformFeeRate', 'minSupplyAmount', 'minHoldForReputationReward', 'bindBorrowToPoolCreator', 'migrationFinalized', 'accumulatedFees', 'totalPools', 'nextLoanId', 'MAX_LENDERS_PER_POOL', 'MAX_ACTIVE_LOANS_PER_AGENT']) out.marketplace[k] = await g(mp, k);
    for (const k of ['VERSION', 'owner', 'pendingOwner', 'MAX_TIER_LIMIT', 'creditMultiple', 'growthStep', 'bootstrapLimit', 'refDuration', 'defaultLockout', 'maxReputationGainPerWindow', 'reputationGainWindow', 'onTimeRepaymentBonus', 'defaultPenaltyBase', 'defaultPenaltyLarge', 'largeLoanThreshold', 'bonusReferenceAmount', 'latePenaltyBase', 'latePenaltyPerDay', 'latePenaltyMax']) out.reputation[k] = await g(rm, k);
    out.reputation.tierLimits = []; out.reputation.tierCollateralPct = []; out.reputation.tierInterestBps = [];
    for (let i = 0; i < 6; i++) {
        out.reputation.tierLimits.push(await g(rm, 'tierLimits', i));
        out.reputation.tierCollateralPct.push(await g(rm, 'tierCollateralPct', i));
        out.reputation.tierInterestBps.push(await g(rm, 'tierInterestBps', i));
    }
    out.reputation.marketplaceAuthorized = await g(rm, 'authorizedPools', A.agentLiquidityMarketplace_v6);
    out.reputation.legacyMarketplaceAuthorized = await g(rm, 'authorizedPools', A.agentLiquidityMarketplacePrevious);
    for (const k of ['owner', 'paused', 'totalAgents']) out.registry[k] = await g(reg, k);
    for (const k of ['owner', 'claimAmount', 'maxEligibleAgentId', 'balance']) out.faucet[k] = await g(fa, k);
    console.log(JSON.stringify(out, null, 2));
})().catch(e => { console.error('READ FAILED:', e.shortMessage || e.message); process.exit(1); });
