const H = require("./lib/harness");
const S = require("./lib/strategies");

async function main() {
  const ctx = await H.deployStack(H.LEVERS_NEW);
  console.log("VERSION", await ctx.mkt.VERSION());
  console.log("plan", S.cyclePlan(H.LEVERS_NEW));
  const r = await S.soloSelfLender(ctx, { targetScore: 125, maxCycles: 6 });
  console.log(JSON.stringify({ ...r, actor: undefined, snaps: r.snaps }, null, 2));
}
main().catch(e => { console.error(e); process.exit(1); });
