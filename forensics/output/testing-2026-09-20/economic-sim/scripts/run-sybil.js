/**
 * Strategy (c): Sybil fan-out. One operator, N agents (N distinct EOAs — the
 * registry allows one agent per address), each with its OWN pool, farmed in
 * parallel. Tests whether the M-1 lever (bindBorrowToPoolCreator) constrains it.
 *
 * Also strategy (d-repeat): the steady-state bust-out cadence at score 800.
 */
const fs = require("fs");
const path = require("path");
const { network } = require("hardhat");
const H = require("./lib/harness");
const S = require("./lib/strategies");
const { U, f6, advance, track, DAY } = H;

async function sybilFanOut(levers, N, targetScore, maxCycles) {
  const ctx = await H.deployStack(levers);
  const plan = S.cyclePlan(levers);
  const agents = [];
  for (let i = 0; i < N; i++) {
    const A = await H.newActor(ctx, `sybil${i}`, U(100000));
    await H.makeAgent(ctx, A);
    const seed = plan.totalPrincipal > levers.minSupply ? plan.totalPrincipal : levers.minSupply;
    await S.supply(ctx, A, A.agentId, seed);
    agents.push(A);
  }
  // M-1 check: can sybil0 borrow from sybil1's pool? (cross-pool borrow)
  let m1Cross = null;
  try {
    await ctx.mkt.connect(agents[0].signer).requestLoan.staticCall(plan.per, 7);
    m1Cross = "n/a (requestLoan always draws the caller's OWN pool)";
  } catch (e) { m1Cross = (e.shortMessage || e.message).slice(0, 100); }

  const t0 = await H.now();
  const feesStart = await ctx.mkt.accumulatedFees();
  const rows = [];
  let cycles = 0;
  while (cycles < maxCycles) {
    // one window: every sybil opens, holds, repays in lockstep
    const open = [];
    for (const A of agents) {
      const ids = [];
      for (let k = 0; k < plan.K; k++) {
        const r = await track(A, ctx.mkt.connect(A.signer).requestLoan(plan.per, 7));
        const ev = r.logs.map(l => { try { return ctx.mkt.interface.parseLog(l); } catch { return null; } })
          .find(e => e && e.name === "LoanRequested");
        ids.push(ev.args[0]);
      }
      open.push({ A, ids });
    }
    await advance(Math.max(Number(levers.minHold), Number(levers.gainWindow)));
    for (const { A, ids } of open) for (const id of ids) await track(A, ctx.mkt.connect(A.signer).repayLoan(id));
    cycles++;
    const scores = [];
    for (const A of agents) scores.push(await H.score(ctx, A));
    rows.push({ cycle: cycles, day: +(((await H.now()) - t0) / DAY).toFixed(3), scores: scores.slice() });
    if (scores.every(s => s >= targetScore)) break;
  }

  const per = [];
  let totalCredit = 0n, totalLocked = 0n, totalGas = 0n;
  for (const A of agents) {
    const cl = await H.creditLimit(ctx, A);
    const lk = await H.lockedCapital(ctx, A);
    per.push({
      agent: A.label, agentId: Number(A.agentId), score: await H.score(ctx, A),
      creditLimitUsdc: f6(cl), lockedUsdc: f6(lk), gas: A.gas.toString(),
    });
    totalCredit += cl; totalLocked += lk; totalGas += A.gas;
  }
  return {
    N, targetScore,
    levers: levers.name,
    m1Enabled: levers.bindM1,
    m1CrossPoolBorrow: m1Cross,
    days: +(((await H.now()) - t0) / DAY).toFixed(3),
    cycles,
    perAgent: per,
    totalCreditUnlockedUsdc: f6(totalCredit),
    totalCapitalLockedUsdc: f6(totalLocked),
    totalFeesUsdc: f6((await ctx.mkt.accumulatedFees()) - feesStart),
    totalGas: totalGas.toString(),
    trajectorySample: rows.filter((r, i) => i % 10 === 0 || i === rows.length - 1),
  };
}

