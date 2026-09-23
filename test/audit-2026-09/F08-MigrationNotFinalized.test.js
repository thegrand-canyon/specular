// F-08 [MEDIUM, owner-privilege blast radius] — migrationFinalized == false on Arc
// mainnet (read on-chain 2026-09-19). seedPool/seedPosition are therefore LIVE
// owner powers on a production contract that was never migrated. A compromised or
// coerced owner key can seed itself a position in any funded pool and withdraw
// other lenders' USDC (seedPosition's Σpositions <= totalLiquidity check is
// satisfied by first seedPool-ing totalLiquidity upward). The fix is a single
// owner tx — setMigrationFinalized() — no redeploy.
//
// CONVENTION: primary test asserts the SECURE property -> FAILING = CONFIRMED
// (it passes only once the owner has finalised migration — the fixture mirrors
// the live state, where it has not been).

const { expect } = require("chai");
const { deployLaunchStack, USDC } = require("./_fixture");

describe("F-08 [MEDIUM] migration helpers still live post-launch", function () {
    this.timeout(120000);
    let f, borrower, lender, thief, agentId;

    before(async () => {
        f = await deployLaunchStack();
        [, borrower, lender, thief] = f.signers;
        await f.fund(borrower); await f.fund(lender);
        agentId = await f.onboardAgent(borrower);
        await f.v6.connect(lender).supplyLiquidity(agentId, USDC(10_000));
    });

    // pending: owner decision / deployment action — see INTERNAL_AUDIT_2026-09-19.md (F-08: owner tx setMigrationFinalized on mainnet)
    it.skip("SECURE PROPERTY: after launch the owner can no longer seed positions", async () => {
        await expect(f.v6.seedPosition(agentId, thief.address, 0, 0, 0))
            .to.be.revertedWith("Migration finalized");
    });

    it("[demonstration, passes] owner key -> seedPool(totalLiquidity x2) + seedPosition(thief) -> thief withdraws the lender's 10,000 USDC", async () => {
        const p = await f.v6.getAgentPool(agentId);
        await f.v6.seedPool(agentId, borrower.address, p.totalLiquidity * 2n, p.availableLiquidity, p.totalEarned);
        await f.v6.seedPosition(agentId, thief.address, USDC(10_000), 0, 0);
        await f.v6.connect(thief).withdrawLiquidity(agentId, USDC(10_000));
        expect(await f.usdc.balanceOf(thief.address)).to.equal(USDC(10_000));
        // the honest lender's position still says 10,000 but the pool is empty
        expect((await f.v6.getLenderPosition(agentId, lender.address)).amount).to.equal(USDC(10_000));
        await expect(f.v6.connect(lender).withdrawLiquidity(agentId, USDC(10_000)))
            .to.be.revertedWith("Insufficient pool liquidity");
        // one-tx remediation
        await f.v6.setMigrationFinalized();
        await expect(f.v6.seedPosition(agentId, thief.address, 1, 0, 0)).to.be.revertedWith("Migration finalized");
    });
});
