/**
 * Item 5: simulate the model change (M1) in ReputationManagerV4Sim against the
 * SAME attacker strategies, and check the honest-agent impact.
 *
 * Attacker under M1 must do two things V3 never asked for:
 *   phase 1 — hold loans to term (principal-TIME bonus) to reach score 600
 *   phase 2 — climb a "demonstrated capacity" ladder: the credit limit is
 *             min(tierLimit, creditMultiple x largest single repaid loan), so the
 *             attacker has to self-fund and repay progressively larger loans
 * then phase 3 — bust out, and phase 4 — see how fast it can repeat.
 */
const fs = require("fs");
const path = require("path");
const H = require("./lib/harness");
const S = require("./lib/strategies");
const { U, f6, advance, track, DAY } = H;

const M1 = {
  ...H.LEVERS_NEW,
  name: "M1 (ReputationManagerV4Sim)",
  repContract: "ReputationManagerV4Sim",
  penaltyBase: 50, penaltyLarge: 100, largeThreshold: U(10000),
};

async function deployM1(params = {}) {
  const ctx = await H.deployStack(M1);
  await (await ctx.rep.setM1Parameters(
    params.refDuration ?? 7 * DAY,
    params.creditMultiple ?? 2,
    params.bootstrapLimit ?? U(100),
    params.lockout ?? 180 * DAY
  )).wait();
  return ctx;
}

async function openLoan(ctx, A, amt, days) {
  const r = await track(A, ctx.mkt.connect(A.signer).requestLoan(amt, days));
  return r.logs.map(l => { try { return ctx.mkt.interface.parseLog(l); } catch { return null; } })
    .find(e => e && e.name === "LoanRequested").args[0];
}

/**
 * Greedy M1 attacker. Each simulated day:
 *   - repay every loan whose 7-day hold is complete (principal-TIME bonus needs the hold)
 *   - keep a 7-deep pipeline of `pipeUsdc` loans running (saturates the 5 pts/day budget)
 *   - whenever aggregate head-room allows, run ONE "ladder" loan as large as the credit
 *     limit permits, to grow `maxRepaidPrincipal` (and therefore the limit itself)
 *
 * Pool funding comes from FRESH Sybil lender addresses: the F-02 top-up guard only
 * constrains an EXISTING lender position, and a new address costs nothing beyond
 * `minSupplyAmount` and gas.
 */
