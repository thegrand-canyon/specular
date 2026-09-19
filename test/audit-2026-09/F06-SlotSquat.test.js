// F-06 [LOW/griefing] — F-C lever at the live value (minSupplyAmount = 1 USDC) makes
// squatting all MAX_LENDERS_PER_POOL=50 slots cost 50 USDC of RECOVERABLE capital
// (+ ~50 tx of gas). No admin eviction exists (compactPoolLenders only dedups),
// so a targeted pool is locked to new lenders until the squatters leave — and the
// squatters are "qualified" lenders who collect a share of that pool's interest.
//
// CONVENTION: primary test asserts the SECURE property -> FAILING = CONFIRMED.

const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const { deployLaunchStack, USDC } = require("./_fixture");

describe("F-06 [LOW] 50-slot squat costs 50 USDC recoverable at the live minSupplyAmount", function () {
    this.timeout(300000);
    let f, borrower, realLender, agentId, sybils = [];

    before(async () => {
        f = await deployLaunchStack();
        [, borrower, realLender] = f.signers;
        await f.fund(borrower); await f.fund(realLender);
        agentId = await f.onboardAgent(borrower);
        const v6Addr = await f.v6.getAddress();
        for (let i = 0; i < 50; i++) {
            const w = ethers.Wallet.createRandom().connect(ethers.provider);
            await network.provider.send("hardhat_setBalance", [w.address, "0x56BC75E2D63100000"]);
            await f.usdc.mint(w.address, USDC(1));
            await f.usdc.connect(w).approve(v6Addr, USDC(1));
            await f.v6.connect(w).supplyLiquidity(agentId, USDC(1)); // exactly minSupplyAmount
            sybils.push(w);
        }
        expect((await f.v6.getAgentPool(agentId)).lenderCount).to.equal(50n);
    });

    // pending: owner decision / deployment action — see INTERNAL_AUDIT_2026-09-19.md (F-06: setMinSupplyAmount lever, ≤100 USDC cap confirmed)
    it.skip("SECURE PROPERTY: a real lender can still supply to a pool after a 50 x 1-USDC squat", async () => {
        await expect(f.v6.connect(realLender).supplyLiquidity(agentId, USDC(10_000))).to.not.be.reverted;
    });

    it("[demonstration, passes] the squat is fully recoverable and the owner has no eviction tool", async () => {
        await expect(f.v6.connect(realLender).supplyLiquidity(agentId, USDC(10_000)))
            .to.be.revertedWith("Pool lender capacity reached");
        await f.v6.compactPoolLenders(agentId); // dedup only — nothing to remove
        expect((await f.v6.getAgentPool(agentId)).lenderCount).to.equal(50n);
        await f.v6.connect(sybils[0]).withdrawLiquidity(agentId, USDC(1));
        expect(await f.usdc.balanceOf(sybils[0].address)).to.equal(USDC(1)); // capital back
        expect((await f.v6.getAgentPool(agentId)).lenderCount).to.equal(49n);
    });
});
