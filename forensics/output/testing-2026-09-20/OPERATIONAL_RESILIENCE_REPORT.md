# Specular — Operational Resilience Test (2026-09-20 → 2026-09-22)

**Question asked:** the Arc-mainnet invariant monitor has only ever reported OK. Would it
actually catch a real problem, and could we respond to an incident?

**Answer:** **no, for most problems.** Against 18 engineered violation states on a local
deployment of the exact V6.1 stack, the monitor that runs on Arc mainnet today caught **3** and
missed **15** — including every ownership, pause, solvency and V6.1-specific failure. One of its
three checks (§S5) was a silent no-op: it queried a mapping with the wrong key type and read 0
for every agent, for every input. Separately, the monitor **crashes without logging anything**
when the RPC fails (15 such crashes already recorded on arc-testnet) and **reports a clean OK
against a stale or frozen endpoint**. Nobody is paged for any of it.

All of that is now fixed in the worktree: **19/19 detected, 0 missed, 0 false positives on the
healthy control**, verified clean against live Arc mainnet, with a working alert path proven
end-to-end. The changes are unported — see §8.

**Scope discipline:** every write was on a local hardhat chain. Live chains were read-only
(`eth_call`/`eth_getBlockByNumber`). No transaction was broadcast to Arc mainnet, Arc testnet or
Base.

---

## 1. Method

A local hardhat node running the exact Arc-mainnet stack — `AgentRegistryV2`,
`ReputationManagerV3`, `AgentLiquidityMarketplaceV6` (V6.1), `AgentCreditFaucet` — with the live
lever values, two agents, three lenders, one repaid loan (late) and two ACTIVE loans
(`scripts/op-resilience/deploy-local.js`).

Each violation is engineered inside an `evm_snapshot`/`evm_revert` pair, then **both** monitors
run against the same chain: the frozen pre-2026-09-20 monitor
(`scripts/op-resilience/v6-invariants-V60-baseline.js`, identical to production except for a
`local` network entry) and the rewritten one. Driver:
`scripts/op-resilience/run-detection-matrix.js`.

Where an owner function can produce the state (`pause`, `transferOwnership`, `seedPool`) it is
used. Where the contract deliberately makes the state unreachable — a duplicate `poolLenders`
entry *is* the §B1 fix — it is written with `hardhat_setStorageAt` against a slot map that is
first asserted against 13 of the contract's own getters (`scripts/op-resilience/storage.js`); a
drifted slot map aborts the run rather than corrupting the wrong word.

---

## 2. Detection matrix

`V6.0` = the monitor running on Arc mainnet right now. `V6.1` = the rewrite in this worktree.
Raw data: `detection-matrix.json`.

