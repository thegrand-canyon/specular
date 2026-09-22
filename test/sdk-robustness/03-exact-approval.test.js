/**
 * EXACT-APPROVAL AUDIT — every USDC-pulling path, success and failure.
 *
 * The 2026-07 audit (M2) replaced blanket MaxUint256 approvals with exact,
 * just-in-time ones. This suite is the exhaustive check of that property across
 * V6.1, including the new late-repay headroom logic and every failure path,
 * and asserts the resting allowance is ZERO after each operation.
 */

const { expect } = require('chai');
const { ethers } = require('ethers');
const { time } = require('@nomicfoundation/hardhat-network-helpers');
const { deployV61, onboardOnChain, makeSdk, raiseScoreTo, USDC, DAY } = require('./helpers/stack');
const { makeFaultyProvider, rpcError, sel } = require('./helpers/faultProvider');
const { walletAt } = require('./helpers/wallets');
const { SpecularQuickstart } = require('../../src/sdk/SpecularQuickstart.js');

const interestSec = SpecularQuickstart.interestForSeconds;

describe('exact-approval audit (every USDC-pulling path)', function () {
    this.timeout(240000);

    let d, provider, transport, wallet, sdk, approvals, agentId;

    const allowance = () => d.usdc.allowance(wallet.address, d.v6.target);
    const assertNeverUnlimited = () => {
        for (const a of approvals) {
            expect(a, 'no approval may be MaxUint256').to.not.equal(ethers.MaxUint256);
            expect(a, 'no approval may exceed the wallet balance').to.be.lte(USDC(50_000));
        }
    };

    beforeEach(async () => {
        d = await deployV61();
        agentId = await onboardOnChain(d, d.borrower, 50_000);
        ({ provider, transport } = makeFaultyProvider());
        wallet = walletAt(1, provider);
        ({ sdk, approvals } = makeSdk(wallet, d));
    });

    it('borrow @ 100% collateral tier: approves exactly the collateral, resting allowance 0', async () => {
        const pct = await d.reputation.calculateCollateralRequirement(wallet.address);
        expect(pct).to.equal(100n);
        await sdk.borrow(250, 7);
        expect(approvals).to.deep.equal([USDC(250)]);
        expect(await allowance(), 'collateral fully consumed').to.equal(0n);
        assertNeverUnlimited();
    });

    it('borrow @ 0% collateral tier: approves nothing at all', async () => {
        const score = await raiseScoreTo(d, wallet.address, 650);
        expect(score).to.be.gte(600);
        expect(await d.reputation.calculateCollateralRequirement(wallet.address)).to.equal(0n);
        await sdk.borrow(250, 7);
        expect(approvals, 'a 0%-collateral borrow must send no approve at all').to.deep.equal([]);
        expect(await allowance()).to.equal(0n);
    });

    it('repay on time: approves exactly principal + nominal interest, resting allowance 0', async () => {
        const { loanId } = await sdk.borrow(1000, 7);
        approvals.length = 0;
        await time.increase(2 * DAY);
        const pv = await sdk.previewRepayment(loanId);
        await sdk.repay(loanId);
        expect(approvals).to.deep.equal([pv.total]);
        expect(await allowance()).to.equal(0n);
        assertNeverUnlimited();
    });

    it('repay LATE: bounded headroom only, clamped by the contract cap, leftover revoked to 0', async () => {
        const { loanId } = await sdk.borrow(1000, 7);
        approvals.length = 0;
        await time.increase(20 * DAY);
        const pv = await sdk.previewRepayment(loanId);
        const { approve, headroom } = await sdk._repayApproval(loanId);
        const capTotal = USDC(1000) + interestSec(USDC(1000), 1500n, BigInt(37 * DAY));
        expect(headroom).to.be.gt(0n);
        expect(approve).to.equal(pv.total + headroom);
        expect(approve).to.be.lte(capTotal, 'never more than the contract could ever pull');

        await sdk.repay(loanId);
        expect(approvals[0]).to.equal(approve);
        expect(approvals[approvals.length - 1], 'leftover revoked').to.equal(0n);
        expect(await allowance()).to.equal(0n);
        assertNeverUnlimited();
    });

    it('repay AT the 30-day interest cap: constant amount, exact approval, no headroom', async () => {
        const { loanId } = await sdk.borrow(1000, 7);
        approvals.length = 0;
        await time.increase(307 * DAY);
        const { approve, headroom, preview } = await sdk._repayApproval(loanId);
        expect(headroom).to.equal(0n);
        expect(approve).to.equal(preview.total);
        await sdk.repay(loanId);
        expect(approvals).to.deep.equal([approve]);
        expect(await allowance()).to.equal(0n);
    });

    it('supply: approves exactly the supplied amount, resting allowance 0', async () => {
        const lw = walletAt(2, provider);
        const { sdk: lsdk, approvals: la } = makeSdk(lw, d);
        await lsdk.supply(agentId, 123.456789);
        expect(la).to.deep.equal([USDC('123.456789')]);
        expect(await d.usdc.allowance(lw.address, d.v6.target)).to.equal(0n);
    });

    it('withdraw and claim pull nothing from the caller — no approval is ever sent', async () => {
        const lw = walletAt(2, provider);
        const { sdk: lsdk, approvals: la } = makeSdk(lw, d);
        await lsdk.supply(agentId, 100);
        la.length = 0;
        await lsdk.withdraw(agentId, 50);
        expect(la, 'withdraw must not approve').to.deep.equal([]);
        let claimErr = null;
        try { await lsdk.claim(agentId); } catch (e) { claimErr = e; }
        expect(la, 'claim must not approve').to.deep.equal([]);
        void claimErr; // "No interest to claim" is a fine outcome here
        expect(await d.usdc.allowance(lw.address, d.v6.target)).to.equal(0n);
    });

    it('[F-R4] a borrow that fails after approving leaves NO allowance', async () => {
        transport.addRule({
            name: 'break-requestLoan', times: 50,
            match: (m, p) => (m === 'eth_estimateGas' || m === 'eth_call') && p[0] &&
                String(p[0].to).toLowerCase() === String(d.v6.target).toLowerCase() &&
                String(p[0].data || '').startsWith(sel(d.v6, 'requestLoan')),
            act: () => ({ throw: rpcError(503) }),
        });
        let err = null;
        try { await sdk.borrow(100, 7); } catch (e) { err = e; }
        expect(err).to.not.equal(null);
        expect(await allowance()).to.equal(0n);
    });

    it('[F-R4] a supply that fails after approving leaves NO allowance', async () => {
        const lw = walletAt(2, provider);
        const { sdk: lsdk } = makeSdk(lw, d);
        transport.addRule({
            name: 'break-supply', times: 50,
            match: (m, p) => (m === 'eth_estimateGas' || m === 'eth_call') && p[0] &&
                String(p[0].to).toLowerCase() === String(d.v6.target).toLowerCase() &&
                String(p[0].data || '').startsWith(sel(d.v6, 'supplyLiquidity')),
            act: () => ({ throw: rpcError(503) }),
        });
        let err = null;
        try { await lsdk.supply(agentId, 100); } catch (e) { err = e; }
        expect(err).to.not.equal(null);
        expect(await d.usdc.allowance(lw.address, d.v6.target)).to.equal(0n);
    });

    it('[F-R4] a repay that fails after approving leaves NO allowance', async () => {
        const { loanId } = await sdk.borrow(1000, 7);
        await time.increase(2 * DAY);
        transport.addRule({
            name: 'break-repay', times: 50,
            match: (m, p) => (m === 'eth_estimateGas') && p[0] &&
                String(p[0].data || '').startsWith(sel(d.v6, 'repayLoan')),
            act: () => ({ throw: rpcError(503) }),
        });
        let err = null;
        try { await sdk.repay(loanId); } catch (e) { err = e; }
        expect(err).to.not.equal(null);
        expect(await allowance()).to.equal(0n);
    });

    it('[F-R15] a pre-existing UNLIMITED allowance is tightened to the exact amount, not carried forward', async () => {
        // e.g. left by an older SDK version, or a crashed session.
        await d.usdc.connect(d.borrower).approve(d.v6.target, ethers.MaxUint256);
        expect(await allowance()).to.equal(ethers.MaxUint256);
        await sdk.borrow(100, 7);
        expect(await allowance(), 'the unlimited allowance must not survive the operation').to.equal(0n);
        for (const a of approvals) expect(a).to.not.equal(ethers.MaxUint256);
    });

    it('[F-R15] a pre-existing over-large (but finite) allowance is reduced to exactly what the op needs', async () => {
        await d.usdc.connect(d.borrower).approve(d.v6.target, USDC(40_000));
        await sdk.borrow(100, 7);
        expect(approvals[0]).to.equal(USDC(100));
        expect(await allowance()).to.equal(0n);
    });

    it('a full lifecycle leaves the wallet with zero standing allowance', async () => {
        const lw = walletAt(2, provider);
        const { sdk: lsdk } = makeSdk(lw, d);
        await lsdk.supply(agentId, 500);
        const { loanId } = await sdk.borrow(200, 7);
        await time.increase(9 * DAY);
        await sdk.repay(loanId);
        try { await lsdk.claim(agentId); } catch (_) { /* may be nothing to claim */ }
        await lsdk.withdraw(agentId, 100);
        expect(await allowance()).to.equal(0n);
        expect(await d.usdc.allowance(lw.address, d.v6.target)).to.equal(0n);
    });
});
