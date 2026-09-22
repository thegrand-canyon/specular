/**
 * THREE-WAY CAPABILITY DETECTION (V6 / V6.1 / V6.2) in the JS SDK.
 *
 * The SDK talks to three marketplace generations and two reputation
 * generations with one set of contract handles. Getting the gate wrong is not
 * cosmetic:
 *
 *  - treating a V6.1 deployment as V6.2 makes `borrow` read `requiredSelfStake`
 *    on a contract that has no such selector;
 *  - treating a V6.2 deployment as V6.1 skips the self-stake pre-check, so the
 *    agent meets a raw "Insufficient self-stake" revert after it has already
 *    approved collateral;
 *  - treating a V4 reputation manager as V3 hands the caller a STALE HARDCODED
 *    tier table (25,000 / 50,000) for a deployment whose real top tier is
 *    5,000 and is owner-settable.
 *
 * Base mainnet and Arc mainnet are V6.1/V3 today, so every one of these paths
 * is live, not hypothetical.
 */

const { expect } = require('chai');
const { ethers } = require('ethers');
const {
    deployV7, makeSdk, v61Abi, v60Abi, v3RepAbi,
    USDC, V7_TIER_LIMITS, V7_TIER_COLLATERAL, V7_TIER_MIN_SCORE, V7_TIER_RATES,
} = require('./helpers/v7stack');
const { SpecularQuickstart } = require('../../src/sdk/SpecularQuickstart.js');

