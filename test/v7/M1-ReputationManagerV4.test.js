// V7 / M1 — unit tests for every new and changed function of ReputationManagerV4.
//
// Covers: the principal-TIME bonus, the credit ladder (including the k==1 deadlock
// the economic report found and the growthStep that fixes it), the size-proportional
// default penalty + capacity reset + lockout, the owner-settable tier table with its
// hard ceiling, the late-repayment penalty hook, and the loanId-keyed open-loan
// registry that replaced the report's ambiguous amount-matching.

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { deployV7Stack, USDC, DAY, DEFAULT_TIER_LIMITS } = require("./_fixture");

describe("V7 / M1 — ReputationManagerV4", function () {
    let f, owner, agent, other, rep, registry, agentId;

    beforeEach(async function () {
        f = await deployV7Stack({ rateLimit: 0, minHold: 0 });
        [owner, agent, other] = f.signers;
        rep = f.reputation; registry = f.registry;
        await f.fund(agent); await f.fund(other);
        agentId = await f.onboardAgent(agent);
        // Let the owner act as an authorized pool so the manager can be unit-tested
        // directly, without driving the whole marketplace.
        await rep.authorizePool(owner.address);
    });

    // ------------------------------------------------------------- M1-1 bonus

    describe("M1-1 — principal-TIME on-time bonus", function () {
        it("awards the full bonus for a loan held for refDuration at the reference principal", async function () {
            await rep.recordBorrow(agent.address, 1, USDC(100));
            await time.increase(7 * DAY);
            await rep.recordLoanCompletion(agent.address, 1, USDC(100), true, 0);
            // 100 (initial) + 10 (full onTimeRepaymentBonus)
            expect(await rep["getReputationScore(uint256)"](agentId)).to.equal(110n);
        });

        it("scales linearly in HOLD TIME — half the reference duration earns half the bonus", async function () {
            await rep.recordBorrow(agent.address, 1, USDC(100));
            await time.increase(3.5 * DAY);
            await rep.recordLoanCompletion(agent.address, 1, USDC(100), true, 0);
            expect(await rep["getReputationScore(uint256)"](agentId)).to.equal(105n);
        });

        it("scales linearly in PRINCIPAL — half the reference amount earns half the bonus", async function () {
            await rep.recordBorrow(agent.address, 1, USDC(50));
            await time.increase(7 * DAY);
            await rep.recordLoanCompletion(agent.address, 1, USDC(50), true, 0);
            expect(await rep["getReputationScore(uint256)"](agentId)).to.equal(105n);
        });

        it("caps both factors — a 10x principal held 10x refDuration still earns exactly the bonus", async function () {
            await rep.recordBorrow(agent.address, 1, USDC(1000));
            await time.increase(70 * DAY);
            await rep.recordLoanCompletion(agent.address, 1, USDC(1000), true, 0);
            expect(await rep["getReputationScore(uint256)"](agentId)).to.equal(110n);
        });

        it("THE ATTACK THIS CLOSES: a 1-day hold on a 7-day term now earns 1/7 of the bonus (V3 gave the full 10)", async function () {
            await rep.recordBorrow(agent.address, 1, USDC(100));
            await time.increase(DAY);
            await rep.recordLoanCompletion(agent.address, 1, USDC(100), true, 0);
            // floor(10 * 100e6 * 86400 / (100e6 * 604800)) == 1
            expect(await rep["getReputationScore(uint256)"](agentId)).to.equal(101n);
        });

        it("earns nothing when the marketplace's onTime gate is false", async function () {
            await rep.recordBorrow(agent.address, 1, USDC(100));
            await time.increase(7 * DAY);
            await rep.recordLoanCompletion(agent.address, 1, USDC(100), false, 0);
            expect(await rep["getReputationScore(uint256)"](agentId)).to.equal(100n);
        });

        it("still honours the per-window rate limit", async function () {
            await rep.setReputationRateLimit(5, DAY);
            for (let i = 1; i <= 3; i++) {
                await rep.recordBorrow(agent.address, i, USDC(100));
            }
            await time.increase(7 * DAY);
            for (let i = 1; i <= 3; i++) {
                await rep.recordLoanCompletion(agent.address, i, USDC(100), true, 0);
            }
            expect(await rep["getReputationScore(uint256)"](agentId)).to.equal(105n); // clamped to 5
        });
    });

    // ------------------------------------------------------------ M1-2 ladder

    describe("M1-2 — credit ladder", function () {
        it("a fresh agent gets exactly bootstrapLimit", async function () {
            expect(await rep.calculateCreditLimit(agent.address)).to.equal(USDC(100));
        });

        it("limit = min(tierLimit, k * maxRepaidPrincipal + growthStep)", async function () {
            await rep.recordBorrow(agent.address, 1, USDC(300));
            await time.increase(7 * DAY);
            await rep.recordLoanCompletion(agent.address, 1, USDC(300), true, 0);
            expect(await rep.maxRepaidPrincipal(agentId)).to.equal(USDC(300));
            // k=2: 2*300 + 100 = 700, tier(110) = 1000 → 700
            expect(await rep.calculateCreditLimit(agent.address)).to.equal(USDC(700));
        });

        it("only ON-TIME repayments advance the ladder", async function () {
            await rep.recordBorrow(agent.address, 1, USDC(300));
            await time.increase(7 * DAY);
            await rep.recordLoanCompletion(agent.address, 1, USDC(300), false, 0);
            expect(await rep.maxRepaidPrincipal(agentId)).to.equal(0n);
            expect(await rep.calculateCreditLimit(agent.address)).to.equal(USDC(100));
        });

        it("the ladder never ratchets DOWN on a smaller repayment", async function () {
            await rep.recordBorrow(agent.address, 1, USDC(300));
            await time.increase(7 * DAY);
            await rep.recordLoanCompletion(agent.address, 1, USDC(300), true, 0);
            await rep.recordBorrow(agent.address, 2, USDC(50));
            await time.increase(7 * DAY);
            await rep.recordLoanCompletion(agent.address, 2, USDC(50), true, 0);
            expect(await rep.maxRepaidPrincipal(agentId)).to.equal(USDC(300));
        });

        it("THE DEADLOCK THE REPORT FOUND: k = 1 with no additive step cannot climb — growthStep is mandatory", async function () {
            // The setter refuses growthStep == 0 precisely because of this.
            await expect(rep.setLadderParameters(1, 0, USDC(100), 7 * DAY))
                .to.be.revertedWith("growthStep must be > 0");
            // And with k == 1 the ladder climbs ONLY by the additive step.
            await rep.setLadderParameters(1, USDC(100), USDC(100), 7 * DAY);
            let prev = 0n;
            for (let i = 1; i <= 4; i++) {
                const limit = await rep.calculateCreditLimit(agent.address);
                expect(limit, "k=1 ladder must strictly increase").to.be.gt(prev);
                prev = limit;
                await rep.recordBorrow(agent.address, i, limit);
                await time.increase(7 * DAY);
                await rep.recordLoanCompletion(agent.address, i, limit, true, 0);
            }
            // 100 → 200 → 300 → 400 → 500
            expect(await rep.calculateCreditLimit(agent.address)).to.equal(USDC(500));
        });

        it("THE LADDER CLIMBS from bootstrap to the tier cap and then stops there", async function () {
            // Push the score into the top tier so the tier cap is 5,000 (V7 table).
            await rep.setReputationRateLimit(0, DAY);
            for (let i = 100; i < 190; i++) {
                await rep.recordBorrow(agent.address, i, USDC(100));
                await time.increase(7 * DAY);
                await rep.recordLoanCompletion(agent.address, i, USDC(100), true, 0);
                if ((await rep["getReputationScore(uint256)"](agentId)) >= 800n) break;
            }
            expect(await rep["getReputationScore(uint256)"](agentId)).to.be.gte(800n);
            expect(await rep.tierLimit(await rep["getReputationScore(uint256)"](agentId))).to.equal(USDC(5000));

            // Now climb the ladder, borrowing the whole limit each rung.
            const rungs = [];
            for (let i = 1; i <= 8; i++) {
                const limit = await rep.calculateCreditLimit(agent.address);
                rungs.push(Number(limit) / 1e6);
                await rep.recordBorrow(agent.address, 500 + i, limit);
                await time.increase(7 * DAY);
                await rep.recordLoanCompletion(agent.address, 500 + i, limit, true, 0);
            }
            // The score pump already repaid 100-USDC loans, so the ladder starts at
            // 2*100 + 100 = 300: 300 → 700 → 1500 → 3100 → 5000 (tier cap) → 5000 …
            expect(rungs.slice(0, 5)).to.deep.equal([300, 700, 1500, 3100, 5000]);
            for (let i = 1; i < 5; i++) {
                expect(rungs[i], `rung ${i} must climb`).to.be.gt(rungs[i - 1]);
            }
            expect(rungs[7]).to.equal(5000, "ladder must stop at the tier cap, never exceed it");
            expect(await rep.calculateCreditLimit(agent.address)).to.equal(USDC(5000));
        });

        it("ladderLimit() exposes the uncapped ladder head-room", async function () {
            await rep.recordBorrow(agent.address, 1, USDC(400));
            await time.increase(7 * DAY);
            await rep.recordLoanCompletion(agent.address, 1, USDC(400), true, 0);
            expect(await rep.ladderLimit(agentId)).to.equal(USDC(900)); // 2*400 + 100
        });

        it("setLadderParameters validates its range", async function () {
            await expect(rep.setLadderParameters(0, USDC(100), USDC(100), 7 * DAY)).to.be.revertedWith("creditMultiple < 1");
            await expect(rep.setLadderParameters(11, USDC(100), USDC(100), 7 * DAY)).to.be.revertedWith("creditMultiple too high");
            await expect(rep.setLadderParameters(2, USDC(100), 0, 7 * DAY)).to.be.revertedWith("bootstrapLimit range");
            await expect(rep.setLadderParameters(2, USDC(100), USDC(100), 0)).to.be.revertedWith("refDuration range");
            await expect(rep.setLadderParameters(2, USDC(100_000), USDC(100), 7 * DAY)).to.be.revertedWith("growthStep exceeds ceiling");
            await expect(rep.connect(agent).setLadderParameters(2, USDC(100), USDC(100), 7 * DAY))
                .to.be.revertedWithCustomError(rep, "OwnableUnauthorizedAccount");
        });
    });

    // ---------------------------------------------------------- M1-3 defaults

    describe("M1-3 — size-proportional default penalty, capacity reset, lockout", function () {
        beforeEach(async function () {
            await rep.setReputationRateLimit(0, DAY);
            for (let i = 100; i < 200; i++) {
                await rep.recordBorrow(agent.address, i, USDC(100));
                await time.increase(7 * DAY);
                await rep.recordLoanCompletion(agent.address, i, USDC(100), true, 0);
                if ((await rep["getReputationScore(uint256)"](agentId)) >= 800n) break;
            }
        });

        it("ships a 1,000 USDC largeLoanThreshold so a capped bust-out is not a flat step", async function () {
            expect(await rep.largeLoanThreshold()).to.equal(USDC(1000));
            const before = await rep["getReputationScore(uint256)"](agentId);
            await rep.recordBorrow(agent.address, 890, USDC(5000)); // a maximum V7 draw
            await rep.recordDefault(agent.address, 890, USDC(5000));
            expect(before - (await rep["getReputationScore(uint256)"](agentId))).to.equal(500n);
        });

        it("penalty scales with the defaulted amount (V3 charged a flat step)", async function () {
            await rep.setScoringParameters(10, 50, 100, USDC(10000)); // pin the divisor
            const before = await rep["getReputationScore(uint256)"](agentId);
            await rep.recordBorrow(agent.address, 900, USDC(20000));
            await rep.recordDefault(agent.address, 900, USDC(20000));
            // defaultPenaltyLarge(100) * 20000 / largeLoanThreshold(10000) = 200
            expect(before - (await rep["getReputationScore(uint256)"](agentId))).to.equal(200n);
        });

        it("penalty is floored at defaultPenaltyBase for a small default", async function () {
            const before = await rep["getReputationScore(uint256)"](agentId);
            await rep.recordBorrow(agent.address, 901, USDC(100));
            await rep.recordDefault(agent.address, 901, USDC(100));
            expect(before - (await rep["getReputationScore(uint256)"](agentId))).to.equal(50n);
        });

        it("resets maxRepaidPrincipal to zero — capacity must be re-demonstrated", async function () {
            await rep.recordBorrow(agent.address, 902, USDC(1000));
            await time.increase(7 * DAY);
            await rep.recordLoanCompletion(agent.address, 902, USDC(1000), true, 0);
            expect(await rep.maxRepaidPrincipal(agentId)).to.equal(USDC(1000));
            await rep.recordBorrow(agent.address, 903, USDC(5000));
            await rep.recordDefault(agent.address, 903, USDC(5000));
            expect(await rep.maxRepaidPrincipal(agentId)).to.equal(0n);
        });

        it("forces the credit limit to ZERO for defaultLockout, then restores it", async function () {
            await rep.recordBorrow(agent.address, 904, USDC(5000));
            await rep.recordDefault(agent.address, 904, USDC(5000));
            expect(await rep.isLockedOut(agentId)).to.equal(true);
            expect(await rep.calculateCreditLimit(agent.address)).to.equal(0n);
            await time.increase(180 * DAY + 1);
            expect(await rep.isLockedOut(agentId)).to.equal(false);
            expect(await rep.calculateCreditLimit(agent.address)).to.equal(USDC(100)); // bootstrap only
        });

        it("earns NO reputation during the lockout, and the ladder does not advance", async function () {
            await rep.recordBorrow(agent.address, 905, USDC(5000));
            await rep.recordDefault(agent.address, 905, USDC(5000));
            const s0 = await rep["getReputationScore(uint256)"](agentId);
            await rep.recordBorrow(agent.address, 906, USDC(100));
            await time.increase(7 * DAY);
            await rep.recordLoanCompletion(agent.address, 906, USDC(100), true, 0);
            expect(await rep["getReputationScore(uint256)"](agentId)).to.equal(s0);
            expect(await rep.maxRepaidPrincipal(agentId)).to.equal(0n);
        });

        it("a second, smaller default never SHORTENS an existing lockout", async function () {
            await rep.recordBorrow(agent.address, 907, USDC(5000));
            await rep.recordDefault(agent.address, 907, USDC(5000));
            const until1 = await rep.lockedUntil(agentId);
            await time.increase(100 * DAY);
            await rep.setDefaultLockout(1 * DAY);
            await rep.recordBorrow(agent.address, 908, USDC(100));
            await rep.recordDefault(agent.address, 908, USDC(100));
            expect(await rep.lockedUntil(agentId)).to.equal(until1);
        });

        it("penalty is capped at MAX_SCORE and the score floors at 0", async function () {
            await rep.recordBorrow(agent.address, 909, USDC(10_000_000));
            await rep.recordDefault(agent.address, 909, USDC(10_000_000));
            expect(await rep["getReputationScore(uint256)"](agentId)).to.equal(0n);
        });

        it("setDefaultLockout is owner-only and bounded", async function () {
            await expect(rep.setDefaultLockout(800 * DAY)).to.be.revertedWith("Lockout too long");
            await expect(rep.connect(agent).setDefaultLockout(DAY))
                .to.be.revertedWithCustomError(rep, "OwnableUnauthorizedAccount");
        });
    });

    // --------------------------------------------------------- M1-4 tier cap

    describe("M1-4 — owner-settable tier table with a hard ceiling", function () {
        it("ships the V7 capped table (600 → 2,500, 800 → 5,000)", async function () {
            for (let i = 0; i < 6; i++) {
                expect(await rep.tierLimits(i)).to.equal(DEFAULT_TIER_LIMITS[i]);
            }
            expect(await rep.tierLimit(600)).to.equal(USDC(2500));
            expect(await rep.tierLimit(800)).to.equal(USDC(5000));
            expect(await rep.tierLimit(1000)).to.equal(USDC(5000));
        });

        it("bounds UNSECURED exposure monotonically across tiers — the 500 tier cannot route around the cap", async function () {
            const exp = [];
            for (let i = 0; i < 6; i++) exp.push(Number(await rep.unsecuredTierExposure(i)) / 1e6);
            expect(exp).to.deep.equal([0, 0, 0, 2500, 2500, 5000]);
            for (let i = 1; i < 6; i++) {
                expect(exp[i], `unsecured exposure must not decrease at tier ${i}`).to.be.gte(exp[i - 1]);
            }
        });

        it("the owner can retune the table", async function () {
            const t = [USDC(500), USDC(1000), USDC(2000), USDC(2000), USDC(1500), USDC(3000)];
            await expect(rep.setTierLimits(t)).to.emit(rep, "TierLimitsUpdated");
            expect(await rep.tierLimit(800)).to.equal(USDC(3000));
        });

        it("THE OWNER KEY CANNOT RAISE A TIER ABOVE MAX_TIER_LIMIT", async function () {
            expect(await rep.MAX_TIER_LIMIT()).to.equal(USDC(10000));
            const t = [...DEFAULT_TIER_LIMITS];
            t[5] = USDC(50000); // the V3 exposure the attack monetised
            await expect(rep.setTierLimits(t)).to.be.revertedWith("Tier limit exceeds ceiling");
        });

        it("rejects a zero tier limit and non-owners", async function () {
            const t = [...DEFAULT_TIER_LIMITS]; t[0] = 0n;
            await expect(rep.setTierLimits(t)).to.be.revertedWith("Tier limit must be > 0");
            await expect(rep.connect(agent).setTierLimits(DEFAULT_TIER_LIMITS))
                .to.be.revertedWithCustomError(rep, "OwnableUnauthorizedAccount");
        });

        it("the ERC-8004 validation bonus cannot exceed the ceiling either", async function () {
            await expect(rep.setValidationBonusParameters(75, USDC(50000)))
                .to.be.revertedWith("Bonus exceeds ceiling");
        });

        it("tierOf / collateral / interest follow the same table", async function () {
            expect(await rep.tierOf(0)).to.equal(0n);
            expect(await rep.tierOf(199)).to.equal(0n);
            expect(await rep.tierOf(200)).to.equal(1n);
            expect(await rep.tierOf(400)).to.equal(2n);
            expect(await rep.tierOf(500)).to.equal(3n);
            expect(await rep.tierOf(600)).to.equal(4n);
            expect(await rep.tierOf(1000)).to.equal(5n);
            expect(await rep.tierCollateralPct(3)).to.equal(75n, "500 tier moves 25% -> 75% (see M1-4)");
            expect(await rep.tierInterestBps(5)).to.equal(500n);
        });
    });

    // -------------------------------------------------------- M1-5 late hook

    describe("M1-5 — late-repayment reputation penalty (the hook V3 lacked)", function () {
        beforeEach(async function () {
            for (let i = 1; i <= 30; i++) {
                await rep.recordBorrow(agent.address, i, USDC(100));
                await time.increase(7 * DAY);
                await rep.recordLoanCompletion(agent.address, i, USDC(100), true, 0);
            }
        });

        it("applies latePenaltyBase + perDay * fullDaysLate", async function () {
            const before = await rep["getReputationScore(uint256)"](agentId);
            await rep.recordBorrow(agent.address, 50, USDC(100));
            await time.increase(10 * DAY);
            await rep.recordLoanCompletion(agent.address, 50, USDC(100), false, 3 * DAY);
            expect(before - (await rep["getReputationScore(uint256)"](agentId))).to.equal(25n); // 10 + 5*3
            expect(await rep.lateCount(agentId)).to.equal(1n);
        });

        it("caps the penalty at latePenaltyMax", async function () {
            const before = await rep["getReputationScore(uint256)"](agentId);
            await rep.recordBorrow(agent.address, 51, USDC(100));
            await time.increase(200 * DAY);
            await rep.recordLoanCompletion(agent.address, 51, USDC(100), false, 180 * DAY);
            expect(before - (await rep["getReputationScore(uint256)"](agentId))).to.equal(100n);
        });

        it("a late repayment does NOT advance the credit ladder", async function () {
            const cap = await rep.maxRepaidPrincipal(agentId);
            await rep.recordBorrow(agent.address, 52, USDC(5000));
            await time.increase(10 * DAY);
            await rep.recordLoanCompletion(agent.address, 52, USDC(5000), false, 2 * DAY);
            expect(await rep.maxRepaidPrincipal(agentId)).to.equal(cap);
        });

        it("emits LateRepaymentRecorded", async function () {
            await rep.recordBorrow(agent.address, 53, USDC(100));
            await time.increase(9 * DAY);
            await expect(rep.recordLoanCompletion(agent.address, 53, USDC(100), false, 2 * DAY))
                .to.emit(rep, "LateRepaymentRecorded").withArgs(agentId, 53, 2 * DAY, 20);
        });

        it("the score floors at 0 rather than underflowing", async function () {
            await rep.setLatePenaltyParameters(300, 0, 300);
            for (let i = 60; i < 70; i++) {
                await rep.recordBorrow(agent.address, i, USDC(100));
                await time.increase(9 * DAY);
                await rep.recordLoanCompletion(agent.address, i, USDC(100), false, DAY);
            }
            expect(await rep["getReputationScore(uint256)"](agentId)).to.equal(0n);
        });

        it("setLatePenaltyParameters validates and is owner-only", async function () {
            await expect(rep.setLatePenaltyParameters(10, 5, 400)).to.be.revertedWith("Late penalty too high");
            await expect(rep.setLatePenaltyParameters(200, 5, 100)).to.be.revertedWith("Component exceeds max");
            await expect(rep.connect(agent).setLatePenaltyParameters(1, 1, 1))
                .to.be.revertedWithCustomError(rep, "OwnableUnauthorizedAccount");
        });
    });

    // --------------------------------------------------- M2-d loanId registry

    describe("M2-d — loanId-keyed open-loan registry", function () {
        it("records and clears the open loan", async function () {
            await rep.recordBorrow(agent.address, 7, USDC(250));
            const ol = await rep.openLoans(owner.address, 7);
            expect(ol.amount).to.equal(USDC(250));
            expect(ol.agentId).to.equal(agentId);
            await time.increase(7 * DAY);
            await rep.recordLoanCompletion(agent.address, 7, USDC(250), true, 0);
            expect((await rep.openLoans(owner.address, 7)).start).to.equal(0n);
        });

        it("refuses to record the same loanId twice", async function () {
            await rep.recordBorrow(agent.address, 7, USDC(100));
            await expect(rep.recordBorrow(agent.address, 7, USDC(100))).to.be.revertedWith("Loan already recorded");
        });

        it("CONCURRENT EQUAL-SIZE LOANS get their own exact hold times (the report's ambiguity)", async function () {
            await rep.recordBorrow(agent.address, 1, USDC(100)); // held 7 days
            await time.increase(6 * DAY);
            await rep.recordBorrow(agent.address, 2, USDC(100)); // held 1 day
            await time.increase(1 * DAY);
            await rep.recordLoanCompletion(agent.address, 2, USDC(100), true, 0); // short one first
            expect(await rep["getReputationScore(uint256)"](agentId)).to.equal(101n); // 1/7 of 10
            await rep.recordLoanCompletion(agent.address, 1, USDC(100), true, 0);
            expect(await rep["getReputationScore(uint256)"](agentId)).to.equal(111n); // + full 10
        });

        it("rejects a completion whose record belongs to a different agent", async function () {
            await f.fund(other);
            await f.onboardAgent(other, "ipfs://other");
            await rep.recordBorrow(agent.address, 9, USDC(100));
            await expect(rep.recordLoanCompletion(other.address, 9, USDC(100), true, 0))
                .to.be.revertedWith("Loan/agent mismatch");
        });

        it("an unrecorded loanId degrades safely to zero hold (no bonus, no revert)", async function () {
            await rep.recordLoanCompletion(agent.address, 4242, USDC(100), true, 0);
            expect(await rep["getReputationScore(uint256)"](agentId)).to.equal(100n);
        });

        it("only authorized pools may write", async function () {
            await expect(rep.connect(agent).recordBorrow(agent.address, 1, USDC(100)))
                .to.be.revertedWith("Only authorized pools");
            await expect(rep.connect(agent).recordLoanCompletion(agent.address, 1, USDC(100), true, 0))
                .to.be.revertedWith("Only authorized pools");
            await expect(rep.connect(agent).recordDefault(agent.address, 1, USDC(100)))
                .to.be.revertedWith("Only authorized pools");
        });
    });

    // --------------------------------------------------------------- hygiene

    describe("V4 hygiene", function () {
        it("reports VERSION V4", async function () {
            expect(await rep.VERSION()).to.equal("V4");
        });

        it("is Ownable2Step and cannot renounce (I-1)", async function () {
            await expect(rep.renounceOwnership()).to.be.revertedWith("Ownership cannot be renounced");
            await rep.transferOwnership(other.address);
            expect(await rep.owner()).to.equal(owner.address); // not yet accepted
            await rep.connect(other).acceptOwnership();
            expect(await rep.owner()).to.equal(other.address);
        });

        it("rejects a zero registry at construction", async function () {
            const F = await ethers.getContractFactory("ReputationManagerV4");
            await expect(F.deploy(ethers.ZeroAddress)).to.be.revertedWith("Invalid registry");
        });

        it("initializeReputation is one-shot and identity-checked (C-02)", async function () {
            await expect(rep.connect(agent)["initializeReputation()"]()).to.be.revertedWith("Already initialized");
            // A never-initialized agent cannot be claimed by someone else.
            await registry.connect(other).register("ipfs://other", []);
            const otherId = await registry.addressToAgentId(other.address);
            const [, , , third] = f.signers;
            await expect(rep.connect(third)["initializeReputation(uint256)"](otherId))
                .to.be.revertedWith("Caller is not the owner of this agent");
            await expect(rep.connect(other)["initializeReputation(uint256)"](otherId)).to.not.be.reverted;
        });

        it("largeLoanThreshold cannot be set to zero (it is a divisor)", async function () {
            await expect(rep.setScoringParameters(10, 50, 100, 0)).to.be.revertedWith("Threshold must be > 0");
        });
    });
});
