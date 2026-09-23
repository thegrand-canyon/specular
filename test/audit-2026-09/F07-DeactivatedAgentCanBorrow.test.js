// F-07 [LOW] — AgentRegistryV2.deactivateAgent() is a no-op for the marketplace.
// requestLoan/createAgentPool/supplyLiquidity check only addressToAgentId != 0,
// never agents[id].isActive / isAgentActive(). The owner therefore has NO per-agent
// kill switch — the only response to a detected bad actor is a global pause(),
// which also freezes every honest lender's withdrawals.
//
// CONVENTION: primary test asserts the SECURE property -> FAILING = CONFIRMED.

const { expect } = require("chai");
const { deployLaunchStack, USDC } = require("./_fixture");

describe("F-07 [LOW] deactivated agent can still borrow", function () {
    this.timeout(120000);
    let f, borrower, lender, agentId;

    before(async () => {
        f = await deployLaunchStack();
        [, borrower, lender] = f.signers;
        await f.fund(borrower); await f.fund(lender);
        agentId = await f.onboardAgent(borrower);
        await f.v6.connect(lender).supplyLiquidity(agentId, USDC(1000));
        await f.registry.deactivateAgent(agentId);
        expect(await f.registry.isAgentActive(borrower.address)).to.equal(false);
    });

    it("SECURE PROPERTY: an owner-deactivated agent cannot open a new loan", async () => {
        await expect(f.v6.connect(borrower).requestLoan(USDC(500), 7)).to.be.reverted;
    });

    it("[demonstration, passes — flipped by the V6.1 fix] a deactivated agent cannot create a pool either; reactivation restores both", async () => {
        await expect(f.v6.connect(borrower).requestLoan(USDC(500), 7)).to.be.revertedWith("Agent deactivated");
        const [, , , other] = f.signers;
        await f.fund(other);
        await f.registry.connect(other).register("ipfs://other", []);
        const id2 = await f.registry.addressToAgentId(other.address);
        await f.registry.deactivateAgent(id2);
        await expect(f.v6.connect(other).createAgentPool()).to.be.revertedWith("Agent deactivated");
        await expect(f.v6.connect(lender).supplyLiquidity(id2, USDC(10))).to.be.revertedWith("Pool not active");
        await f.registry.reactivateAgent(id2);
        await expect(f.v6.connect(other).createAgentPool()).to.not.be.reverted;
        await f.registry.reactivateAgent(agentId);
        await expect(f.v6.connect(borrower).requestLoan(USDC(500), 7)).to.not.be.reverted;
    });
});
