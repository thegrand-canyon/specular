/**
 * V7 model validation — re-runs the ECONOMIC_ATTACK_SIMULATION.md attacker
 * strategies against the SHIPPED implementation and produces the same table shape.
 *
 * Configurations measured:
 *   v3        ReputationManagerV3   + AgentLiquidityMarketplaceV6   (V6.1)  — live today
 *   m1_k2     ReputationManagerV4Sim+ AgentLiquidityMarketplaceV6   (V6.1)  — M1 alone, k = 2
 *   m1_k4     ReputationManagerV4Sim+ AgentLiquidityMarketplaceV6   (V6.1)  — M1 alone, k = 4
 *   v7_k2     ReputationManagerV4   + AgentLiquidityMarketplaceV62  (V6.2)  — M1 + M2, k = 2
 *   v7_k4     ReputationManagerV4   + AgentLiquidityMarketplaceV62  (V6.2)  — M1 + M2, k = 4
 *
 * plus the HONEST agent trajectory on v3 and v7 (same strategy, but the pool is
 * funded by a genuine third-party lender so the borrower pays the full interest
 * instead of recapturing it).
 *
 * Local hardhat chain only. Nothing is broadcast.
 */
const fs = require("fs");
const path = require("path");
const H = require("./lib/harness");
const S = require("./lib/strategies");
const { U, f6, advance, track, DAY, ethers } = H;

const MAX_LENDER_SLOTS = 45; // MAX_LENDERS_PER_POOL is 50; leave headroom

// ---------------------------------------------------------------- config table

const V3_TIERS = [[800, 50000], [600, 25000], [400, 10000], [200, 5000], [0, 1000]];
const V3_COLL = [[800, 0], [600, 0], [500, 25], [0, 100]];

function tierLimitV3(score) {
  for (const [s, l] of V3_TIERS) if (score >= s) return l;
  return 1000;
}
function collPctV3(score) {
  for (const [s, c] of V3_COLL) if (score >= s) return c;
  return 100;
}

const CONFIGS = {
  v3: { levers: () => ({ ...H.LEVERS_NEW, name: "V3 live (V6.1)" }), k: null, v7: false },
  m1_k2: { levers: () => ({ ...H.LEVERS_M1, name: "M1 only k=2", m1: { ...H.LEVERS_M1.m1, creditMultiple: 2 } }), k: 2, v7: false },
  m1_k4: { levers: () => ({ ...H.LEVERS_M1, name: "M1 only k=4", m1: { ...H.LEVERS_M1.m1, creditMultiple: 4 } }), k: 4, v7: false },
  v7_k2: { levers: () => ({ ...H.LEVERS_V7, name: "V7 (M1+M2) k=2", m1: { ...H.LEVERS_V7.m1, creditMultiple: 2 } }), k: 2, v7: true },
  v7_k4: { levers: () => ({ ...H.LEVERS_V7, name: "V7 (M1+M2) k=4", m1: { ...H.LEVERS_V7.m1, creditMultiple: 4 } }), k: 4, v7: true },
};

// ------------------------------------------------------------------- helpers

async function openLoan(ctx, A, amt, days) {
  const r = await track(A, ctx.mkt.connect(A.signer).requestLoan(amt, days));
  return r.logs
    .map((l) => { try { return ctx.mkt.interface.parseLog(l); } catch { return null; } })
    .find((e) => e && e.name === "LoanRequested").args[0];
}

/** Tier limit for a score under whichever reputation manager is deployed. */
async function tierLimitOf(ctx, score) {
  if (ctx.rep.tierLimit) return f6(await ctx.rep.tierLimit(score));
  return tierLimitV3(score);
}

/** Self-stake the agent must hold before borrowing `amt` more (0 on non-M2 stacks). */
async function neededSelfStake(ctx, agentId, amt) {
  if (!ctx.mkt.requiredSelfStake) return 0n;
  return await ctx.mkt.requiredSelfStake(agentId, amt);
}

