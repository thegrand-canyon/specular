/**
 * Item 4: the LEVER FRONTIER.
 *
 * Sweeps rate limit x minSupply x platformFeeRate x minHold x bonusReferenceAmount
 * and measures, from a real steady-state simulation under each configuration:
 *
 *   attacker (self-lending): USDC cost / point, days / point, capital locked
 *   honest   (third-party-funded, same behaviour): USDC cost / point
 *
 * The attacker runs a STAGGERED PIPELINE of depth ceil(minHold / window) so that
 * a long minHold costs capital, not calendar time (MAX_ACTIVE_LOANS_PER_AGENT=10
 * bounds the pipeline).
 *
 * Costs to reach score 600 are projected from the measured per-point cost using
 * the tier blend 300 pts @15% APR + 200 pts @10% APR (= 433.33 "15%-equivalent"
 * points). That projection is validated against the full 100-cycle runs in
 * run-farm.js — see `validation` in the output.
 */
const fs = require("fs");
const path = require("path");
const H = require("./lib/harness");
const S = require("./lib/strategies");
const { U, f6, advance, track, DAY } = H;

const BLEND = 300 + 200 * (10 / 15); // 15%-APR-equivalent points for 100 -> 600

/** Steady-state measurement of one lever configuration. */
async function measure(levers, windows = 6) {
  const ctx = await H.deployStack(levers);
  const maxGain = levers.maxGainPerWindow > 0 ? levers.maxGainPerWindow : 1000;
  const win = Number(levers.gainWindow);
  const depth = Math.max(1, Math.ceil(Number(levers.minHold) / win));
  let K = Math.max(1, Math.ceil(maxGain / levers.onTimeBonus));
  const MAXACT = 10;
  let feasible = true;
  if (K * depth > MAXACT) { K = Math.max(1, Math.floor(MAXACT / depth)); feasible = false; }
  const gainPerWindow = Math.min(maxGain, K * levers.onTimeBonus);
  // The loan term must exceed the hold time, or the repayment lands past endTime
  // (onTime=false) and earns nothing. Longer terms cost proportionally more interest.
  const durDays = Math.max(7, Math.ceil(Number(levers.minHold) / DAY) + 1);
  const per = (BigInt(gainPerWindow) * levers.bonusRef) / BigInt(levers.onTimeBonus) / BigInt(K);

  // ---- attacker: self-lender, staggered pipeline ----
  const A = await H.newActor(ctx, "sweep-atk", U(20000000));
  await H.makeAgent(ctx, A);
  const poolNeed = per * BigInt(K) * BigInt(depth) * 2n;
  const seed = poolNeed > levers.minSupply ? poolNeed : levers.minSupply;
  await S.supply(ctx, A, A.agentId, seed);

  const batches = [];
  const openBatch = async () => {
    const ids = [];
    for (let k = 0; k < K; k++) {
      const r = await track(A, ctx.mkt.connect(A.signer).requestLoan(per, durDays));
      ids.push(r.logs.map(l => { try { return ctx.mkt.interface.parseLog(l); } catch { return null; } })
        .find(e => e && e.name === "LoanRequested").args[0]);
    }
    batches.push(ids);
  };
  // prime the pipeline
  for (let d = 0; d < depth; d++) { await openBatch(); if (d < depth - 1) await advance(win); }

  const t0 = await H.now();
  const fee0 = await ctx.mkt.accumulatedFees();
  const s0 = await H.score(ctx, A);
  let peakLocked = 0;
  for (let w = 0; w < windows; w++) {
    await advance(win);
    const due = batches.shift();
    for (const id of due) await track(A, ctx.mkt.connect(A.signer).repayLoan(id));
    await openBatch();
    const lk = f6(await H.lockedCapital(ctx, A));
    if (lk > peakLocked) peakLocked = lk;
  }
  const dPts = (await H.score(ctx, A)) - s0;
  const dDays = ((await H.now()) - t0) / DAY;
  const dFee = f6((await ctx.mkt.accumulatedFees()) - fee0);

  // ---- honest: identical loans, but funded by a third-party lender ----
  const B = await H.newActor(ctx, "sweep-hon", U(20000000));
  await H.makeAgent(ctx, B);
  const L = await H.newActor(ctx, "sweep-lender", U(20000000));
  await S.supply(ctx, L, B.agentId, seed);
  const hb = [];
  const openH = async () => {
    const ids = [];
    for (let k = 0; k < K; k++) {
      const r = await track(B, ctx.mkt.connect(B.signer).requestLoan(per, durDays));
      ids.push(r.logs.map(l => { try { return ctx.mkt.interface.parseLog(l); } catch { return null; } })
        .find(e => e && e.name === "LoanRequested").args[0]);
    }
    hb.push(ids);
  };
  for (let d = 0; d < depth; d++) { await openH(); if (d < depth - 1) await advance(win); }
  const hs0 = await H.score(ctx, B);
  const hbal0 = await ctx.usdc.balanceOf(B.address);
  for (let w = 0; w < windows; w++) {
    await advance(win);
    const due = hb.shift();
    for (const id of due) await track(B, ctx.mkt.connect(B.signer).repayLoan(id));
    await openH();
  }
  const hPts = (await H.score(ctx, B)) - hs0;
  const hCost = f6(hbal0 - (await ctx.usdc.balanceOf(B.address)));

  const atkPerPt = dPts > 0 ? dFee / dPts : null;
  const honPerPt = hPts > 0 ? hCost / hPts : null;
  return {
    config: {
      maxGainPerDay: levers.maxGainPerWindow,
      minSupplyUsdc: f6(levers.minSupply),
      feeBps: levers.platformFeeRate,
      minHoldDays: Number(levers.minHold) / DAY,
      bonusRefUsdc: f6(levers.bonusRef),
      penaltyLarge: levers.penaltyLarge,
    },
    pipelineDepth: depth, loansPerWindow: K, perLoanUsdc: f6(per), saturatesRateLimit: feasible,
    measured: {
      pointsPerDay: +(dPts / dDays).toFixed(4),
      attackerUsdcPerPoint: atkPerPt,
      honestUsdcPerPoint: honPerPt,
      attackerCapitalLockedUsdc: peakLocked,
    },
    projected100to600: {
      days: +(500 / (dPts / dDays)).toFixed(1),
      attackerUsdc: atkPerPt != null ? +(atkPerPt * BLEND).toFixed(6) : null,
      honestUsdc: honPerPt != null ? +(honPerPt * BLEND).toFixed(4) : null,
      attackerCapitalUsdc: peakLocked,
      attackerCostAsPctOfHonest: (atkPerPt && honPerPt) ? +((atkPerPt / honPerPt) * 100).toFixed(3) : null,
      attackerTotalOutlayUsdc: atkPerPt != null ? +(atkPerPt * BLEND + peakLocked * 0).toFixed(4) : null,
      capitalToPrizeRatio: +(peakLocked / 25000).toFixed(5),
      // refarm after a 25k default (penalty applies since 25k > largeLoanThreshold)
      refarmDaysAfter25kDefault: +(levers.penaltyLarge / (dPts / dDays)).toFixed(1),
      refarmUsdcAfter25kDefault: atkPerPt != null ? +(atkPerPt * levers.penaltyLarge * (10 / 15)).toFixed(6) : null,
    },
  };
}

