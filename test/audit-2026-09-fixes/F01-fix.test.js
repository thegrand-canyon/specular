// Regression tests for the F-01 fix (V6.1): the loan-closing path is keyed by
// loan.agentId, not by the historical borrower address.
//
// Repayer policy: original borrower OR current NFT holder may repay; collateral is
// always returned to loan.borrower (the address that posted it). liquidateLoan never
// depends on the borrower address being registered.

const { expect } = require("chai");
const { deployLaunchStack, USDC, DAY, pumpScore, expectConserved } = require("./_helpers");

describe("F-01 fix — loan closing survives agent NFT transfer", function () {
    this.timeout(180000);

    it("contract reports VERSION V6.1", async () => {
        const f = await deployLaunchStack();
        expect(await f.v6.VERSION()).to.equal("V6.1");
    });

    describe("NFT transferred, then repaid by the ORIGINAL borrower", () => {
        let f, borrower, lender, holder, agentId, loanId;
        before(async () => {
            f = await deployLaunchStack();
            [, borrower, lender, holder] = f.signers;
            await f.fund(borrower); await f.fund(lender);
            agentId = await f.onboardAgent(borrower);
            await f.v6.connect(lender).supplyLiquidity(agentId, USDC(1000));
            loanId = await f.v6.nextLoanId();
            await f.v6.connect(borrower).requestLoan(USDC(500), 7); // 100% collateral
            await f.registry.connect(borrower).transferFrom(borrower.address, holder.address, agentId);
            await f.time.increase(2 * DAY); // > minHold, on time
        });

        it("repay succeeds, collateral returns to the original borrower, on-time bonus lands on the agentId", async () => {
            const scoreBefore = await f.reputation["getReputationScore(uint256)"](agentId);
            const b0 = await f.usdc.balanceOf(borrower.address);
            const h0 = await f.usdc.balanceOf(holder.address);
            await expect(f.v6.connect(borrower).repayLoan(loanId)).to.emit(f.v6, "LoanRepaid");
            const interest = f.interestFor(USDC(500), 1500, 7);
            expect(b0 - (await f.usdc.balanceOf(borrower.address))).to.equal(interest); // paid P+I, got 500 collateral back
            expect(await f.usdc.balanceOf(holder.address)).to.equal(h0);                 // holder untouched
            expect(await f.reputation["getReputationScore(uint256)"](agentId)).to.equal(scoreBefore + 10n);
            // the holder address now reads the agent's score; the borrower address is not an agent
            expect(await f.reputation["getReputationScore(address)"](holder.address)).to.equal(scoreBefore + 10n);
            expect(await f.registry.addressToAgentId(borrower.address)).to.equal(0n);
            expect((await f.v6.loans(loanId)).state).to.equal(2n);
            expect(await f.v6.activeLoanCount(agentId)).to.equal(0n);
            await expectConserved(f, agentId);
        });
    });

    describe("NFT transferred, then repaid by the NEW holder", () => {
        let f, borrower, lender, holder, stranger, agentId, loanId;
        before(async () => {
            f = await deployLaunchStack();
            [, borrower, lender, holder, stranger] = f.signers;
            await f.fund(borrower); await f.fund(lender); await f.fund(holder); await f.fund(stranger);
            agentId = await f.onboardAgent(borrower);
            await f.v6.connect(lender).supplyLiquidity(agentId, USDC(1000));
            loanId = await f.v6.nextLoanId();
            await f.v6.connect(borrower).requestLoan(USDC(500), 7);
            await f.registry.connect(borrower).transferFrom(borrower.address, holder.address, agentId);
            await f.time.increase(2 * DAY);
        });

        it("a third party still cannot repay", async () => {
            await expect(f.v6.connect(stranger).repayLoan(loanId)).to.be.revertedWith("Not the borrower");
        });

        it("the holder pays principal + interest from its own wallet; collateral still returns to loan.borrower", async () => {
            const b0 = await f.usdc.balanceOf(borrower.address);
            const h0 = await f.usdc.balanceOf(holder.address);
            await f.v6.connect(holder).repayLoan(loanId);
            const interest = f.interestFor(USDC(500), 1500, 7);
            expect(h0 - (await f.usdc.balanceOf(holder.address))).to.equal(USDC(500) + interest);
            expect((await f.usdc.balanceOf(borrower.address)) - b0).to.equal(USDC(500)); // collateral back to poster
            expect((await f.v6.loans(loanId)).state).to.equal(2n);
            expect((await f.v6.loans(loanId)).borrower).to.equal(borrower.address);   // loan record unchanged
            await expectConserved(f, agentId);
        });

        it("after closing, the original borrower cannot repay again and the holder cannot re-repay", async () => {
            await expect(f.v6.connect(borrower).repayLoan(loanId)).to.be.revertedWith("Loan not active");
            await expect(f.v6.connect(holder).repayLoan(loanId)).to.be.revertedWith("Loan not active");
        });
    });

    describe("NFT transferred, original borrower re-registers as a NEW agent, then repays", () => {
        it("reputation is credited to the loan's agentId, not to the borrower's new agent", async () => {
            const f = await deployLaunchStack();
            const [, borrower, lender, holder] = f.signers;
            await f.fund(borrower); await f.fund(lender);
            const agentId = await f.onboardAgent(borrower);
            await f.v6.connect(lender).supplyLiquidity(agentId, USDC(1000));
            const loanId = await f.v6.nextLoanId();
            await f.v6.connect(borrower).requestLoan(USDC(500), 7);
            await f.registry.connect(borrower).transferFrom(borrower.address, holder.address, agentId);
            await f.registry.connect(borrower).register("ipfs://again", []);
            const newId = await f.registry.addressToAgentId(borrower.address);
            expect(newId).to.not.equal(agentId);
            await f.reputation.connect(borrower)["initializeReputation()"]();
            await f.time.increase(2 * DAY);
            const oldScore = await f.reputation["getReputationScore(uint256)"](agentId);
            const newScore = await f.reputation["getReputationScore(uint256)"](newId);
            await f.v6.connect(borrower).repayLoan(loanId);
            expect(await f.reputation["getReputationScore(uint256)"](agentId)).to.equal(oldScore + 10n);
            expect(await f.reputation["getReputationScore(uint256)"](newId)).to.equal(newScore);
        });
    });

    describe("liquidation after transfer (real loss at the 0%-collateral tier)", () => {
        let f, borrower, lender, holder, agentId, loanId;
        before(async () => {
            f = await deployLaunchStack({ rateLimit: 0 });
            [, borrower, lender, holder] = f.signers;
            await f.fund(borrower); await f.fund(lender);
            agentId = await f.onboardAgent(borrower);
            await pumpScore(f, borrower, 600); // 0% collateral, 7% APR
            await f.v6.connect(lender).supplyLiquidity(agentId, USDC(10_000));
            loanId = await f.v6.nextLoanId();
            await f.v6.connect(borrower).requestLoan(USDC(4000), 7);
            expect((await f.v6.loans(loanId)).collateralAmount).to.equal(0n);
            await f.registry.connect(borrower).transferFrom(borrower.address, holder.address, agentId);
            await f.time.increase(8 * DAY);
        });

        it("cannot be liquidated before it is overdue / by non-owner (unchanged)", async () => {
            await expect(f.v6.connect(holder).liquidateLoan(loanId)).to.be.reverted; // onlyOwner
        });

        it("owner liquidates; default penalty lands on the agentId; loss socialized; active set updated", async () => {
            const before = await f.reputation["getReputationScore(uint256)"](agentId);
            await expect(f.v6.liquidateLoan(loanId)).to.emit(f.v6, "LoanDefaulted").withArgs(loanId);
            expect(await f.reputation["getReputationScore(uint256)"](agentId)).to.equal(before - 50n);
            expect(await f.reputation.defaultCount(agentId)).to.equal(1n);
            expect((await f.v6.getLenderPosition(agentId, lender.address)).amount).to.equal(USDC(6000));
            expect(await f.v6.activeLoanCount(agentId)).to.equal(0n);
            expect((await f.v6.getActiveLoanIds(agentId)).length).to.equal(0);
            expect(await f.v6.outstandingPrincipal(agentId)).to.equal(0n);
            await expectConserved(f, agentId);
        });

        it("the lender can exit the remaining principal", async () => {
            await expect(f.v6.connect(lender).withdrawLiquidity(agentId, USDC(6000))).to.not.be.reverted;
        });
    });
});
