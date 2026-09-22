/**
 * Parameterised strategies driven against the real contracts.
 *
 * The core primitive is `farmCycle`: one reputation-gain window worth of
 * loan→hold→repay activity, sized to exactly saturate the rate-limit budget at
 * minimum principal (cost per point is scale-invariant below bonusReferenceAmount,
 * so the cheapest saturating configuration is the fewest loans that sum to
 * `maxGain/onTimeBonus * bonusReferenceAmount` of principal).
 */
const H = require("./harness");
const { U, f6, advance, track, DAY } = H;

/** Loans-per-cycle and per-loan principal that exactly saturate the gain budget. */
function cyclePlan(levers) {
  const maxGain = levers.maxGainPerWindow > 0 ? levers.maxGainPerWindow : levers.onTimeBonus * 10;
  const K = Math.max(1, Math.ceil(maxGain / levers.onTimeBonus));
  // principal needed for `maxGain` points: bonus = onTimeBonus * min(amt,ref)/ref
  const totalPrincipal = (BigInt(maxGain) * levers.bonusRef) / BigInt(levers.onTimeBonus);
  const per = totalPrincipal / BigInt(K);
  return { K, per, totalPrincipal, maxGain };
}

/**
 * One rate-limit window of farming. Opens K loans, holds them `hold` seconds,
 * repays them all. Returns {gained, elapsed}.
 */
async function farmCycle(ctx, borrower, plan, opts = {}) {
  const before = await H.score(ctx, borrower);
  const t0 = await H.now();
  const ids = [];
  for (let k = 0; k < plan.K; k++) {
    const r = await track(borrower, ctx.mkt.connect(borrower.signer).requestLoan(plan.per, opts.durationDays || 7));
    const ev = r.logs.map(l => { try { return ctx.mkt.interface.parseLog(l); } catch { return null; } })
      .find(e => e && e.name === "LoanRequested");
    ids.push(ev.args[0]);
  }
  const hold = Math.max(opts.hold ?? Number(ctx.levers.minHold), Number(ctx.levers.gainWindow));
  await advance(hold);
  for (const id of ids) {
    await track(borrower, ctx.mkt.connect(borrower.signer).repayLoan(id));
  }
  const after = await H.score(ctx, borrower);
  return { gained: after - before, elapsed: (await H.now()) - t0, score: after, ids };
}

/** Full unwind: repay every active loan, claim interest, withdraw principal. */
async function unwind(ctx, actor) {
  if (actor.agentId && actor.agentId > 0n) {
    const ids = await ctx.mkt.getActiveLoanIds(actor.agentId);
    for (const id of ids) {
      const loan = await ctx.mkt.loans(id);
      if (loan.state === 1n) {
        try { await track(actor, ctx.mkt.connect(actor.signer).repayLoan(id)); } catch (e) { /* insolvent */ }
      }
    }
  }
  for (const pid of actor.suppliedTo || []) {
    const pos = await ctx.mkt.positions(pid, actor.address);
    if (pos.earnedInterest > 0n) {
      try { await track(actor, ctx.mkt.connect(actor.signer).claimInterest(pid)); } catch (e) {}
    }
    if (pos.amount > 0n) {
      const pool = await ctx.mkt.getAgentPool(pid);
      const avail = pool[2];
      const amt = pos.amount < avail ? pos.amount : avail;
      if (amt > 0n) { try { await track(actor, ctx.mkt.connect(actor.signer).withdrawLiquidity(pid, amt)); } catch (e) {} }
    }
  }
}

async function supply(ctx, lender, agentId, amount) {
  await track(lender, ctx.mkt.connect(lender.signer).supplyLiquidity(agentId, amount));
  lender.suppliedTo = lender.suppliedTo || [];
  if (!lender.suppliedTo.includes(agentId)) lender.suppliedTo.push(agentId);
}

/**
 * Strategy (a)/(b): solo self-lender farming.
 * The attacker is BOTH the borrower and the only lender in its own pool, so
 * ~all interest is recaptured as `earnedInterest`; the only unrecoverable
 * outflow is the platform fee (+ rounding dust) and gas.
 */