| # | Engineered violation | V6.0 | V6.1 | Severity | Codes raised by V6.1 |
|---|---|---|---|---|---|
| — | **healthy control** | exit 0 ✓ | exit 0 ✓ | — | *(none — no false positives)* |
| a1 | §S1 phantom liquidity, gross (avail ≫ balance) | **exit 1 ✓** | exit 1 ✓ | CRITICAL | `S1`, `SOLV`, `LOAN-TOTAL`, `POOL-SLACK`(W) |
| a2 | §S1 phantom liquidity, **masked** (+500 USDC < 700 USDC escrowed collateral) | exit 0 ✗ **MISS** | exit 1 ✓ | CRITICAL | `SOLV`, `POOL-SLACK`(W) |
| b | §B1 duplicate address in `poolLenders[]` | **exit 1 ✓** | exit 1 ✓ | CRITICAL | `B1`, `POOL` |
| c | §S5 runaway `activeLoanCount` (47 vs cap 10) | exit 0 ✗ **MISS** | exit 1 ✓ | CRITICAL | `S5-COUNTER`, `S5-CAP`, `ALI-LEN` |
| d1 | Insolvency: claims + fees + collateral > balance | **exit 1 ✓** | exit 1 ✓ | CRITICAL | `S1`, `SOLV` |
| d2 | Pool-level insolvency, global balance still fine | exit 0 ✗ **MISS** | exit 1 ✓ | CRITICAL | `POOL` |
| e | `pool.totalLoaned` disagrees with Σ ACTIVE loans | exit 0 ✗ **MISS** | exit 1 ✓ | CRITICAL | `LOAN-TOTAL`, `POOL` |
| f1 | Ownership transferred + accepted by another wallet | exit 0 ✗ **MISS** | exit 1 ✓ | CRITICAL | `OWN` |
| f2 | Ownership transfer **pending** (not yet accepted) | exit 0 ✗ **MISS** | exit 1 ✓ | CRITICAL | `OWN-PENDING` |
| g | Contract paused unexpectedly | exit 0 ✗ **MISS** | exit 1 ✓ | CRITICAL | `PAUS` |
| h | `accumulatedFees` exceeds contract balance | exit 0 ✗ **MISS** | exit 1 ✓ | CRITICAL | `FEE`, `SOLV` |
| v1 | **[V6.1]** `pendingTranche.amount > position.amount` | exit 0 ✗ **MISS** | exit 1 ✓ | CRITICAL | `PT`, `QUAL-REVERT` |
| v2 | **[V6.1]** pending tranche timestamp older than base tranche | exit 0 ✗ **MISS** | exit 1 ✓ | CRITICAL | `PT-TS` |
| v3 | **[V6.1]** `activeLoanIds` holds a REPAID loan id | exit 0 ✗ **MISS** | exit 1 ✓ | CRITICAL | `ALI`, `ALI-LEN` |
| v4 | **[V6.1]** `activeLoanIds` emptied, counter still 1 | exit 0 ✗ **MISS** | exit 1 ✓ | CRITICAL | `ALI`, `ALI-LEN` |
| v5 | **[V6.1]** `qualifiedAmountAt` reverts (repayments bricked) | exit 0 ✗ **MISS** | exit 1 ✓ | CRITICAL | `QUAL-REVERT`, `PT`, `PT-TS`, `POOL` |
| v6 | **[V6.1]** `lateRepayCount` rewritten downwards | exit 0 ✗ **MISS** | exit 1 ✓ | CRITICAL | `LATE-COUNT`, `LATE-MONO` |
| v7 | **[V6.1]** `lateSecondsTotal` inflated beyond the records | exit 0 ✗ **MISS** | exit 1 ✓ | CRITICAL | `LATE-SECONDS` |
| n | Agent NFT moved while a loan is ACTIVE (F-01 follow-up) | exit 0 ✗ **MISS** | exit 1 ✓ | WARN | `NFT-MOVED` |

**Totals — V6.0: 3/19 detected, 16 missed. V6.1: 19/19 detected, 0 missed, 0 false positives.**
Every V6.1 detection exits non-zero (1). No detection exits 2 (a `MONITOR-FAILED` abort would
mean remaining checks were skipped — the first draft aborted on cases v1/v5 and was fixed).

### 2.1 Root cause of the §S5 blind spot — the worst single finding

V6.0 read `mp.activeLoanCount(agent.agentWallet)`. V6.1 declares
`mapping(uint256 => uint256) public activeLoanCount` — keyed by **agentId**, not address (the
2026-08 D2 change). ethers coerces the address to a uint256, so the call read the slot for
`agentId == 642829559307850963015472508762062935916233390536`. Proven
(`scripts/op-resilience/prove-s5-bug.js`):

```json
{ "agentId": "1", "cap": 10,
  "activeLoanCount(agentId)  [truth]": 47,
  "activeLoanCount(wallet)   [what V6.0 read]": 0,
  "V6.0 would have flagged?": false,
  "V6.1 flags?": true }
```

The check returned 0 for every agent on every run since the V6.1 deploy. It could not fail.
Its `§S5 OK` lines in the production mainnet log are meaningless.

### 2.2 Why a1 was caught but a2 was not

V6.0's only solvency test was `Σ availableLiquidity ≤ usdc.balanceOf(marketplace)`. Escrowed
collateral sits in that same balance, so any phantom liquidity smaller than Σ collateral is
invisible. That is the realistic shape of an §S1-class leak — it accumulates in small
increments. V6.1 checks the exact identity instead:

```
balance == Σ availableLiquidity + accumulatedFees + Σ (ACTIVE loan collateral)
```

`<` is insolvency (CRITICAL); `>` is an unexplained surplus (WARN, threshold
`V6_SURPLUS_WARN_USDC`, default 1 USDC) because on Arc a forced native donation lands in that
balance — audit finding I-3 explicitly asked for `>=` plus a delta alarm.

---

## 3. V6.1 gap analysis — new invariants and proof they fire

The V6.0 monitor was written for V6.0 and checked **none** of the state V6.1 added. New checks:

