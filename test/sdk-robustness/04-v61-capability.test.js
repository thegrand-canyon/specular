/**
 * V6.1 CORRECTNESS UNDER FAILURE.
 *
 * V6.1 made `repayLoan` charge interest on max(duration, elapsed) capped at
 * duration + LATE_INTEREST_CAP, so for a LATE loan the contract pulls strictly
 * more than principal + nominal interest. The SDK sizes its EXACT approval from
 * `previewRepayment`, gated on capability detection (`VERSION()`).
 *
 * Capability detection is therefore money-critical: if a *transient* RPC error
 * is mistaken for a *missing selector*, the SDK silently downgrades to V6
 * semantics and under-approves a late repayment — the repay then reverts and
 * the agent cannot close its loan at all (it defaults).
 */

const { expect } = require('chai');
const { ethers } = require('ethers');
const { time } = require('@nomicfoundation/hardhat-network-helpers');
const { deployV61, onboardOnChain, makeSdk, v60Abi, USDC, DAY } = require('./helpers/stack');
const { makeFaultyProvider, failCall, rpcError, timeoutError, sel } = require('./helpers/faultProvider');
const { walletAt } = require('./helpers/wallets');
const { SpecularQuickstart } = require('../../src/sdk/SpecularQuickstart.js');

const interestSec = SpecularQuickstart.interestForSeconds;
const RATE = 1500n;           // score-0 tier: 15% APR
const P = USDC(1000);
const DUR = BigInt(7 * DAY);

