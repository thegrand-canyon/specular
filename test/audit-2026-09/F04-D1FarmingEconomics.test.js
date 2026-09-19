// F-04 [HIGH, design — D1 residual, quantified under the LIVE levers]
// Cost to farm from the initialised score (100) to the 0%-collateral tier (600,
// 25,000 USDC unsecured limit) with a self-lender under the exact mainnet config:
//   rate limit 20 pts/day, minHold 1 day, fee 1%, bonusReference 100 USDC.
// The "cost" the D1 mitigations impose is the 1% platform fee on the interest of
// 50 x 100-USDC 7-day loans (~0.14 USDC) + gas + 25 calendar days. Working
// capital (~200 USDC) is fully recovered. The unlocked exposure is 25,000 USDC of
// other people's money per agent, and the default penalty (-100 for >10k) is
// re-farmed in 5 days.
//
// CONVENTION: the two primary tests assert what a sound reputation economy would
// guarantee -> FAILING = CONFIRMED (D1 is time-gated, not economically gated).

const { expect } = require("chai");
const { deployLaunchStack, USDC, DAY } = require("./_fixture");

describe("F-04 [HIGH/design] D1 reputation-farming economics under live levers", function () {
    this.timeout(600000);
    let f, farmer, victimLender, agentId;
    const LOAN = USDC(100);
    let days = 0, cycles = 0, gasUsed = 0n;
    const score = async () => f.reputation["getReputationScore(uint256)"](agentId);

    before(async () => {
        f = await deployLaunchStack();
        [, farmer, victimLender] = f.signers;
        // working capital: 200 self-lend + 100 collateral float per loan (returned) + interest float (recaptured)
        await f.fund(farmer, USDC(500)); await f.fund(victimLender);
        const startBal = await f.usdc.balanceOf(farmer.address);
        f.startBal = startBal;
        agentId = await f.onboardAgent(farmer);                // score 100 (free initialise)
        await f.v6.connect(farmer).supplyLiquidity(agentId, USDC(200)); // self-lend: 2 concurrent 100-USDC loans
        expect(await score()).to.equal(100n);

        // Farm to 600: 2 loans/day x 10 pts = the 20 pts/day cap; hold 1 day (minHold), repay, repeat.
        while ((await score()) < 600n) {
            const id1 = await f.v6.nextLoanId();
            let r = await (await f.v6.connect(farmer).requestLoan(LOAN, 7)).wait(); gasUsed += r.gasUsed;
            r = await (await f.v6.connect(farmer).requestLoan(LOAN, 7)).wait();       gasUsed += r.gasUsed;
            await f.time.increase(DAY); days++;
            r = await (await f.v6.connect(farmer).repayLoan(id1)).wait();             gasUsed += r.gasUsed;
            r = await (await f.v6.connect(farmer).repayLoan(id1 + 1n)).wait();        gasUsed += r.gasUsed;
            cycles += 2;
            // farmer recaptures its own interest as the sole qualified lender
            await f.v6.connect(farmer).claimInterest(agentId);
        }
    });

    it("[numbers, passes] prints the farming bill", async () => {
        const fees = await f.v6.accumulatedFees();
        const gasUSDC = Number(gasUsed) * 20.1e9 / 1e18; // Arc gas 20.1 gwei, paid in USDC (native view)
        console.log(`      farmed 100 -> ${await score()} in ${days} days, ${cycles} loans`);
        console.log(`      protocol fees paid: ${Number(fees) / 1e6} USDC; gas ~${gasUSDC.toFixed(3)} USDC @20.1 gwei`);
        const netSpent = f.startBal - (await f.usdc.balanceOf(farmer.address)) - USDC(200); // 200 still self-lent (recoverable)
        console.log(`      farmer net USDC spent (excl. recoverable self-lend): ${Number(netSpent) / 1e6} USDC`);
        console.log(`      credit limit now: ${Number(await f.reputation.calculateCreditLimit(farmer.address)) / 1e6} USDC, collateral ${await f.reputation.calculateCollateralRequirement(farmer.address)}%`);
        expect(await f.reputation.calculateCollateralRequirement(farmer.address)).to.equal(0n);
        expect(await f.reputation.calculateCreditLimit(farmer.address)).to.equal(USDC(25_000));
        expect(days).to.equal(25);
    });

    // pending: owner decision / deployment action — see INTERNAL_AUDIT_2026-09-19.md (F-04: ReputationManagerV3 model change)
    it.skip("SECURE PROPERTY: unlocking 25,000 USDC of unsecured credit costs at least 1% of it (250 USDC) in non-recoverable fees", async () => {
        const fees = await f.v6.accumulatedFees();
        expect(fees).to.be.gte(USDC(250));
    });

    // pending: owner decision / deployment action — see INTERNAL_AUDIT_2026-09-19.md (F-04: ReputationManagerV3 model change)
    it.skip("SECURE PROPERTY: a 25k unsecured default costs more reputation than 5 days of farming can rebuild", async () => {
        // bust-out: a real lender funds the pool, farmer borrows the full limit unsecured and walks.
        await f.v6.connect(farmer).withdrawLiquidity(agentId, USDC(200));
        await f.v6.connect(victimLender).supplyLiquidity(agentId, USDC(25_000));
        const id = await f.v6.nextLoanId();
        await f.v6.connect(farmer).requestLoan(USDC(25_000), 7);
        expect((await f.v6.loans(id)).collateralAmount).to.equal(0n);
        expect(await f.usdc.balanceOf(farmer.address)).to.be.gte(USDC(25_000));
        await f.time.increase(8 * DAY);
        const before = await score();
        await f.v6.liquidateLoan(id);
        const after = await score();
        const lenderPos = await f.v6.getLenderPosition(agentId, victimLender.address);
        console.log(`      bust-out: lender position 25000 -> ${Number(lenderPos.amount) / 1e6} USDC; score ${before} -> ${after}`);
        const penalty = before - after;
        const rebuildDays = Number(penalty) / 20;
        console.log(`      penalty ${penalty} pts = ${rebuildDays} days of farming to return to the 0-collateral tier`);
        expect(penalty).to.be.gte(500n); // i.e. >= 25 days to re-earn; actual is 100 (5 days)
    });
});
