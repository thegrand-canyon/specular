// Regression tests for the F-07 fix (V6.1): registry deactivation is a per-agent
// kill switch for NEW credit (requestLoan, createAgentPool) but never blocks the
// closing path (repay) or lenders' exits.

const { expect } = require("chai");
const { deployLaunchStack, USDC, DAY, expectConserved } = require("./_helpers");

describe("F-07 fix — deactivated agent cannot open new credit; everything else stays live", function () {
    this.timeout(120000);
    let f, borrower, lender, agentId, loanId;

    before(async () => {
        f = await deployLaunchStack();
        [, borrower, lender] = f.signers;
        await f.fund(borrower); await f.fund(lender);
        agentId = await f.onboardAgent(borrower);
        await f.v6.connect(lender).supplyLiquidity(agentId, USDC(1000));
        loanId = await f.v6.nextLoanId();
        await f.v6.connect(borrower).requestLoan(USDC(500), 7);
        await f.registry.deactivateAgent(agentId);
    });

    it("cannot request a new loan while deactivated", async () => {
        await expect(f.v6.connect(borrower).requestLoan(USDC(100), 7)).to.be.revertedWith("Agent deactivated");
    });

    it("cannot create a pool while deactivated (fresh agent)", async () => {
        const [, , , other] = f.signers;
        await f.registry.connect(other).register("ipfs://other", []);
        const id = await f.registry.addressToAgentId(other.address);
        await f.registry.deactivateAgent(id);
        await expect(f.v6.connect(other).createAgentPool()).to.be.revertedWith("Agent deactivated");
        await f.registry.reactivateAgent(id);
        await expect(f.v6.connect(other).createAgentPool()).to.emit(f.v6, "PoolCreated");
    });

    it("lenders can still withdraw from a deactivated agent's pool", async () => {
        await expect(f.v6.connect(lender).withdrawLiquidity(agentId, USDC(100))).to.not.be.reverted;
    });

    it("the deactivated agent can still repay its open loan (closing path stays live)", async () => {
        await f.time.increase(2 * DAY);
        await expect(f.v6.connect(borrower).repayLoan(loanId)).to.emit(f.v6, "LoanRepaid");
        expect(await f.v6.activeLoanCount(agentId)).to.equal(0n);
        await expectConserved(f, agentId);
    });

    it("an overdue loan of a deactivated agent can still be liquidated", async () => {
        await f.registry.reactivateAgent(agentId);
        const id = await f.v6.nextLoanId();
        await f.v6.connect(borrower).requestLoan(USDC(100), 7);
        await f.registry.deactivateAgent(agentId);
        await f.time.increase(8 * DAY);
        await expect(f.v6.liquidateLoan(id)).to.emit(f.v6, "LoanDefaulted");
    });

    it("reactivation restores borrowing", async () => {
        await f.registry.reactivateAgent(agentId);
        await expect(f.v6.connect(borrower).requestLoan(USDC(100), 7)).to.emit(f.v6, "LoanDisbursed");
    });
});
