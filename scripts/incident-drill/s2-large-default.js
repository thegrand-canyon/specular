// SCENARIO 2 — a borrower defaults large enough to socialise loss, with the
// agent's own M2 first-loss self-stake in place.
//
// What this proves or disproves, on the real V6.2 + V4 code at the live Arc-mainnet
// levers:
//   * M2-a  the creator's own position really is LOCKED while it owes principal
//   * M2-b  that position absorbs the loss BEFORE any other lender (ordering)
//   * L7    a lender who joined MID-LOAN bears none of that loan's loss
//   * M1-3  credit ladder resets to 0 and the 180-day lockout engages
//   * detection: does the monitor page anyone about an OVERDUE loan at all?
//   * nothing strands: every survivor can still withdraw/claim after the default
//
// Usage: npx hardhat run --network localhost scripts/incident-drill/s2-large-default.js

const { ethers } = require('hardhat');
const L = require('./lib');
const { USDC, u, DAY, advance, attempt } = L;

async function main() {
    const a = L.addr();
    const signers = await ethers.getSigners();
    const owner = signers[0];
    const agentC = signers[6];      // the borrower that will default
    const victimA = signers[7];     // lender in BEFORE the loan  (qualified)
    const victimB = signers[8];     // lender in BEFORE the loan  (qualified)
    const lateLender = signers[9];  // lender in AFTER  the loan starts (L7: not qualified)

    const v6 = await ethers.getContractAt('AgentLiquidityMarketplaceV62', a.agentLiquidityMarketplace_v6);
    const rep = await ethers.getContractAt('ReputationManagerV4', a.reputationManagerV4);
    const reg = await ethers.getContractAt('AgentRegistryV2', a.agentRegistryV2);
    const usdc = await ethers.getContractAt('MockUSDC', a.usdc);

    const snap = await L.snap();
    const steps = [];
    const S = (k, v) => { steps.push({ step: k, ...v }); console.log(`  ${k}: ${JSON.stringify(v)}`); };

    // ---------------------------------------------------------------- onboarding
    for (const w of [agentC, victimA, victimB, lateLender]) {
        await (await usdc.mint(w.address, USDC(500000))).wait();
        await (await usdc.connect(w).approve(await v6.getAddress(), ethers.MaxUint256)).wait();
    }
    await (await reg.connect(agentC).register('ipfs://agentC', [])).wait();
    const idC = await reg.addressToAgentId(agentC.address);
    await (await rep.connect(agentC)['initializeReputation()']()).wait();
    await (await v6.connect(agentC).createAgentPool()).wait();

    // Bootstrap: the agent seeds its OWN pool. This is the M2 self-stake; it is
    // exempt from minSupplyAmount by design (M2-a comment in supplyLiquidity).
    await (await v6.connect(agentC).supplyLiquidity(idC, USDC(3000))).wait();

    // ------------------------------------------------- climb to the 0 %-collateral tier
    console.log('climbing reputation to the 600 tier at the live 5 pts/day rate limit...');
    const climb = await L.climbTo({ v6, rep, usdc, agent: agentC, agentId: idC }, 600, { loanSize: USDC(100) });
    S('climbed', { cycles: climb.cycles, score: climb.score, collateralPct: Number(await rep.collateralRequirementOf(idC)), tierLimit: u(await rep.tierLimit(climb.score)) });

    // Victim lenders arrive BEFORE any of the loans that will default.
    await (await v6.connect(victimA).supplyLiquidity(idC, USDC(1000))).wait();
    await (await v6.connect(victimB).supplyLiquidity(idC, USDC(500))).wait();

    console.log('climbing the M1 credit ladder to the tier cap...');
    const rungs = await L.climbLadderTo({ v6, rep, usdc, agent: agentC, agentId: idC }, USDC(2400));
    S('ladder', { rungs, creditLimit: u(await rep.calculateCreditLimit(agentC.address)), maxRepaidPrincipal: u(await rep.maxRepaidPrincipal(idC)) });

    // The attacker trims its self-stake to exactly the M2-c minimum for the loan it
    // is about to take. Allowed only because it has no outstanding principal right
    // now — that is M2-a doing its job.
    const LOAN = USDC(2400);
    const need = await v6.requiredSelfStake(idC, LOAN);
    const have = (await v6.positions(idC, agentC.address)).amount;
    if (have > need) await (await v6.connect(agentC).withdrawLiquidity(idC, have - need)).wait();
    S('self-stake trimmed to the M2-c minimum', { requiredSelfStake: u(need), actual: u((await v6.positions(idC, agentC.address)).amount) });

    const preLoan = await L.poolSnapshot(v6, idC);
    const scoreBefore = Number(await rep['getReputationScore(uint256)'](idC));

    // ------------------------------------------------------------ the bad loan
    await (await v6.connect(agentC).requestLoan(LOAN, 7)).wait();
    const loanId = (await v6.nextLoanId()) - 1n;
    const loan = await v6.loans(loanId);
    S('loan opened', { loanId: Number(loanId), principal: u(loan.amount), collateral: u(loan.collateralAmount), rateBps: Number(loan.interestRate) });

    // M2-a: the self-stake must now be un-withdrawable.
    const lockTest = await attempt('agent withdraws its own self-stake mid-loan', () => v6.connect(agentC).withdrawLiquidity(idC, 1n));
    S('M2-a lock', { blocked: !lockTest.ok, revert: lockTest.revert });

    // L7: a lender who arrives AFTER the loan started must bear none of its loss.
    await advance(DAY);
    await (await v6.connect(lateLender).supplyLiquidity(idC, USDC(500))).wait();
    const qLate = await v6.qualifiedAmountAt(idC, lateLender.address, loan.startTime);
    S('mid-loan lender', { supplied: 500, qualifiedForThisLoan: u(qLate) });

    // ------------------------------------------------- overdue, but is anyone told?
    await advance(8 * DAY);   // 1 day past a 7-day term
    const overdueRun = L.runMonitor();
    S('DETECT: monitor on an OVERDUE, unliquidated loan', {
        exitCode: overdueRun.exitCode, codes: overdueRun.codes,
        detected: overdueRun.exitCode !== 0,
    });

    // ------------------------------------------------------------- liquidation
    const balBefore = {
        agent: await usdc.balanceOf(agentC.address),
        victimA: await usdc.balanceOf(victimA.address),
        victimB: await usdc.balanceOf(victimB.address),
        lateLender: await usdc.balanceOf(lateLender.address),
    };
    const atLoan = await L.poolSnapshot(v6, idC);
    const tx = await (await v6.connect(owner).liquidateLoan(loanId)).wait();
    const post = await L.poolSnapshot(v6, idC);

    const ev = {};
    for (const lg of tx.logs) {
        try {
            const p = v6.interface.parseLog(lg);
            if (p) ev[p.name] = p.args.map(x => (typeof x === 'bigint' ? x.toString() : String(x)));
        } catch {}
    }

    const posOf = async w => (await v6.positions(idC, w.address));
    const loss = (before, after) => u(before - after);
    const lenderRows = [];
    for (const [name, w] of [['agent self-stake (creator)', agentC], ['victimA (in before the loan)', victimA], ['victimB (in before the loan)', victimB], ['lateLender (in AFTER loan start)', lateLender]]) {
        const b = atLoan.lenders.find(x => x.address.toLowerCase() === w.address.toLowerCase());
        const p = await posOf(w);
        lenderRows.push({
            lender: name, address: w.address,
            principalBefore: b ? u(b.amount) : 0,
            principalAfter: u(p.amount),
            lost: b ? loss(b.amount, p.amount) : 0,
            lostPct: b && b.amount > 0n ? Number((10000n * (b.amount - p.amount)) / b.amount) / 100 : 0,
            unclaimedInterestAfter: u(p.earnedInterest),
            qualifiedForDefaultedLoan: u(await v6.qualifiedAmountAt(idC, w.address, loan.startTime).catch(() => 0n)),
        });
    }

    const scoreAfter = Number(await rep['getReputationScore(uint256)'](idC));
    const lockedUntil = Number(await rep.lockedUntil(idC));
    const chainNow = await L.now();

    // Conservation after the loss: Σ principal + Σ unclaimed interest == avail + loaned
    let claims = 0n;
    for (const l of post.lenders) claims += l.amount + l.earnedInterest;
    const backing = post.availableLiquidity + post.totalLoaned;

    // Nothing strands: every survivor can actually get their money out.
    const exits = [];
    for (const [name, w] of [['victimA', victimA], ['victimB', victimB], ['lateLender', lateLender], ['agent(creator)', agentC]]) {
        const p = await posOf(w);
        if (p.earnedInterest > 0n) exits.push({ who: name, action: 'claimInterest', ...(await attempt('claim', () => v6.connect(w).claimInterest(idC))) });
        if (p.amount > 0n) exits.push({ who: name, action: 'withdrawLiquidity(full)', ...(await attempt('withdraw', () => v6.connect(w).withdrawLiquidity(idC, p.amount))) });
    }

    const recovery = L.runMonitor();

    const result = {
        scenario: 'S2 — large default, M2 first-loss self-stake',
        levers: a._levers,
        agentId: idC.toString(),
        climb: { cycles: climb.cycles, scoreReached: climb.score, rungs },
        loan: { loanId: Number(loanId), principal: u(loan.amount), collateralPosted: u(loan.collateralAmount), collateralPct: 0, durationDays: 7 },
        selfStakeLockHeld: !lockTest.ok,
        selfStakeLockRevert: lockTest.revert,
        detection: {
            overdueLoanDetected: overdueRun.exitCode !== 0,
            overdueMonitorExit: overdueRun.exitCode,
            overdueMonitorCodes: overdueRun.codes,
            note: 'The monitor has NO overdue-ACTIVE-loan check. Liquidation is not alert-driven.',
        },
        liquidation: {
            gasUsed: Number(tx.gasUsed),
            events: ev,
            selfStakeAbsorbed: ev.SelfStakeAbsorbedLoss ? u(BigInt(ev.SelfStakeAbsorbedLoss[2])) : 0,
            interestLossSocialized: ev.InterestLossSocialized ? u(BigInt(ev.InterestLossSocialized[1])) : 0,
        },
        m2OrderingHeld:
            !!ev.SelfStakeAbsorbedLoss
            && lenderRows[0].lostPct === 100
            && lenderRows[0].lost >= lenderRows[1].lost,
        l7Held: lenderRows[3].lost === 0 && lenderRows[3].qualifiedForDefaultedLoan === 0,
        lenderOutcomes: lenderRows,
        reputation: {
            scoreBefore, scoreAfter, penaltyApplied: scoreBefore - scoreAfter,
            expectedPenalty: Math.max(50, Math.floor(100 * u(LOAN) / 1000)),
            maxRepaidPrincipalAfter: u(await rep.maxRepaidPrincipal(idC)),
            creditLimitAfter: u(await rep.calculateCreditLimit(agentC.address)),
            isLockedOut: await rep.isLockedOut(idC),
            lockoutDays: Math.round((lockedUntil - chainNow) / DAY),
            defaultCount: Number(await rep.defaultCount(idC)),
        },
        poolBefore: L.prettyPool(preLoan),
        poolAtLoan: L.prettyPool(atLoan),
        poolAfter: L.prettyPool(post),
        conservationAfterLoss: { claims: u(claims), backing: u(backing), delta: u(backing - claims), holds: claims === backing },
        nothingStranded: exits.every(e => e.ok),
        exits,
        monitorAfterLiquidation: { exitCode: recovery.exitCode, codes: recovery.codes },
    };
    console.log(JSON.stringify(result, null, 2));
    L.writeResult('s2-large-default.json', result);
    await L.revert(snap);
}

main().catch(e => { console.error(e); process.exit(1); });
