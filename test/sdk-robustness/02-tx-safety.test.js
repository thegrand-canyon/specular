/**
 * TRANSACTION SAFETY.
 *
 *  - nonce handling when one wallet fires several SDK operations at once
 *  - gas-estimation failure paths
 *  - a tx that reverts on chain after a successful estimate
 *  - underpriced / stuck tx behaviour
 *  - never double-submitting a write
 */

const { expect } = require('chai');
const { ethers } = require('ethers');
const { time } = require('@nomicfoundation/hardhat-network-helpers');
const { deployV61, onboardOnChain, makeSdk, USDC, DAY } = require('./helpers/stack');
const { makeFaultyProvider, rpcError, sel, revertData } = require('./helpers/faultProvider');
const { walletAt } = require('./helpers/wallets');

describe('transaction safety', function () {
    this.timeout(240000);

    let d, provider, transport, wallet, sdk;

    beforeEach(async () => {
        d = await deployV61();
        ({ provider, transport } = makeFaultyProvider());
        wallet = walletAt(1, provider);
        ({ sdk } = makeSdk(wallet, d));
    });

    it('[F-R10] concurrent operations from ONE wallet must not collide on the nonce or be silently dropped', async () => {
        const agentId = await onboardOnChain(d, d.borrower, 50_000);
        const { loanId } = await sdk.borrow(500, 7);
        await time.increase(2 * DAY);

        const results = await Promise.allSettled([
            sdk.supply(agentId, 25),
            sdk.repay(loanId),
            sdk.borrow(50, 7),
        ]);
        const failures = results
            .map((r, i) => ({ i, r }))
            .filter(({ r }) => r.status === 'rejected')
            .map(({ i, r }) => `#${i}: ${r.reason && (r.reason.shortMessage || r.reason.message)}`);
        expect(failures, `concurrent SDK ops collided: ${failures.join(' | ')}`).to.deep.equal([]);
        expect(Number((await d.v6.loans(loanId)).state), 'repay must have landed').to.equal(2);

        // Every broadcast must be a distinct, gap-free nonce.
        const raw = transport.forwarded
            .filter((c) => c.method === 'eth_sendRawTransaction')
            .map((c) => ethers.Transaction.from(c.params[0]))
            .filter((t) => t.from && t.from.toLowerCase() === wallet.address.toLowerCase())
            .map((t) => t.nonce);
        expect(new Set(raw).size, `duplicate nonces broadcast: ${raw.join(',')}`).to.equal(raw.length);
    });

    it('two concurrent borrows do not produce a nonce clash', async () => {
        await onboardOnChain(d, d.borrower, 50_000);
        const results = await Promise.allSettled([sdk.borrow(100, 7), sdk.borrow(100, 7)]);
        const rejected = results.filter((r) => r.status === 'rejected');
        for (const r of rejected) {
            const m = r.reason && (r.reason.shortMessage || r.reason.message) || '';
            expect(m, `a concurrent borrow failed on a nonce/broadcast problem: ${m}`)
                .to.not.match(/nonce|replacement|already known|underpriced/i);
        }
    });

    it('a gas-estimation failure surfaces and broadcasts nothing', async () => {
        await onboardOnChain(d, d.borrower, 50_000);
        const before = transport.forwarded.filter((c) => c.method === 'eth_sendRawTransaction').length;
        transport.addRule({
            name: 'estimate-500', times: 50,
            match: (m) => m === 'eth_estimateGas',
            act: () => ({ throw: rpcError(500) }),
        });
        let err = null;
        try { await sdk.supply(1, 10); } catch (e) { err = e; }
        expect(err).to.not.equal(null);
        const after = transport.forwarded.filter((c) => c.method === 'eth_sendRawTransaction').length;
        expect(after - before, 'estimation failure must not broadcast').to.equal(0);
    });

    it('[F-R11] a tx that reverts ON CHAIN after a successful estimate is never reported as success', async () => {
        await onboardOnChain(d, d.borrower, 50_000);
        const { loanId } = await sdk.borrow(100, 7);
        await time.increase(2 * DAY);
        const { approve } = await sdk._repayApproval(loanId);
        await sdk._approveExact(approve);

        // The estimate passes (canned), but between estimate and mining the loan
        // is repaid by someone else, so repayLoan reverts "Loan not active".
        transport.addRule({
            name: 'fake-estimate', times: 50,
            match: (m, p) => m === 'eth_estimateGas' && p[0] &&
                String(p[0].data || '').startsWith(sel(d.v6, 'repayLoan')),
            act: async ({ base }) => {
                // someone else settles the loan first
                await base.request({ method: 'evm_setAutomine', params: [true] });
                return { result: '0x7a120' }; // 500k gas
            },
        });
        await d.usdc.connect(d.lender).approve(d.v6.target, ethers.MaxUint256);
        await d.v6.connect(d.borrower).repayLoan(loanId); // front-run by the agent's own other process

        let err = null, out = null;
        try { out = await sdk.repay(loanId); } catch (e) { err = e; }
        expect(err, `repay returned ${out} for an already-settled loan instead of failing`).to.not.equal(null);
        expect(Number((await d.v6.loans(loanId)).state)).to.equal(2);
    });

    it('an underpriced/rejected broadcast surfaces without resending', async () => {
        await onboardOnChain(d, d.borrower, 50_000);
        const before = transport.forwarded.filter((c) => c.method === 'eth_sendRawTransaction').length;
        transport.addRule({
            name: 'underpriced', times: 50,
            match: (m) => m === 'eth_sendRawTransaction',
            act: () => ({ throw: Object.assign(new Error('replacement transaction underpriced'), {
                code: 'REPLACEMENT_UNDERPRICED' }) }),
        });
        let err = null;
        try { await sdk.supply(1, 10); } catch (e) { err = e; }
        expect(err).to.not.equal(null);
        const raw = transport.forwarded.filter((c) => c.method === 'eth_sendRawTransaction').slice(before);
        expect(new Set(raw.map((c) => c.params[0])).size, 'no duplicate broadcast on rejection').to.equal(raw.length);
    });

    it('a revert with a reason string is terminal — the SDK does not retry it into a second tx', async () => {
        await onboardOnChain(d, d.borrower, 50_000);
        const before = transport.forwarded.filter((c) => c.method === 'eth_sendRawTransaction').length;
        transport.addRule({
            name: 'hard-revert', times: 50,
            match: (m, p) => (m === 'eth_estimateGas' || m === 'eth_call') && p[0] &&
                String(p[0].data || '').startsWith(sel(d.v6, 'supplyLiquidity')),
            act: () => ({ throw: Object.assign(new Error('execution reverted: Pool not active'), {
                code: 'CALL_EXCEPTION', reason: 'Pool not active', data: revertData('Pool not active') }) }),
        });
        let err = null;
        try { await sdk.supply(1, 10); } catch (e) { err = e; }
        expect(err).to.not.equal(null);
        expect(err.message).to.match(/Pool not active/);
        // The approve (and its cleanup revoke) may be broadcast, but never the
        // reverting call itself, and no allowance may survive.
        const supplyCalls = transport.forwarded
            .filter((c) => c.method === 'eth_sendRawTransaction')
            .slice(before)
            .map((c) => ethers.Transaction.from(c.params[0]))
            .filter((t) => (t.data || '').startsWith(sel(d.v6, 'supplyLiquidity')));
        expect(supplyCalls.length, 'the reverting call must not be broadcast').to.equal(0);
        expect(await d.usdc.allowance(wallet.address, d.v6.target), 'and leave no allowance behind').to.equal(0n);
    });

    void USDC;
});