/**
 * The attacker/agent climb. Each simulated day:
 *   1. repay every matured loan (the M1 principal-TIME bonus needs the hold)
 *   2. keep a staggered pipeline of small loans running to saturate the
 *      reputation rate-limit budget (one new loan per window — batching them
 *      costs N× the fees for the same clamped points)
 *   3. spend any remaining head-room on ONE "ladder" loan as large as the limit
 *      allows, to grow `maxRepaidPrincipal` and therefore the limit itself
 * Pool liquidity comes from fresh addresses (the F-02 top-up guard only binds an
 * EXISTING position; a new address costs `minSupplyAmount` and gas). On the V7
 * stack the agent must additionally maintain its own locked first-loss stake.
 *
 * `selfFunded` distinguishes the ATTACKER (supplies its own pool through Sybil
 * lender addresses it controls, so all that capital is its own) from the HONEST
 * agent (the pool is funded by a genuine third party; only the self-stake, the
 * collateral and the interest are the agent's own money).
 */
async function climb(ctx, A, opts) {
  const { targetScore = 800, maxDays = 400, selfFunded = true, pipeUsdc = U(50) } = opts;
  const t0 = await H.now();
  const feeStart = await ctx.mkt.accumulatedFees();
  const lenders = [];
  let lenderBudget = 0n;

  // USDC the ATTACKER (or, for the honest case, the borrower) has tied up.
  const ownCapital = async () => {
    let tot = await H.lockedCapital(ctx, A);
    if (selfFunded) for (const l of lenders) tot += await H.lockedCapital(ctx, l);
    return f6(tot);
  };

  const fund = async (amount) => {
    // Top up an existing lender when the tranche rules allow it, otherwise open a
    // fresh slot. Oversupply 3× so long runs do not exhaust MAX_LENDERS_PER_POOL.
    const want = amount * 3n > U(200) ? amount * 3n : U(200);
    for (const l of lenders) {
      if (await ctx.mkt.canTopUp(A.agentId, l.address)) {
        await track(l, ctx.usdc.connect(l.signer).approve(await ctx.mkt.getAddress(), ethers.MaxUint256));
        await ctx.usdc.mint(l.address, want);
        l.startUsdc += want;
        await track(l, ctx.mkt.connect(l.signer).supplyLiquidity(A.agentId, want));
        lenderBudget += want;
        return;
      }
    }
    if (lenders.length >= MAX_LENDER_SLOTS) throw new Error("lender slots exhausted");
    const L = await H.newActor(ctx, `fund${lenders.length}`, want + U(10));
    await track(L, ctx.mkt.connect(L.signer).supplyLiquidity(A.agentId, want));
    lenders.push(L);
    lenderBudget += want;
  };

  /** Ensure `amt` is borrowable: pool liquidity, collateral approval and self-stake. */
  const prepare = async (amt) => {
    const pool = await ctx.mkt.getAgentPool(A.agentId);
    if (pool[2] < amt) await fund(amt - pool[2]);
    const need = await neededSelfStake(ctx, A.agentId, amt);
    const have = (await ctx.mkt.positions(A.agentId, A.address)).amount;
    if (need > have) {
      const top = need - have;
      await ctx.usdc.mint(A.address, top);
      A.startUsdc += top;
      await track(A, ctx.mkt.connect(A.signer).supplyLiquidity(A.agentId, top));
    }
  };

  const pipe = [];
  let ladder = null;
  const rows = [];
  let peak = 0;
  let day = 0;
  let stalled = 0;
  let lastLimit = -1;

  while (day < maxDays) {
    for (let i = pipe.length - 1; i >= 0; i--) {
      if (pipe[i].due <= day) {
        await track(A, ctx.mkt.connect(A.signer).repayLoan(pipe[i].id));
        pipe.splice(i, 1);
      }
    }
    if (ladder && ladder.due <= day) {
      await track(A, ctx.mkt.connect(A.signer).repayLoan(ladder.id));
      ladder = null;
    }

    const score = await H.score(ctx, A);
    const limit = await H.creditLimit(ctx, A);
    const tl = U(await tierLimitOf(ctx, score));
    if (score >= targetScore && limit >= tl) break;

    // Stall detector: neither score nor limit has moved for 40 days.
    if (Number(limit) === lastLimit) { stalled++; } else { stalled = 0; lastLimit = Number(limit); }
    if (stalled > 40 && score >= targetScore) break;

    const outst = await ctx.mkt.outstandingPrincipal(A.agentId);
    let free = limit > outst ? limit - outst : 0n;
    let active = Number(await ctx.mkt.activeLoanCount(A.agentId));
    const record = ctx.rep.maxRepaidPrincipal ? await ctx.rep.maxRepaidPrincipal(A.agentId) : 0n;

    const ladderUseful = ctx.rep.maxRepaidPrincipal && limit < tl;
    const pipeNeed = 7n * pipeUsdc;

    const doLadder = async () => {
      if (!ladder && active < 10 && free > record && free > 0n) {
        const amt = free;
        try { await prepare(amt); } catch (e) { return; }
        ladder = { id: await openLoan(ctx, A, amt, 8), due: day + 7, amount: amt };
        free = 0n; active++;
      }
    };
    const doPipe = async () => {
      if (pipe.length < 7 && active < 9 && free > 0n) {
        const sz = free >= pipeUsdc ? pipeUsdc : free;
        try { await prepare(sz); } catch (e) { return; }
        pipe.push({ id: await openLoan(ctx, A, sz, 8), due: day + 7, amount: sz });
        free -= sz; active++;
      }
    };

    if (!ladderUseful) {
      await doPipe();
    } else {
      const ladderFirst = !((free > pipeNeed ? free - pipeNeed : 0n) > record);
      if (ladderFirst) { await doLadder(); await doPipe(); }
      else {
        const reserve = free > pipeNeed ? pipeNeed : free;
        free -= reserve; await doLadder(); free += reserve; await doPipe();
      }
    }

    await advance(DAY);
    day++;
    const cap = await ownCapital();
    if (cap > peak) peak = cap;
    if (day % 20 === 0 || day < 3) {
      rows.push({
        day,
        score: await H.score(ctx, A),
        limitUsdc: f6(await H.creditLimit(ctx, A)),
        maxRepaidUsdc: ctx.rep.maxRepaidPrincipal ? f6(await ctx.rep.maxRepaidPrincipal(A.agentId)) : null,
        capitalUsdc: cap,
      });
    }
  }

  // Close everything still open so the bust-out starts from a clean sheet.
  for (const l of pipe) { try { await track(A, ctx.mkt.connect(A.signer).repayLoan(l.id)); } catch (e) {} }
  if (ladder) { try { await track(A, ctx.mkt.connect(A.signer).repayLoan(ladder.id)); } catch (e) {} }

  return {
    days: +(((await H.now()) - t0) / DAY).toFixed(2),
    score: await H.score(ctx, A),
    creditLimitUsdc: f6(await H.creditLimit(ctx, A)),
    collateralPct: await H.collateralPct(ctx, A),
    maxRepaidUsdc: ctx.rep.maxRepaidPrincipal ? f6(await ctx.rep.maxRepaidPrincipal(A.agentId)) : null,
    peakCapitalUsdc: peak,
    feesUsdc: f6((await ctx.mkt.accumulatedFees()) - feeStart),
    lenderAddresses: lenders.length,
    lenderCapitalUsdc: f6(lenderBudget),
    gas: A.gas.toString(),
    trajectory: rows,
    lenders,
  };
}

