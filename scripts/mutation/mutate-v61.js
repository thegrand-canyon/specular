#!/usr/bin/env node
/**
 * Mutation testing campaign for the V6.1 diff of
 * contracts/core/AgentLiquidityMarketplaceV6.sol
 * (F-01 ownerOf / F-02 pending tranches / F-03 late-interest cap /
 *  F-05 interest-loss socialization / F-07 isAgentActive gates, plus the
 *  2026-09-20 `canTopUp` view fix).
 *
 * Method (same as commit a3cd2df): one mutant at a time — patch the real source
 * file in place from an in-memory pristine copy, run a targeted subset of the
 * hardhat suite plus the Foundry V6.1 invariants, record killed/survived,
 * restore the file byte-for-byte, verify `git diff` is back to the baseline.
 *
 * A mutant is KILLED if the hardhat subset fails OR the Foundry invariants fail
 * (a compile error also counts as killed and is flagged, since it means the
 * mutation was not semantically meaningful — none of the mutants below should
 * fail to compile).
 *
 * Usage:
 *   export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
 *   node scripts/mutation/mutate-v61.js                # all mutants
 *   node scripts/mutation/mutate-v61.js --only=M01,M09 # a subset
 *   node scripts/mutation/mutate-v61.js --no-forge     # hardhat only (faster)
 *   node scripts/mutation/mutate-v61.js --out=path.json
 */

const fs = require("fs");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..", "..");
const TARGET = path.join(ROOT, "contracts", "core", "AgentLiquidityMarketplaceV6.sol");

// ---------------------------------------------------------------- test subsets
const EDGE = "test/unit/V61TrancheEdgeCases.test.js";
const FUZZ = "test/unit/V61PropertyFuzz.test.js";
const F01 = "test/audit-2026-09-fixes/F01-fix.test.js";
const F02 = "test/audit-2026-09-fixes/F02-fix.test.js";
const F03 = "test/audit-2026-09-fixes/F03-fix.test.js";
const F05 = "test/audit-2026-09-fixes/F05-fix.test.js";
const F07 = "test/audit-2026-09-fixes/F07-fix.test.js";
// One subset for every mutant keeps the campaign comparable and cheap: it is the
// whole V6.1-specific surface (14 edge-case tests + the 2-test property fuzz +
// the five F-xx regression suites), ~90 tests, and it recompiles once per mutant.
const SUBSET = [EDGE, FUZZ, F01, F02, F03, F05, F07];