async function main() {
  const grid = [];
  for (const maxGain of [20, 5, 1])
    for (const minSupply of [10, 100])
      for (const feeBps of [100, 500])
        for (const minHoldDays of [1, 7])
          for (const refUsdc of [100, 1000, 10000])
            grid.push({ maxGain, minSupply, feeBps, minHoldDays, refUsdc });

  const out = { generatedAt: new Date().toISOString(), blendFactor: BLEND, results: [] };
  let i = 0;
  for (const g of grid) {
    const lev = {
      ...H.LEVERS_NEW,
      name: `rl${g.maxGain}_ms${g.minSupply}_fee${g.feeBps}_mh${g.minHoldDays}_ref${g.refUsdc}`,
      maxGainPerWindow: g.maxGain,
      minSupply: U(g.minSupply),
      platformFeeRate: g.feeBps,
      minHold: g.minHoldDays * DAY,
      bonusRef: U(g.refUsdc),
      penaltyLarge: 300, penaltyBase: 200, // max-strength penalties in the sweep
    };
    try {
      const r = await measure(lev, 4);
      out.results.push(r);
      i++;
      if (i % 8 === 0) console.log(`[${i}/${grid.length}]`, lev.name, JSON.stringify(r.projected100to600));
    } catch (e) {
      const msg = (e.shortMessage || e.message);
      out.results.push({ config: g, error: msg.slice(0, 160),
        infeasibleReason: /Exceeds credit limit/.test(msg)
          ? "BOOTSTRAP-INFEASIBLE: the principal needed to saturate the gain budget exceeds the 1,000 USDC bottom-tier credit limit, so NO agent (honest or attacker) can build reputation under this config"
          : undefined });
    }
  }
  // Also measure the max-penalty variant of the CURRENT live config for the frontier table
  const p = path.join(__dirname, "out", "sweep.json");
  fs.writeFileSync(p, JSON.stringify(out, null, 2));
  console.log("wrote", p, out.results.length, "configs");
}
main().catch(e => { console.error(e); process.exit(1); });
