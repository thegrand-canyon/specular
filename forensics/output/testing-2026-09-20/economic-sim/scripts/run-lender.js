/**
 * Item 3: attacks on the LENDER side.
 *
 *  L1  worst-case third-party lender loss per unit of attacker cost
 *  L2  the withdrawal race: can a warned lender exit before liquidation?
 *  L3  partial draw — is the loss bounded by the credit limit?
 *  L4  F-05 path: loss > Σ principal → socialisation across unclaimed interest
 *  L5  F-02 verification: does a mid-loan top-up still forfeit in-flight interest?
 *      and how much interest does a self-lending borrower still recapture?
 *  L6  F-03 verification: does late repayment still cost nothing?
 *  L7  yield/loss asymmetry: a lender who joins while a loan is open earns nothing
 *      from it but still absorbs its default loss (D4 socialises over ALL lenders)
 */
const fs = require("fs");
const path = require("path");
const H = require("./lib/harness");
const S = require("./lib/strategies");
const { U, f6, advance, track, DAY } = H;

async function mkAgent(ctx, label, bal) {
  const A = await H.newActor(ctx, label, bal);
  await H.makeAgent(ctx, A);
  return A;
}
async function borrow(ctx, A, amt, days) {
  const r = await track(A, ctx.mkt.connect(A.signer).requestLoan(amt, days));
  return r.logs.map(l => { try { return ctx.mkt.interface.parseLog(l); } catch { return null; } })
    .find(e => e && e.name === "LoanRequested").args[0];
}
/** Push an agent's score to >=target the cheap way (self-lend farm). */
async function farmScore(ctx, A, target) {
  const plan = S.cyclePlan(ctx.levers);
  const seed = plan.totalPrincipal > ctx.levers.minSupply ? plan.totalPrincipal : ctx.levers.minSupply;
  await S.supply(ctx, A, A.agentId, seed);
  let s = await H.score(ctx, A), c = 0;
  while (s < target && c < 400) { const r = await S.farmCycle(ctx, A, plan); s = r.score; c++; }
  const pos = await ctx.mkt.positions(A.agentId, A.address);
  if (pos.amount > 0n) await track(A, ctx.mkt.connect(A.signer).withdrawLiquidity(A.agentId, pos.amount));
  if (pos.earnedInterest > 0n) { try { await track(A, ctx.mkt.connect(A.signer).claimInterest(A.agentId)); } catch (e) {} }
  return { score: s, cycles: c };
}

async function L1_L3_worstCase() {
  const ctx = await H.deployStack(H.LEVERS_NEW);
  const A = await mkAgent(ctx, "atk", U(200000));
  const feesBefore = await ctx.mkt.accumulatedFees();
  const farm = await farmScore(ctx, A, 600);
  const farmCost = f6((await ctx.mkt.accumulatedFees()) - feesBefore);

  // Honest lenders supply MORE than the credit limit, to test the bound.
  const lenders = [];
  for (let i = 0; i < 4; i++) {
    const L = await H.newActor(ctx, `L${i}`, U(20000));
    await S.supply(ctx, L, A.agentId, U(10000));
    lenders.push(L);
  }
  const supplied = 40000;
  const limit = await H.creditLimit(ctx, A);
  const balBefore = await ctx.usdc.balanceOf(A.address);
  const id = await borrow(ctx, A, limit, 7);

  // L2 — withdrawal race: 15,000 USDC should still be free (40k supplied − 25k drawn)
  const pool = await ctx.mkt.getAgentPool(A.agentId);
  const freeAfterDraw = f6(pool[2]);
  let escaped = 0;
  const got = {};
  for (const L of lenders) {
    const p = await ctx.mkt.positions(A.agentId, L.address);
    const pl = await ctx.mkt.getAgentPool(A.agentId);
    const amt = p.amount < pl[2] ? p.amount : pl[2];
    got[L.label] = 0;
    if (amt > 0n) { await track(L, ctx.mkt.connect(L.signer).withdrawLiquidity(A.agentId, amt)); escaped += f6(amt); got[L.label] = f6(amt); }
  }
  await advance(8 * DAY);
  await (await ctx.mkt.liquidateLoan(id)).wait();
  const gain = f6((await ctx.usdc.balanceOf(A.address)) - balBefore);
  const losses = [];
  for (const L of lenders) {
    const p = await ctx.mkt.positions(A.agentId, L.address);
    losses.push({ lender: L.label, suppliedUsdc: 10000, withdrawnBeforeLiquidationUsdc: got[L.label],
                  leftUsdc: f6(p.amount + p.earnedInterest),
                  lossUsdc: +(10000 - got[L.label] - f6(p.amount + p.earnedInterest)).toFixed(6) });
  }
  const totalLoss = losses.reduce((a, b) => a + b.lossUsdc, 0);
  return {
    farmCycles: farm.cycles, farmFeeCostUsdc: farmCost,
    honestSuppliedUsdc: supplied, creditLimitUsdc: f6(limit),
    drawnUsdc: f6(limit), attackerGainUsdc: gain,
    freeLiquidityAfterDrawUsdc: freeAfterDraw,
    lendersEscapedUsdc: escaped,
    perLender: losses,
    totalLenderLossUsdc: +totalLoss.toFixed(6),
    lossPerUnitAttackerCost: +(totalLoss / farmCost).toFixed(0),
    note: "FIFO race: whoever withdraws first takes the un-drawn remainder; the rest is socialised",
  };
}