/**
 * Bust-out: a genuine third-party lender funds the pool up to the credit limit, the
 * attacker draws the whole line and never repays.
 *   V3/M1:  the attacker first WITHDRAWS its own seed (M2-a makes this impossible).
 *   V7:     the self-stake is locked and is first-loss, so the attacker's gain is
 *           net of it.
 */
async function bustOut(ctx, A, climbRes) {
  const limit = await H.creditLimit(ctx, A);
  const collPct = await H.collateralPct(ctx, A);

  // 1. The attacker first recovers every dollar of its OWN capital that it can,
  //    before the victim is on the hook: all the Sybil lender positions, and any
  //    self-stake above what M2-c will require for the draw. (Under V3/M1 there is
  //    no such requirement, so it takes the whole seed back — exactly the ordering
  //    every bust-out in the report used.)
  for (const l of climbRes.lenders) {
    const pos = await ctx.mkt.positions(A.agentId, l.address);
    if (pos.amount === 0n) continue;
    const p = await ctx.mkt.getAgentPool(A.agentId);
    const amt = pos.amount < p[2] ? pos.amount : p[2];
    if (amt > 0n) { try { await track(l, ctx.mkt.connect(l.signer).withdrawLiquidity(A.agentId, amt)); } catch (e) {} }
  }

  const needStake = await neededSelfStake(ctx, A.agentId, limit);
  let preWithdrawn = 0n;
  let own = (await ctx.mkt.positions(A.agentId, A.address)).amount;
  if (own > needStake) {
    const p = await ctx.mkt.getAgentPool(A.agentId);
    const want = own - needStake;
    const amt = want < p[2] ? want : p[2];
    if (amt > 0n) { try { await track(A, ctx.mkt.connect(A.signer).withdrawLiquidity(A.agentId, amt)); preWithdrawn = amt; } catch (e) {} }
  }
  // 2. ...and must re-commit first-loss capital if it is short (M2-c).
  own = (await ctx.mkt.positions(A.agentId, A.address)).amount;
  if (own < needStake) {
    const top = needStake - own;
    await ctx.usdc.mint(A.address, top); A.startUsdc += top;
    await track(A, ctx.mkt.connect(A.signer).supplyLiquidity(A.agentId, top));
  }

  // 3. Genuine victim lender tops the pool up to the full line.
  const pool0 = await ctx.mkt.getAgentPool(A.agentId);
  const short = limit > pool0[2] ? limit - pool0[2] : 0n;
  const V = await H.newActor(ctx, "victim", limit * 2n + U(1000));
  if (short > 0n) await track(V, ctx.mkt.connect(V.signer).supplyLiquidity(A.agentId, short));
  const victimSupplied = short;

  const pool = await ctx.mkt.getAgentPool(A.agentId);
  let draw = pool[2] < limit ? pool[2] : limit;
  // Collateral the tier still demands is the attacker's own money and is seized.
  const collateral = (draw * BigInt(collPct)) / 100n;
  if (collateral > 0n) { await ctx.usdc.mint(A.address, collateral); A.startUsdc += collateral; }

  const balBefore = await ctx.usdc.balanceOf(A.address);
  const selfBefore = (await ctx.mkt.positions(A.agentId, A.address)).amount;
  const victimBefore = (await ctx.mkt.positions(A.agentId, V.address)).amount;
  const id = await openLoan(ctx, A, draw, 7);

  // 4. [M2-a] With the loan outstanding, can the attacker still pull its stake out?
  let selfStakeLocked = false;
  if (selfBefore > 0n) {
    try { await track(A, ctx.mkt.connect(A.signer).withdrawLiquidity(A.agentId, 1n)); }
    catch (e) { selfStakeLocked = /Self-stake locked/.test(e.message); }
  }

  await advance(8 * DAY);
  const scoreBefore = await H.score(ctx, A);
  await (await ctx.mkt.liquidateLoan(id)).wait();
  const scoreAfter = await H.score(ctx, A);

  const selfAfter = (await ctx.mkt.positions(A.agentId, A.address)).amount;
  const victimAfter = (await ctx.mkt.positions(A.agentId, V.address)).amount;
  const lockedUntil = ctx.rep.lockedUntil ? Number(await ctx.rep.lockedUntil(A.agentId)) : 0;
  const nowTs = await H.now();

  return {
    creditLimitUsdc: f6(limit),
    collateralPct: collPct,
    drawnUsdc: f6(draw),
    collateralSeizedUsdc: f6(collateral),
    attackerCashDeltaUsdc: f6((await ctx.usdc.balanceOf(A.address)) - balBefore),
    selfStakeLockedAtBustOut: selfStakeLocked,
    selfStakePreWithdrawnUsdc: f6(preWithdrawn),
    selfStakeBurnedUsdc: f6(selfBefore - selfAfter),
    victimSuppliedUsdc: f6(victimSupplied),
    victimLossUsdc: f6(victimBefore - victimAfter),
    scoreBefore, scoreAfter, penaltyPoints: scoreBefore - scoreAfter,
    creditLimitAfterUsdc: f6(await H.creditLimit(ctx, A)),
    maxRepaidAfterUsdc: ctx.rep.maxRepaidPrincipal ? f6(await ctx.rep.maxRepaidPrincipal(A.agentId)) : null,
    lockoutDays: lockedUntil > nowTs ? +((lockedUntil - nowTs) / DAY).toFixed(1) : 0,
  };
}

