/**
 * LOCAL (hardhat, chainId 31337) — the time-dependent V7 paths that cannot run on a
 * live testnet: a 180-day post-default lockout, late-repayment penalties, default
 * penalty scaling, and a socialised loss (which needs an overdue loan to liquidate).
 *
 * RUN:  export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
 *       npx hardhat run scripts/e2e-v7/local-time-travel.js
 *
 * NOTHING HERE TOUCHES ANY NETWORK. It deploys a fresh V7 stack on the in-process
 * hardhat chain with the LIVE arc-staging levers (k=2, growthStep 100 USDC,
 * bootstrap 100 USDC, refDuration 7 d, minHold 1 d, minSupply 10 USDC, fee 100 bps,
 * M-1 on, rate limit 5/day, lockout 180 d, shipped tier table) and travels time.
 *
 * SETUP SHORTCUT (clearly labelled): reaching the 0 %-collateral tier takes ~50 real
 * loan cycles. Scores and ladder capacity are therefore seeded through the
 * authorized-pool path (`recordBorrow` / `recordLoanCompletion` from the owner, the
 * same shortcut `test/v7/_fixture.js` uses); the owner's pool authorization is then
 * REVOKED so every measured mechanism below runs through the real marketplace.
 *
 * Scenarios:
 *   L1  default penalty scales with size, with a floor at defaultPenaltyBase
 *   L2  default resets maxRepaidPrincipal to 0 and forces creditLimit to 0 for the lockout
 *   L3  the credit line recovers to the bootstrap rung once the lockout expires
 *   L4  a second, smaller default never SHORTENS an existing lockout
 *   L5  late repayment applies the M1-5 reputation penalty and does NOT advance the ladder
 *   L6  the late penalty is capped at latePenaltyMax
 *   L7  socialised loss: the self-stake absorbs first (M2-b) and a lender who joined
 *       MID-LOAN is not charged for that loan's loss (L7)
 */
const { ethers } = require('hardhat');
const { time } = require('@nomicfoundation/hardhat-network-helpers');
const fs = require('fs');
const path = require('path');

const USDC = (n) => ethers.parseUnits(String(n), 6);
const fmt = (x) => ethers.formatUnits(x, 6);
const DAY = 86400;
const OUT = path.join(__dirname, '..', '..', 'forensics', 'output', 'v7-model', 'e2e-v7-results');