| Check | Invariant | Fires on |
|---|---|---|
| `PT` | `pendingTranche.amount ≤ positions.amount` | v1 |
| `PT-TS` | `pendingTranche.timestamp ≥ position.depositTimestamp` | v2 |
| `PT-GHOST` | pending timestamp set with zero amount (stale slot) | WARN only |
| `ALI` | `activeLoanIds[agentId]` is exactly the set of ACTIVE loans — no stale, no missing, no duplicates | v3, v4 |
| `ALI-LEN` | `activeLoanIds.length == activeLoanCount` | c, v3, v4 |
| `S5-COUNTER` | `activeLoanCount == \|actual ACTIVE loans\|` | c |
| `S5-CAP` | `activeLoanCount ≤ MAX_ACTIVE_LOANS_PER_AGENT` | c |
| `QUAL` / `QUAL-LENDER` | `Σ qualifiedAmountAt(loan.startTime) ≤ Σ positions.amount`, and per-lender `q ≤ amount` | defence in depth |
| `QUAL-REVERT` | `qualifiedAmountAt` must not revert — a revert means `_distributeInterest` reverts too, so **every repayment on that pool is bricked** | v1, v5 |
| `LATE-COUNT` / `LATE-SECONDS` | `lateRepayCount` / `lateSecondsTotal` agree with the per-loan `repayments[]` records | v6, v7 |
| `LATE-MONO` / `LATE-MONO-S` | both counters are monotonically non-decreasing across runs (persisted in `state-<net>.json`) | v6 |
| `LATE-EXCESS` / `LATE-ZERO` | `lateRepayCount ≤ closed loans`; `lateSecondsTotal ≥ lateRepayCount` | sanity |
| `LOAN-OUTSTANDING` | `outstandingPrincipal == Σ ACTIVE principal` (the H-3 aggregate) | e |
| `LOAN-ORPHAN` | no ACTIVE loans against an agent with no pool | sanity |
| `POOL` | per-pool conservation: `Σ amount + Σ earnedInterest == availableLiquidity + totalLoaned` | a2, b, d2, e, v5 |
| `OWN` / `OWN-PENDING` / `PAUS` | control plane | f1, f2, g |
| `FEE` | `accumulatedFees ≤ balance` | h |
| `NFT-MOVED` | the F-01 residual credit event the audit asked for (recommendation 6) | n |
| `FRESH` / `FRESH-STUCK` / `FRESH-REORG` | the RPC is serving a current, advancing, same-chain head | §4 |

`QUAL-REVERT` deserves its own note: the only reachable way to trip `QUAL` is via a corrupt
pending tranche, and at that point `qualifiedAmountAt` *reverts* (`p.amount - pend` underflows)
rather than returning a wrong number. `_distributeInterest` computes the same quantity, so the
observable symptom of that corruption is **`repayLoan` reverting for every borrower on the
pool**. Worth detecting; not fixable with a lever.

The per-pool conservation check is the workhorse — it independently caught 5 of the 19
scenarios, including the two that global solvency alone masks.

---

## 4. RPC failure and stale data — does it report a false OK?

Fault-injecting proxy in front of the local chain (`scripts/op-resilience/fault-rpc.js`), full
matrix in `rpc-failure-matrix.txt`:

| Endpoint condition | V6.0 | V6.1 | Note |
|---|---|---|---|
| healthy | exit 0 | exit 0 | control |
| **dead** (nothing listening) | **exit 1, ZERO log lines written** | exit 2, `MONITOR-FAILED` logged + alert | V6.0 crashes on an unhandled rejection — `getBlock()` sits *outside* its try/catch |
| **JSON-RPC errors** | **exit 1, ZERO log lines** | exit 2, `MONITOR-FAILED` | same crash |
| **slow** (20 s/call) | **exit 0 after 261 s — reports OK** | exit 2 after 40 s | V6.0 has no per-request timeout at all |
| **stale head** (2 h old, reads succeed) | **exit 0 — FALSE OK** | exit 1, `FRESH` | |
| **frozen RPC** (same block replayed, every read succeeds and is self-consistent) | **exit 0 — FALSE OK, for ever** | exit 1, `FRESH-STUCK` | V6.0 keeps no run-to-run state, so it can never see this |