async function m1Attack(ctx, A, targetLimitUsdc, maxDays) {
  const pipeUsdc = U(50);
  const t0 = await H.now();
  const sybils = [];
  const fund = async (amount) => {
    const L = await H.newActor(ctx, `m1-fund${sybils.length}`, amount + U(10));
    await S.supply(ctx, L, A.agentId, amount);
    sybils.push({ actor: L, amount });
  };
  const ownCapital = async () => {
    let tot = await H.lockedCapital(ctx, A);
    for (const s of sybils) tot += await H.lockedCapital(ctx, s.actor);
    return f6(tot);
  };

  await fund(U(200));
  const pipe = [];          // {id, due}
  let ladder = null;        // {id, due, amount}
  const rows = [];
  let peak = 0, day = 0;

  const open = async (amt, tag) => {
    const pool = await ctx.mkt.getAgentPool(A.agentId);
    if (pool[2] < amt) await fund(amt - pool[2]);
    const id = await openLoan(ctx, A, amt, 8);
    return { id, due: day + 7, amount: amt, tag };
  };

  while (day < maxDays) {
    // 1. repay matured loans
    for (let i = pipe.length - 1; i >= 0; i--) {
      if (pipe[i].due <= day) { await track(A, ctx.mkt.connect(A.signer).repayLoan(pipe[i].id)); pipe.splice(i, 1); }
    }
    if (ladder && ladder.due <= day) { await track(A, ctx.mkt.connect(A.signer).repayLoan(ladder.id)); ladder = null; }

    const limit = await H.creditLimit(ctx, A);
    if (f6(limit) >= targetLimitUsdc) break;
    let outst = await ctx.mkt.outstandingPrincipal(A.agentId);
    let free = limit > outst ? limit - outst : 0n;
    let active = Number(await ctx.mkt.activeLoanCount(A.agentId));

    // 2/3. Allocate head-room between the LADDER (grows the limit: the loan must
    // exceed the current record, i.e. > limit/creditMultiple) and the PIPELINE
    // (saturates the 5 pts/day reputation budget: 7 concurrent 50-USDC loans).
    // While the limit is small the ladder has priority — without it the pipeline
    // can never reach the 350 USDC it needs.
    const record = await ctx.rep.maxRepaidPrincipal(A.agentId);
    const pipeNeed = 7n * pipeUsdc;
    const tl = await ctx.rep.tierLimit(await H.score(ctx, A));
    // The ladder is only worth head-room while the TIER is not already the binding
    // cap; and it only grows the limit if the loan exceeds the current record.
    const ladderUseful = limit < tl;
    const ladderFirst = ladderUseful && !((free > pipeNeed ? free - pipeNeed : 0n) > record);
    const doLadder = async () => {
      if (!ladder && active < 10 && free > record && free > 0n) {
        ladder = await open(free, "ladder"); free = 0n; active++;
      }
    };
    // ONE pipeline loan per day: the pipeline must be STAGGERED. Opening all 7 in
    // one block makes them all mature on the same day, where the rate limit clamps
    // 7 x 5 points down to 5 — the batch costs 7x the fees for the same reputation.
    const doPipe = async () => {
      if (pipe.length < 7 && active < 9 && free > 0n) {
        const sz = free >= pipeUsdc ? pipeUsdc : free;
        pipe.push(await open(sz, "pipe"));
        free -= sz; active++;
      }
    };
    if (!ladderUseful) { await doPipe(); }
    else if (ladderFirst) { await doLadder(); await doPipe(); }
    else {
      // keep `pipeNeed` back for the pipeline, give the rest to the ladder
      const reserve = free > pipeNeed ? pipeNeed : free;
      free -= reserve;
      await doLadder();
      free += reserve;
      await doPipe();
    }

    await advance(DAY);
    day++;
    const cap = await ownCapital();
    if (cap > peak) peak = cap;
    if (day % 10 === 0 || day < 5) rows.push({
      day, score: await H.score(ctx, A), creditLimitUsdc: f6(await H.creditLimit(ctx, A)),
      maxRepaidUsdc: f6(await ctx.rep.maxRepaidPrincipal(A.agentId)), capitalUsdc: cap,
    });
  }
  return {
    days: +(((await H.now()) - t0) / DAY).toFixed(1),
    score: await H.score(ctx, A),
    creditLimitUsdc: f6(await H.creditLimit(ctx, A)),
    maxRepaidUsdc: f6(await ctx.rep.maxRepaidPrincipal(A.agentId)),
    peakCapitalUsdc: peak,
    sybilLenderAddresses: sybils.length,
    trajectory: rows,
    openPipe: pipe, openLadder: ladder,
  };
}

