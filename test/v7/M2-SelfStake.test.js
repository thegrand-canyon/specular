// V7 / M2 — the marketplace half: self-stake lock, first-loss absorption, the
// self-stake gate on low-collateral tiers, the loanId/lateSeconds pass-through, and
// the L7 socialisation-basis fix.

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { deployV7Stack, USDC, DAY, pumpScore, pumpCapacity, expectConserved } = require("./_fixture");

describe("V7 / M2 — AgentLiquidityMarketplaceV62 self-stake + L7", function () {
    let f, owner, agent, lender, lender2, lender3, other, v62, rep, agentId;

    async function setup(opts = {}) {
        f = await deployV7Stack({ rateLimit: 0, minHold: 0, ...opts });
        [owner, agent, lender, lender2, lender3, other] = f.signers;
        v62 = f.v62; rep = f.reputation;
        for (const w of [agent, lender, lender2, lender3, other]) await f.fund(w);
        agentId = await f.onboardAgent(agent);
    }

    beforeEach(async function () { await setup(); });

    /** Put the agent in the 0%-collateral, 5,000-limit tier with a 5,000 ladder. */
    async function toTopTier() {
        await pumpScore(f, agent, 800);
        await pumpCapacity(f, agent, USDC(5000));
        expect(await rep.calculateCollateralRequirement(agent.address)).to.equal(0n);
        expect(await rep.calculateCreditLimit(agent.address)).to.equal(USDC(5000));
    }

    // ------------------------------------------------------------- M2-c gate

    describe("M2-c — self-stake gate on partially/un-collateralised tiers", function () {
        it("refuses a 0%-collateral loan with no self-stake", async function () {
            await toTopTier();
            await v62.connect(lender).supplyLiquidity(agentId, USDC(5000));
            await expect(v62.connect(agent).requestLoan(USDC(1000), 7))
                .to.be.revertedWith("Insufficient self-stake");
        });

        it("requires exactly outstanding/creditMultiple at the 0% tier", async function () {
            await toTopTier();
            await v62.connect(lender).supplyLiquidity(agentId, USDC(5000));
            expect(await v62.requiredSelfStake(agentId, USDC(1000))).to.equal(USDC(500));
            await v62.connect(agent).supplyLiquidity(agentId, USDC(500) - 1n);
            await expect(v62.connect(agent).requestLoan(USDC(1000), 7))
                .to.be.revertedWith("Insufficient self-stake");
            await v62.connect(agent).supplyLiquidity(agentId, 1n);
            await expect(v62.connect(agent).requestLoan(USDC(1000), 7)).to.not.be.reverted;
        });

        it("the requirement is AGGREGATE — a second loan needs more stake", async function () {
            await toTopTier();
            await v62.connect(lender).supplyLiquidity(agentId, USDC(5000));
            await v62.connect(agent).supplyLiquidity(agentId, USDC(500));
            await v62.connect(agent).requestLoan(USDC(1000), 7);
            expect(await v62.outstandingPrincipal(agentId)).to.equal(USDC(1000));
            expect(await v62.requiredSelfStake(agentId, USDC(1000))).to.equal(USDC(1000));
            await expect(v62.connect(agent).requestLoan(USDC(1000), 7))
                .to.be.revertedWith("Insufficient self-stake");
        });

        it("scales with the collateral percentage — the 500 tier needs 25%/k, not 0", async function () {
            await pumpScore(f, agent, 500);
            await pumpCapacity(f, agent, USDC(5000));
            expect(await rep.calculateCollateralRequirement(agent.address)).to.equal(75n);
            // exposure 1,000, unsecured 250, k=2 → 125
            expect(await v62.requiredSelfStake(agentId, USDC(1000))).to.equal(USDC(125));
        });

        it("is not required at the 100%-collateral tiers", async function () {
            await pumpCapacity(f, agent, USDC(1000));
            expect(await rep.calculateCollateralRequirement(agent.address)).to.equal(100n);
            expect(await v62.requiredSelfStake(agentId, USDC(500))).to.equal(0n);
            await v62.connect(lender).supplyLiquidity(agentId, USDC(1000));
            await expect(v62.connect(agent).requestLoan(USDC(500), 7)).to.not.be.reverted;
        });

        it("a larger creditMultiple demands proportionally LESS stake (k prices the residual)", async function () {
            await toTopTier();
            expect(await v62.requiredSelfStake(agentId, USDC(4000))).to.equal(USDC(2000));
            await rep.setLadderParameters(4, USDC(100), USDC(100), 7 * DAY);
            expect(await v62.requiredSelfStake(agentId, USDC(4000))).to.equal(USDC(1000));
        });

        it("the pool creator's own stake is exempt from minSupplyAmount", async function () {
            await setup({ minSupply: USDC(10) });
            await pumpScore(f, agent, 500);
            await pumpCapacity(f, agent, USDC(1000));
            // required stake for a 50-USDC loan at 75% collateral, k=2 = 6.25 USDC < 10
            await expect(v62.connect(agent).supplyLiquidity(agentId, USDC(6.25))).to.not.be.reverted;
            await expect(v62.connect(lender).supplyLiquidity(agentId, USDC(6.25)))
                .to.be.revertedWith("Below minimum supply");
        });
    });

    // ------------------------------------------------------------- M2-a lock

    describe("M2-a — the self-stake is locked while the agent borrows", function () {
        beforeEach(async function () {
            await toTopTier();
            await v62.connect(lender).supplyLiquidity(agentId, USDC(5000));
            await v62.connect(agent).supplyLiquidity(agentId, USDC(2000));
        });

        it("withdrawLiquidity by the pool creator reverts while principal is outstanding", async function () {
            await v62.connect(agent).requestLoan(USDC(2000), 7);
            await expect(v62.connect(agent).withdrawLiquidity(agentId, 1n))
                .to.be.revertedWith("Self-stake locked while borrowing");
            expect((await v62.selfStake(agentId)).locked).to.equal(true);
        });

        it("THE BUST-OUT ORDERING IS BROKEN: the attacker cannot pull its seed before drawing", async function () {
            // Draw the line first (the only way to have liquidity to take), then try to exit.
            await v62.connect(agent).requestLoan(USDC(3000), 7);
            await expect(v62.connect(agent).withdrawLiquidity(agentId, USDC(2000)))
                .to.be.revertedWith("Self-stake locked while borrowing");
        });

        it("other lenders are NOT locked", async function () {
            await v62.connect(agent).requestLoan(USDC(2000), 7);
            await expect(v62.connect(lender).withdrawLiquidity(agentId, USDC(1000))).to.not.be.reverted;
        });

        it("unlocks once every loan is closed", async function () {
            const tx = await v62.connect(agent).requestLoan(USDC(2000), 7);
            const r = await tx.wait();
            const id = r.logs.map(l => { try { return v62.interface.parseLog(l); } catch { return null; } })
                .find(e => e && e.name === "LoanRequested").args[0];
            await time.increase(6 * DAY);
            await v62.connect(agent).repayLoan(id);
            expect(await v62.outstandingPrincipal(agentId)).to.equal(0n);
            expect((await v62.selfStake(agentId)).locked).to.equal(false);
            await expect(v62.connect(agent).withdrawLiquidity(agentId, USDC(2000))).to.not.be.reverted;
        });

        it("selfStake() view reports the creator's position and lock state", async function () {
            const s0 = await v62.selfStake(agentId);
            expect(s0.amount).to.equal(USDC(2000));
            expect(s0.locked).to.equal(false);
        });
    });

    // ------------------------------------------------------- M2-b first loss

    describe("M2-b — the self-stake absorbs default loss FIRST", function () {
        let loanId;
        async function drawAndDefault(selfAmt, lenderAmt, drawAmt) {
            await toTopTier();
            await v62.connect(lender).supplyLiquidity(agentId, lenderAmt);
            await v62.connect(agent).supplyLiquidity(agentId, selfAmt);
            const tx = await v62.connect(agent).requestLoan(drawAmt, 7);
            const r = await tx.wait();
            loanId = r.logs.map(l => { try { return v62.interface.parseLog(l); } catch { return null; } })
                .find(e => e && e.name === "LoanRequested").args[0];
            await time.increase(8 * DAY);
            return v62.liquidateLoan(loanId);
        }

        it("a loss smaller than the stake falls ENTIRELY on the agent", async function () {
            await drawAndDefault(USDC(2000), USDC(4000), USDC(1000));
            expect((await v62.positions(agentId, agent.address)).amount).to.equal(USDC(1000));
            expect((await v62.positions(agentId, lender.address)).amount).to.equal(USDC(4000));
            await expectConserved(f, agentId, "self-stake absorbs all");
        });

        it("emits SelfStakeAbsorbedLoss", async function () {
            await expect(drawAndDefault(USDC(2000), USDC(4000), USDC(1000)))
                .to.emit(v62, "SelfStakeAbsorbedLoss").withArgs(agentId, agent.address, USDC(1000));
        });

        it("only the EXCESS over the stake reaches other lenders", async function () {
            await drawAndDefault(USDC(2000), USDC(4000), USDC(3000));
            expect((await v62.positions(agentId, agent.address)).amount).to.equal(0n, "stake wiped first");
            expect((await v62.positions(agentId, lender.address)).amount).to.equal(USDC(3000), "4000 - 1000 residual");
            await expectConserved(f, agentId, "self-stake + socialised");
        });

        it("the agent's stake is NOT made whole pro-rata alongside the victims", async function () {
            // Under V6.1's flat pro-rata the agent (1/5 of the pool) would have kept 80%
            // of its stake; here it keeps none until the lenders are covered.
            await drawAndDefault(USDC(1500), USDC(4000), USDC(3000));
            expect((await v62.positions(agentId, agent.address)).amount).to.equal(0n);
            expect((await v62.positions(agentId, lender.address)).amount).to.equal(USDC(2500));
        });

        it("conservation stays exact when the loss wipes the whole pool", async function () {
            await drawAndDefault(USDC(2500), USDC(2500), USDC(5000));
            expect((await v62.positions(agentId, agent.address)).amount).to.equal(0n);
            expect((await v62.positions(agentId, lender.address)).amount).to.equal(0n);
            await expectConserved(f, agentId, "total wipe");
        });
    });

    // ------------------------------------------------------------------- L7

    describe("L7 — loss falls on the principal QUALIFIED for the defaulted loan", function () {
        it("a lender who joins mid-loan bears NO loss from that loan", async function () {
            await toTopTier();
            await v62.connect(lender).supplyLiquidity(agentId, USDC(2000));   // early
            await v62.connect(agent).supplyLiquidity(agentId, USDC(1000));    // self-stake
            const tx = await v62.connect(agent).requestLoan(USDC(2000), 7);
            const r = await tx.wait();
            const id = r.logs.map(l => { try { return v62.interface.parseLog(l); } catch { return null; } })
                .find(e => e && e.name === "LoanRequested").args[0];
            await time.increase(DAY);
            await v62.connect(lender2).supplyLiquidity(agentId, USDC(2000));  // LATE joiner
            await time.increase(8 * DAY);
            await v62.liquidateLoan(id);

            // loss 2,000: self-stake 1,000 absorbs first, remaining 1,000 falls on the
            // qualified basis, which is the EARLY lender only.
            expect((await v62.positions(agentId, agent.address)).amount).to.equal(0n);
            expect((await v62.positions(agentId, lender.address)).amount).to.equal(USDC(1000));
            expect((await v62.positions(agentId, lender2.address)).amount)
                .to.equal(USDC(2000), "late joiner had zero upside and must take zero loss");
            await expectConserved(f, agentId, "L7 qualified basis");
        });

        it("V6.1 BEHAVIOUR FOR COMPARISON: the same setup splits the loss 50/50", async function () {
            // Proves the fix is a real behavioural change, not a no-op.
            const { deployLaunchStack } = require("../audit-2026-09/_fixture");
            const g = await deployLaunchStack({ rateLimit: 0, minHold: 0 });
            const [o, ag, l1, l2] = g.signers;
            for (const w of [ag, l1, l2]) await g.fund(w);
            const aid = await g.onboardAgent(ag);
            await g.reputation.authorizePool(o.address);
            while ((await g.reputation["getReputationScore(uint256)"](aid)) < 600n) {
                await g.reputation.recordLoanCompletion(ag.address, USDC(100), true);
            }
            await g.v6.connect(l1).supplyLiquidity(aid, USDC(2000));
            const tx = await g.v6.connect(ag).requestLoan(USDC(2000), 7);
            const r = await tx.wait();
            const id = r.logs.map(l => { try { return g.v6.interface.parseLog(l); } catch { return null; } })
                .find(e => e && e.name === "LoanRequested").args[0];
            await time.increase(DAY);
            await g.v6.connect(l2).supplyLiquidity(aid, USDC(2000));
            await time.increase(8 * DAY);
            await g.v6.liquidateLoan(id);
            expect((await g.v6.positions(aid, l1.address)).amount).to.equal(USDC(1000));
            expect((await g.v6.positions(aid, l2.address)).amount)
                .to.equal(USDC(1000), "V6.1: the late joiner absorbed half the loss it could never earn on");
        });

        it("falls back to the remaining principal when the qualified lenders have exited", async function () {
            await toTopTier();
            await v62.connect(lender).supplyLiquidity(agentId, USDC(3000));
            await v62.connect(agent).supplyLiquidity(agentId, USDC(800));
            const tx = await v62.connect(agent).requestLoan(USDC(1500), 7);
            const r = await tx.wait();
            const id = r.logs.map(l => { try { return v62.interface.parseLog(l); } catch { return null; } })
                .find(e => e && e.name === "LoanRequested").args[0];
            await time.increase(DAY);
            await v62.connect(lender2).supplyLiquidity(agentId, USDC(3000));
            // the qualified lender exits entirely
            await v62.connect(lender).withdrawLiquidity(agentId, USDC(3000));
            await time.increase(8 * DAY);
            await v62.liquidateLoan(id);
            // 1,500 loss: 800 self-stake, then nothing qualified is left, so the
            // fallback pass charges the late joiner for the remaining 700.
            expect((await v62.positions(agentId, agent.address)).amount).to.equal(0n);
            expect((await v62.positions(agentId, lender2.address)).amount).to.equal(USDC(2300));
            await expectConserved(f, agentId, "L7 fallback pass");
        });

        it("splits pro-rata among several qualified lenders and skips the unqualified", async function () {
            await toTopTier();
            await v62.connect(lender).supplyLiquidity(agentId, USDC(1000));
            await v62.connect(lender2).supplyLiquidity(agentId, USDC(3000));
            await v62.connect(agent).supplyLiquidity(agentId, USDC(2000));
            const tx = await v62.connect(agent).requestLoan(USDC(4000), 7);
            const r = await tx.wait();
            const id = r.logs.map(l => { try { return v62.interface.parseLog(l); } catch { return null; } })
                .find(e => e && e.name === "LoanRequested").args[0];
            await time.increase(DAY);
            await v62.connect(lender3).supplyLiquidity(agentId, USDC(4000));
            await time.increase(8 * DAY);
            await v62.liquidateLoan(id);
            // loss 4,000 − 2,000 self = 2,000 across a qualified basis of 4,000 → 25 % / 75 %
            expect((await v62.positions(agentId, lender.address)).amount).to.equal(USDC(500));
            expect((await v62.positions(agentId, lender2.address)).amount).to.equal(USDC(1500));
            expect((await v62.positions(agentId, lender3.address)).amount).to.equal(USDC(4000));
            await expectConserved(f, agentId, "L7 pro-rata");
        });
    });

    // ------------------------------------------- M2-d/e reputation plumbing

    describe("M2-d/e — loanId and lateSeconds pass-through", function () {
        it("recordBorrow is keyed by the marketplace loanId", async function () {
            await pumpCapacity(f, agent, USDC(1000));
            await v62.connect(lender).supplyLiquidity(agentId, USDC(1000));
            const tx = await v62.connect(agent).requestLoan(USDC(500), 7);
            const r = await tx.wait();
            const id = r.logs.map(l => { try { return v62.interface.parseLog(l); } catch { return null; } })
                .find(e => e && e.name === "LoanRequested").args[0];
            const ol = await rep.openLoans(await v62.getAddress(), id);
            expect(ol.amount).to.equal(USDC(500));
            expect(ol.agentId).to.equal(agentId);
        });

        it("a HELD-TO-TERM repayment earns the full bonus; a same-day one earns ~nothing", async function () {
            await setup({ rateLimit: 0, minHold: 0 });
            await pumpCapacity(f, agent, USDC(1000));
            await v62.connect(lender).supplyLiquidity(agentId, USDC(2000));
            const before = await rep["getReputationScore(uint256)"](agentId);

            const open = async (amt, hold) => {
                const tx = await v62.connect(agent).requestLoan(amt, 7);
                const r = await tx.wait();
                const id = r.logs.map(l => { try { return v62.interface.parseLog(l); } catch { return null; } })
                    .find(e => e && e.name === "LoanRequested").args[0];
                await time.increase(hold);
                await v62.connect(agent).repayLoan(id);
            };
            await open(USDC(100), 7 * DAY - 600);
            const afterTerm = await rep["getReputationScore(uint256)"](agentId);
            expect(afterTerm - before).to.equal(9n); // ~full bonus (hold is 10 min short)

            await open(USDC(100), 60);
            expect((await rep["getReputationScore(uint256)"](agentId)) - afterTerm)
                .to.equal(0n, "a 60-second hold earns nothing — the V3 attacker cycle is dead");
        });

        it("a LATE repayment now costs reputation (the V6.1 gap)", async function () {
            await pumpScore(f, agent, 300);
            await pumpCapacity(f, agent, USDC(1000));
            await v62.connect(lender).supplyLiquidity(agentId, USDC(2000));
            const tx = await v62.connect(agent).requestLoan(USDC(500), 7);
            const r = await tx.wait();
            const id = r.logs.map(l => { try { return v62.interface.parseLog(l); } catch { return null; } })
                .find(e => e && e.name === "LoanRequested").args[0];
            const before = await rep["getReputationScore(uint256)"](agentId);
            await time.increase(10 * DAY); // 3 days late
            await expect(v62.connect(agent).repayLoan(id))
                .to.emit(rep, "LateRepaymentRecorded");
            expect(before - (await rep["getReputationScore(uint256)"](agentId))).to.equal(25n); // 10 + 5*3
            expect(await rep.lateCount(agentId)).to.equal(1n);
        });

        it("recordDefault is keyed by loanId and applies the scaled penalty + lockout", async function () {
            await toTopTier();
            await v62.connect(lender).supplyLiquidity(agentId, USDC(5000));
            await v62.connect(agent).supplyLiquidity(agentId, USDC(1000));
            const tx = await v62.connect(agent).requestLoan(USDC(2000), 7);
            const r = await tx.wait();
            const id = r.logs.map(l => { try { return v62.interface.parseLog(l); } catch { return null; } })
                .find(e => e && e.name === "LoanRequested").args[0];
            const before = await rep["getReputationScore(uint256)"](agentId);
            await time.increase(8 * DAY);
            await v62.liquidateLoan(id);
            // 2,000 default / largeLoanThreshold 1,000 x defaultPenaltyLarge 100 = 200
            expect(before - (await rep["getReputationScore(uint256)"](agentId))).to.equal(200n);
            expect(await rep.maxRepaidPrincipal(agentId)).to.equal(0n);
            expect(await rep.calculateCreditLimit(agent.address)).to.equal(0n);
            expect(await rep.isLockedOut(agentId)).to.equal(true);
            expect((await rep.openLoans(await v62.getAddress(), id)).start).to.equal(0n);
        });

        it("a locked-out agent cannot open any loan", async function () {
            await toTopTier();
            await v62.connect(lender).supplyLiquidity(agentId, USDC(5000));
            await v62.connect(agent).supplyLiquidity(agentId, USDC(1000));
            const tx = await v62.connect(agent).requestLoan(USDC(2000), 7);
            const r = await tx.wait();
            const id = r.logs.map(l => { try { return v62.interface.parseLog(l); } catch { return null; } })
                .find(e => e && e.name === "LoanRequested").args[0];
            await time.increase(8 * DAY);
            await v62.liquidateLoan(id);
            await expect(v62.connect(agent).requestLoan(USDC(1), 7)).to.be.revertedWith("Exceeds credit limit");
        });
    });

    describe("V6.2 hygiene", function () {
        it("reports VERSION V6.2", async function () {
            expect(await v62.VERSION()).to.equal("V6.2");
        });
    });
});
