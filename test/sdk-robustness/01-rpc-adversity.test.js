/**
 * RPC ADVERSITY — what a third-party agent meets on a flaky public endpoint.
 *
 *  - 429 / 500 / timeout mid-flow
 *  - a replica serving state minutes/hours behind head (does the SDK notice?)
 *  - inconsistent views across calls (registry registered, marketplace not)
 *  - the connection dying inside tx.wait()
 *  - a tx submitted whose send response is lost (does the SDK double-submit?)
 *  - a chain reorg replacing a mined tx (simulated with evm_snapshot/evm_revert)
 */

const { expect } = require('chai');
const { ethers } = require('ethers');
const hre = require('hardhat');
const { time, mine } = require('@nomicfoundation/hardhat-network-helpers');
const { deployV61, onboardOnChain, makeSdk, USDC, DAY } = require('./helpers/stack');
const {
    makeFaultyProvider, failMethod, staleReads, swallowReceipts, sendThenLoseResponse,
    rpcError, timeoutError, connectionDropped, revertData, sel,
} = require('./helpers/faultProvider');
const { walletAt } = require('./helpers/wallets');

describe('RPC adversity', function () {
    this.timeout(240000);

    let d, provider, transport, wallet, sdk, approvals;

    beforeEach(async () => {
        d = await deployV61();
        ({ provider, transport } = makeFaultyProvider());
        wallet = walletAt(1, provider);
        ({ sdk, approvals } = makeSdk(wallet, d));
    });

    // ---------------------------------------------------------- 429/500/timeout

    it('a 500 on a read fails CLOSED — no tx is broadcast and no allowance is left behind', async () => {
        await onboardOnChain(d, d.borrower);
        const before = transport.sent().length;
        transport.addRule(failMethod('eth_call', 500, 20));
        let err = null;
        try { await sdk.borrow(100, 7); } catch (e) { err = e; }
        expect(err, 'must not pretend to succeed').to.not.equal(null);
        expect(transport.sent().length, 'nothing may be broadcast').to.equal(before);
        expect(await d.usdc.allowance(wallet.address, d.v6.target)).to.equal(0n);
    });

    it('[F-R4] a transient failure AFTER the approval leaves a dangling allowance unless the SDK cleans up', async () => {
        await onboardOnChain(d, d.borrower);
        // Let onboarding + collateral approval through, then break requestLoan.
        transport.addRule({
            name: 'break-requestLoan',
            times: 20,
            match: (m, p) => (m === 'eth_estimateGas' || m === 'eth_call') && p[0] &&
                String(p[0].to).toLowerCase() === String(d.v6.target).toLowerCase() &&
                String(p[0].data || '').startsWith(sel(d.v6, 'requestLoan')),
            act: () => ({ throw: rpcError(503) }),
        });
        let err = null;
        try { await sdk.borrow(100, 7); } catch (e) { err = e; }
        expect(err).to.not.equal(null);
        expect(approvals.some((a) => a === USDC(100)), 'the collateral approval did go out').to.equal(true);
        const dangling = await d.usdc.allowance(wallet.address, d.v6.target);
        expect(dangling, 'a failed borrow must not leave the marketplace able to pull collateral').to.equal(0n);
    });

    // ---------------------------------------------------------------- staleness

    it('[F-R5] a replica serving state behind head must be NOTICED, not silently acted on', async () => {
        await onboardOnChain(d, d.borrower, 50_000);
        const { loanId } = await sdk.borrow(1000, 7);
        await time.increase(20 * DAY);
        await mine();
        const truth = await d.v6.previewRepayment(loanId);
        // A healthy call first — this is the head the SDK has observed.
        await sdk._repayApproval(loanId);

        // Now the endpoint load-balances onto a replica 2 blocks behind, i.e.
        // before the 20-day jump, so the loan reads as on-time and cheap.
        transport.addRule(staleReads(2));

        let err = null, pv = null;
        try { pv = await sdk._repayApproval(loanId); } catch (e) { err = e; }
        if (!err) {
            throw new Error(
                `SDK sized an approval from stale state: approve=${pv.approve} but the chain will pull ${truth.total}`);
        }
        expect(err.message).to.match(/stale|behind|lag/i);
    });

    it('a healthy RPC is not falsely accused of being stale', async () => {
        await onboardOnChain(d, d.borrower, 50_000);
        const { loanId } = await sdk.borrow(1000, 7);
        await time.increase(20 * DAY);
        const { approve } = await sdk._repayApproval(loanId);
        expect(approve).to.be.gt(0n);
        await sdk.repay(loanId);
        expect(Number((await d.v6.loans(loanId)).state)).to.equal(2);
    });

    // ------------------------------------------------------- inconsistent views

    it('inconsistent replicas (registry says registered, marketplace says not) are retried through', async () => {
        await d.registry.connect(d.borrower).register('ipfs://agent', []);
        await d.reputation.connect(d.borrower)['initializeReputation()']();
        // First two createAgentPool attempts revert "Not a registered agent" —
        // exactly the load-balanced-replica signature the SDK retries on.
        transport.addRule({
            name: 'stale-registry-view',
            times: 2,
            match: (m, p) => (m === 'eth_estimateGas' || m === 'eth_call') && p[0] &&
                String(p[0].to).toLowerCase() === String(d.v6.target).toLowerCase() &&
                String(p[0].data || '').startsWith(sel(d.v6, 'createAgentPool')),
            act: () => ({ throw: Object.assign(new Error('execution reverted: Not a registered agent'), {
                code: 'CALL_EXCEPTION', reason: 'Not a registered agent', data: revertData('Not a registered agent') }) }),
        });
        const out = await sdk.onboard();
        expect(out.agentId).to.be.greaterThan(0);
        expect((await d.v6.agentPools(out.agentId)).isActive).to.equal(true);
    });

    it('a persistently inconsistent replica eventually surfaces the revert instead of looping forever', async () => {
        await d.registry.connect(d.borrower).register('ipfs://agent', []);
        await d.reputation.connect(d.borrower)['initializeReputation()']();
        transport.addRule({
            name: 'always-stale',
            match: (m, p) => (m === 'eth_estimateGas' || m === 'eth_call') && p[0] &&
                String(p[0].to).toLowerCase() === String(d.v6.target).toLowerCase() &&
                String(p[0].data || '').startsWith(sel(d.v6, 'createAgentPool')),
            act: () => ({ throw: Object.assign(new Error('execution reverted: Not a registered agent'), {
                code: 'CALL_EXCEPTION', reason: 'Not a registered agent', data: revertData('Not a registered agent') }) }),
        });
        let err = null;
        try { await sdk.onboard(); } catch (e) { err = e; }
        expect(err).to.not.equal(null);
        expect(err.message).to.match(/Not a registered agent/);
    });

    // ------------------------------------------------------- connection dropped

    it('the connection dying inside tx.wait() never re-broadcasts the transaction', async () => {
        await onboardOnChain(d, d.borrower);
        transport.addRule({
            name: 'kill-receipts',
            times: 200,
            match: (m) => m === 'eth_getTransactionReceipt',
            act: () => ({ throw: connectionDropped() }),
        });
        const sentBefore = transport.sent().length;
        let err = null;
        try { await sdk.borrow(100, 7); } catch (e) { err = e; }
        expect(err, 'a dropped connection must not read as success').to.not.equal(null);
        const sentAfter = transport.sent().length;
        // At most the approve (+ at most one borrow) — never the same write twice.
        const raw = transport.forwarded.filter((c) => c.method === 'eth_sendRawTransaction').map((c) => c.params[0]);
        expect(new Set(raw).size, 'no duplicate raw transactions').to.equal(raw.length);
        expect(sentAfter - sentBefore).to.be.lessThan(4);
    });

    // -------------------------------------------- submitted but receipt missing

    it('[F-R6] a lost send response on repay must not be reported as failure when the repay actually mined', async () => {
        await onboardOnChain(d, d.borrower, 50_000);
        const { loanId } = await sdk.borrow(1000, 7);
        await time.increase(2 * DAY);
        // Approve first so only the repayLoan send is affected.
        const { approve } = await sdk._repayApproval(loanId);
        await sdk._approveExact(approve);
        transport.addRule(sendThenLoseResponse(1));

        let err = null, hash = null;
        try { hash = await sdk.repay(loanId); } catch (e) { err = e; }
        const state = Number((await d.v6.loans(loanId)).state);
        expect(state, 'the repay really did mine').to.equal(2);
        if (err) {
            throw new Error(
                'repay() threw although the loan is REPAID on chain — an unattended agent will retry and be told ' +
                `"Loan not active", or worse, treat the loan as outstanding. err=${err.shortMessage || err.message}`);
        }
        // Contract: a tx hash, or null when the repay is confirmed settled but the
        // hash was never learned. Never an exception on a settled loan.
        expect(hash === null || typeof hash === 'string').to.equal(true);
    });

    it('[F-R8] a receipt that never arrives times out instead of hanging the agent forever', async () => {
        await onboardOnChain(d, d.borrower, 50_000);
        const { loanId } = await sdk.borrow(1000, 7);
        await time.increase(2 * DAY);
        const { approve } = await sdk._repayApproval(loanId);
        await sdk._approveExact(approve);
        sdk.receiptTimeoutMs = 3000;
        transport.addRule(swallowReceipts(10000));
        // …and the loan view is dead too, so nothing can be reconciled.
        transport.addRule({
            name: 'kill-loans-view', times: 10000,
            match: (m, p) => m === 'eth_call' && p[0] &&
                String(p[0].data || '').startsWith(sel(d.v6, 'loans')),
            act: () => ({ throw: timeoutError() }),
        });
        const started = Date.now();
        let err = null;
        try { await sdk.repay(loanId); } catch (e) { err = e; }
        const elapsed = Date.now() - started;
        expect(err, 'must surface, not hang').to.not.equal(null);
        expect(elapsed, 'bounded by receiptTimeoutMs — pre-fix this never returned').to.be.lessThan(120000);
    });

    it('a repay whose receipt never arrives does not double-submit', async () => {
        await onboardOnChain(d, d.borrower, 50_000);
        const { loanId } = await sdk.borrow(1000, 7);
        await time.increase(2 * DAY);
        const { approve } = await sdk._repayApproval(loanId);
        await sdk._approveExact(approve);
        const before = transport.forwarded.filter((c) => c.method === 'eth_sendRawTransaction').length;
        sdk.receiptTimeoutMs = 3000;
        transport.addRule(swallowReceipts(10000));
        try { await sdk.repay(loanId); } catch (_) { /* expected: no receipt */ }
        const after = transport.forwarded.filter((c) => c.method === 'eth_sendRawTransaction').length;
        expect(after - before, 'exactly one repay broadcast').to.be.lessThan(2);
    });

    // -------------------------------------------------------------------- reorg

    it('[F-R7] a reorg that un-mines a repay: the SDK must not keep reporting it as settled', async () => {
        await onboardOnChain(d, d.borrower, 50_000);
        const { loanId } = await sdk.borrow(1000, 7);
        await time.increase(2 * DAY);
        const snap = await hre.network.provider.send('evm_snapshot');
        await sdk.repay(loanId);
        expect(Number((await d.v6.loans(loanId)).state)).to.equal(2);

        // …and the chain reorgs that block away.
        await hre.network.provider.send('evm_revert', [snap]);
        expect(Number((await d.v6.loans(loanId)).state), 'the repay is gone on chain').to.equal(1);

        // A fresh read through the SDK must reflect reality, not a cached belief.
        const pv = await sdk.previewRepayment(loanId);
        expect(pv.total).to.be.gt(0n);
        // And the SDK must notice the head went backwards rather than sizing
        // money from observations that no longer exist.
        let err = null;
        try { await sdk._assertChainNotBehind('reorg-check'); } catch (e) { err = e; }
        expect(err, 'the SDK must flag that the observed head moved backwards').to.not.equal(null);
        expect(err.message).to.match(/behind|reorg|stale/i);
    });
});