async function main() {
  const out = { generatedAt: new Date().toISOString() };

  // ---------- M1 attacker ----------
  const ctx = await deployM1();
  const A = await H.newActor(ctx, "m1-attacker", U(2000000));
  await H.makeAgent(ctx, A);
  const fee0 = await ctx.mkt.accumulatedFees();
  const t0 = await H.now();

  const atk = await m1Attack(ctx, A, 25000, 400);
  // close out any still-open loans so the bust-out starts clean
  for (const l of atk.openPipe) { try { await track(A, ctx.mkt.connect(A.signer).repayLoan(l.id)); } catch (e) {} }
  if (atk.openLadder) { try { await track(A, ctx.mkt.connect(A.signer).repayLoan(atk.openLadder.id)); } catch (e) {} }
  const preBustFees = f6((await ctx.mkt.accumulatedFees()) - fee0);
  const daysToCredit = +(((await H.now()) - t0) / DAY).toFixed(2);

  // bust-out
  const limit = await H.creditLimit(ctx, A);
  const L = await H.newActor(ctx, "m1-victim", limit * 2n);
  await S.supply(ctx, L, A.agentId, limit);
  const own = await ctx.mkt.positions(A.agentId, A.address);
  if (own.amount > 0n) {
    const pool = await ctx.mkt.getAgentPool(A.agentId);
    const amt = own.amount < pool[2] ? own.amount : pool[2];
    await track(A, ctx.mkt.connect(A.signer).withdrawLiquidity(A.agentId, amt));
  }
  const balB = await ctx.usdc.balanceOf(A.address);
  const pool2 = await ctx.mkt.getAgentPool(A.agentId);
  const draw = pool2[2] < limit ? pool2[2] : limit;
  const bid = await openLoan(ctx, A, draw, 7);
  await advance(8 * DAY);
  const sBefore = await H.score(ctx, A);
  await (await ctx.mkt.liquidateLoan(bid)).wait();
  const bust = {
    creditLimitUsdc: f6(limit),
    drawnUsdc: f6(draw),
    attackerGainUsdc: f6((await ctx.usdc.balanceOf(A.address)) - balB),
    scoreBefore: sBefore, scoreAfter: await H.score(ctx, A),
    penaltyPoints: sBefore - (await H.score(ctx, A)),
    creditLimitAfterUsdc: f6(await H.creditLimit(ctx, A)),
    maxRepaidAfterUsdc: f6(await ctx.rep.maxRepaidPrincipal(A.agentId)),
    lockoutDays: +((Number(await ctx.rep.lockedUntil(A.agentId)) - (await H.now())) / DAY).toFixed(1),
  };

  out.m1Attacker = {
    climb: { ...atk, openPipe: undefined, openLadder: undefined },
    daysToUnlock25k: daysToCredit,
    peakCapitalLockedUsdc: atk.peakCapitalUsdc,
    feesPaidUsdc: preBustFees,
    gas: A.gas.toString(),
    bustOut: bust,
    repeatCadenceDays: +(bust.lockoutDays).toFixed(1),
    note: "repeat cadence = post-default lockout + a fresh capacity ladder (maxRepaidPrincipal is reset to 0); score re-climb overlaps the lockout",
  };
  console.log("M1 attacker:", JSON.stringify({ d: daysToCredit, score: atk.score, limit: atk.creditLimitUsdc, cap: atk.peakCapitalUsdc, fees: preBustFees, bust }));

  // ---------- M1 honest impact ----------
  const ctxH = await deployM1();
  const hb = await S.honestBorrower(ctxH, { label: "m1-H1", tenorDays: 7, holdToTerm: true, maxLoans: 120, targetScore: 600 });
  out.m1HonestH1 = {
    days: +hb.days.toFixed(1), finalScore: hb.finalScore, realisedCostUsdc: hb.realisedCostUsdc,
    note: "H1 holds to term already, so the principal-TIME change costs it nothing",
  };
  console.log("M1 honest H1:", JSON.stringify(out.m1HonestH1));

  // honest agent that needs a real 25k line: identical climb, but the pool is
  // funded by a REAL third-party lender, so the capital is the lenders' not the
  // borrower's — the borrower only pays interest.
  const ctxH2 = await deployM1();
  const B = await H.newActor(ctxH2, "m1-H5", U(2000000));
  await H.makeAgent(ctxH2, B);
  const hon = await m1Attack(ctxH2, B, 25000, 400);
  for (const l of hon.openPipe) { try { await track(B, ctxH2.mkt.connect(B.signer).repayLoan(l.id)); } catch (e) {} }
  if (hon.openLadder) { try { await track(B, ctxH2.mkt.connect(B.signer).repayLoan(hon.openLadder.id)); } catch (e) {} }
  out.m1HonestTo25k = {
    totalDays: hon.days, finalScore: hon.score, creditLimitUsdc: hon.creditLimitUsdc,
    interestPaidUsdc: f6(B.startUsdc - (await ctxH2.usdc.balanceOf(B.address))),
    trajectory: hon.trajectory,
    note: "same trajectory as the attacker; the difference is WHO supplies the pool capital (here real lenders, there the attacker itself)",
  };
  console.log("M1 honest to 25k:", JSON.stringify({ d: hon.days, limit: hon.creditLimitUsdc, cost: out.m1HonestTo25k.interestPaidUsdc }));

  const p = path.join(__dirname, "out", "model.json");
  fs.writeFileSync(p, JSON.stringify(out, null, 2));
  console.log("wrote", p);
}
module.exports = { deployM1, m1Attack, openLoan, M1 };
if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
