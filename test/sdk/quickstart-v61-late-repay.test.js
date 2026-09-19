// V6.1 (2026-09 audit fixes, F-03): repayLoan charges interest on
// max(duration, elapsed) capped at duration + LATE_INTEREST_CAP, so a LATE loan
// pulls MORE than principal + nominal interest. SpecularQuickstart.repay() must
// size its EXACT approval from previewRepayment(loanId).total (never
// MaxUint256), with bounded headroom only while the amount is still accruing.
//
// Deploys the V6.1 stack on the local hardhat network, opens a loan through
// the SDK, time-travels it late, and records every approve() the SDK sends.

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { SpecularQuickstart } = require("../../src/sdk/SpecularQuickstart.js");

const USDC = (n) => ethers.parseUnits(n.toString(), 6);
const DAY = 86400;
const interestSec = SpecularQuickstart.interestForSeconds;

async function deployV61() {
    const [owner, borrower, lender] = await ethers.getSigners();
    const registry = await (await ethers.getContractFactory("AgentRegistryV2")).deploy();
    const reputation = await (await ethers.getContractFactory("ReputationManagerV3")).deploy(await registry.getAddress());
    const usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
    const v6 = await (await ethers.getContractFactory("AgentLiquidityMarketplaceV6")).deploy(
        await registry.getAddress(), await reputation.getAddress(), await usdc.getAddress());
    await reputation.authorizePool(await v6.getAddress());
    // Arc-mainnet launch levers
    await reputation.setReputationRateLimit(20, DAY);
    await v6.setMinHoldForReputationReward(DAY);
    await v6.setPlatformFeeRate(100);
    await v6.setBindBorrowToPoolCreator(true);
    await v6.setMinSupplyAmount(USDC(1));
    expect(await v6.VERSION()).to.equal("V6.1");

    // lender: funded + blanket approval (not under test); borrower: funded, NO approval
    await usdc.mint(lender.address, USDC(100_000));
    await usdc.connect(lender).approve(await v6.getAddress(), ethers.MaxUint256);
    await usdc.mint(borrower.address, USDC(5_000));

    // borrower onboarding (register + reputation + pool)
    await registry.connect(borrower).register("ipfs://agent", []);
    const agentId = await registry.addressToAgentId(borrower.address);
    await reputation.connect(borrower)["initializeReputation()"]();
    await v6.connect(borrower).createAgentPool();
    await v6.connect(lender).supplyLiquidity(agentId, USDC(10_000));

    return { owner, borrower, lender, registry, reputation, usdc, v6, agentId };
}

/** SpecularQuickstart wired to the local deployment (constructor needs a network config file). */
function sdkFor(signer, d, { marketplaceAbi } = {}) {
    const sdk = Object.create(SpecularQuickstart.prototype);
    sdk.wallet = signer;
    sdk.network = "local-v61";
    sdk.cfg = { decimals: 6, explorer: "" };
    sdk.addresses = { marketplace: d.v6.target, registry: d.registry.target, reputation: d.reputation.target, usdc: d.usdc.target };
    sdk.marketplace = marketplaceAbi ? new ethers.Contract(d.v6.target, marketplaceAbi, signer) : d.v6.connect(signer);
    sdk.registry = d.registry.connect(signer);
    sdk.reputation = d.reputation.connect(signer);
    const usdc = d.usdc.connect(signer);
    const approvals = [];
    sdk.usdc = {
        allowance: (o, s) => usdc.allowance(o, s),
        balanceOf: (a) => usdc.balanceOf(a),
        approve: async (spender, amount) => { approvals.push(amount); return usdc.approve(spender, amount); },
    };
    return { sdk, approvals };
}