/** (d) steady state: repeat bust-outs at the top tier, measuring the cadence. */
async function repeatBustOut(levers, rounds) {
  const ctx = await H.deployStack(levers);
  const plan = S.cyclePlan(levers);
  const A = await H.newActor(ctx, "serial-attacker", U(5000000));
  await H.makeAgent(ctx, A);
  const seed = plan.totalPrincipal > levers.minSupply ? plan.totalPrincipal : levers.minSupply;
  await S.supply(ctx, A, A.agentId, seed);

  const t0 = await H.now();
  const feesStart = await ctx.mkt.accumulatedFees();
  const log = [];
  let extracted = 0n;

  const climbTo = async (target) => {
    let s = await H.score(ctx, A);
    let c = 0;
    while (s < target && c < 400) { const r = await S.farmCycle(ctx, A, plan); s = r.score; c++; }
    return c;
  };

  for (let round = 0; round < rounds; round++) {
    const cyclesUsed = await climbTo(800);
    const dayAt800 = ((await H.now()) - t0) / DAY;
    const limit = await H.creditLimit(ctx, A);
    // fresh honest lender funds the pool to the credit limit
    const L = await H.newActor(ctx, `victim${round}`, limit * 2n);
    await S.supply(ctx, L, A.agentId, limit);
    // attacker pulls its own seed + interest
    const pos = await ctx.mkt.positions(A.agentId, A.address);
    if (pos.amount > 0n) await track(A, ctx.mkt.connect(A.signer).withdrawLiquidity(A.agentId, pos.amount));
    if (pos.earnedInterest > 0n) { try { await track(A, ctx.mkt.connect(A.signer).claimInterest(A.agentId)); } catch (e) {} }
    const balBefore = await ctx.usdc.balanceOf(A.address);
    const pool = await ctx.mkt.getAgentPool(A.agentId);
    const draw = pool[2] < limit ? pool[2] : limit;
    const r = await track(A, ctx.mkt.connect(A.signer).requestLoan(draw, 7));
    const id = r.logs.map(l => { try { return ctx.mkt.interface.parseLog(l); } catch { return null; } })
      .find(e => e && e.name === "LoanRequested").args[0];
    await advance(8 * DAY);
    await (await ctx.mkt.liquidateLoan(id)).wait();
    const gain = (await ctx.usdc.balanceOf(A.address)) - balBefore;
    extracted += gain;
    log.push({
      round: round + 1,
      climbCycles: cyclesUsed,
      dayReached800: +dayAt800.toFixed(2),
      dayOfDefault: +(((await H.now()) - t0) / DAY).toFixed(2),
      creditLimitUsdc: f6(limit),
      extractedUsdc: f6(gain),
      scoreAfter: await H.score(ctx, A),
      cumExtractedUsdc: f6(extracted),
      cumFeesUsdc: f6((await ctx.mkt.accumulatedFees()) - feesStart),
    });
    // re-seed the attacker's own pool for the next climb
    await S.supply(ctx, A, A.agentId, seed);
  }
  const totalDays = ((await H.now()) - t0) / DAY;
  return {
    levers: levers.name, rounds, log,
    totalDays: +totalDays.toFixed(2),
    totalExtractedUsdc: f6(extracted),
    totalFeesUsdc: f6((await ctx.mkt.accumulatedFees()) - feesStart),
    usdcPerDay: +(f6(extracted) / totalDays).toFixed(2),
    steadyStateUsdcPerDay: log.length > 1
      ? +((log[log.length - 1].cumExtractedUsdc - log[0].cumExtractedUsdc) /
          (log[log.length - 1].dayOfDefault - log[0].dayOfDefault)).toFixed(2)
      : null,
  };
}

async function main() {
  const out = { generatedAt: new Date().toISOString() };
  out.sybilNew = await sybilFanOut(H.LEVERS_NEW, 5, 600, 120);
  console.log("sybil NEW:", out.sybilNew.days, "days,", out.sybilNew.totalCreditUnlockedUsdc, "USDC credit,",
    out.sybilNew.totalCapitalLockedUsdc, "USDC locked");
  out.repeatBustNew = await repeatBustOut(H.LEVERS_NEW, 3);
  console.log("repeat bust NEW:", JSON.stringify(out.repeatBustNew.log));
  const p = path.join(__dirname, "out", "sybil.json");
  fs.writeFileSync(p, JSON.stringify(out, null, 2));
  console.log("wrote", p);
}
main().catch(e => { console.error(e); process.exit(1); });
