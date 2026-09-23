/**
 * Local V7 (AgentLiquidityMarketplaceV62 + ReputationManagerV4) deployment and
 * SpecularQuickstart wiring for the client-migration suites.
 *
 * Nothing here touches a real network: everything runs on the in-process hardhat
 * chain (chainId 31337).
 *
 * The SDK is wired by hand rather than through `new SpecularQuickstart(...)` so
 * the suite can point it at freshly deployed local addresses, and so every
 * `usdc.approve` amount is recorded — the exact-approval invariant from the
 * 2026-07 audit is asserted on that list.
 */

const { ethers: hhEthers } = require('hardhat');
const { ethers } = require('ethers');
const { time } = require('@nomicfoundation/hardhat-network-helpers');
const { SpecularQuickstart } = require('../../../src/sdk/SpecularQuickstart.js');

const USDC = (n) => ethers.parseUnits(n.toString(), 6);
const DAY = 86400;

/** V7 shipped defaults (ReputationManagerV4 constructor). */
const V7_TIER_LIMITS = [USDC(1000), USDC(5000), USDC(10000), USDC(10000), USDC(2500), USDC(5000)];
const V7_TIER_COLLATERAL = [100, 100, 100, 75, 0, 0];
const V7_TIER_MIN_SCORE = [0, 200, 400, 500, 600, 800];
const V7_TIER_RATES = [1500, 1500, 1000, 1000, 700, 500];

/**
 * Deploy the FULL V7 stack: AgentRegistryV2 + ReputationManagerV4 +
 * AgentLiquidityMarketplaceV62 + MockUSDC, wired and levered like the deployment
 * runbook (§9 of V7_DESIGN_AND_VALIDATION.md).
 *
 * `minSupply` deliberately defaults to 50 USDC — above the self-stake a small
 * honest loan needs — so the suite genuinely exercises M2's exemption of the
 * pool creator's own first-loss position from `minSupplyAmount`. (The contract
 * caps `setMinSupplyAmount` at 100 USDC, so 50 is near the top of the range.)
 */
async function deployV7(opts = {}) {
    const signers = await hhEthers.getSigners();
    const [owner, agent, lender, other] = signers;

    const registry = await (await hhEthers.getContractFactory('AgentRegistryV2')).deploy();
    const reputation = await (await hhEthers.getContractFactory('ReputationManagerV4')).deploy(await registry.getAddress());
    const usdc = await (await hhEthers.getContractFactory('MockUSDC')).deploy();
    const v62 = await (await hhEthers.getContractFactory('AgentLiquidityMarketplaceV62')).deploy(
        await registry.getAddress(), await reputation.getAddress(), await usdc.getAddress());

    await reputation.authorizePool(await v62.getAddress());
    await v62.setMigrationFinalized();

    // Live launch levers, carried forward from the Arc-mainnet config.
    await reputation.setReputationRateLimit(opts.rateLimit ?? 20, DAY);
    await v62.setMinHoldForReputationReward(opts.minHold ?? DAY);
    await v62.setPlatformFeeRate(opts.feeBps ?? 100);
    await v62.setBindBorrowToPoolCreator(opts.bindM1 ?? true);
    await v62.setMinSupplyAmount(opts.minSupply ?? USDC(50));
    // V7 knobs (k = 2, mandatory non-zero growth step).
    await reputation.setLadderParameters(
        opts.creditMultiple ?? 2,
        opts.growthStep ?? USDC(100),
        opts.bootstrapLimit ?? USDC(100),
        opts.refDuration ?? 7 * DAY,
    );
    await reputation.setDefaultLockout(opts.lockout ?? 180 * DAY);

    // Fund the players. NO blanket approval anywhere: the SDK must approve
    // exactly what each operation pulls, and the suite asserts that.
    await usdc.mint(agent.address, USDC(100_000));
    await usdc.mint(lender.address, USDC(1_000_000));
    await usdc.mint(other.address, USDC(1_000_000));

    return { owner, agent, lender, other, signers, registry, reputation, usdc, v62, time };
}

/**
 * SpecularQuickstart bound to a local deployment.
 *
 * Returns `{ sdk, approvals }`, where `approvals` records every amount handed to
 * `usdc.approve()` in order — the exact-approval audit reads that list.
 */
