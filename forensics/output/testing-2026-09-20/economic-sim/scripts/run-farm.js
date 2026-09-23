/**
 * Strategies (a) (b) (d) (e): solo self-lender farming under OLD vs NEW levers,
 * bust-out timing (600 vs 800), and re-farm cost after a default.
 *
 * Everything is driven against the real V6.1 + ReputationManagerV3 contracts on
 * a local hardhat chain with evm_increaseTime / evm_snapshot.
 */
const fs = require("fs");
const path = require("path");
const { network } = require("hardhat");
const H = require("./lib/harness");
const S = require("./lib/strategies");
const { U, f6, advance, track, DAY } = H;

const snapshot = () => network.provider.send("evm_snapshot", []);
const revert = (id) => network.provider.send("evm_revert", [id]);

/** Farm an attacker from 100 to `target`, recording milestones; leaves state live. */
async function farmTo(ctx, A, plan, target, opts = {}) {
  const t0 = opts.t0 ?? (await H.now());
  const feesStart = opts.feesStart ?? 0n;
  const marks = opts.marks || {};
  const rows = opts.rows || [];
  let cycles = opts.cycles || 0;
  let s = await H.score(ctx, A);
  while (s < target && cycles < (opts.maxCycles ?? 600)) {
    const r = await S.farmCycle(ctx, A, plan, opts);
    cycles++;
    s = r.score;
    const row = {
      cycle: cycles,
      day: +(((await H.now()) - t0) / DAY).toFixed(4),
      score: s,
      creditLimitUsdc: f6(await H.creditLimit(ctx, A)),
      collateralPct: await H.collateralPct(ctx, A),
      cumFeesUsdc: f6((await ctx.mkt.accumulatedFees()) - feesStart),
      lockedUsdc: f6(await H.lockedCapital(ctx, A)),
      cumGas: A.gas.toString(),
    };
    rows.push(row);
    for (const m of [200, 400, 500, 600, 700, 800, 900, 1000]) {
      if (s >= m && !marks[m]) marks[m] = row;
    }
    if (r.gained === 0) { row.stalled = true; break; }
  }
  return { cycles, rows, marks, score: s };
}

/**
 * Bust-out: honest lenders fund the (now reputable) attacker's pool up to the
 * credit limit; the attacker withdraws its own seed, borrows the maximum at the
 * 0 %-collateral tier, never repays, and the owner liquidates.
 */
async function bustOut(ctx, A, label, nLenders = 5) {
  const limit = await H.creditLimit(ctx, A);
  const collPct = await H.collateralPct(ctx, A);
  const lenders = [];
  const per = limit / BigInt(nLenders);
  for (let i = 0; i < nLenders; i++) {
    const L = await H.newActor(ctx, `${label}-L${i}`, per * 2n);
    await S.supply(ctx, L, A.agentId, per);
    lenders.push(L);
  }
  const honestSupplied = per * BigInt(nLenders);

  // Attacker pulls its own seed principal out first (it is fungible with lender USDC).
  const ownPos = await ctx.mkt.positions(A.agentId, A.address);
  let ownWithdrawn = 0n;
  if (ownPos.amount > 0n) {
    const pool = await ctx.mkt.getAgentPool(A.agentId);
    const amt = ownPos.amount < pool[2] ? ownPos.amount : pool[2];
    await track(A, ctx.mkt.connect(A.signer).withdrawLiquidity(A.agentId, amt));
    ownWithdrawn = amt;
  }
  if (ownPos.earnedInterest > 0n) {
    try { await track(A, ctx.mkt.connect(A.signer).claimInterest(A.agentId)); } catch (e) {}
  }

  const balBefore = await ctx.usdc.balanceOf(A.address);
  const pool = await ctx.mkt.getAgentPool(A.agentId);
  let draw = pool[2] < limit ? pool[2] : limit; // min(availableLiquidity, creditLimit)
  const r = await track(A, ctx.mkt.connect(A.signer).requestLoan(draw, 7));
  const ev = r.logs.map(l => { try { return ctx.mkt.interface.parseLog(l); } catch { return null; } })
    .find(e => e && e.name === "LoanRequested");
  const loanId = ev.args[0];

  // Can a warned lender escape before liquidation? (availableLiquidity is now ~0)
  let lenderEscape = null;
  try {
    await ctx.mkt.connect(lenders[0].signer).withdrawLiquidity.staticCall(A.agentId, per);
    lenderEscape = "POSSIBLE";
  } catch (e) { lenderEscape = `BLOCKED: ${(e.shortMessage || e.message).slice(0, 80)}`; }

  await advance(8 * DAY);
  const scoreBefore = await H.score(ctx, A);
  await (await ctx.mkt.liquidateLoan(loanId)).wait();
  const scoreAfter = await H.score(ctx, A);

  const balAfter = await ctx.usdc.balanceOf(A.address);
  const lenderLosses = [];
  for (const L of lenders) {
    const p = await ctx.mkt.positions(A.agentId, L.address);
    const recoverable = p.amount + p.earnedInterest;
    lenderLosses.push({ lender: L.label, suppliedUsdc: f6(per), remainingUsdc: f6(recoverable), lossUsdc: f6(per - recoverable) });
  }
  const totalLoss = lenderLosses.reduce((a, b) => a + b.lossUsdc, 0);

  return {
    label,
    scoreAtBustOut: scoreBefore,
    creditLimitUsdc: f6(limit),
    collateralPct: collPct,
    honestSuppliedUsdc: f6(honestSupplied),
    ownSeedWithdrawnUsdc: f6(ownWithdrawn),
    drawnUsdc: f6(draw),
    attackerGainUsdc: f6(balAfter - balBefore),
    lenderEscapeBeforeLiquidation: lenderEscape,
    lenderLosses,
    totalLenderLossUsdc: +totalLoss.toFixed(6),
    scoreAfterDefault: scoreAfter,
    penaltyPoints: scoreBefore - scoreAfter,
    defaultCount: Number(await ctx.rep.defaultCount(A.agentId)),
  };
}