describe("SpecularQuickstart.repay on V6.1 — approval sized from previewRepayment()", function () {
    this.timeout(180000);
    let d, sdk, approvals, loanId;
    const P = USDC(1000);
    const RATE = 1500n; // score 0 => 15% APR
    const DUR = BigInt(7 * DAY);

    beforeEach(async () => {
        d = await deployV61();
        ({ sdk, approvals } = sdkFor(d.borrower, d));
        expect(await sdk.marketplaceVersion()).to.equal("V6.1");
        const res = await sdk.borrow(1000, 7); // 100% collateral tier: SDK approves exactly 1000 for collateral
        loanId = res.loanId;
        expect(approvals).to.deep.equal([P]);
        approvals.length = 0;
        expect((await d.v6.loans(loanId)).interestRate).to.equal(RATE);
    });

    async function pulledFor(id) {
        const rec = await d.v6.repayments(id);
        return { pulled: P + rec.interestPaid, interestPaid: rec.interestPaid, lateSeconds: rec.lateSeconds };
    }

    it("on time (2 days in): approves exactly previewRepayment().total == principal + nominal interest, one approve, no leftover", async () => {
        await time.increase(2 * DAY);
        const pv = await sdk.previewRepayment(loanId);
        expect(pv.source).to.equal("previewRepayment");
        expect(pv.lateSeconds).to.equal(0n);
        expect(pv.total).to.equal(P + interestSec(P, RATE, DUR));

        await sdk.repay(loanId);

        expect(approvals).to.deep.equal([pv.total]);
        expect(Number((await d.v6.loans(loanId)).state)).to.equal(2); // REPAID
        expect((await pulledFor(loanId)).pulled).to.equal(pv.total);
        expect(await d.usdc.allowance(d.borrower.address, d.v6.target)).to.equal(0n);
    });

    it("10 days late on a 7-day term: approves previewRepayment().total + bounded headroom (< cap total), repay succeeds, leftover revoked", async () => {
        await time.increase(17 * DAY);
        const pv = await sdk.previewRepayment(loanId);
        expect(pv.lateSeconds).to.be.gt(0n);
        expect(pv.chargeableSeconds).to.be.gte(BigInt(17 * DAY));
        const nominalTotal = P + interestSec(P, RATE, DUR);
        expect(pv.total).to.be.gt(nominalTotal, "a late loan owes more than principal + nominal interest");

        // what the SDK itself computes, before any tx moves the clock
        const { approve, headroom } = await sdk._repayApproval(loanId);
        expect(headroom).to.be.gt(0n);
        expect(approve).to.equal(pv.total + headroom);
        const expectedHeadroom = interestSec(P, RATE, pv.chargeableSeconds + BigInt(SpecularQuickstart.LATE_REPAY_HEADROOM_SECONDS)) - pv.interest;
        expect(headroom).to.equal(expectedHeadroom);
        const capTotal = P + interestSec(P, RATE, DUR + BigInt(30 * DAY));
        expect(approve).to.be.lt(capTotal);
        expect(approve).to.not.equal(ethers.MaxUint256);

        await sdk.repay(loanId);

        // one bounded approve, then a revoke of the few base units the per-second accrual left over
        expect(approvals.length).to.equal(2);
        expect(approvals[0]).to.equal(approve);
        expect(approvals[1]).to.equal(0n);
        expect(Number((await d.v6.loans(loanId)).state)).to.equal(2);
        const { pulled, lateSeconds } = await pulledFor(loanId);
        expect(lateSeconds).to.be.gte(BigInt(10 * DAY));
        // the contract pulled the preview total plus a couple of seconds of accrual (approve + repay blocks), all inside the headroom
        expect(pulled).to.be.gte(pv.total);
        expect(pulled).to.be.lte(approve);
        expect(pulled - pv.total).to.be.lt(headroom);
        // the nominal-only approval the pre-V6.1 SDK made would have been short
        expect(pulled).to.be.gt(nominalTotal);
        expect(await d.usdc.allowance(d.borrower.address, d.v6.target)).to.equal(0n);
    });

    it("300 days late (at the 30-day cap): amount is constant, approves exactly previewRepayment().total, no revoke", async () => {
        await time.increase(307 * DAY);
        const pv = await sdk.previewRepayment(loanId);
        const capTotal = P + interestSec(P, RATE, DUR + BigInt(30 * DAY));
        expect(pv.chargeableSeconds).to.equal(DUR + BigInt(30 * DAY));
        expect(pv.total).to.equal(capTotal);
        const { approve, headroom } = await sdk._repayApproval(loanId);
        expect(headroom).to.equal(0n);
        expect(approve).to.equal(pv.total);

        await sdk.repay(loanId);

        expect(approvals).to.deep.equal([pv.total]);
        expect((await pulledFor(loanId)).pulled).to.equal(pv.total);
        expect(await d.usdc.allowance(d.borrower.address, d.v6.target)).to.equal(0n);
    });

    it("pre-V6.1 ABI (no VERSION/previewRepayment selectors): detects 'V6', falls back to the nominal figure, repay still succeeds on time", async () => {
        const v6Abi = d.v6.interface.fragments.filter((f) => !(f.type === "function" && ["VERSION", "previewRepayment", "canTopUp", "getActiveLoanIds", "LATE_INTEREST_CAP"].includes(f.name)));
        const { sdk: oldSdk, approvals: oldApprovals } = sdkFor(d.borrower, d, { marketplaceAbi: v6Abi });
        expect(await oldSdk.marketplaceVersion()).to.equal("V6");
        expect(await oldSdk.canTopUp(d.agentId)).to.equal(true);
        const pv = await oldSdk.previewRepayment(loanId);
        expect(pv.source).to.equal("calculateInterest");
        expect(pv.total).to.equal(P + interestSec(P, RATE, DUR));

        await oldSdk.repay(loanId);
        expect(oldApprovals).to.deep.equal([pv.total]);
        expect(Number((await d.v6.loans(loanId)).state)).to.equal(2);
    });

    it("activeLoanIds / canTopUp views: active set tracks the loan; a fresh lender is never refused", async () => {
        expect(await sdk.activeLoanIds(d.agentId)).to.deep.equal([loanId]);
        expect(await sdk.canTopUp(d.agentId, d.lender.address)).to.equal(true);
        const { sdk: lenderSdk } = sdkFor(d.lender, d);
        // top-up with no pending tranche and an open loan: case (b) — allowed, and supply() lets it through
        await lenderSdk.supply(d.agentId, 5);
        await sdk.repay(loanId);
        expect(await sdk.activeLoanIds(d.agentId)).to.deep.equal([]);
    });
});