// ------------------------------------------------------------------- mutants
// `find` must occur EXACTLY once in the pristine source (asserted below).
const MUTANTS = [
  {
    id: "M01",
    area: "F-02 _activeLoanStartedIn",
    title: "half-open window becomes closed: `s < hi` → `s <= hi`",
    find: "            if (s >= lo && s < hi) return true;",
    replace: "            if (s >= lo && s <= hi) return true;",
  },
  {
    id: "M02",
    area: "F-02 qualifiedAmountAt",
    title: "base tranche boundary `<=` → `<` (equal-timestamp lender loses its share)",
    find: "        if (p.depositTimestamp <= loanStartTime) q = p.amount - pend;",
    replace: "        if (p.depositTimestamp < loanStartTime) q = p.amount - pend;",
  },
  {
    id: "M03",
    area: "F-02 qualifiedAmountAt",
    title: "pending tranche boundary `<=` → `<`",
    find: "        if (pend > 0 && pt.timestamp <= loanStartTime) q += pend;",
    replace: "        if (pend > 0 && pt.timestamp < loanStartTime) q += pend;",
  },
  {
    id: "M04",
    area: "F-02 _socializeLoss pass 1",
    title: "drop the `_shrinkPendingProRata` call (pending may exceed principal)",
    find: "            _shrinkPendingProRata(agentId, lenders[i], share, p.amount);",
    replace: "            // MUTANT: _shrinkPendingProRata removed",
  },
  {
    id: "M05",
    area: "F-02 _socializeLoss remainder pass",
    title: "drop the `_shrinkPendingProRata` call in the remainder loop",
    find: "                _shrinkPendingProRata(agentId, lenders[i], take, p.amount);",
    replace: "                // MUTANT: _shrinkPendingProRata removed",
  },
  {
    id: "M06",
    area: "F-01 repayLoan",
    title: "revert the ownerOf substitution: only the original borrower may repay",
    find: '        require(msg.sender == loan.borrower || msg.sender == holder, "Not the borrower");',
    replace: '        require(msg.sender == loan.borrower, "Not the borrower");',
  },
  {
    id: "M07",
    area: "F-01 repayLoan",
    title: "reputation credited to the historical borrower instead of the NFT holder",
    find: "        reputationManager.recordLoanCompletion(holder, loan.amount, onTime && heldLongEnough && paidInterest);",
    replace: "        reputationManager.recordLoanCompletion(loan.borrower, loan.amount, onTime && heldLongEnough && paidInterest);",
  },
  {
    id: "M08",
    area: "F-01 liquidateLoan",
    title: "revert the ownerOf substitution: default recorded against loan.borrower",
    find: "        reputationManager.recordDefault(agentRegistry.ownerOf(loan.agentId), loan.amount);",
    replace: "        reputationManager.recordDefault(loan.borrower, loan.amount);",
  },
  {
    id: "M09",
    area: "F-03 _interestDue",
    title: "remove the 30-day late-interest cap",
    find: "        if (chargeableSeconds > cap) chargeableSeconds = cap;",
    replace: "        // MUTANT: LATE_INTEREST_CAP clamp removed",
  },
  {
    id: "M10",
    area: "F-03 _interestDue",
    title: "drop max(duration, elapsed): a late loan is charged the nominal term only",
    find: "        chargeableSeconds = elapsed > loan.duration ? elapsed : loan.duration;",
    replace: "        chargeableSeconds = loan.duration; elapsed;",
  },
  {
    id: "M11",
    area: "F-02 withdrawLiquidity LIFO",
    title: "off-by-one: the pending tranche is trimmed one base unit short",
    find: "            uint256 fromPending = amount < pt.amount ? amount : pt.amount;",
    replace: "            uint256 fromPending = amount < pt.amount ? amount : pt.amount - 1;",
  },
  {
    id: "M12",
    area: "F-01 repayLoan",
    title: "collateral returned to the current NFT holder instead of loan.borrower",
    find: "            usdcToken.safeTransfer(loan.borrower, loan.collateralAmount);",
    replace: "            usdcToken.safeTransfer(holder, loan.collateralAmount);",
  },
  {
    id: "M13",
    area: "F-07 requestLoan",
    title: "delete the isAgentActive gate on borrowing",
    find:
      '        require(agentRegistry.isAgentActive(msg.sender), "Agent deactivated");\n' +
      '        require(agentPools[agentId].isActive, "No pool for agent");',
    replace:
      "        // MUTANT: isAgentActive gate removed\n" +
      '        require(agentPools[agentId].isActive, "No pool for agent");',
  },
  {
    id: "M14",
    area: "F-07 createAgentPool",
    title: "delete the isAgentActive gate on pool creation",
    find:
      '        require(agentRegistry.isAgentActive(msg.sender), "Agent deactivated");\n' +
      '        require(!agentPools[agentId].isActive, "Pool already exists");',
    replace:
      "        // MUTANT: isAgentActive gate removed\n" +
      '        require(!agentPools[agentId].isActive, "Pool already exists");',
  },
  {
    id: "M15",
    area: "F-05 liquidateLoan",
    title: "skip `_socializeInterestLoss` (loss beyond principal leaves unbacked interest)",
    find: "                uint256 interestReduced = _socializeInterestLoss(loan.agentId, loss - reduced);",
    replace: "                uint256 interestReduced = 0; // MUTANT: _socializeInterestLoss skipped",
  },
  {
    id: "M16",
    area: "F-05 liquidateLoan",
    title: "skip `_pruneEmptyLenders` (wiped lenders keep their slot forever)",
    find: "            _pruneEmptyLenders(loan.agentId);",
    replace: "            // MUTANT: _pruneEmptyLenders removed",
  },
  {
    id: "M17",
    area: "2026-09-20 fix — canTopUp",
    title: "neutralize the fix: inclusive bound `block.timestamp + 1` → `block.timestamp`",
    find: "        return !_activeLoanStartedIn(agentId, pt.timestamp, block.timestamp + 1);",
    replace: "        return !_activeLoanStartedIn(agentId, pt.timestamp, block.timestamp);",
  },
];

// ------------------------------------------------------------------- helpers
function parseArgs() {
  const a = { only: null, forge: true, out: null };
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith("--only=")) a.only = arg.slice(7).split(",").map((s) => s.trim());
    else if (arg === "--no-forge") a.forge = false;
    else if (arg.startsWith("--out=")) a.out = arg.slice(6);
    else throw new Error(`unknown arg: ${arg}`);
  }
  return a;
}