async function runLeverSet(levers, opts = {}) {
  const ctx = await H.deployStack(levers);
  const plan = S.cyclePlan(levers);
  const budget = U(2000000);
  const A = await H.newActor(ctx, `atk-${levers.name}`, budget);
  await H.makeAgent(ctx, A);
  const seed = plan.totalPrincipal > levers.minSupply ? plan.totalPrincipal : levers.minSupply;
  await S.supply(ctx, A, A.agentId, seed);

  const t0 = await H.now();
  const feesStart = await ctx.mkt.accumulatedFees();
  const marks = {}, rows = [];

  // --- farm to 600 ---
  let st = await farmTo(ctx, A, plan, 600, { t0, feesStart, marks, rows, maxCycles: opts.maxCycles ?? 250 });

  const at600 = {
    days: marks[600] ? marks[600].day : null,
    cycles: marks[600] ? marks[600].cycle : null,
    feesUsdc: marks[600] ? marks[600].cumFeesUsdc : null,
    lockedUsdc: marks[600] ? marks[600].lockedUsdc : null,
    gas: marks[600] ? marks[600].cumGas : null,
  };

  // --- bust-out at 600 (snapshot / revert so the 800 run starts from the same state) ---
  const snap600 = await snapshot();
  const bust600 = await bustOut(ctx, A, "bust@600");

  // (e) re-farm cost after the 25k default, measured in the post-default state
  const reSeed = plan.totalPrincipal > levers.minSupply ? plan.totalPrincipal : levers.minSupply;
  await S.supply(ctx, A, A.agentId, reSeed);
  const refarmT0 = await H.now();
  const refarmFees = await ctx.mkt.accumulatedFees();
  const refarmMarks = {}, refarmRows = [];
  await farmTo(ctx, A, plan, 600, { t0: refarmT0, feesStart: refarmFees, marks: refarmMarks, rows: refarmRows, maxCycles: 200 });
  const refarm = {
    fromScore: bust600.scoreAfterDefault,
    daysBackTo600: refarmMarks[600] ? refarmMarks[600].day : null,
    feesUsdc: refarmMarks[600] ? refarmMarks[600].cumFeesUsdc : null,
    cycles: refarmMarks[600] ? refarmMarks[600].cycle : null,
  };
  await revert(snap600);
  // chain state is restored; restore the JS-side gas counter to match
  if (at600.gas) A.gas = BigInt(at600.gas);

  // --- continue to 800, then bust out there ---
  st = await farmTo(ctx, A, plan, 800, { t0, feesStart, marks, rows, cycles: st.cycles, maxCycles: opts.maxCycles800 ?? 400 });
  const at800 = {
    days: marks[800] ? marks[800].day : null,
    cycles: marks[800] ? marks[800].cycle : null,
    feesUsdc: marks[800] ? marks[800].cumFeesUsdc : null,
    lockedUsdc: marks[800] ? marks[800].lockedUsdc : null,
    gas: marks[800] ? marks[800].cumGas : null,
  };
  const snap800 = await snapshot();
  const bust800 = await bustOut(ctx, A, "bust@800");
  await revert(snap800);

  return {
    levers: { ...levers, minSupply: f6(levers.minSupply), bonusRef: f6(levers.bonusRef), largeThreshold: f6(levers.largeThreshold) },
    plan: { loansPerCycle: plan.K, perLoanUsdc: f6(plan.per), principalPerCycleUsdc: f6(plan.totalPrincipal) },
    milestones: marks,
    at600, at800, bust600, bust800, refarm,
    trajectory: rows.filter((r, i) => i % 5 === 0 || r.score >= 595),
  };
}

async function main() {
  const out = { generatedAt: new Date().toISOString(), runs: {} };
  out.runs.NEW = await runLeverSet(H.LEVERS_NEW);
  console.log("NEW done:", JSON.stringify(out.runs.NEW.at600), JSON.stringify(out.runs.NEW.at800));
  out.runs.OLD = await runLeverSet(H.LEVERS_OLD);
  console.log("OLD done:", JSON.stringify(out.runs.OLD.at600), JSON.stringify(out.runs.OLD.at800));
  const p = path.join(__dirname, "out", "farm.json");
  fs.writeFileSync(p, JSON.stringify(out, null, 2));
  console.log("wrote", p);
}
main().catch(e => { console.error(e); process.exit(1); });