// ------------------------------------------------------------------ scenarios

async function runAttacker(key, maxDays) {
  const cfg = CONFIGS[key];
  const ctx = await H.deployStack(cfg.levers());
  const A = await H.newActor(ctx, `${key}-attacker`, U(2000000));
  await H.makeAgent(ctx, A);
  const climbRes = await climb(ctx, A, { targetScore: 800, maxDays, selfFunded: true });
  const bust = await bustOut(ctx, A, climbRes);

  // Repeat cadence: the lockout (V4) or the re-farm of the lost points (V3).
  let repeatDays;
  if (bust.lockoutDays > 0) {
    // Lockout, then a fresh capacity ladder (maxRepaidPrincipal was reset to 0).
    repeatDays = bust.lockoutDays;
  } else {
    // V3: re-farm the penalty points at the rate limit, no capacity to rebuild.
    repeatDays = bust.penaltyPoints / cfg.levers().maxGainPerWindow;
  }
  const netGain = bust.drawnUsdc - bust.collateralSeizedUsdc - bust.selfStakeBurnedUsdc;

  const { lenders, ...climbOut } = climbRes;
  return {
    config: cfg.levers().name,
    creditMultiple: cfg.k,
    climb: climbOut,
    bustOut: bust,
    netAttackerGainUsdc: +netGain.toFixed(6),
    capitalShareOfPrize: +(climbRes.peakCapitalUsdc / Math.max(bust.drawnUsdc, 1e-9)).toFixed(4),
    repeatCadenceDays: +repeatDays.toFixed(1),
    steadyStateExtractionPerDay: +(netGain / Math.max(repeatDays, 1e-9)).toFixed(4),
  };
}