/** L4 — force loss > Σ principal so the F-05 interest socialisation path runs. */
async function L4_interestSocialisation() {
  const ctx = await H.deployStack(H.LEVERS_NEW);
  const A = await mkAgent(ctx, "atk4", U(500000));
  await farmScore(ctx, A, 600);
  const L = await H.newActor(ctx, "L-only", U(100000));
  await S.supply(ctx, L, A.agentId, U(10000));
  // generate unclaimed interest for L, then let L withdraw principal so that
  // availableLiquidity is backed mostly by unclaimed interest
  const id1 = await borrow(ctx, A, U(10000), 30);
  await advance(29 * DAY);
  await track(A, ctx.mkt.connect(A.signer).repayLoan(id1));
  const pos1 = await ctx.mkt.positions(A.agentId, L.address);
  await track(L, ctx.mkt.connect(L.signer).withdrawLiquidity(A.agentId, pos1.amount));
  const pos2 = await ctx.mkt.positions(A.agentId, L.address);
  const pool = await ctx.mkt.getAgentPool(A.agentId);
  const drawable = pool[2];
  let res = { unclaimedInterestBeforeUsdc: f6(pos2.earnedInterest), availableLiquidityUsdc: f6(drawable), principalInPoolUsdc: f6(pos2.amount) };
  if (drawable > 0n) {
    const id2 = await borrow(ctx, A, drawable, 7);
    await advance(8 * DAY);
    await (await ctx.mkt.liquidateLoan(id2)).wait();
    const pos3 = await ctx.mkt.positions(A.agentId, L.address);
    res.unclaimedInterestAfterUsdc = f6(pos3.earnedInterest);
    res.interestSocialisedUsdc = +(res.unclaimedInterestBeforeUsdc - res.unclaimedInterestAfterUsdc).toFixed(6);
    res.claimStillSolvent = null;
    try { await ctx.mkt.connect(L.signer).claimInterest.staticCall(A.agentId); res.claimStillSolvent = true; }
    catch (e) { res.claimStillSolvent = (e.shortMessage || e.message).slice(0, 60); }
  }
  return res;
}

/** L5 — F-02 verification + self-lending interest recapture fraction. */
async function L5_topUpAndRecapture() {
  const ctx = await H.deployStack(H.LEVERS_NEW);
  const A = await mkAgent(ctx, "atk5", U(500000));
  await farmScore(ctx, A, 600);
  // attacker keeps a minimum self-lender position; honest lender supplies the rest
  await S.supply(ctx, A, A.agentId, U(10));
  const L = await H.newActor(ctx, "L5", U(100000));
  await S.supply(ctx, L, A.agentId, U(10000));
  const id = await borrow(ctx, A, U(10000), 30);
  // honest lender tops up MID-LOAN (the F-02 trigger)
  await advance(5 * DAY);
  await S.supply(ctx, L, A.agentId, U(1));
  const canTopUp = await ctx.mkt.canTopUp(A.agentId, L.address);
  const qual = await ctx.mkt.qualifiedAmountAt(A.agentId, L.address, (await ctx.mkt.loans(id)).startTime);
  await advance(24 * DAY);
  await track(A, ctx.mkt.connect(A.signer).repayLoan(id));
  const pa = await ctx.mkt.positions(A.agentId, A.address);
  const pl = await ctx.mkt.positions(A.agentId, L.address);
  const rec = await ctx.mkt.repayments(id);
  const lenderInterest = Number(rec.interestPaid) * (1 - ctx.levers.platformFeeRate / 10000);
  return {
    interestPaidUsdc: f6(rec.interestPaid),
    honestLenderQualifiedPrincipalUsdc: f6(qual),
    honestLenderEarnedUsdc: f6(pl.earnedInterest),
    selfLenderEarnedUsdc: f6(pa.earnedInterest),
    selfLenderRecaptureFraction: +(Number(pa.earnedInterest) / lenderInterest).toFixed(6),
    canTopUpFlag: canTopUp,
    verdict: Number(pl.earnedInterest) > 0
      ? "F-02 FIXED: mid-loan top-up did NOT forfeit the base tranche's in-flight interest"
      : "F-02 STILL PRESENT",
  };
}