function run(cmd, args, env) {
  const r = spawnSync(cmd, args, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return { status: r.status, out: (r.stdout || "") + (r.error ? String(r.error) : ""), err: r.stderr || "" };
}

function hardhat(files) {
  return run("npx", ["hardhat", "test", ...files], { V61_FUZZ_OPS: "150" });
}

function forge(file) {
  return run(path.join(process.env.HOME, ".foundry", "bin", "forge"), ["test", "--match-path", file]);
}

function summarizeHardhat(out) {
  const pass = /(\d+) passing/.exec(out);
  const fail = /(\d+) failing/.exec(out);
  const compileErr = /Error HH\d+|CompilerError|ParserError|TypeError:/.test(out);
  const firstFail = /\n\s+\d+\)\s+(.+)\n/.exec(out);
  return {
    passing: pass ? Number(pass[1]) : null,
    failing: fail ? Number(fail[1]) : 0,
    compileError: compileErr,
    firstFailure: firstFail ? firstFail[1].trim() : null,
  };
}

function summarizeForge(out) {
  const m = /(\d+) tests? passed, (\d+) failed/.exec(out);
  const failLine = /\[FAIL[^\]]*\]\s+(\S+)/.exec(out);
  return {
    passed: m ? Number(m[1]) : null,
    failed: m ? Number(m[2]) : null,
    firstFailure: failLine ? failLine[1] : null,
  };
}

// ---------------------------------------------------------------------- main
function main() {
  const args = parseArgs();
  const pristine = fs.readFileSync(TARGET, "utf8");
  const baselineDiff = execFileSync("git", ["diff", "--", TARGET], { cwd: ROOT, encoding: "utf8" });

  // Sanity: every `find` anchor must appear exactly once.
  for (const m of MUTANTS) {
    const n = pristine.split(m.find).length - 1;
    if (n !== 1) throw new Error(`${m.id}: anchor occurs ${n} times (expected 1):\n${m.find}`);
  }

  const selected = args.only ? MUTANTS.filter((m) => args.only.includes(m.id)) : MUTANTS;
  console.log(`Mutation campaign: ${selected.length} mutants on ${path.relative(ROOT, TARGET)}`);
  console.log(`Subset per mutant: ${SUBSET.join(" ")}${args.forge ? " + forge V61Invariants" : ""}\n`);

  const results = [];
  const restore = () => fs.writeFileSync(TARGET, pristine);
  process.on("SIGINT", () => { restore(); process.exit(130); });
  process.on("uncaughtException", (e) => { restore(); throw e; });

  for (const m of selected) {
    const t0 = Date.now();
    fs.writeFileSync(TARGET, pristine.replace(m.find, m.replace));
    let hh, fg;
    try {
      hh = summarizeHardhat(hardhat(SUBSET).out);
      fg = args.forge ? summarizeForge(forge("test/foundry/V61Invariants.t.sol").out) : null;
    } finally {
      restore();
    }
    const killedByHardhat = hh.failing > 0 || hh.compileError;
    const killedByForge = !!(fg && fg.failed > 0);
    const killed = killedByHardhat || killedByForge;
    const secs = Math.round((Date.now() - t0) / 1000);
    results.push({ ...m, hardhat: hh, foundry: fg, killedByHardhat, killedByForge, killed, seconds: secs });
    console.log(
      `${m.id} ${killed ? "KILLED " : "SURVIVED"} ` +
        `[hh ${hh.passing ?? "?"}p/${hh.failing}f${hh.compileError ? " COMPILE-ERR" : ""}` +
        (fg ? `, forge ${fg.passed ?? "?"}p/${fg.failed ?? "?"}f` : "") +
        `] ${secs}s — ${m.area}: ${m.title}` +
        (hh.firstFailure ? `\n         first hardhat failure: ${hh.firstFailure}` : "")
    );
  }

  // Tree must be byte-identical to the baseline.
  const afterDiff = execFileSync("git", ["diff", "--", TARGET], { cwd: ROOT, encoding: "utf8" });
  const clean = afterDiff === baselineDiff && fs.readFileSync(TARGET, "utf8") === pristine;

  const killed = results.filter((r) => r.killed).length;
  const byForge = results.filter((r) => r.killedByForge).length;
  console.log(
    `\n${killed}/${results.length} killed, ${results.length - killed} survived. ` +
      `${byForge} additionally killed by the Foundry invariants. ` +
      `Source restored: ${clean ? "yes (byte-identical)" : "NO — CHECK THE TREE"}`
  );

  const out =
    args.out || path.join(ROOT, "forensics", "output", "testing-2026-09-20", "mutation-results.json");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(
    out,
    JSON.stringify(
      { generatedAt: new Date().toISOString(), target: path.relative(ROOT, TARGET), subset: SUBSET, forge: args.forge, killed, total: results.length, killedByForge: byForge, sourceRestored: clean, results },
      null,
      2
    )
  );
  console.log(`Results → ${path.relative(ROOT, out)}`);
  if (!clean) process.exit(1);
}

main();