**This is not hypothetical.** `forensics/monitor/v6-invariants-stderr.log` holds **15 real
crashes** of the production arc-testnet job — 9 × `ENOTFOUND arc-testnet.drpc.org`,
3 × `exceeded maximum retry limit`, 2 × `request timeout`, 1 × HTTP 500 — each of which wrote
**nothing** to the JSONL log and raised **no** alert. The arc-testnet RPC was in fact down
throughout this test session; the V6.1 monitor reported it correctly as
`[MONITOR-FAILED] … the deployment is UNMONITORED this cycle`, exit 2.

Consequences addressed in V6.1: `withRetry` now has a per-request timeout
(`V6_RPC_TIMEOUT_MS`, 20 s default) and treats `ECONNREFUSED`/`ENOTFOUND`/`SERVER_ERROR` as
retryable; the whole body is inside a try/catch that logs and alerts; and a wall-clock watchdog
(`V6_MAX_RUNTIME_SEC`, 300 s default) aborts loudly rather than blocking the next scheduled run.

**Exit-code semantics:** `0` clear · `1` invariant violation (or a sibling monitor is down) ·
`2` the monitor could not complete. `2` is not "better" than `1` — it means we are blind.

---

## 5. Is the launchd job genuinely running?

Yes for mainnet, with caveats for testnet. Measured from the real log files.

```
launchctl list | grep specular
-  0  com.specular.v6-invariants
-  0  com.specular.v6-invariants-arc-mainnet
```

**arc-mainnet** (`v6-invariants-arc-mainnet.log`, 114 runs since 2026-09-19T15:37:06Z):

- last 24 h: **48 runs, expected 48**. Inter-run deltas: `30,30,30,…,30` — exactly on schedule.
- all-time gaps > 40 min: **1** (2026-09-19T15:49 → 16:29, a single missed run on deploy day).
- every run exit 0; 565 log lines, **all INFO — the monitor has never logged a WARN or ERROR**.
- run duration p50 **0.44 s**, max 1.74 s. Chain head advances 1,434–4,751 blocks per cycle, so
  `FRESH-STUCK` will not false-positive.

**arc-testnet** (`v6-invariants.log`, 2,209 runs since 2026-05-07):

- cadence is **31 min**, not 30: launchd schedules the next start from the previous process's
  **exit**, and this job takes ~41 s (p50). That already costs ~2 runs/day. A slow RPC costs far
  more — V6.0's 261 s run would push the cycle to ~35 min, and a 30-min run would halve coverage.
- last 7 days: 297 runs, **~28 silently missed**. Last 30 days: 902 runs, **~482 silently
  missed** (~35 %). Those gaps are exactly the crashes above: the crash happens before the first
  `log()` call, so a missed run leaves no trace at all — just a hole.
- 11,044 INFO lines, **1 ERROR** in 137 days.

**Log rotation: none existed.** No `newsyslog.d` entry, no `logrotate`, nothing in the monitor.
`v6-invariants.log` had grown to **1.49 MB / 11,045 lines over 137 days** (~11 KB/day); the
mainnet log is growing faster at **~31 KB/day** (≈11 MB/year) because it emits more per run.
V6.1 rotates in-process at `V6_LOG_MAX_BYTES` (5 MiB default, 5 generations) so the fix travels
with the script — verified: a 200 KB log with the cap set to 100 KB rotated to `.log.1` and the
run continued into a fresh file.

**Nothing was watching the watchers.** If a job stopped, the silence was indistinguishable from
"all clear". V6.1 stamps `heartbeat-<network>.json` on every run and every run checks the *other*
networks' heartbeats; a sibling stale by > 90 min raises `MONITOR_DOWN` (CRITICAL) and makes the
checking run exit 1. Verified (`scripts/op-resilience/verify-deadman.sh`): with a 4-hour-old
arc-mainnet heartbeat, the local run exits 1 and alerts. **Residual gap: nothing detects all
jobs being dead at once** — a sleeping or powered-off Mac silences everything. Weekly
`node forensics/monitor/alert.js --status` is the only backstop today.

---

## 6. Alerting — assessment and what was built

**Before:** a violation appended a JSON line to a log file and exited non-zero into launchd,
which discards exit status. `WEBHOOK_URL` existed but was unset. Net effect: **no channel
whatsoever.** A crash was worse than a violation — it produced no log line either. The system
had never once alerted, and could not have.

**Now** (`forensics/monitor/alert.js` + `run-with-alert.sh`), all free and local:

| Channel | What it is | Why |
|---|---|---|
| `forensics/monitor/ALERT-ACTIVE.json` | **latch** file; first alert kept, repeats counted | presence = unacknowledged incident; never auto-cleared |
| `~/SPECULAR-ALERT.txt` | plain text in the home directory | impossible to miss in a shell, survives reboot |
| macOS notification | `osascript` banner + `say` on CRITICAL | interrupts rather than informs |
| `forensics/monitor/alerts.log` | append-only JSONL | incident history |
| `SPECULAR_ALERT_WEBHOOK` | **opt-in** env var, Slack/Discord-shaped JSON | no URL is hardcoded or invented; unset = silent no-op. Put it in `forensics/monitor/monitor.env` (gitignored) |
| `heartbeat-<net>.json` | dead-man's switch (§5) | a monitor that stopped is itself an incident |

`run-with-alert.sh` is the new launchd entry point: it alerts on **any** non-zero exit, so a
crash that never reaches the monitor's own alerting still pages. It reads the heartbeat's
`alerted` flag to avoid double-paging when the monitor already fanned out.

**Verified end-to-end** (`scripts/op-resilience/verify-alert-path.js`) by pausing the local
marketplace for real and running the actual launchd entry point against it, with a throwaway
local HTTP server as the webhook target:

```
engineered violation: marketplace paused = true
wrapperExitCode        1
latchExists            true        findingCodes  ["PAUS"]
historyLines           1           alertsRaised  1     (no duplicate)
homeFlagExists         true
webhookDeliveries      1           body: "Specular CRITICAL: 1 critical / 1 warning ... on local"
heartbeatExists        true
latchClearedAfterAck   true        homeFlagClearedAfterAck  true
VERDICT: ALERT PATH VERIFIED END-TO-END
```

The macOS banner path was verified separately (`alert.js --self-test`, plus a direct `osascript`
call) and the latch cleared with `alert.js --ack`.

---

## 7. Pause blast radius

`pause()` is the primary emergency lever, so its cost was measured, not assumed: every operation
attempted from the correct caller, unpaused and paused
(`scripts/op-resilience/pause-blast-radius.js`, `pause-blast-radius.json`).

| Operation | Unpaused | Paused |
|---|---|---|
| lender: `withdrawLiquidity` | works | **BLOCKED** `EnforcedPause()` |
| lender: `claimInterest` | works | **BLOCKED** `EnforcedPause()` |
| lender: `supplyLiquidity` | works | **BLOCKED** `EnforcedPause()` |
| borrower: `repayLoan` | works | **BLOCKED** `EnforcedPause()` |
| borrower: `requestLoan` | works | **BLOCKED** `EnforcedPause()` |
| **owner: `liquidateLoan`** | works | **BLOCKED** `EnforcedPause()` |
| owner: `withdrawFees` | works | works |
| owner: `setPlatformFeeRate` | works | works |
| owner: `setMinSupplyAmount` | works | works |
| owner: `setMinHoldForReputationReward` | works | works |
| owner: `setBindBorrowToPoolCreator` | works | works |
| owner: `compactPoolLenders` | works | works |
| owner: `resetPoolAccounting` | works | works |
| owner: `transferOwnership` | works | works |
| registry: `register` a new agent | works | works |
| registry: agent NFT `transferFrom` | works | works |

**6 of 18 operations broken. The three that matter:**

1. **Lenders cannot exit.** Neither principal nor interest. Audit I-5, confirmed empirically.
   Pausing converts a suspected problem into a certain, visible freeze of other people's money.
2. **Borrowers cannot repay** — while V6.1's F-03 fix keeps charging interest on elapsed time up
   to `LATE_INTEREST_CAP` (30 days). A pause therefore *bills* borrowers who are willing to pay
   and cannot.
3. **`liquidateLoan` is disabled by the same flag.** The primary recovery action is switched off
   by the primary emergency lever. If you pause to contain a bad loan, you must `unpause()` to
   close it.

What pause does **not** stop: agent NFTs keep moving, agents keep registering, and every
risk-parameter lever plus `transferOwnership` still works. A pause does not freeze identity.

A quieter lever exists and is better in most cases: **V6.1 enforces `isActive` in
`createAgentPool`/`requestLoan`** (audit F-07 fixed), so `registry.deactivateAgent(agentId)` is a
genuine per-agent kill switch — it stops one bad actor without touching anyone else. Also note
`reputation.revokePool()` bricks `repayLoan`/`liquidateLoan` exactly like a pause but **without a
pause flag** to make it visible; treat it as equally destructive.