/**
 * Honest agent on the same model: identical growth strategy, but the pool is funded
 * by a REAL third-party lender, so the agent pays the interest instead of recapturing
 * it. Reported: time and realised cost to the largest unsecured line it can hold.
 */
async function runHonest(key, maxDays) {
  const cfg = CONFIGS[key];
  const ctx = await H.deployStack(cfg.levers());
  const B = await H.newActor(ctx, `${key}-honest`, U(2000000));
  await H.makeAgent(ctx, B);
  const res = await climb(ctx, B, { targetScore: 800, maxDays, selfFunded: false });
  const { lenders, ...out } = res;

  // Realised cost: everything the borrower cannot get back after a full unwind.
  B.suppliedTo = [B.agentId];
  await S.unwind(ctx, B);
  const realised = f6(B.startUsdc - (await ctx.usdc.balanceOf(B.address)));
  let lenderEarned = 0;
  for (const l of lenders) lenderEarned += f6((await ctx.mkt.positions(B.agentId, l.address)).earnedInterest);

  return {
    config: cfg.levers().name,
    creditMultiple: cfg.k,
    ...out,
    realisedCostUsdc: realised,
    thirdPartyLenderEarnedUsdc: +lenderEarned.toFixed(6),
  };
}

/**
 * Fixed-profile honest borrower (the report's H1): 7-day working capital held to
 * term, third-party funded. Measures whether the M1 principal-TIME bonus slows a
 * genuine term-holding borrower.
 */