describe('SDK V7 — three-way capability detection', function () {
    this.timeout(180000);

    let d;
    before(async () => { d = await deployV7(); });

    // ------------------------------------------------------------ ordinals

    it('versionOrdinal orders the generations and fails safe on junk', () => {
        expect(SpecularQuickstart.versionOrdinal('V6')).to.equal(6);
        expect(SpecularQuickstart.versionOrdinal('V6.1')).to.equal(6.1);
        expect(SpecularQuickstart.versionOrdinal('V6.2')).to.equal(6.2);
        expect(SpecularQuickstart.versionOrdinal('V7')).to.equal(7);
        // An unparseable answer must sort as the MOST conservative generation,
        // so no newer feature is attempted on a contract we cannot identify.
        expect(SpecularQuickstart.versionOrdinal('')).to.equal(6);
        expect(SpecularQuickstart.versionOrdinal(undefined)).to.equal(6);
        expect(SpecularQuickstart.versionOrdinal('nonsense')).to.equal(6);
    });

    // ------------------------------------------------------------- V6.2

    it('a real V6.2 + V4 deployment reports v61 AND v62 AND reputationV4', async () => {
        const { sdk } = makeSdk(d.agent, d);
        const caps = await sdk.capabilities();
        expect(caps.version).to.equal('V6.2');
        expect(caps.ordinal).to.equal(6.2);
        expect(caps.v61, 'V6.2 keeps every V6.1 view').to.equal(true);
        expect(caps.v62).to.equal(true);
        expect(caps.reputationVersion).to.equal('V4');
        expect(caps.reputationV4).to.equal(true);
        // cached: a second call must not re-probe
        expect(await sdk.capabilities()).to.equal(caps);
    });

    // ------------------------------------------------------------- V6.1

    it('a V6.1 deployment is v61 but NOT v62 — the self-stake views are refused, not guessed', async () => {
        const { sdk } = makeSdk(d.agent, d, { marketplaceAbi: v61Abi(d.v62), reputationAbi: v3RepAbi(d.reputation) });
        // The bytecode at this address IS V6.2, but the client is given a V6.1
        // ABI: capability detection must follow what it can actually encode.
        sdk._mpVersion = 'V6.1'; // as a real V6.1 deployment would answer
        const caps = await sdk.capabilities();
        expect(caps.v61).to.equal(true);
        expect(caps.v62, 'a V6.1 deployment has no self-stake gate').to.equal(false);
        expect(caps.reputationV4).to.equal(false);

        for (const fn of [() => sdk.selfStake(1), () => sdk.requiredSelfStake(1, 100)]) {
            let err = null;
            try { await fn(); } catch (e) { err = e; }
            expect(err, 'must throw rather than fabricate a zero requirement').to.not.equal(null);
            expect(err.code).to.equal('SPECULAR_UNSUPPORTED_ON_DEPLOYMENT');
            expect(err.message).to.match(/not supported on this deployment/);
            expect(err.message).to.match(/requires V6\.2/);
        }
    });

    // --------------------------------------------------------------- V6

    it('a V6 deployment (no VERSION selector) reports V6, and neither v61 nor v62', async () => {
        const { sdk } = makeSdk(d.agent, d, { marketplaceAbi: v60Abi(d.v62), reputationAbi: v3RepAbi(d.reputation) });
        const caps = await sdk.capabilities();
        expect(caps.version).to.equal('V6');
        expect(caps.v61).to.equal(false);
        expect(caps.v62).to.equal(false);
        expect(caps.reputationVersion).to.equal('V3');
        expect(caps.reputationV4).to.equal(false);
    });

    it('a contract that claims V6.2 but has no self-stake selector is NOT treated as v62', async () => {
        const { sdk } = makeSdk(d.agent, d, { marketplaceAbi: v61Abi(d.v62) });
        sdk._mpVersion = 'V6.2'; // a mislabelled / partially migrated deployment
        const caps = await sdk.capabilities();
        expect(caps.version).to.equal('V6.2');
        expect(caps.v62, 'the version string alone must never enable the gate').to.equal(false);
    });

    // -------------------------------------------------- the tier table

    it('tierTable() reads the table FROM THE CHAIN on V4 — no hardcoded 25,000 / 50,000', async () => {
        const { sdk } = makeSdk(d.agent, d);
        const t = await sdk.tierTable();
        expect(t.source).to.equal('chain');
        expect(t.tiers).to.have.length(6);
        expect(t.tiers.map((x) => x.limit)).to.deep.equal(V7_TIER_LIMITS);
        expect(t.tiers.map((x) => x.collateralPct)).to.deep.equal(V7_TIER_COLLATERAL);
        expect(t.tiers.map((x) => x.minScore)).to.deep.equal(V7_TIER_MIN_SCORE);
        expect(t.tiers.map((x) => x.interestRateBps)).to.deep.equal(V7_TIER_RATES);
        expect(t.maxTierLimit).to.equal(USDC(10000));
        // The V3 figures every client used to carry must not appear.
        expect(t.tiers.some((x) => x.limit === USDC(25000) || x.limit === USDC(50000))).to.equal(false);
        // unsecured exposure is published and bounded by the ceiling
        for (const tier of t.tiers) {
            expect(tier.unsecuredExposure).to.equal((tier.limit * BigInt(100 - tier.collateralPct)) / 100n);
            expect(tier.limit).to.be.at.most(t.maxTierLimit);
        }
    });

    it('tierTable() follows an OWNER-SET change, which a hardcoded copy could never do', async () => {
        const { sdk } = makeSdk(d.agent, d);
        const before = await sdk.tierTable();
        expect(before.tiers[5].limit).to.equal(USDC(5000));

        const raised = [...V7_TIER_LIMITS];
        raised[5] = USDC(9000);
        await d.reputation.connect(d.owner).setTierLimits(raised);
        try {
            const after = await sdk.tierTable();
            expect(after.tiers[5].limit, 'the client must report what the contract now says').to.equal(USDC(9000));
            expect(after.tiers[5].limitUsdc).to.equal('9000.0');
            expect(after.tiers[5].unsecuredExposure).to.equal(USDC(9000));
        } finally {
            await d.reputation.connect(d.owner).setTierLimits(V7_TIER_LIMITS);
        }
    });

    it('setTierLimits can never lift a tier above the immutable MAX_TIER_LIMIT the client reports', async () => {
        const { sdk } = makeSdk(d.agent, d);
        const t = await sdk.tierTable();
        const over = [...V7_TIER_LIMITS];
        over[5] = t.maxTierLimit + 1n;
        await expect(d.reputation.connect(d.owner).setTierLimits(over)).to.be.reverted;
    });

    it('tierTable() on a V3 manager returns the compiled-in constants, HONESTLY LABELLED', async () => {
        const { sdk } = makeSdk(d.agent, d, { marketplaceAbi: v61Abi(d.v62), reputationAbi: v3RepAbi(d.reputation) });
        const t = await sdk.tierTable();
        expect(t.source, 'must not be passed off as chain data').to.equal('v3-constant');
        expect(t.maxTierLimit, 'V3 has no ceiling to report').to.equal(null);
        expect(t.tiers[4].limit).to.equal(USDC(25000));
        expect(t.tiers[5].limit).to.equal(USDC(50000));
    });

    // ------------------------------------------- probe failures fail SAFE

    it('a failed capability probe never fails a borrow: the pre-check is advisory, the chain still enforces it', async () => {
        const { sdk } = makeSdk(d.agent, d);
        // Simulate an RPC that cannot answer the version question at all.
        sdk._caps = undefined;
        sdk._mpVersion = undefined;
        sdk._mpCode = undefined;
        const realGetCode = sdk.wallet.provider.getCode.bind(sdk.wallet.provider);
        sdk.wallet.provider.getCode = async () => { throw Object.assign(new Error('boom'), { code: 'SERVER_ERROR' }); };
        try {
            // collateralPct < 100 so the gate WOULD apply if we could detect it
            await sdk._assertSelfStakeSufficient(USDC(100), 0n); // must simply return
            await sdk._assertWithdrawNotLocked(1);               // must simply return
        } finally {
            sdk.wallet.provider.getCode = realGetCode;
        }
    });

    it('a 100%-collateral tier is never charged a self-stake pre-check (no unsecured exposure)', async () => {
        const { sdk } = makeSdk(d.agent, d);
        let probed = false;
        const real = sdk.marketplace.requiredSelfStake.bind(sdk.marketplace);
        sdk.marketplace.requiredSelfStake = async (...a) => { probed = true; return real(...a); };
        await sdk._assertSelfStakeSufficient(USDC(100), 100n);
        expect(probed, 'nothing unsecured => nothing to stake => no read').to.equal(false);
    });

    it('approvals are never MaxUint256 anywhere in the V7 paths', async () => {
        const { sdk, approvals } = makeSdk(d.agent, d);
        await sdk._approveExact(USDC(7));
        await sdk._revokeApprovalInner();
        expect(approvals).to.deep.equal([USDC(7), 0n]);
        expect(approvals.includes(ethers.MaxUint256)).to.equal(false);
    });
});