---

## 8. Prioritised operational gaps

### Needs your action

| # | Gap | Action | Why it is ranked here |
|---|---|---|---|
| **1** | **The monitor running on Arc mainnet today detects 3/19 failure modes and its §S5 check is a no-op.** | Port §9 into `~/Specular` and reload the plist. | Everything else in this report is downstream of this. |
| **2** | **Nobody is paged, and a crash is silent.** | Install `run-with-alert.sh` as the launchd entry point (new plist in §9). Optionally set `SPECULAR_ALERT_WEBHOOK` in `forensics/monitor/monitor.env`. | 15 real crashes already went unnoticed. |
| **3** | **Single owner EOA; no multisig, no timelock.** Every lever in the runbook is one key away, and `§3.2` of the runbook has no good branch if that key is lost. | Product/ops decision before third-party lender USDC arrives. | Not a monitoring problem — the monitor can only *tell* you it happened. |
| **4** | Arc-testnet/staging have no working RPC and have missed ~35 % of runs over 30 days. | Add a fallback endpoint (`ARC_TESTNET_RPC_URL`), or accept testnet blindness explicitly. | Testnet still holds ~849 test USDC of lender funds on the legacy V6.0 marketplace. |
| **5** | Nothing detects *all* monitor jobs being dead (sleeping/off Mac). | Weekly `alert.js --status`, or move one job off this machine. | Cross-heartbeats cover single-job death only. |
| **6** | `pause()` traps lender funds and disables `liquidateLoan`. | No code fix without a redeploy. Pre-write the lender communication now; prefer `deactivateAgent`. | Decide *before* an incident, not during. |
| **7** | Registry / Reputation / Faucet are one-step `Ownable` (audit I-1); `revokePool` bricks loan closing invisibly. | Accept and document, or redeploy with `Ownable2Step`. | Now documented in the runbook. |

### Fixed in this round (in the worktree)

| Gap | Fix | Proof |
|---|---|---|
| §S5 check was a silent no-op (wrong mapping key) | keyed by `agentId`; plus counter-vs-reality and `activeLoanIds` set equality | scenario c, `prove-s5-bug.js` |
| No solvency, pool-conservation, loan-accounting, ownership, pause or fee checks | 12 new check families | scenarios a2, d2, e, f1, f2, g, h |
| Zero coverage of V6.1 state | `PT`, `PT-TS`, `ALI`, `QUAL*`, `LATE*` | scenarios v1–v7 |
| Crash on RPC failure, no log, no alert | whole body in try/catch → `MONITOR-FAILED` + alert, exit 2 | §4 |
| No request timeout → unbounded run blocking the next cycle | `V6_RPC_TIMEOUT_MS` + `V6_MAX_RUNTIME_SEC` watchdog | 261 s → 40 s |
| False OK on stale / frozen RPC | `FRESH`, `FRESH-STUCK`, `FRESH-REORG` + persisted run-to-run state | §4 |
| Log grows unbounded, no rotation anywhere | in-process rotation, 5 MiB × 5 | verified |
| No alerting at all | latch + home flag + macOS banner + history + opt-in webhook + dead-man's switch | §6 |
| No runbook | `forensics/monitor/INCIDENT_RUNBOOK.md` | §9 |
| Monitor had no regression suite | `run-detection-matrix.js` — 19 scenarios, re-runnable | this report |

**Validated against production, read-only:** the rewritten monitor runs clean on **live Arc
mainnet** (block 22,088,961 → 22,089,267, exit 0, all 12 check families OK, 0 warnings) and on
the healthy local control. It is not noisy.

Live Arc-mainnet state at the time of writing (`arc-mainnet-levers.json`): V6.1 at
`0x358c5E69…B282`, owner = secure wallet, `pendingOwner` = 0, **unpaused**,
`migrationFinalized = true` (F-08 closed), fee 100 bps, `minSupplyAmount` 10 USDC, D1 rate limit
5 pts/day, 1 pool, 0 active loans, 1 agent, balance 0.000014 USDC. **There is essentially nothing
at risk today — which is exactly why this is the moment to fix the monitoring.**

---

## 9. Porting instructions and artifacts