describe('V6.1 under failure — capability detection must not mis-approve', function () {
    this.timeout(180000);

    let d, provider, transport, wallet, sdk, approvals, loanId;

    beforeEach(async () => {
        d = await deployV61();
        await onboardOnChain(d, d.borrower, 50_000);
        ({ provider, transport } = makeFaultyProvider());
        wallet = walletAt(1, provider);
        ({ sdk, approvals } = makeSdk(wallet, d));
        const r = await sdk.borrow(1000, 7);
        loanId = r.loanId;
        approvals.length = 0;
        sdk._mpVersion = undefined; // forget detection done during borrow
    });

    const capTotal = () => P + interestSec(P, RATE, DUR + BigInt(30 * DAY));
    const nominalTotal = () => P + interestSec(P, RATE, DUR);

    it('[F-R1] a transient 500 on VERSION() must not be cached as "this is a V6 deployment"', async () => {
        transport.addRule(failCall(d.v6.target, sel(d.v6, 'VERSION'), rpcError(500), 1));
        let v;
        try {
            v = await sdk.marketplaceVersion();
        } catch (e) {
            // Failing closed is acceptable; silently reporting V6 is not.
            expect(e.message).to.match(/version|VERSION|RPC/i);
            return;
        }
        expect(v, 'transient RPC failure must not downgrade a V6.1 deployment to V6').to.equal('V6.1');
    });

    it('[F-R1] poisoned detection under-approves a LATE repay and the loan cannot be closed', async () => {
        await time.increase(20 * DAY); // 13 days late on a 7-day term
        transport.addRule(failCall(d.v6.target, sel(d.v6, 'VERSION'), timeoutError(), 1));

        let repayErr = null;
        try {
            await sdk.repay(loanId);
        } catch (e) { repayErr = e; }

        if (repayErr) {
            // Pre-fix signature: SDK thought it was V6, approved the nominal
            // figure, and the contract's larger pull blew the allowance.
            throw new Error(
                `repay() failed after a single transient VERSION() error: ${repayErr.shortMessage || repayErr.message}. ` +
                `approvals=[${approvals.join(',')}] nominal=${nominalTotal()}`
            );
        }
        expect(Number((await d.v6.loans(loanId)).state), 'loan must be REPAID').to.equal(2);
        const approved = approvals.filter((a) => a > 0n);
        for (const a of approved) {
            expect(a).to.be.gte(nominalTotal());
            expect(a).to.be.lte(capTotal(), 'approval must stay bounded by the contract cap');
            expect(a).to.not.equal(ethers.MaxUint256);
        }
    });

    it('[F-R2] a transient error on previewRepayment() must not silently fall back to the nominal figure', async () => {
        await time.increase(20 * DAY);
        expect(await sdk.marketplaceVersion()).to.equal('V6.1');
        const truth = await d.v6.previewRepayment(loanId);
        transport.addRule(failCall(d.v6.target, sel(d.v6, 'previewRepayment'), rpcError(429), 1));

        let pv = null, err = null;
        try { pv = await sdk.previewRepayment(loanId); } catch (e) { err = e; }
        if (err) return; // failing closed is fine
        expect(pv.source, 'a 429 is not a missing selector').to.equal('previewRepayment');
        expect(pv.total).to.be.gte(truth.total);
    });

    it('[F-R2] the same transient error must not under-approve the repay', async () => {
        await time.increase(20 * DAY);
        await sdk.marketplaceVersion();
        transport.addRule(failCall(d.v6.target, sel(d.v6, 'previewRepayment'), rpcError(429), 1));
        await sdk.repay(loanId);
        expect(Number((await d.v6.loans(loanId)).state)).to.equal(2);
        const approved = approvals.filter((a) => a > 0n);
        expect(approved.length, 'should not need a second corrective approval').to.equal(1);
        expect(approved[0]).to.be.gt(nominalTotal());
        expect(approved[0]).to.be.lte(capTotal());
    });

    it('a genuine V6.0 deployment (selectors absent) is detected and never mis-approves', async () => {
        const { sdk: old, approvals: oldApprovals } = makeSdk(wallet, d, { marketplaceAbi: v60Abi(d.v6) });
        expect(await old.marketplaceVersion()).to.equal('V6');
        const pv = await old.previewRepayment(loanId);
        expect(pv.source).to.equal('calculateInterest');
        expect(pv.total).to.equal(nominalTotal());
        expect(await old.canTopUp(1)).to.equal(true);
        await time.increase(2 * DAY); // still on time: V6 figure is exact
        await old.repay(loanId);
        expect(oldApprovals).to.deep.equal([nominalTotal()]);
        expect(Number((await d.v6.loans(loanId)).state)).to.equal(2);
        expect(await d.usdc.allowance(wallet.address, d.v6.target)).to.equal(0n);
    });

    it('the REAL production shape — V6.0 bytecode on chain, V6.1 ABI in the SDK — is detected from the code, not from a failing call', async () => {
        // The SDK always ships the newest ABI, so `this.marketplace.VERSION` exists
        // as a fragment even against a V6.0 deployment. Detection must come from
        // eth_getCode. Simulate V6.0 bytecode by stripping the V6.1 selectors.
        const strip = ['VERSION', 'previewRepayment', 'canTopUp', 'getActiveLoanIds']
            .map((n) => sel(d.v6, n).slice(2).toLowerCase());
        transport.addRule({
            name: 'v6.0-bytecode',
            match: (m, p) => m === 'eth_getCode' && String(p[0]).toLowerCase() === String(d.v6.target).toLowerCase(),
            act: async ({ params, base }) => {
                let code = String(await base.request({ method: 'eth_getCode', params })).toLowerCase();
                for (const s of strip) code = code.split(s).join('deadbeef');
                return { result: code };
            },
        });
        expect(await sdk.marketplaceVersion()).to.equal('V6');
        const pv = await sdk.previewRepayment(loanId);
        expect(pv.source).to.equal('calculateInterest');
        expect(pv.total).to.equal(nominalTotal());
        await time.increase(2 * DAY);
        await sdk.repay(loanId);
        expect(approvals).to.deep.equal([nominalTotal()]);
        expect(Number((await d.v6.loans(loanId)).state)).to.equal(2);
    });

    it('preview → accrual → repay race: the bounded headroom absorbs it, or the bump does; never unlimited', async () => {
        await time.increase(20 * DAY);
        const pv = await sdk.previewRepayment(loanId);
        const { approve } = await sdk._repayApproval(loanId);
        // Accrue PAST the 600s headroom between the preview and the send.
        await time.increase(3 * 3600);
        await sdk.repay(loanId);
        expect(Number((await d.v6.loans(loanId)).state)).to.equal(2);
        const rec = await d.v6.repayments(loanId);
        const pulled = P + rec.interestPaid;
        expect(pulled, 'contract really did charge more than the stale preview').to.be.gt(pv.total);
        for (const a of approvals) {
            expect(a).to.not.equal(ethers.MaxUint256);
            expect(a).to.be.lte(capTotal());
        }
        expect(await d.usdc.allowance(wallet.address, d.v6.target), 'no dangling allowance after a successful repay').to.equal(0n);
        void approve;
    });

    it('process dies between approve and repay: the residual allowance is bounded by the contract cap, never unlimited', async () => {
        await time.increase(20 * DAY);
        const { approve } = await sdk._repayApproval(loanId);
        await sdk._approveExact(approve); // …and then the agent process is killed
        const residual = await d.usdc.allowance(wallet.address, d.v6.target);
        expect(residual).to.equal(approve);
        expect(residual).to.not.equal(ethers.MaxUint256);
        expect(residual).to.be.lte(capTotal(), 'residual is capped at the most the contract could ever pull for this loan');
        // And it is spendable only by the marketplace, only for this loan's size.
        expect(residual).to.be.lt(await d.usdc.balanceOf(wallet.address));
    });

    it('a failing revoke leaves the loan repaid and the residual still bounded', async () => {
        await time.increase(20 * DAY);
        const { approve } = await sdk._repayApproval(loanId);
        // Make every approve(spender, 0) fail — the revoke path dies.
        const iface = new ethers.Interface(['function approve(address,uint256)']);
        const zeroApprove = iface.encodeFunctionData('approve', [d.v6.target, 0]).slice(0, 74); // selector+addr
        transport.addRule({
            name: 'revoke-fails',
            match: (m, p) => (m === 'eth_estimateGas' || m === 'eth_call') && p[0] &&
                String(p[0].to).toLowerCase() === String(d.usdc.target).toLowerCase() &&
                String(p[0].data || '').toLowerCase().startsWith(zeroApprove.toLowerCase()) &&
                /^0x0*$/.test(String(p[0].data).slice(74)),
            act: () => ({ throw: rpcError(500) }),
        });
        await sdk.repay(loanId);
        expect(Number((await d.v6.loans(loanId)).state)).to.equal(2);
        const residual = await d.usdc.allowance(wallet.address, d.v6.target);
        expect(residual).to.be.lte(approve);
        expect(residual).to.not.equal(ethers.MaxUint256);
    });

    it('canTopUp pre-check: "Top-up would forfeit in-flight interest" surfaces as an actionable SDK error, not a raw revert', async () => {
        // lender supplies, agent borrows against it, lender tries to top up
        const lw = walletAt(2, provider);
        const { sdk: lsdk } = makeSdk(lw, d);
        const agentId = Number(await d.registry.addressToAgentId(d.borrower.address));
        await lsdk.supply(agentId, 100);
        const can = await lsdk.canTopUp(agentId);
        if (!can) {
            let err = null;
            try { await lsdk.supply(agentId, 10); } catch (e) { err = e; }
            expect(err, 'supply must refuse before broadcasting').to.not.equal(null);
            expect(err.message).to.match(/forfeit in-flight interest/);
        }
    });
});