function makeSdk(signer, d, { marketplaceAbi, reputationAbi, marketplaceAddress } = {}) {
    const sdk = Object.create(SpecularQuickstart.prototype);
    sdk.wallet = signer;
    sdk.network = 'local-v7';
    sdk.cfg = { decimals: 6, explorer: 'https://example.invalid/tx/' };
    sdk.receiptTimeoutMs = 0;
    const mpAddr = marketplaceAddress || d.v62.target;
    sdk.addresses = {
        marketplace: mpAddr,
        registry: d.registry.target,
        reputation: d.reputation.target,
        usdc: d.usdc.target,
    };
    sdk.marketplace = new ethers.Contract(mpAddr, marketplaceAbi || d.v62.interface.fragments, signer);
    sdk.registry = new ethers.Contract(d.registry.target, d.registry.interface.fragments, signer);
    sdk.reputation = new ethers.Contract(d.reputation.target, reputationAbi || d.reputation.interface.fragments, signer);

    const usdc = new ethers.Contract(d.usdc.target, d.usdc.interface.fragments, signer);
    const approvals = [];
    sdk.usdc = {
        allowance: (o, s) => usdc.allowance(o, s),
        balanceOf: (a) => usdc.balanceOf(a),
        approve: async (spender, amount) => { approvals.push(amount); return usdc.approve(spender, amount); },
    };
    sdk._rawUsdc = usdc;
    return { sdk, approvals };
}

/**
 * Raise `wallet`'s score to `target` through the authorized-pool path.
 *
 * Each synthetic cycle records the borrow first and then holds for a full
 * `refDuration`, so the principal-TIME bonus (M1-1) pays out in full; that also
 * lifts `maxRepaidPrincipal` to `amount`, which is what the credit ladder is
 * built on.
 */
async function pumpScore(d, wallet, target, amount = USDC(100)) {
    const agentId = await d.registry.addressToAgentId(wallet.address);
    if (!(await d.reputation.authorizedPools(d.owner.address))) {
        await d.reputation.authorizePool(d.owner.address);
    }
    let synthetic = 1_000_000;
    let guard = 0;
    while ((await d.reputation['getReputationScore(uint256)'](agentId)) < BigInt(target)) {
        if (guard++ > 500) throw new Error(`pumpScore: could not reach ${target}`);
        const id = synthetic++;
        await d.reputation.recordBorrow(wallet.address, id, amount);
        await time.increase(7 * DAY);
        await d.reputation.recordLoanCompletion(wallet.address, id, amount, true, 0);
    }
    return Number(await d.reputation['getReputationScore(uint256)'](agentId));
}

/** An ABI with the V6.2-only selectors stripped — a genuine V6.1 deployment. */
function v61Abi(v62) {
    const gone = ['requiredSelfStake', 'selfStake'];
    return v62.interface.fragments.filter((f) => !(f.type === 'function' && gone.includes(f.name)));
}

/** An ABI with every post-V6 selector stripped — a genuine V6.0 deployment. */
function v60Abi(v62) {
    const gone = ['VERSION', 'previewRepayment', 'canTopUp', 'getActiveLoanIds', 'LATE_INTEREST_CAP', 'repayments', 'requiredSelfStake', 'selfStake'];
    return v62.interface.fragments.filter((f) => !(f.type === 'function' && gone.includes(f.name)));
}

/** A reputation ABI with the V4-only selectors stripped — a genuine V3 manager. */
function v3RepAbi(reputation) {
    const gone = ['VERSION', 'tierOf', 'tierLimit', 'tierLimits', 'tierMinScore', 'tierCollateralPct', 'tierInterestBps',
        'unsecuredTierExposure', 'MAX_TIER_LIMIT', 'ladderLimit', 'maxRepaidPrincipal', 'isLockedOut', 'lockedUntil',
        'creditLimitOf', 'creditMultiple', 'growthStep', 'bootstrapLimit', 'refDuration', 'defaultLockout', 'lateCount', 'openLoans'];
    return reputation.interface.fragments.filter((f) => !(f.type === 'function' && gone.includes(f.name)));
}

module.exports = {
    deployV7, makeSdk, pumpScore, v61Abi, v60Abi, v3RepAbi,
    USDC, DAY, V7_TIER_LIMITS, V7_TIER_COLLATERAL, V7_TIER_MIN_SCORE, V7_TIER_RATES,
};