All work is in the worktree `.claude/worktrees/agent-a16d2471b142c1479` (branch
`worktree-agent-a16d2471b142c1479`, fast-forwarded to `arc-mainnet-launch` @ `5fe56c4`). The
harness is sandboxed there. The two **deliverables** have been copied into the main repo at the
requested paths — `~/Specular/forensics/output/testing-2026-09-20/OPERATIONAL_RESILIENCE_REPORT.md`
and `~/Specular/forensics/monitor/INCIDENT_RUNBOOK.md`, alongside the JSON/patch artifacts.
**The code changes are NOT ported** — they live only in the worktree; apply the patch below.

**Full patch:** `forensics/output/testing-2026-09-20/operational-resilience.patch`
(2,895 lines, covers `forensics/monitor/`, `.gitignore`, `scripts/op-resilience/`).

```bash
cd ~/Specular
git apply .claude/worktrees/agent-a16d2471b142c1479/forensics/output/testing-2026-09-20/operational-resilience.patch
# or cherry-pick: git diff main..worktree-agent-a16d2471b142c1479 -- forensics/monitor scripts/op-resilience .gitignore
```

### Files

| File | Status | Note |
|---|---|---|
| `forensics/monitor/v6-invariants.js` | **modified** (+583 / −146) | the rewrite; the one file that must ship |
| `forensics/monitor/alert.js` | **new** | alert fan-out + heartbeat + `--ack` / `--status` / `--self-test` |
| `forensics/monitor/run-with-alert.sh` | **new** | launchd entry point; alerts on any non-zero exit |
| `forensics/monitor/com.specular.v6-invariants-arc-mainnet.plist` | **new** | replacement plist (wrapper, `RunAtLoad`, pinned `V6_EXPECTED_OWNER`) |
| `forensics/monitor/INCIDENT_RUNBOOK.md` | **new** | already copied to `~/Specular/forensics/monitor/` |
| `.gitignore` | modified | monitor runtime artifacts + `monitor.env` (webhook URL never committed) |
| `scripts/op-resilience/*` | **new** | the harness: `deploy-local.js`, `storage.js`, `verify-slots.js`, `scenarios.js`, `run-detection-matrix.js`, `fault-rpc.js`, `run-rpc-failure-tests.sh`, `time-slow-rpc.sh`, `verify-deadman.sh`, `verify-alert-path.js`, `pause-blast-radius.js`, `prove-s5-bug.js`, `read-mainnet-levers.js`, `v6-invariants-V60-baseline.js` (frozen V6.0 copy, test artifact) |

### Deploy

```bash
cd ~/Specular
cp forensics/monitor/com.specular.v6-invariants-arc-mainnet.plist ~/Library/LaunchAgents/
launchctl unload ~/Library/LaunchAgents/com.specular.v6-invariants-arc-mainnet.plist
launchctl load   ~/Library/LaunchAgents/com.specular.v6-invariants-arc-mainnet.plist
# optional, for the opt-in webhook (gitignored):
printf 'export SPECULAR_ALERT_WEBHOOK="<your url>"\n' > forensics/monitor/monitor.env
node forensics/monitor/alert.js --self-test   # confirm the channels
node forensics/monitor/alert.js --status
```

Do the same for the arc-testnet job by copying the plist, changing the `Label` and the
`arc-mainnet` argument to `arc-testnet`, and dropping `V6_EXPECTED_OWNER` (or setting the
testnet owner).

### Re-running the suite

```bash
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
npx hardhat node &                                                   # terminal 1
npx hardhat run --network localhost scripts/op-resilience/deploy-local.js
npx hardhat run --network localhost scripts/op-resilience/run-detection-matrix.js
npx hardhat run --network localhost scripts/op-resilience/pause-blast-radius.js
npx hardhat run --network localhost scripts/op-resilience/verify-alert-path.js
bash scripts/op-resilience/run-rpc-failure-tests.sh
bash scripts/op-resilience/verify-deadman.sh
```

Treat `run-detection-matrix.js` as the monitor's regression suite: any future change to
`v6-invariants.js` should keep it at 19/19 with 0 false positives, and any newly imagined failure
mode should be added to `scenarios.js` first.

### Data files in `forensics/output/testing-2026-09-20/`

`detection-matrix.json` · `rpc-failure-matrix.txt` · `pause-blast-radius.json` ·
`alert-e2e-result.json` · `arc-mainnet-levers.json` · `operational-resilience.patch`