async function soloSelfLender(ctx, opts = {}) {
  const levers = ctx.levers;
  const plan = cyclePlan(levers);
  const budget = opts.budget ?? U(500000);
  const A = await H.newActor(ctx, opts.label || "attacker", budget);
  await H.makeAgent(ctx, A);
  const poolSupply = plan.totalPrincipal > levers.minSupply ? plan.totalPrincipal : levers.minSupply;
  await supply(ctx, A, A.agentId, poolSupply);

  const feesStart = await ctx.mkt.accumulatedFees();
  const t0 = await H.now();
  const snaps = [];
  const milestones = {};
  let cycles = 0;
  const target = opts.targetScore ?? 600;
  const maxCycles = opts.maxCycles ?? 400;

  const snap = async () => {
    const s = await H.score(ctx, A);
    const row = {
      cycle: cycles,
      day: ((await H.now()) - t0) / DAY,
      score: s,
      creditLimitUsdc: f6(await H.creditLimit(ctx, A)),
      collateralPct: await H.collateralPct(ctx, A),
      feesPaidUsdc: f6((await ctx.mkt.accumulatedFees()) - feesStart),
      lockedUsdc: f6(await H.lockedCapital(ctx, A)),
      gas: A.gas.toString(),
    };
    row.ownCapitalUsdc = row.netPaidUsdc;
    snaps.push(row);
    for (const m of [200, 400, 500, 600, 800, 1000]) {
      if (s >= m && !milestones[m]) milestones[m] = row;
    }
    return s;
  };

  await snap();
  while (cycles < maxCycles) {
    const res = await farmCycle(ctx, A, plan, opts);
    cycles++;
    const s = await snap();
    if (res.gained === 0 && opts.stopOnStall !== false) break;
    if (s >= target) break;
  }

  const balBeforeUnwind = await ctx.usdc.balanceOf(A.address);
  await unwind(ctx, A);
  const realisedCost = A.startUsdc - (await ctx.usdc.balanceOf(A.address));

  return {
    actor: A,
    plan: { loansPerCycle: plan.K, perLoanUsdc: f6(plan.per), principalPerCycleUsdc: f6(plan.totalPrincipal) },
    snaps, milestones,
    cycles,
    finalScore: await H.score(ctx, A),
    days: ((await H.now()) - t0) / DAY,
    feesUsdc: f6((await ctx.mkt.accumulatedFees()) - feesStart),
    peakLockedUsdc: Math.max(...snaps.map(s => s.lockedUsdc)),
    realisedCostUsdc: f6(realisedCost),
    gas: A.gas.toString(),
    balBeforeUnwindUsdc: f6(balBeforeUnwind),
  };
}

/**
 * Honest borrower: a third-party lender funds the pool; the borrower pays the
 * FULL interest (lender share is not recaptured). `tenorDays` is the loan term
 * and `holdToTerm` controls whether they hold to term (real use of credit) or
 * cycle at minHold (reputation-optimising behaviour).
 */
async function honestBorrower(ctx, opts = {}) {
  const levers = ctx.levers;
  const plan = cyclePlan(levers);
  const tenor = opts.tenorDays ?? 7;
  const B = await H.newActor(ctx, opts.label || "honest", opts.budget ?? U(500000));
  await H.makeAgent(ctx, B);
  const atLimit = opts.loanUsdc === "limit";
  const loanAmt = (opts.loanUsdc && !atLimit) ? U(opts.loanUsdc) : plan.per;
  const L = await H.newActor(ctx, (opts.label || "honest") + "-lender", U(5000000));
  const want = atLimit ? U(60000) : loanAmt * 4n;
  const supplyAmt = want > levers.minSupply ? want : levers.minSupply;
  await supply(ctx, L, B.agentId, supplyAmt);

  const t0 = await H.now();
  const feesStart = await ctx.mkt.accumulatedFees();
  const snaps = [];
  const milestones = {};
  let loans = 0;
  const target = opts.targetScore ?? 600;
  const maxLoans = opts.maxLoans ?? 60;

  while (loans < maxLoans) {
    const amt = atLimit ? await H.creditLimit(ctx, B) : loanAmt;
    const r = await track(B, ctx.mkt.connect(B.signer).requestLoan(amt, tenor));
    const ev = r.logs.map(l => { try { return ctx.mkt.interface.parseLog(l); } catch { return null; } })
      .find(e => e && e.name === "LoanRequested");
    const id = ev.args[0];
    // NOTE: hold to term MINUS a 10-minute margin. Repaying at (or one second
    // past) `endTime` makes onTime=false and forfeits the whole bonus — there is
    // no partial credit for lateness (see F-03 note in the report).
    const hold = opts.holdToTerm === false
      ? Math.max(Number(levers.minHold), Number(levers.gainWindow))
      : tenor * DAY - 600;
    await advance(hold);
    await track(B, ctx.mkt.connect(B.signer).repayLoan(id));
    loans++;
    const s = await H.score(ctx, B);
    const row = {
      loan: loans,
      day: ((await H.now()) - t0) / DAY,
      score: s,
      creditLimitUsdc: f6(await H.creditLimit(ctx, B)),
      netPaidUsdc: f6(B.startUsdc - (await ctx.usdc.balanceOf(B.address))),
    };
    row.ownCapitalUsdc = row.netPaidUsdc;
    snaps.push(row);
    for (const m of [200, 400, 500, 600, 800]) if (s >= m && !milestones[m]) milestones[m] = row;
    if (s >= target) break;
  }

  const realisedCost = B.startUsdc - (await ctx.usdc.balanceOf(B.address));
  const peakOwn = Math.max(...snaps.map(s => s.netPaidUsdc), 0);
  return {
    snaps, milestones, loans,
    tenorDays: tenor,
    holdToTerm: opts.holdToTerm !== false,
    finalScore: await H.score(ctx, B),
    days: ((await H.now()) - t0) / DAY,
    realisedCostUsdc: f6(realisedCost),
    feesUsdc: f6((await ctx.mkt.accumulatedFees()) - feesStart),
    lenderEarnedUsdc: f6((await ctx.mkt.positions(B.agentId, L.address)).earnedInterest),
    gas: B.gas.toString(),
    perLoanUsdc: atLimit ? "at tier credit limit" : f6(loanAmt),
    peakOwnCapitalUsdc: peakOwn,
  };
}

module.exports = { cyclePlan, farmCycle, unwind, supply, soloSelfLender, honestBorrower };
