// F-01 [HIGH] — Borrower can freeze an ACTIVE loan (un-repayable AND un-liquidatable)
// by transferring their agent NFT away, and un-freeze it by transferring it back.
//
// Mechanism (V6, pre-fix): repayLoan() -> reputationManager.recordLoanCompletion(loan.borrower, ...)
//            liquidateLoan() -> reputationManager.recordDefault(loan.borrower, ...)
// Both resolve the agent via agentRegistry.addressToAgentId(borrower) and
// `require(agentId != 0, "Not an agent")`. AgentRegistryV2._update deletes
// addressToAgentId[from] on transfer, so after the borrower moves the NFT to any
// fresh address both terminal transitions revert.
//
// FIXED in V6.1 (2026-09-19): the closing path resolves the agent by loan.agentId
// (registry ownerOf, whose holder always maps back to the id). Repay is allowed from
// the original borrower OR the current NFT holder; collateral returns to loan.borrower.
//
// CONVENTION: the two primary tests assert the SECURE property -> FAILING = CONFIRMED.
// [2026-09 fix round] Restructured to open TWO loans so that liquidating one does
// not make the repay test trivially fail with "Loan not active".

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { deployLaunchStack, USDC, DAY } = require("./_fixture");

describe("F-01 [HIGH] agent NFT transfer freezes an active loan", function () {
    this.timeout(120000);
    let f, borrower, lender, parkingWallet, agentId, loanToLiquidate, loanToRepay;

    before(async () => {
        f = await deployLaunchStack();
        [, borrower, lender, parkingWallet] = f.signers;
        await f.fund(borrower); await f.fund(lender);
        agentId = await f.onboardAgent(borrower);
        await f.v6.connect(lender).supplyLiquidity(agentId, USDC(1000));
        // score 100 tier: 100% collateral, 1,000 USDC limit. Two 500-USDC loans.
        loanToLiquidate = await f.v6.nextLoanId();
        await f.v6.connect(borrower).requestLoan(USDC(500), 7);
        loanToRepay = await f.v6.nextLoanId();
        await f.v6.connect(borrower).requestLoan(USDC(500), 7);
        expect((await f.v6.loans(loanToLiquidate)).state).to.equal(1n); // ACTIVE
        expect((await f.v6.loans(loanToRepay)).state).to.equal(1n);

        // Borrower parks the NFT in a fresh wallet (any address without an agent is accepted).
        await f.registry.connect(borrower).transferFrom(borrower.address, parkingWallet.address, agentId);
        expect(await f.registry.addressToAgentId(borrower.address)).to.equal(0n);
        await f.time.increase(8 * DAY); // loans are now overdue
    });

    it("SECURE PROPERTY: owner can still liquidate an overdue loan after the borrower transfers the NFT", async () => {
        await expect(f.v6.liquidateLoan(loanToLiquidate)).to.not.be.reverted;
    });

    it("SECURE PROPERTY: borrower can still repay after transferring the NFT", async () => {
        await expect(f.v6.connect(borrower).repayLoan(loanToRepay)).to.not.be.reverted;
    });

    it("[demonstration, passes] both loans reached a terminal state with the NFT parked elsewhere; accounting and identity are consistent", async () => {
        expect((await f.v6.loans(loanToLiquidate)).state).to.equal(3n); // DEFAULTED
        expect((await f.v6.loans(loanToRepay)).state).to.equal(2n);     // REPAID
        const pool = await f.v6.getAgentPool(agentId);
        expect(pool.totalLoaned).to.equal(0n);
        expect(await f.v6.outstandingPrincipal(agentId)).to.equal(0n);
        expect(await f.v6.activeLoanCount(agentId)).to.equal(0n);
        expect((await f.v6.getActiveLoanIds(agentId)).length).to.equal(0);

        // Reputation was recorded against the AGENT ID (the NFT's current holder maps to it),
        // not against the historical borrower address (which is no longer an agent).
        expect(await f.reputation.defaultCount(agentId)).to.equal(1n);
        expect(await f.registry.addressToAgentId(borrower.address)).to.equal(0n);

        // Collateral of the repaid loan went back to the ORIGINAL borrower, not the parking wallet.
        expect(await f.usdc.balanceOf(parkingWallet.address)).to.equal(0n);

        // The repay was ~1 day late on a 7-day term → charged elapsed (8 days + tx clock drift) of interest (F-03), no bonus.
        const rec = await f.v6.repayments(loanToRepay);
        const loan = await f.v6.loans(loanToRepay);
        expect(rec.lateSeconds).to.be.gte(BigInt(DAY)).and.lt(BigInt(DAY + 60));
        expect(rec.lateSeconds).to.equal(rec.repaidAt - loan.endTime);
        const annual = (USDC(500) * 1500n) / 10000n;
        expect(rec.interestPaid).to.equal((annual * (loan.duration + rec.lateSeconds)) / BigInt(365 * DAY));
        expect(rec.interestPaid).to.be.gt(f.interestFor(USDC(500), 1500, 7));

        const { bal, rhs } = await f.solvent([agentId]);
        expect(bal).to.equal(rhs); // global solvency intact
    });
});
