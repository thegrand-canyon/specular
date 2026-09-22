/**
 * FULL V7 STACK, DRIVEN THROUGH THE SDK.
 *
 * Deploys AgentRegistryV2 + ReputationManagerV4 + AgentLiquidityMarketplaceV62 +
 * MockUSDC on the local hardhat chain and runs SpecularQuickstart through the
 * whole lifecycle an integrator will meet on a V7 deployment:
 *
 *      onboard -> post first-loss self-stake -> borrow -> repay -> withdraw
 *
 * plus the two NEW failure modes, which must be caught in the client BEFORE a
 * transaction is sent rather than surfacing as raw reverts:
 *
 *      "Insufficient self-stake"          (M2-c, requestLoan)
 *      "Self-stake locked while borrowing" (M2-a, withdrawLiquidity)
 *
 * Nothing is broadcast to any network.
 */

const { expect } = require('chai');
const { ethers } = require('ethers');
const { deployV7, makeSdk, pumpScore, USDC, DAY } = require('./helpers/v7stack');

describe('SDK V7 — end-to-end on the full V7 stack', function () {
    this.timeout(600000);

    let d, sdk, approvals, lenderSdk, agentId;

    // The score-600 tier: 0 % collateral, 2,500 USDC tier limit, 7 % APR.
    // The ladder caps the agent at 2 x 100 (pumped maxRepaidPrincipal) + 100 = 300.
    const BORROW = USDC(80);
    const STAKE = USDC(40); // BORROW / creditMultiple(2)

    before(async () => {
        d = await deployV7();
        ({ sdk, approvals } = makeSdk(d.agent, d));
        ({ sdk: lenderSdk } = makeSdk(d.lender, d));
    });

    it('onboard registers the agent and creates its pool, sending NO approval', async () => {
        const out = await sdk.onboard('ipfs://v7-agent');
        expect(out.agentId).to.be.a('number').and.greaterThan(0);
        expect(out.approveTx, 'onboarding must never grant a blanket allowance').to.equal(null);
        agentId = out.agentId;
        expect((await d.v62.agentPools(agentId)).isActive).to.equal(true);
        expect(approvals, 'no approve at all during onboarding').to.deep.equal([]);
        // Reputation does NOT carry across a V7 deploy. A fresh V4 manager knows
        // nothing about this agent until it initialises, and then it starts at
        // INITIAL_SCORE with an empty ladder — a client must never assume a
        // prior score survived the redeploy.
        expect(await d.reputation['getReputationScore(uint256)'](agentId), 'unknown to a fresh V4 manager').to.equal(0n);
        expect(await d.reputation.initialized(agentId)).to.equal(false);
        await d.reputation.connect(d.agent)['initializeReputation()']();
        expect(await d.reputation['getReputationScore(uint256)'](agentId))
            .to.equal(await d.reputation.INITIAL_SCORE());
        expect(await d.reputation.maxRepaidPrincipal(agentId), 'the credit ladder starts at zero').to.equal(0n);
    });

    it('creditInfo reports the V7 model: tier, ladder, ceiling and the reason for the limit', async () => {
        await pumpScore(d, d.agent, 600);
        const info = await sdk.creditInfo();
        expect(info.score).to.be.at.least(600);
        expect(info.marketplaceVersion).to.equal('V6.2');
        expect(info.reputationVersion).to.equal('V4');
        expect(info.collateralPct, 'score 600 is a 0 %-collateral tier').to.equal(0);
        expect(info.tier).to.equal(4);
        expect(info.tierLimit).to.equal('2500.0');
        // ladder = creditMultiple(2) * maxRepaidPrincipal(100) + growthStep(100)
        expect(info.ladderLimit).to.equal('300.0');
        expect(info.maxRepaidPrincipal).to.equal('100.0');
        expect(info.creditLimit, 'the LADDER binds here, not the tier').to.equal('300.0');
        expect(info.maxTierLimit).to.equal('10000.0');
        expect(info.lockedOut).to.equal(false);
        expect(info.limitExplanation).to.match(/min\(tier limit/);
        expect(info.limitExplanation).to.match(/MAX_TIER_LIMIT/);
    });

    it('a lender funds the pool (an ordinary lender IS held to minSupplyAmount)', async () => {
        await lenderSdk.supply(agentId, 5000);
        expect((await d.v62.getAgentPool(agentId)).availableLiquidity).to.equal(USDC(5000));
        // A FRESH lender slot below the 50 USDC minimum, from someone who did not
        // create the pool, is refused — only the creator's first-loss slot is
        // exempt. (minSupplyAmount gates a new slot, never a top-up.)
        const { sdk: otherSdk } = makeSdk(d.other, d);
        let err = null;
        try { await otherSdk.supply(agentId, 5); } catch (e) { err = e; }
        expect(err, 'a non-creator opening a slot below the minimum must be refused').to.not.equal(null);
        expect(`${err.message} ${err.shortMessage || ''}`).to.match(/Below minimum supply/);
    });

    // ------------------------------------------------ REVERT PATH 1: M2-c

    it('borrow WITHOUT a self-stake is refused in the client, with the exact shortfall, before any tx', async () => {
        approvals.length = 0;
        const loansBefore = await sdk._loanCount();

        let err = null;
        try { await sdk.borrow(80, 30); } catch (e) { err = e; }

        expect(err, 'the SDK must not let this reach the chain').to.not.equal(null);
        expect(err.code).to.equal('SPECULAR_INSUFFICIENT_SELF_STAKE');
        expect(err.agentId).to.equal(agentId);
        expect(err.required).to.equal(STAKE);
        expect(err.current).to.equal(0n);
        expect(err.shortfall).to.equal(STAKE);
        expect(err.message).to.match(/Insufficient self-stake/);
        expect(err.message).to.match(/40\.0 USDC short/);
        expect(err.message).to.match(/sdk\.supply\(/);
        expect(err.message).to.match(/LOCKED while any principal is outstanding/);

        // Nothing was sent: no approval, no loan.
        expect(approvals, 'a refused borrow must not leave an allowance behind').to.deep.equal([]);
        expect(await sdk._loanCount()).to.equal(loansBefore);
        expect(await d.usdc.allowance(d.agent.address, d.v62.target)).to.equal(0n);
    });

    it('the same request reverts on chain if the gate is bypassed — the pre-check mirrors the contract', async () => {
        // Prove the client is not inventing a rule: the contract refuses it too.
        await expect(d.v62.connect(d.agent).requestLoan(BORROW, 30)).to.be.revertedWith('Insufficient self-stake');
    });

    // -------------------------------------------- the creator's own stake

    it('the pool creator posts a 40 USDC self-stake BELOW the 50 USDC minimum supply (M2 exemption)', async () => {
        expect(await d.v62.minSupplyAmount(), 'the exemption must be non-trivial').to.be.greaterThan(STAKE);
        approvals.length = 0;
        await sdk.supply(agentId, '40');
        // Exact approval: exactly the amount supplied, nothing left standing.
        expect(approvals).to.deep.equal([STAKE]);
        expect(await d.usdc.allowance(d.agent.address, d.v62.target)).to.equal(0n);

        const st = await sdk.selfStake(agentId);
        expect(st.amount).to.equal(STAKE);
        expect(st.locked, 'nothing outstanding yet').to.equal(false);
        expect(st.required, 'requiredSelfStake(agentId, 0) with no exposure').to.equal(0n);
        expect(st.shortfall).to.equal(0n);
        expect(st.amountUsdc).to.equal('40.0');

        expect(await sdk.requiredSelfStake(agentId, 80)).to.equal(STAKE);
        expect(await sdk.requiredSelfStake(agentId, 0)).to.equal(0n);
    });

    // ------------------------------------------------------------ borrow

    let loanId;

    it('borrow now succeeds, with an exact (zero-collateral) approval path', async () => {
        approvals.length = 0;
        const r = await sdk.borrow(80, 30);
        loanId = r.loanId;
        expect(loanId).to.be.a('number');
        const loan = await d.v62.loans(loanId);
        expect(Number(loan.state), 'ACTIVE').to.equal(1);
        expect(loan.amount).to.equal(BORROW);
        expect(loan.collateralAmount, '0 %-collateral tier').to.equal(0n);
        // A 0-collateral borrow pulls nothing, so it must approve nothing.
        expect(approvals.filter((a) => a > 0n)).to.deep.equal([]);
        expect(approvals.includes(ethers.MaxUint256)).to.equal(false);

        // The loanId is plumbed through to ReputationManagerV4 (M2-d).
        const open = await d.reputation.openLoans(loanId);
        expect(open.amount).to.equal(BORROW);
        expect(open.agentId).to.equal(BigInt(agentId));
        expect(open.start).to.be.greaterThan(0n);
    });

    it('the self-stake is now LOCKED and reported as first-loss capital', async () => {
        const st = await sdk.selfStake(agentId);
        expect(st.locked).to.equal(true);
        expect(st.amount).to.equal(STAKE);
        expect(st.required, 'the outstanding exposure now demands the stake').to.equal(STAKE);
        expect(st.shortfall).to.equal(0n);

        const info = await sdk.creditInfo();
        expect(info.selfStake.locked).to.equal(true);
        expect(info.selfStake.amountUsdc).to.equal('40.0');
    });

    it('a SECOND loan needs MORE stake — the requirement is on aggregate exposure', async () => {
        expect(await sdk.requiredSelfStake(agentId, 80)).to.equal(USDC(80)); // (80 + 80) / 2
        let err = null;
        try { await sdk.borrow(80, 30); } catch (e) { err = e; }
        expect(err).to.not.equal(null);
        expect(err.code).to.equal('SPECULAR_INSUFFICIENT_SELF_STAKE');
        expect(err.required).to.equal(USDC(80));
        expect(err.shortfall).to.equal(USDC(40));
    });

    // ------------------------------------------------ REVERT PATH 2: M2-a

    it('the creator CANNOT withdraw its locked stake — refused in the client, before any tx', async () => {
        const before = await d.v62.getLenderPosition(agentId, d.agent.address);
        let err = null;
        try { await sdk.withdraw(agentId, '10'); } catch (e) { err = e; }

        expect(err, 'the SDK must not let this reach the chain').to.not.equal(null);
        expect(err.code).to.equal('SPECULAR_SELF_STAKE_LOCKED');
        expect(err.agentId).to.equal(agentId);
        expect(err.outstandingPrincipal).to.equal(BORROW);
        expect(err.message).to.match(/FIRST-LOSS SELF-STAKE/);
        expect(err.message).to.match(/Self-stake locked while borrowing/);
        expect(err.message).to.match(/Ordinary lenders in this pool are not locked/);

        const after = await d.v62.getLenderPosition(agentId, d.agent.address);
        expect(after.amount, 'nothing moved').to.equal(before.amount);
    });

    it('the same withdrawal reverts on chain if the gate is bypassed', async () => {
        await expect(d.v62.connect(d.agent).withdrawLiquidity(agentId, USDC(10)))
            .to.be.revertedWith('Self-stake locked while borrowing');
    });

    it('an ORDINARY lender in the same pool is not locked and withdraws freely', async () => {
        const before = await d.usdc.balanceOf(d.lender.address);
        await lenderSdk.withdraw(agentId, '1000');
        expect(await d.usdc.balanceOf(d.lender.address)).to.equal(before + USDC(1000));
    });

    // ------------------------------------------------------------- repay

    it('repay closes the loan with an EXACT approval (never MaxUint256)', async () => {
        await d.time.increase(3 * DAY);
        approvals.length = 0;
        const preview = await sdk.previewRepayment(loanId);
        expect(preview.source).to.equal('previewRepayment');
        expect(preview.lateSeconds).to.equal(0n);

        const balBefore = await d.usdc.balanceOf(d.agent.address);
        await sdk.repay(loanId);

        expect(Number((await d.v62.loans(loanId)).state), 'REPAID').to.equal(2);
        // Exactly one approval, exactly the previewed total, and no residue.
        expect(approvals).to.deep.equal([preview.total]);
        expect(approvals.includes(ethers.MaxUint256)).to.equal(false);
        expect(await d.usdc.allowance(d.agent.address, d.v62.target)).to.equal(0n);
        expect(balBefore - (await d.usdc.balanceOf(d.agent.address))).to.equal(preview.total);

        // The V4 open-loan record is closed and the ladder advanced (M1/M2-d).
        expect((await d.reputation.openLoans(loanId)).start).to.equal(0n);
        expect(await d.reputation.maxRepaidPrincipal(agentId)).to.equal(USDC(100)); // 80 < the pumped 100
    });

    // ---------------------------------------------------------- withdraw

    it('with the loan repaid the self-stake unlocks and the creator can withdraw it', async () => {
        const st = await sdk.selfStake(agentId);
        expect(st.locked).to.equal(false);
        expect(st.required).to.equal(0n);

        const before = await d.usdc.balanceOf(d.agent.address);
        await sdk.withdraw(agentId, '40');
        expect(await d.usdc.balanceOf(d.agent.address)).to.equal(before + STAKE);
        expect((await sdk.selfStake(agentId)).amount).to.equal(0n);
    });

    it('the whole run left no standing allowance and never used an unlimited approval', async () => {
        expect(await d.usdc.allowance(d.agent.address, d.v62.target)).to.equal(0n);
        expect(await d.usdc.allowance(d.lender.address, d.v62.target)).to.equal(0n);
    });

    // -------------------------------------------- lockout after a default

    it('after a default the agent reads creditLimit 0 and the SDK EXPLAINS the lockout', async () => {
        const dd = await deployV7();
        const { sdk: s2 } = makeSdk(dd.agent, dd);
        const { sdk: l2 } = makeSdk(dd.lender, dd);
        const id = (await s2.onboard()).agentId;
        await dd.reputation.connect(dd.agent)['initializeReputation()']();
        await pumpScore(dd, dd.agent, 600);
        await l2.supply(id, 5000);
        await s2.supply(id, '40');
        const r = await s2.borrow(80, 7);

        // Let it go past due and liquidate it (owner-only), which records the default.
        await dd.time.increase(40 * DAY);
        await dd.v62.connect(dd.owner).liquidateLoan(r.loanId);

        const info = await s2.creditInfo();
        expect(info.lockedOut).to.equal(true);
        expect(info.creditLimit).to.equal('0.0');
        expect(info.maxRepaidPrincipal, 'the ladder capacity is reset by a default').to.equal('0.0');
        expect(info.lockedUntil).to.be.greaterThan(0);
        expect(info.limitExplanation).to.match(/LOCKED OUT after a default/);
        expect(info.limitExplanation).to.match(/reset to 0/);

        // The self-stake absorbed the loss first (M2-b): the creator's position shrank.
        const st = await dd.v62.selfStake(id);
        expect(st.amount, 'first-loss capital is seized before any lender').to.be.lessThan(USDC(40));
    });
});