/** L6 — F-03 verification: cost of repaying late. */
async function L6_lateRepay() {
  const ctx = await H.deployStack(H.LEVERS_NEW);
  const out = {};
  for (const [label, lateDays] of [["on-time", 0], ["late-10d", 10], ["late-30d", 30], ["late-90d(cap)", 90]]) {
    const A = await mkAgent(ctx, `atk6-${label}`, U(500000));
    await farmScore(ctx, A, 600);
    const L = await H.newActor(ctx, `L6-${label}`, U(100000));
    await S.supply(ctx, L, A.agentId, U(10000));
    const id = await borrow(ctx, A, U(10000), 7);
    const scoreBefore = await H.score(ctx, A);
    await advance((7 + lateDays) * DAY - (lateDays === 0 ? 600 : 0));
    const pv = await ctx.mkt.previewRepayment(id);
    await track(A, ctx.mkt.connect(A.signer).repayLoan(id));
    out[label] = {
      lateDays,
      interestChargedUsdc: f6(pv[0]),
      chargeableDays: +(Number(pv[2]) / DAY).toFixed(3),
      lateDaysRecorded: +(Number(pv[3]) / DAY).toFixed(3),
      scoreBefore, scoreAfter: await H.score(ctx, A),
      reputationBonus: (await H.score(ctx, A)) - scoreBefore,
    };
  }
  const nominal = out["on-time"].interestChargedUsdc;
  out.summary = {
    nominal7dInterestUsdc: nominal,
    extraCostOf30dLateUsdc: +(out["late-30d"].interestChargedUsdc - nominal).toFixed(6),
    cappedAtUsdc: out["late-90d(cap)"].interestChargedUsdc,
    verdict: out["late-30d"].interestChargedUsdc > nominal
      ? "F-03 FIXED: overdue credit is charged for the time used (capped at duration + 30d)"
      : "F-03 STILL PRESENT",
    residual: "interest stops accruing after duration+30d; beyond that overdue credit is free again, and lateness carries NO reputation penalty (ReputationManagerV3 has no hook) — only loss of the bonus",
  };
  return out;
}

/** L7 — a lender who joins while a loan is open: zero yield, full loss exposure. */
async function L7_yieldLossAsymmetry() {
  const ctx = await H.deployStack(H.LEVERS_NEW);
  const A = await mkAgent(ctx, "atk7", U(500000));
  await farmScore(ctx, A, 600);
  const early = await H.newActor(ctx, "early", U(50000));
  await S.supply(ctx, early, A.agentId, U(10000));
  const id = await borrow(ctx, A, U(10000), 30);      // drawn against EARLY's money only
  const late = await H.newActor(ctx, "late-joiner", U(50000));
  await S.supply(ctx, late, A.agentId, U(10000));      // joins AFTER the loan started
  const qLate = await ctx.mkt.qualifiedAmountAt(A.agentId, late.address, (await ctx.mkt.loans(id)).startTime);
  await advance(31 * DAY);
  await (await ctx.mkt.liquidateLoan(id)).wait();
  const pe = await ctx.mkt.positions(A.agentId, early.address);
  const plt = await ctx.mkt.positions(A.agentId, late.address);
  return {
    earlyLenderSuppliedUsdc: 10000, lateJoinerSuppliedUsdc: 10000,
    lateJoinerQualifiedForLoanUsdc: f6(qLate),
    earlyLenderLeftUsdc: f6(pe.amount + pe.earnedInterest),
    lateJoinerLeftUsdc: f6(plt.amount + plt.earnedInterest),
    finding: "the late joiner could earn NOTHING from the in-flight loan (W1 qualification) but D4 socialises that loan's default loss across ALL current lenders pro-rata",
  };
}

async function main() {
  const out = { generatedAt: new Date().toISOString() };
  out.L1_L3 = await L1_L3_worstCase(); console.log("L1/L3", JSON.stringify(out.L1_L3).slice(0, 400));
  out.L4 = await L4_interestSocialisation(); console.log("L4", JSON.stringify(out.L4));
  out.L5 = await L5_topUpAndRecapture(); console.log("L5", JSON.stringify(out.L5));
  out.L6 = await L6_lateRepay(); console.log("L6", JSON.stringify(out.L6.summary));
  out.L7 = await L7_yieldLossAsymmetry(); console.log("L7", JSON.stringify(out.L7));
  const p = path.join(__dirname, "out", "lender.json");
  fs.writeFileSync(p, JSON.stringify(out, null, 2));
  console.log("wrote", p);
}
main().catch(e => { console.error(e); process.exit(1); });
