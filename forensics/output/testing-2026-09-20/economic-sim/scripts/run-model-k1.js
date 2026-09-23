/**
 * M1 variant: how does `creditMultiple` (the "demonstrated capacity" multiplier)
 * move the attacker's capital requirement? k = 1 means an agent may borrow only
 * as much as the single largest loan it has already repaid.
 */
const fs = require("fs");
const path = require("path");
const H = require("./lib/harness");
const { U, f6, track } = H;
const { deployM1, m1Attack } = require("./run-model.js");

async function run(k) {
  const ctx = await deployM1({ creditMultiple: k });
  const A = await H.newActor(ctx, `k${k}-attacker`, U(5000000));
  await H.makeAgent(ctx, A);
  const fee0 = await ctx.mkt.accumulatedFees();
  const r = await m1Attack(ctx, A, 25000, 500);
  for (const l of r.openPipe) { try { await track(A, ctx.mkt.connect(A.signer).repayLoan(l.id)); } catch (e) {} }
  if (r.openLadder) { try { await track(A, ctx.mkt.connect(A.signer).repayLoan(r.openLadder.id)); } catch (e) {} }
  return {
    creditMultiple: k,
    days: r.days, score: r.score, creditLimitUsdc: r.creditLimitUsdc,
    maxRepaidUsdc: r.maxRepaidUsdc,
    peakCapitalUsdc: +r.peakCapitalUsdc.toFixed(2),
    feesUsdc: f6((await ctx.mkt.accumulatedFees()) - fee0),
    sybilLenderAddresses: r.sybilLenderAddresses,
    capitalPerUsdcOfCredit: +(r.peakCapitalUsdc / Math.max(r.creditLimitUsdc, 1)).toFixed(4),
  };
}

async function main() {
  const out = { generatedAt: new Date().toISOString(), runs: [] };
  for (const k of [1, 2, 4]) {
    const r = await run(k);
    out.runs.push(r);
    console.log("k=" + k, JSON.stringify(r));
  }
  const p = path.join(__dirname, "out", "model-k.json");
  fs.writeFileSync(p, JSON.stringify(out, null, 2));
  console.log("wrote", p);
}
main().catch(e => { console.error(e); process.exit(1); });
