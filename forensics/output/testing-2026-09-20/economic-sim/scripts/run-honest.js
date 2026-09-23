/**
 * Strategy (f): honest-agent trajectories, for the honest-vs-attacker ratio.
 *
 *  H1  7-day working-capital loans, held to term          (typical short-tenor agent)
 *  H2  30-day loans, held to term                          (typical working-capital agent)
 *  H3  reputation-optimising honest agent: 7-day term repaid after minHold, so it
 *      cycles as fast as the attacker but pays the full interest to real lenders
 *
 * All three pay the FULL interest (a third-party lender funds their pool); the
 * self-lending attacker pays only the platform fee.
 */
const fs = require("fs");
const path = require("path");
const H = require("./lib/harness");
const S = require("./lib/strategies");
const { U, f6 } = H;

async function run(levers, cfg) {
  const ctx = await H.deployStack(levers);
  const r = await S.honestBorrower(ctx, cfg);
  return { profile: cfg.label, tenorDays: cfg.tenorDays, holdToTerm: cfg.holdToTerm !== false, levers: levers.name, ...r };
}

async function main() {
  const out = { generatedAt: new Date().toISOString(), runs: [] };
  const profiles = [
    { label: "H1-7d-to-term", tenorDays: 7, holdToTerm: true, maxLoans: 120, targetScore: 600 },
    { label: "H2-30d-to-term", tenorDays: 30, holdToTerm: true, maxLoans: 120, targetScore: 600 },
    { label: "H3-daily-cycler", tenorDays: 7, holdToTerm: false, maxLoans: 120, targetScore: 600 },
  ];
  // Realistic working-capital agents: the loan size is set by the BUSINESS, not by
  // bonusReferenceAmount. Above the reference the bonus is capped but the interest
  // keeps scaling, so reputation gets strictly more expensive per point.
  const bigProfiles = [
    { label: "H4-1k-30d", tenorDays: 30, holdToTerm: true, loanUsdc: 1000, maxLoans: 110, targetScore: 600 },
    { label: "H5-at-tier-limit-30d", tenorDays: 30, holdToTerm: true, loanUsdc: "limit", maxLoans: 110, targetScore: 600 },
  ];
  for (const lev of [H.LEVERS_NEW, H.LEVERS_OLD]) {
    for (const p of profiles) {
      const r = await run(lev, p);
      out.runs.push({ ...r, snaps: r.snaps.filter((s, i) => i % 10 === 0 || i === r.snaps.length - 1) });
      console.log(lev.name, p.label, "->", r.finalScore, "in", r.days.toFixed(1), "days, cost",
        r.realisedCostUsdc, "USDC (fees", r.feesUsdc, ", lender earned", r.lenderEarnedUsdc, ")");
    }
  }
  for (const p of bigProfiles) {
    const r = await run(H.LEVERS_NEW, p);
    out.runs.push({ ...r, loanUsdc: p.loanUsdc, snaps: r.snaps.filter((s, i) => i % 10 === 0 || i === r.snaps.length - 1) });
    console.log(H.LEVERS_NEW.name, p.label, "->", r.finalScore, "in", r.days.toFixed(1), "days, cost",
      r.realisedCostUsdc, "USDC (fees", r.feesUsdc, ")");
  }
  const p = path.join(__dirname, "out", "honest.json");
  fs.writeFileSync(p, JSON.stringify(out, null, 2));
  console.log("wrote", p);
}
main().catch(e => { console.error(e); process.exit(1); });