async function runHonestFixed(key, maxLoans) {
  const cfg = CONFIGS[key];
  const ctx = await H.deployStack(cfg.levers());
  const B = await H.newActor(ctx, `${key}-H1`, U(2000000));
  await H.makeAgent(ctx, B);
  const L = await H.newActor(ctx, `${key}-H1-lender`, U(500000));
  await S.supply(ctx, L, B.agentId, U(2000));

  const loanAmt = U(50);
  const t0 = await H.now();
  const feeStart = await ctx.mkt.accumulatedFees();
  let loans = 0;
  let selfStaked = 0n;
  while (loans < maxLoans) {
    // [M2-c] Even a small honest borrower must post the first-loss self-stake once
    // its tier stops demanding 100 % collateral. Measured as part of its cost of capital.
    const need = await neededSelfStake(ctx, B.agentId, loanAmt);
    const have = (await ctx.mkt.positions(B.agentId, B.address)).amount;
    if (need > have) {
      const top = need - have;
      await track(B, ctx.mkt.connect(B.signer).supplyLiquidity(B.agentId, top));
      selfStaked += top;
    }
    const id = await openLoan(ctx, B, loanAmt, 7);
    await advance(7 * DAY - 600); // hold to term, 10 min short (repaying AT endTime forfeits the bonus)
    await track(B, ctx.mkt.connect(B.signer).repayLoan(id));
    loans++;
    if ((await H.score(ctx, B)) >= 600) break;
  }
  const days = +(((await H.now()) - t0) / DAY).toFixed(1);
  const score = await H.score(ctx, B);
  // Unwind so only genuinely unrecoverable outflows are counted.
  B.suppliedTo = [B.agentId];
  await S.unwind(ctx, B);
  return {
    config: cfg.levers().name, profile: "H1 (50 USDC / 7-day working capital, held to term)",
    days, finalScore: score, loans,
    creditLimitUsdc: f6(await H.creditLimit(ctx, B)),
    selfStakePostedUsdc: f6(selfStaked),
    realisedCostUsdc: f6(B.startUsdc - (await ctx.usdc.balanceOf(B.address))),
    feesUsdc: f6((await ctx.mkt.accumulatedFees()) - feeStart),
  };
}

// ---------------------------------------------------------------------- main

async function main() {
  const only = process.env.SIM_ONLY ? process.env.SIM_ONLY.split(",") : null;
  const outPath = path.join(__dirname, "out", "v7-model.json");
  const out = fs.existsSync(outPath) ? JSON.parse(fs.readFileSync(outPath)) : {};
  out.generatedAt = new Date().toISOString();
  out.attackers = out.attackers || {};
  out.honest = out.honest || {};
  out.honestFixed = out.honestFixed || {};

  const save = () => fs.writeFileSync(outPath, JSON.stringify(out, null, 2));

  for (const key of Object.keys(CONFIGS)) {
    if (only && !only.includes(key)) continue;
    console.log(`\n=== ATTACKER ${key} ===`);
    out.attackers[key] = await runAttacker(key, key === "v3" ? 200 : 300);
    console.log(JSON.stringify({
      days: out.attackers[key].climb.days,
      score: out.attackers[key].climb.score,
      limit: out.attackers[key].climb.creditLimitUsdc,
      peakCapital: out.attackers[key].climb.peakCapitalUsdc,
      fees: out.attackers[key].climb.feesUsdc,
      net: out.attackers[key].netAttackerGainUsdc,
      perDay: out.attackers[key].steadyStateExtractionPerDay,
    }));
    save();
  }

  for (const key of ["v3", "m1_k2", "v7_k2"]) {
    if (only && !only.includes("honest-" + key)) continue;
    console.log(`\n=== HONEST (ladder strategy) ${key} ===`);
    out.honest[key] = await runHonest(key, key === "v3" ? 200 : 300);
    console.log(JSON.stringify({
      days: out.honest[key].days, score: out.honest[key].score,
      limit: out.honest[key].creditLimitUsdc, cost: out.honest[key].realisedCostUsdc,
    }));
    save();
  }

  for (const key of ["v3", "m1_k2", "v7_k2"]) {
    if (only && !only.includes("honestfixed-" + key)) continue;
    console.log(`\n=== HONEST H1 (fixed 7-day profile) ${key} ===`);
    out.honestFixed[key] = await runHonestFixed(key, 120);
    console.log(JSON.stringify(out.honestFixed[key]));
    save();
  }

  save();
  console.log("\nwrote", outPath);
}

module.exports = { climb, bustOut, openLoan, CONFIGS };
if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