const checks = [];
function check(scenario, label, cond, detail = '') {
    const ok = Boolean(cond);
    checks.push({ scenario, label, ok, detail: String(detail) });
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  [${scenario}] ${label}${detail ? '  -- ' + detail : ''}`);
}
function note(scenario, label, detail) {
    checks.push({ scenario, label, ok: null, detail: String(detail) });
    console.log(`  NOTE  [${scenario}] ${label}  -- ${detail}`);
}

async function main() {
    const net = await ethers.provider.getNetwork();
    if (Number(net.chainId) !== 31337) throw new Error(`LOCAL ONLY: chainId ${net.chainId} != 31337`);
    console.log(`local hardhat chain ${net.chainId} — no network is touched\n`);

    const signers = await ethers.getSigners();
    const [owner, G1, G2, G3, G4, G5, G6, LEarly, LMid, LOther] = signers;

    const registry = await (await ethers.getContractFactory('AgentRegistryV2')).deploy();
    const reputation = await (await ethers.getContractFactory('ReputationManagerV4')).deploy(await registry.getAddress());
    const usdc = await (await ethers.getContractFactory('MockUSDC')).deploy();
    const mp = await (await ethers.getContractFactory('AgentLiquidityMarketplaceV62')).deploy(
        await registry.getAddress(), await reputation.getAddress(), await usdc.getAddress());
    const MPA = await mp.getAddress();
    await reputation.authorizePool(MPA);
    await mp.setMigrationFinalized();

    // ---- LIVE arc-staging levers
    await reputation.setReputationRateLimit(5, DAY);
    await reputation.setBonusReferenceAmount(USDC(100));
    await reputation.setScoringParameters(10, 50, 100, USDC(1000));
    await reputation.setLadderParameters(2, USDC(100), USDC(100), 7 * DAY);
    await reputation.setDefaultLockout(180 * DAY);
    await reputation.setLatePenaltyParameters(10, 5, 100);
    await reputation.setTierLimits([USDC(1000), USDC(5000), USDC(10000), USDC(10000), USDC(2500), USDC(5000)]);
    await mp.setMinHoldForReputationReward(DAY);
    await mp.setPlatformFeeRate(100);
    await mp.setBindBorrowToPoolCreator(true);
    await mp.setMinSupplyAmount(USDC(10));
    note('setup', 'levers', 'live arc-staging values: k=2, step=100, boot=100, refDur=7d, minHold=1d, minSupply=10, fee=100bps, M-1 on, rate 5/day, lockout 180d');

    const ids = {};
    for (const [name, w] of Object.entries({ G1, G2, G3, G4, G5, G6 })) {
        await usdc.mint(w.address, USDC(100000));
        await usdc.connect(w).approve(MPA, ethers.MaxUint256);
        await registry.connect(w).register(`ipfs://local-${name}`, []);
        await reputation.connect(w)['initializeReputation()']();
        await mp.connect(w).createAgentPool();
        ids[name] = await registry.addressToAgentId(w.address);
    }
    for (const w of [LEarly, LMid, LOther]) {
        await usdc.mint(w.address, USDC(100000));
        await usdc.connect(w).approve(MPA, ethers.MaxUint256);
    }

    // ---- SETUP SHORTCUT: seed score + ladder capacity via the authorized-pool path
    await reputation.authorizePool(owner.address);
    let synthetic = 1_000_000;
    async function seed(wallet, targetScore, targetCapacity) {
        const agentId = await registry.addressToAgentId(wallet.address);
        while ((await reputation['getReputationScore(uint256)'](agentId)) < BigInt(targetScore)) {
            const id = synthetic++;
            await reputation.recordBorrow(wallet.address, id, USDC(100));
            await time.increase(7 * DAY);
            await reputation.recordLoanCompletion(wallet.address, id, USDC(100), true, 0);
        }
        if (targetCapacity && (await reputation.maxRepaidPrincipal(agentId)) < USDC(targetCapacity)) {
            const id = synthetic++;
            await reputation.recordBorrow(wallet.address, id, USDC(targetCapacity));
            await time.increase(7 * DAY);
            await reputation.recordLoanCompletion(wallet.address, id, USDC(targetCapacity), true, 0);
        }
    }
    await seed(G1, 600, 200);     // 0 % collateral, ladder >= 500
    await seed(G2, 600, 1200);    // 0 % collateral, ladder >= 2500
    await seed(G3, 450, 0);       // 100 % collateral tier, bootstrap rung only
    await seed(G4, 600, 500);     // 0 % collateral, ladder >= 1100
    await seed(G5, 600, 600);     // 0 % collateral, ladder >= 1300
    await seed(G6, 600, 500);     // 0 % collateral, ladder >= 1100 — reserved for L7 (never defaults)
    await reputation.revokePool(owner.address);
    check('setup', 'owner pool authorization REVOKED — every measured mechanism below runs through the marketplace',
        (await reputation.authorizedPools(owner.address)) === false);
    for (const [n, id] of Object.entries(ids)) {
        note('setup', `agent ${n} (#${id})`, `score ${await reputation['getReputationScore(uint256)'](id)} maxRepaid ${fmt(await reputation.maxRepaidPrincipal(id))} ladder ${fmt(await reputation.ladderLimit(id))} limit ${fmt(await reputation.creditLimitOf(id))} coll ${await reputation.calculateCollateralRequirement(Object.values({ G1, G2, G3, G4, G5, G6 })[Object.keys(ids).indexOf(n)].address)}%`);
    }

    // helper: open a loan and let it go overdue, then liquidate
    async function borrowAndDefault(wallet, agentId, amountDisplay, days = 7) {
        const rc = await (await mp.connect(wallet).requestLoan(USDC(amountDisplay), days)).wait();
        const loanId = rc.logs.map(l => { try { return mp.interface.parseLog(l); } catch (e) { return null; } })
            .find(p => p && p.name === 'LoanRequested').args.loanId;
        await time.increase(days * DAY + DAY);
        return { loanId, rc };
    }

    // ================================================================= L1 / L2
    console.log('\n-- L1/L2: default penalty scaling, capacity reset, lockout --');
    const scenarios = [
        { name: 'G1', w: G1, amount: 300, expectPenalty: 50n, why: 'floor: 100·300/1000 = 30 < base 50' },
        { name: 'G5', w: G5, amount: 1000, expectPenalty: 100n, why: '100·1000/1000 = 100 (at the threshold)' },
        { name: 'G2', w: G2, amount: 2000, expectPenalty: 200n, why: '100·2000/1000 = 200 (scales with size)' }
    ];
    const lockouts = {};
    for (const s of scenarios) {
        const agentId = ids[s.name];
        const need = await mp.requiredSelfStake(agentId, USDC(s.amount));
        await mp.connect(s.w).supplyLiquidity(agentId, need);
        await mp.connect(LOther).supplyLiquidity(agentId, USDC(s.amount));
        const scoreBefore = await reputation['getReputationScore(uint256)'](agentId);
        const maxRepaidBefore = await reputation.maxRepaidPrincipal(agentId);
        const { loanId } = await borrowAndDefault(s.w, agentId, s.amount);
        const rcL = await (await mp.liquidateLoan(loanId)).wait();
        const scoreAfter = await reputation['getReputationScore(uint256)'](agentId);
        check('L1', `${s.name}: default of ${s.amount} USDC costs ${s.expectPenalty} points (${s.why})`,
            scoreBefore - scoreAfter === s.expectPenalty, `${scoreBefore} -> ${scoreAfter}`);
        check('L2', `${s.name}: maxRepaidPrincipal reset ${fmt(maxRepaidBefore)} -> 0`,
            (await reputation.maxRepaidPrincipal(agentId)) === 0n && maxRepaidBefore > 0n);
        const cap = rcL.logs.map(l => { try { return reputation.interface.parseLog(l); } catch (e) { return null; } }).find(p => p && p.name === 'CreditCapacityUpdated');
        check('L2', `${s.name}: CreditCapacityUpdated(agent, 0) emitted`, cap && cap.args.maxRepaidPrincipal === 0n);
        const lock = rcL.logs.map(l => { try { return reputation.interface.parseLog(l); } catch (e) { return null; } }).find(p => p && p.name === 'AgentLockedOut');
        check('L2', `${s.name}: AgentLockedOut(agent, now + 180 days) emitted`,
            lock && lock.args.until_ === BigInt(await time.latest()) + BigInt(180 * DAY), lock ? `until ${lock.args.until_}` : 'none');
        check('L2', `${s.name}: isLockedOut == true and creditLimit forced to 0`,
            (await reputation.isLockedOut(agentId)) === true && (await reputation.creditLimitOf(agentId)) === 0n);
        await mp.connect(s.w).supplyLiquidity(agentId, USDC(2000));
        await expectRevert('L2', `${s.name}: a locked-out agent cannot borrow ("Exceeds credit limit")`,
            mp.connect(s.w).requestLoan(USDC(50), 7), 'Exceeds credit limit');
        lockouts[s.name] = await reputation.lockedUntil(agentId);
    }
    const pens = scenarios.map(s => s.expectPenalty);
    check('L1', 'the penalty is proportional above the threshold (1000 -> 100 pts, 2000 -> 200 pts) and floors below it (300 -> 50 pts)',
        pens[1] * 2n === pens[2] && pens[0] === 50n, pens.join(' / '));

    // ================================================================= L4
    console.log('\n-- L4: a second, smaller default never shortens an existing lockout --');
    {
        // G4 opens two loans, defaults on the big one, then (with the lockout lever
        // temporarily shortened) defaults on the small one: lockedUntil must not move.
        const agentId = ids.G4;
        const need = await mp.requiredSelfStake(agentId, USDC(1100));
        await mp.connect(G4).supplyLiquidity(agentId, need);
        await mp.connect(LOther).supplyLiquidity(agentId, USDC(1200));
        const rcA = await (await mp.connect(G4).requestLoan(USDC(1000), 7)).wait();
        const loanA = rcA.logs.map(l => { try { return mp.interface.parseLog(l); } catch (e) { return null; } }).find(p => p && p.name === 'LoanRequested').args.loanId;
        const rcB = await (await mp.connect(G4).requestLoan(USDC(100), 7)).wait();
        const loanB = rcB.logs.map(l => { try { return mp.interface.parseLog(l); } catch (e) { return null; } }).find(p => p && p.name === 'LoanRequested').args.loanId;
        await time.increase(8 * DAY);
        await mp.liquidateLoan(loanA);
        const lockedAfterA = await reputation.lockedUntil(agentId);
        check('L4', 'first default set a 180-day lockout',
            lockedAfterA === BigInt(await time.latest()) + BigInt(180 * DAY), `${lockedAfterA}`);
        await reputation.setDefaultLockout(DAY); // a shorter lockout, so a naive write would move it EARLIER
        await mp.liquidateLoan(loanB);
        const lockedAfterB = await reputation.lockedUntil(agentId);
        check('L4', 'a later, smaller default with a SHORTER lockout lever did NOT shorten the existing lockout',
            lockedAfterB === lockedAfterA, `${lockedAfterA} -> ${lockedAfterB}`);
        await reputation.setDefaultLockout(180 * DAY);
    }

    // ================================================================= L3
    console.log('\n-- L3: the credit line recovers when the lockout expires --');
    {
        const agentId = ids.G1;
        const until = lockouts.G1;
        await time.increaseTo(Number(until) - 10);
        check('L3', 'credit limit is still 0 ten seconds before the lockout expires',
            (await reputation.creditLimitOf(agentId)) === 0n && (await reputation.isLockedOut(agentId)) === true);
        await time.increaseTo(Number(until) + 1);
        const score = await reputation['getReputationScore(uint256)'](agentId);
        const tierLimit = await reputation.tierLimit(score);
        const ladder = await reputation.ladderLimit(agentId);
        const limit = await reputation.creditLimitOf(agentId);
        check('L3', 'isLockedOut false once the 180 days elapse', (await reputation.isLockedOut(agentId)) === false);
        check('L3', 'the ladder restarts at the BOOTSTRAP rung (100 USDC), not where it was',
            ladder === USDC(100) && (await reputation.maxRepaidPrincipal(agentId)) === 0n, fmt(ladder));
        check('L3', 'credit limit recovers to min(tierLimit, bootstrap) exactly',
            limit === (ladder < tierLimit ? ladder : tierLimit) && limit === USDC(100),
            `score ${score} tierLimit ${fmt(tierLimit)} ladder ${fmt(ladder)} -> limit ${fmt(limit)}`);
        const rc = await (await mp.connect(G1).requestLoan(USDC(100), 7)).wait();
        check('L3', 'the agent can borrow again at the bootstrap rung after the lockout', rc.status === 1);
        const loanId = rc.logs.map(l => { try { return mp.interface.parseLog(l); } catch (e) { return null; } }).find(p => p && p.name === 'LoanRequested').args.loanId;
        await time.increase(2 * DAY);
        await mp.connect(G1).repayLoan(loanId);
        check('L3', 'and the ladder starts climbing again from zero (maxRepaidPrincipal 100)',
            (await reputation.maxRepaidPrincipal(agentId)) === USDC(100));
    }

    // ================================================================= L5 / L6
    console.log('\n-- L5/L6: late repayment penalty --');
    {
        const agentId = ids.G3;
        await mp.connect(LOther).supplyLiquidity(agentId, USDC(1000));
        for (const [tag, daysLate, expected] of [['L5', 3, 25n], ['L6', 25, 100n]]) {
            const scoreBefore = await reputation['getReputationScore(uint256)'](agentId);
            const lateCountBefore = await reputation.lateCount(agentId);
            const maxRepaidBefore = await reputation.maxRepaidPrincipal(agentId);
            const rc = await (await mp.connect(G3).requestLoan(USDC(100), 7)).wait();
            const loanId = rc.logs.map(l => { try { return mp.interface.parseLog(l); } catch (e) { return null; } }).find(p => p && p.name === 'LoanRequested').args.loanId;
            await time.increase((7 + daysLate) * DAY + 60);
            const pv = await mp.previewRepayment(loanId);
            const rcR = await (await mp.connect(G3).repayLoan(loanId)).wait();
            const scoreAfter = await reputation['getReputationScore(uint256)'](agentId);
            const ev = rcR.logs.map(l => { try { return reputation.interface.parseLog(l); } catch (e) { return null; } }).find(p => p && p.name === 'LateRepaymentRecorded');
            check(tag, `${daysLate} days late: reputation penalty == ${expected} points (base 10 + 5/day, cap 100)`,
                scoreBefore - scoreAfter === expected && ev && ev.args.penalty === expected,
                `${scoreBefore} -> ${scoreAfter}, event penalty ${ev ? ev.args.penalty : 'none'}`);
            check(tag, `${daysLate} days late: LateRepaymentRecorded carries the loanId and lateSeconds`,
                ev && ev.args.loanId === loanId && ev.args.lateSeconds >= BigInt(daysLate * DAY), ev ? `lateSeconds ${ev.args.lateSeconds}` : 'none');
            check(tag, `${daysLate} days late: the ladder did NOT advance (maxRepaidPrincipal unchanged)`,
                (await reputation.maxRepaidPrincipal(agentId)) === maxRepaidBefore, fmt(maxRepaidBefore));
            check(tag, `${daysLate} days late: lateCount incremented and interest charged on elapsed time (F-03)`,
                (await reputation.lateCount(agentId)) === lateCountBefore + 1n && pv.lateSeconds > 0n &&
                pv.chargeableSeconds > 7n * BigInt(DAY), `chargeable ${pv.chargeableSeconds}s interest ${fmt(pv.interest)}`);
        }
        check('L6', 'the cap keeps a very late repayment from costing more than latePenaltyMax',
            (await reputation.latePenaltyMax()) === 100n);
    }

    // ================================================================= L7
    console.log('\n-- L7: socialised loss basis + M2-b first-loss waterfall --');
    {
        // G6 is reserved for this scenario: it has never defaulted, so it is still at the
        // 0 %-collateral tier and the default loss is the whole principal.
        const G = G6, agentId = ids.G6;
        await mp.connect(LEarly).supplyLiquidity(agentId, USDC(600));
        await mp.connect(G).supplyLiquidity(agentId, USDC(500));
        const limitNow = await reputation.creditLimitOf(agentId);
        check('L7', 'precondition: 0 % collateral tier, creditLimit >= 1000, stake 500, early lender 600, pool has 1100 available',
            limitNow >= USDC(1000) && (await reputation.calculateCollateralRequirement(G.address)) === 0n &&
            (await mp.selfStake(agentId)).amount === USDC(500) &&
            (await mp.positions(agentId, LEarly.address)).amount === USDC(600) &&
            (await mp.getAgentPool(agentId)).availableLiquidity === USDC(1100),
            `limit ${fmt(limitNow)} avail ${fmt((await mp.getAgentPool(agentId)).availableLiquidity)}`);

        const rc = await (await mp.connect(G).requestLoan(USDC(1000), 7)).wait();
        const loanId = rc.logs.map(l => { try { return mp.interface.parseLog(l); } catch (e) { return null; } }).find(p => p && p.name === 'LoanRequested').args.loanId;
        const loan = await mp.loans(loanId);
        check('L7', 'the loan is fully unsecured (0 % collateral tier), so the default loss == principal',
            loan.collateralAmount === 0n && loan.amount === USDC(1000));

        // a lender joins AFTER the loan started — it can never earn interest on this loan
        await time.increase(60);
        await mp.connect(LMid).supplyLiquidity(agentId, USDC(400));
        const qEarly = await mp.qualifiedAmountAt(agentId, LEarly.address, loan.startTime);
        const qMid = await mp.qualifiedAmountAt(agentId, LMid.address, loan.startTime);
        check('L7', 'the mid-loan joiner is NOT qualified for this loan (W1), the early lender is',
            qMid === 0n && qEarly === USDC(600), `early ${fmt(qEarly)} mid ${fmt(qMid)}`);

        await time.increase(8 * DAY);
        const rcL = await (await mp.liquidateLoan(loanId)).wait();
        const absorbed = rcL.logs.map(l => { try { return mp.interface.parseLog(l); } catch (e) { return null; } }).find(p => p && p.name === 'SelfStakeAbsorbedLoss');
        const selfAfter = (await mp.positions(agentId, G.address)).amount;
        const earlyAfter = (await mp.positions(agentId, LEarly.address)).amount;
        const midAfter = (await mp.positions(agentId, LMid.address)).amount;

        check('L7', 'M2-b: the creator\'s self-stake absorbed the loss FIRST, in full (500 -> 0)',
            absorbed && absorbed.args.amount === USDC(500) && selfAfter === 0n, `absorbed ${absorbed ? fmt(absorbed.args.amount) : 'none'}`);
        check('L7', 'the residual 500 fell ENTIRELY on the qualified early lender (600 -> 100)',
            earlyAfter === USDC(100), fmt(earlyAfter));
        check('L7', 'the MID-LOAN joiner was not charged at all (400 -> 400) — the L7 fix',
            midAfter === USDC(400), fmt(midAfter));
        const proRata = (USDC(500) * USDC(400)) / (USDC(600) + USDC(400));
        check('L7', `flat pro-rata (the V6.1 behaviour) would have charged the joiner ${fmt(proRata)} USDC — it was charged 0`,
            proRata === USDC(200) && USDC(400) - midAfter === 0n, `counterfactual ${fmt(proRata)}`);

        const pool = await mp.getAgentPool(agentId);
        let sumAmt = 0n, sumEarned = 0n;
        for (let i = 0n; i < pool.lenderCount; i++) {
            const l = await mp.poolLenders(agentId, i);
            const p = await mp.positions(agentId, l);
            sumAmt += p.amount; sumEarned += p.earnedInterest;
        }
        check('L7', 'per-pool conservation stays EXACT through the socialised loss',
            pool.availableLiquidity + pool.totalLoaned === sumAmt + sumEarned,
            `avail ${fmt(pool.availableLiquidity)} + loaned ${fmt(pool.totalLoaned)} == Σamt ${fmt(sumAmt)} + Σearned ${fmt(sumEarned)}`);
        check('L7', 'the defaulting agent is locked out and its capacity reset',
            (await reputation.isLockedOut(agentId)) === true && (await reputation.maxRepaidPrincipal(agentId)) === 0n);
    }

    // ================================================================= report
    const passed = checks.filter(c => c.ok === true).length;
    const failed = checks.filter(c => c.ok === false).length;
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, 'local-time-travel.json'), JSON.stringify({
        scenario: 'local-time-travel', chainId: 31337, runAt: new Date().toISOString(),
        note: 'LOCAL hardhat with time travel — nothing broadcast to any network',
        passed, failed, checks
    }, null, 2));
    console.log(`\n=== local-time-travel: ${passed} passed, ${failed} failed ===`);
    if (failed > 0) process.exitCode = 1;
}

async function expectRevert(scenario, label, promise, reason) {
    try {
        const tx = await promise;
        if (tx && tx.wait) await tx.wait();
        check(scenario, label, false, 'NO REVERT');
    } catch (e) {
        const msg = [e.reason, e.shortMessage, e.message].filter(Boolean).join(' | ');
        check(scenario, label, msg.includes(reason), msg.slice(0, 140));
    }
}

main().catch(e => { console.error(e); process.exit(1); });
