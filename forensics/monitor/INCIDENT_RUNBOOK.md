# Specular Invariant Monitor — Incident Runbook

**Scope:** what a human does when `com.specular.v6-invariants-*` fires.
**Applies to:** **AgentLiquidityMarketplace V6.2 + ReputationManagerV4** (the V7 credit model),
AgentRegistryV2 and AgentCreditFaucet — the stack live on Arc mainnet.
**Owner:** the holder of the secure wallet `0x800e305A0caDdE6289dFDFEDF38218f45C06F72C`.
**Written:** 2026-09-20 · **Rewritten 2026-09-23** after the first end-to-end incident drill
against V6.2 + V4 · **Re-verified and corrected 2026-09-24** (operational verification round:
every lever below re-probed on the live contracts, every drill re-executed, every path in this
file walked). Every number, revert string and lever effect below was **executed**, not
assumed. Evidence and method: `forensics/output/testing-2026-09-23/INCIDENT_DRILL_REPORT.md`
and `forensics/output/testing-2026-09-24/OPERATIONAL_VERIFICATION.md`.

> ## Read this first
>
> **1. `pause()` freezes lender exits, borrower repayments AND your own `liquidateLoan`.**
> Measured on V6.2: **9 of 35 operations blocked** (§5). It is not a "make it safe" button, it is
> a "stop the world, including the recovery tools" button. `registry.deactivateAgent(agentId)`
> breaks **1** operation and is reversible — reach for that instead (§5).
>
> **2. Nothing pages you about an overdue loan.** The monitor has no overdue-ACTIVE-loan check.
> A borrower a full day past `endTime` produces `exit 0, no findings`. **Liquidation is a polling
> job, not an alert-driven one.** It IS polled: launchd `com.specular.overdue-loans-arc-mainnet`
> runs `forensics/monitor/check-overdue-loans.js` hourly. Run it by hand whenever you want the
> current picture (§7).
>
> **3. The monitor watches the MARKETPLACE owner and nothing else.** Registry, reputation-manager
> and faucet ownership can change — including a permanent `renounceOwnership` that destroys
> `deactivateAgent` for ever — and the monitor stays green (§4, §6).
>
> **4. Every alert channel is LOCAL to this Mac.** `SPECULAR_ALERT_WEBHOOK` is not set and
> `forensics/monitor/monitor.env` does not exist, so an alert is a latch file, a file in `$HOME`,
> a banner and a spoken line — all of which require somebody to be at this machine. If you want
> to be told while you are away, set the webhook (`WEBHOOK_SETUP.md`). Verified 2026-09-24 by
> forcing a real failure end to end.

---

## 0. TL;DR triage card

| You see | First move | Then |
|---|---|---|
| `SOLV` / `S1` / `POOL` (money doesn't add up) | **Do not pause. Do not run `resetPoolAccounting` yet.** Snapshot (§2.1), confirm on a second RPC. **Establish whether the USDC is missing or only the books are wrong** — the monitor cannot tell you. | §3.1 |
| `OWN` / `OWN-PENDING` / `PAUS` (control plane moved) | **Assume key compromise.** Seconds matter. | §3.2 |
| `CP-CHANGED` (WARN — credit policy drifted) | If you did not make that change, treat it as §3.2. It is the **only** signal a hostile key reliably produces — and it was **structurally dead on Arc mainnet** until 2026-09-24; see the box below §3.2. | §3.2 |
| `B1` / `S5-*` / `ALI` / `PT` / `QUAL-*` / `LATE-*` | Snapshot, stop new inflow, no pause. | §3.3 |
| `SS-UNLOCKED` / `SS-MISMATCH` / `SS-ORPHAN` (V6.2 self-stake) | The M2 first-loss tranche is not holding. Stop new borrowing on that agent. | §3.4 |
| `FRESH` / `FRESH-STUCK` / `MONITOR-FAILED` / `[WATCHDOG]` / `MONITOR-DOWN` | You are **blind**, not necessarily broken. | §3.5 |
| `NFT-MOVED` (WARN) | Informational credit event — but it latches every cycle until the loan closes. | §3.6 |
| `SOLV-SURPLUS` / `POOL-SLACK` (WARN) | Usually a donation or rounding. | §3.7 |
| nothing, but a loan is overdue | The monitor will never tell you. | §7 |

---

## 1. How an alert reaches you

Every 30 minutes `launchd` runs `forensics/monitor/run-with-alert.sh <network>`, which runs
`v6-invariants.js` and fans **any** non-zero exit out to:

1. `forensics/monitor/ALERT-ACTIVE.json` — a **latch**. Its existence means "unacknowledged
   incident". Never cleared automatically.
2. `~/SPECULAR-ALERT.txt` — plain text in your home directory.
3. A macOS notification banner (plus a spoken alert for CRITICAL).
4. `forensics/monitor/alerts.log` — append-only JSONL history.
5. `SPECULAR_ALERT_WEBHOOK` — **only if you set it** in `forensics/monitor/monitor.env`
   (gitignored). Nothing is hardcoded. **Checked 2026-09-24: not set** — channels 1–4 are all
   there is, and all four need you to be at this Mac.

The **overdue-loan** job (`run-overdue-check.sh`, hourly) alerts through the same `alert.js`,
CRITICAL, with the full report — loan ids, principal, collateral, unsecured amount, days
overdue — in the alert details.

```bash
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
node forensics/monitor/alert.js --status     # latch + per-network heartbeats
node forensics/monitor/alert.js --self-test  # prove the channels still work
node forensics/monitor/alert.js --ack        # clear the latch AFTER you have handled it
```

**Exit codes:** `0` clear · `1` invariant violation (or a sibling monitor is down) ·
`2` the monitor could not complete — RPC dead/slow/stale, config broken. **Treat 2 as seriously
as 1**: it means the deployment is unmonitored, not that it is fine.

**Verified 2026-09-23:** the wrapper fans out correctly on a dead RPC (`exit 2`, latch raised)
even when the monitor never got far enough to alert on its own.

---

## 2. Triage — do these before deciding anything

### 2.1 Snapshot the truth

```bash
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
cd ~/Specular

# full, verbose, un-quieted run against mainnet
V6_MONITOR_NETWORK=arc-mainnet V6_EXPECTED_OWNER=0x800e305A0caDdE6289dFDFEDF38218f45C06F72C \
  node forensics/monitor/v6-invariants.js --verbose --no-alert | tee /tmp/incident-$(date +%s).json

# EVERY owner lever on V6.2 + V4 + registry + faucet, read-only
node scripts/incident-drill/read-live-levers.js

# Prove the levers this runbook names STILL EXIST, with these signatures, on the deployed
# bytecode — and that each is owner-gated. eth_call only; sends nothing, needs no key.
# Exit 0 = every lever present and gated. Last run 2026-09-24: 52/52.
node scripts/incident-drill/verify-runbook-levers.js
```

> `read-live-levers.js` and `verify-runbook-levers.js` are committed under
> `scripts/incident-drill/` — no patch to apply.
> **Do not rely on the older `scripts/op-resilience/read-mainnet-levers.js`** — it loads the
> ReputationManagerV3 ABI against the V4 address and the V6.1 ABI against V6.2, so it silently
> omits the tier table, the ladder parameters, the default lockout, the late-penalty parameters,
> V4's `pendingOwner` and the M2 self-stake views. It will not lie to you, but it will leave out
> most of what a V7 incident turns on.

### 2.2 Rule out the monitor before you believe the alert

A false alarm from a bad RPC is more likely than a broken contract. Re-run against a **different**
endpoint:

```bash
ARC_MAINNET_RPC_URL=<second endpoint> V6_MONITOR_NETWORK=arc-mainnet \
  node forensics/monitor/v6-invariants.js --no-alert
```

Two independent endpoints agreeing is the bar for acting. One disagreeing with the other is itself
the finding (§3.5).

### 2.3 Size the exposure before choosing a lever

From the snapshot: `usdcBalance`, `sumAvail`, `sumActiveCollateral`, ACTIVE loans, distinct
lenders, and **`selfStake` per pool**. **If third-party lender principal is zero, almost nothing
is urgent** — take the slow, reversible path.

Live figures, read on-chain 2026-09-23 (block 22 287 733) and **re-read unchanged 2026-09-24
(block 22 416 766)**, canonical V6.2 `0xCb23f2fb03Bfd4775Cc0e76E28f64c1e545071be`:

| | |
|---|---|
| `VERSION` / reputation `VERSION` | `V6.2` / `V4` (`0x12953e73…`) |
| owner / pendingOwner / paused | secure wallet / `0x0` / false |
| `migrationFinalized` | **true** — `seedPool`/`seedPosition` are dead (F-08 closed) |
| totalPools / nextLoanId / totalAgents | 1 / 2 / 1 |
| `accumulatedFees` | 0.000014 USDC |
| faucet balance / claimAmount / cohort | 19 USDC / 1 USDC / agentIds ≤ 100 |
| levers | fee 100 bps · minSupply 10 USDC · minHold 86 400 s · M-1 **on** · rate-limit 5 pts/day |
| ladder | k = 2 · growthStep 100 USDC · bootstrap 100 USDC · lockout 180 d · `MAX_TIER_LIMIT` 10 000 USDC (immutable) |

**There is essentially nothing at risk on mainnet today and no reason to pause anything.**

### 2.4 Two facts that change how you read the numbers

1. **The marketplace is ONE USDC pot shared by every pool.** A shortfall in one pool is paid out
   of every other pool's liquidity. Per-pool conservation (`POOL`) can read perfect while the
   contract is globally insolvent — always check `SOLV` too.
2. **Loss socialisation only runs inside `liquidateLoan`, on one specific defaulted loan.** A bare
   shortfall is *not* shared: it is first-come-first-served, and whoever withdraws last eats all
   of it.

---

## 3. Playbooks by finding

### 3.1 Money doesn't add up — `SOLV`, `S1`, `POOL`, `FEE`, `LOAN-TOTAL`, `LOAN-OUTSTANDING`

**These codes cover two opposite incidents and the monitor cannot distinguish them.** Establish
which one you are in *before* touching any lever:

```
Σ lender claims (principal + unclaimed interest, all pools)   vs   USDC balanceOf(marketplace)
```

| | **Case A — phantom liquidity** | **Case B — real shortfall** |
|---|---|---|
| what is wrong | the books over-state liquidity; the USDC is all there | the books are right; the USDC has left |
| monitor codes | `S1` + `SOLV` CRITICAL | `S1` + `SOLV` CRITICAL — **identical** |
| how to tell | balance ≥ Σ claims + fees + active collateral | balance < Σ claims |
| **the fix** | `resetPoolAccounting(agentId)` — **works, exactly** | **no on-chain fix exists** |

**Case A — recovery is complete.** `resetPoolAccounting(agentId)` rebuilds `totalLoaned` from the
bounded active set and `availableLiquidity` from Σ positions + Σ unclaimed interest − totalLoaned.
Drilled 2026-09-23: a 500 USDC inflation was restored to the exact pre-incident figure, the next
monitor run was clean, and lenders could still withdraw. Lenders lose nothing.

**Case B — say so out loud: you cannot make lenders whole with a lever.** Drilled, every candidate
executed:

| Lever | What it actually does |
|---|---|
| `resetPoolAccounting` | **Makes it worse.** It rebuilds the books from the lender *positions* — i.e. from the claims — so it re-asserts liquidity the contract does not hold. This is audit finding I-2, reproduced. |
| do nothing | First-come-first-served. The early lender is paid in full; the late one reverts `ERC20InsufficientBalance`. The loss lands entirely on whoever is slowest. |
| `pause()` | Converts the race into a total freeze — exits, repayments and your own `liquidateLoan` all stop (§5). Recovers nothing. Note the owner can **still `withdrawFees`** out of a pool that cannot pay its lenders; don't. |
| **`setMinSupplyAmount(100e6)` + `registry.deactivateAgent(agentId)`** | **The correct first move.** New lenders blocked (`Below minimum supply`), new borrowing blocked (`Agent deactivated`), while **existing lenders still exit and the borrower still repays**. Stops the bleeding without freezing anyone. Recovers nothing. |
| **send USDC to the marketplace address from treasury** | **The only repair.** A plain ERC-20 transfer; no contract function involved. The monitor goes clean and lenders are whole. |

Order of operations for Case B: contain (`setMinSupplyAmount` + `deactivateAgent`) → publish →
decide whether treasury covers the hole → only then consider pausing, and only if you have
accepted that you cannot liquidate your way out.

**3.1a Closing a bad loan on V6.2.** `liquidateLoan(loanId)` is owner-only, requires `ACTIVE` +
`block.timestamp > endTime` + **UNPAUSED**, and costs ~198 k gas. The waterfall is **not** flat
pro-rata — this is the biggest single change from V6.1:

1. **Collateral is seized** into `availableLiquidity`.
2. **[M2-b] The pool creator's own position absorbs the remaining loss FIRST, in full**, before any
   other lender is touched. It is guaranteed to still be there because M2-a locks it while the
   agent owes principal. Emits `SelfStakeAbsorbedLoss`.
3. **[L7] Whatever the self-stake cannot cover** is socialised pro-rata across the principal that
   was **qualified for THAT loan at its `startTime`** — a lender who supplied mid-loan bears
   **nothing**. Any residual then falls on the remaining principal, then (F-05) on unclaimed
   interest.
4. **Reputation:** penalty = `max(defaultPenaltyBase, defaultPenaltyLarge × amount / largeLoanThreshold)`,
   i.e. at live levers `max(50, 100 × amount / 1 000 USDC)`, capped at 1 000. Plus
   **`maxRepaidPrincipal → 0`** and a **180-day credit lockout** (`calculateCreditLimit` returns
   exactly 0). Recorded against the **current NFT holder's agentId**.

Measured on a real 2 400 USDC default at the 0 %-collateral tier: creator's 1 200 self-stake wiped
100 %, the two qualified lenders lost 80 % each, the mid-loan lender lost 0, score 615 → 375
(−240), ladder reset, lockout engaged, per-pool conservation exact to the base unit, and every
survivor could still withdraw or claim.

### 3.2 Control plane moved — `OWN`, `OWN-PENDING`, `PAUS`, `CP-CHANGED`

> **⚠️ `CP-CHANGED` was dead on Arc mainnet from the V7 migration until 2026-09-24. Know why,
> because the same shape will come back the next time a stack is superseded.**
>
> Two launchd jobs watch Arc mainnet — the canonical V6.2 stack and the superseded V6.1 one —
> and both used `V6_MONITOR_NETWORK=arc-mainnet`, so both wrote
> `forensics/monitor/state-arc-mainnet.json`. The legacy marketplace points at
> ReputationManagerV**3**, which has no on-chain tier table, so its run recorded
> `creditPolicy: null`. It ran ~30 s before the canonical job on **every** cycle (confirmed in
> the log: 19:36:37/19:37:05, 20:06:39/20:07:09, …), so the canonical run always found a null
> previous policy and skipped the comparison entirely. The one signal a hostile owner key
> reliably produces could never fire. Proven by re-running the two jobs in that order and
> watching the WARN disappear.
>
> **Fixed:** setting `V6_MONITOR_MARKETPLACE` now gives a run its own instance namespace
> (`state-<net>-<addr8>.json`, its own log, its own heartbeat), so the two jobs cannot
> overwrite each other, and `alert.js --status` shows a heartbeat per job instead of one for
> both. Re-verified: with the fix, the tampered baseline survives the legacy run and
> `CP-CHANGED` fires.
>
> **Whenever you add a monitor for a superseded stack, check afterwards that
> `alert.js --status` gained a heartbeat and that `state-*.json` gained a file.** If it did
> not, the new job is silently cannibalising the old one's memory.

The only scenario measured in seconds. If the owner is not the secure wallet, a `pendingOwner` you
did not set exists, the contract is paused and you did not pause it, **or the credit policy changed
and you did not change it**:

1. **Assume the key is compromised.**
2. **If you still control the key — rotate all FOUR owners now.** Six transactions, drilled:

```bash
# marketplace and reputation manager are Ownable2Step — BOTH steps required
marketplace.transferOwnership(<fresh cold wallet>)  ;  marketplace.acceptOwnership()   # from cold
reputation.transferOwnership(<fresh cold wallet>)   ;  reputation.acceptOwnership()    # from cold
# registry and faucet are plain Ownable — ONE STEP, instant, NO undo. Check the address twice.
registry.transferOwnership(<fresh cold wallet>)
faucet.transferOwnership(<fresh cold wallet>)
```

   Verified: after all six, the old key can no longer `pause()`, `authorizePool` or
   `deactivateAgent`. `renounceOwnership` is disabled on the marketplace and on
   ReputationManagerV4 (both revert), so neither can be orphaned.

3. **If you do not control it any more, there is no containment.** No timelock, no multisig, no
   guardian. `pause()` is itself owner-only. Publish a disclosure, tell every lender to
   `withdrawLiquidity` **while the contract is still unpaused**, and treat the deployment as lost.
4. **Check all four owners by hand** (§2.1). The monitor reads the **marketplace owner only** —
   registry, reputation-manager and faucet ownership changes are invisible to it (§6 gap 2).

**What a hostile key can do, measured.** 34 owner calls enumerated and executed; 29 succeeded,
6 were visible to the monitor, **23 were invisible**. The four worst:

| Call | Effect | Monitor |
|---|---|---|
| `reputation.authorizePool(any address)` | Unbounded. Any EOA gains the right to call `recordBorrow`/`recordLoanCompletion`/`recordDefault` — i.e. to write reputation and credit capacity for any agent, directly. | **nothing** |
| `reputation.revokePool(the live marketplace)` | One transaction, protocol-wide brick: `repayLoan` **and** `liquidateLoan` both revert `Only authorized pools`. Loans can never close; **no pause flag to show for it**. | **nothing** |
| `reputation.setValidationRegistry(hostile address)` | `creditLimitOf` calls into it, so `requestLoan` reverts for every agent. | **nothing** |
| `registry.renounceOwnership()` | **Permanent.** Owner becomes `0x0`; `deactivateAgent` — the kill switch this runbook recommends — is gone for ever. Same for the faucet. | **nothing** |

Also silent and damaging: `setBindBorrowToPoolCreator(false)` turns M-1 off, letting a bought or
stolen agent NFT borrow against the **seller's** locked self-stake and the pool's lenders.

**The full chain, executed:** authorize a hostile EOA → disable the rate limit → zero the default
penalty → zero the lockout → raise every tier to the ceiling → `setLadderParameters(k=10, …)` →
14 forged `recordBorrow`/`recordLoanCompletion` pairs. 35 transactions. Result: an agent at score
800, credit limit 10 000 USDC, 0 % collateral, self-stake requirement only 500 USDC — which then
drew **5 561 USDC** (including a third party's 5 000) for **561 USDC** of its own capital.
**The monitor's entire reaction: one `CP-CHANGED(WARN)`, up to 30 minutes later.**

**What the key provably CANNOT do** (16 probes, all blocked):

- raise any tier limit above the **immutable `MAX_TIER_LIMIT` = 10 000 USDC** (`Tier limit exceeds ceiling`)
- set `creditMultiple` > 10, `growthStep` > `MAX_TIER_LIMIT`, fee > 5 %, `minSupplyAmount` > 100 USDC, lockout > 2 years
- **re-open migration, or mint pool liquidity / a lender position** — `seedPool` and `seedPosition`
  both revert `Migration finalized`. **F-08 is verified closed on mainnet.**
- withdraw more than `accumulatedFees`
- renounce marketplace or reputation-manager ownership
- liquidate a loan that is not overdue, or liquidate while paused
- move an agent NFT it does not hold
- set a reputation score directly — no such function exists on V4

So the ceiling is real: a hostile key cannot mint balances and cannot push unsecured exposure past
10 000 USDC per agent. Within that ceiling it can manufacture exposure for an agent it controls,
and it can brick the protocol in one transaction. **This is the largest structural risk in the
deployment and no lever fixes it — only a multisig or timelock would.**

### 3.3 State corruption — `B1`, `S5-COUNTER`, `S5-CAP`, `ALI`, `ALI-LEN`, `PT`, `PT-TS`, `QUAL-REVERT`, `LATE-*`

V6.2's code cannot produce these, so one appearing means either a monitor bug (check
`scripts/op-resilience/storage.js` still matches the deployed layout) or something genuinely
novel. Nothing here is fixable with a lever except:

- `B1` duplicate lenders → `compactPoolLenders(agentId)` dedups in place, **works while paused**,
  bounded to 50 iterations. Safe.
- `QUAL-REVERT` is the serious one: `qualifiedAmountAt` reverting means `_distributeInterest`
  reverts too, so **every repayment on that pool is bricked**. No lever; needs a redeploy.
- `S5-CAP` / `ALI` corruption means the concurrency limit is not being enforced → stop new
  borrowing with `registry.deactivateAgent(agentId)` (§5).

### 3.4 Self-stake findings — `SS-UNLOCKED`, `SS-MISMATCH`, `SS-ORPHAN`, `SS-SHORT` (V6.2 only)

The M2 self-stake is the whole basis of the V7 fix for F-04. If the lock stops holding, the
attacker can withdraw its seed before drawing the pool down and the economics revert to the
pre-V7 state.

| Code | Meaning | Action |
|---|---|---|
| `SS-UNLOCKED` CRITICAL | `selfStake.locked` is false while the agent owes principal — the first-loss tranche can be withdrawn | `registry.deactivateAgent(agentId)` immediately, then investigate. Do not pause. |
| `SS-MISMATCH` / `SS-ORPHAN` CRITICAL | `selfStake()` disagrees with the creator's actual `poolLenders` position | State corruption — treat as §3.3 |
| `SS-SHORT` WARN | the stake is below the *current* requirement for the outstanding principal | Usually benign: the requirement is tier-derived and an owner tier change moves it under a live loan. Confirm you made that change. |

Expected healthy behaviour, verified: the creator's own `withdrawLiquidity` reverts
`Self-stake locked while borrowing` for as long as `outstandingPrincipal > 0`, **regardless of
pause state**.

### 3.5 You are blind — `FRESH`, `FRESH-STUCK`, `FRESH-REORG`, `MONITOR-FAILED`, `MONITOR-DOWN`, `[WATCHDOG]`

All drilled 2026-09-23 against a fault-injecting proxy. **No false OKs** — every blind mode exits
non-zero and latches an alert.

| Code | Meaning | Measured | Action |
|---|---|---|---|
| `MONITOR-FAILED` | RPC dead, erroring, or slower than `V6_RPC_TIMEOUT_MS` | exit **2**, CRITICAL, latched | Try a second endpoint. If both fail, the chain or your network is down — re-run manually every few minutes. |
| `[WATCHDOG]` | Run exceeded `V6_MAX_RUNTIME_SEC` | exit **2**, CRITICAL, latched | The endpoint is degraded. A run that outlives the interval also *delays the next one* — launchd schedules from the previous process's exit. |
| `FRESH` | Chain head older than `V6_MAX_BLOCK_AGE_SEC` (1800 s) | exit **1**, CRITICAL, latched | Endpoint is serving stale data, or the chain stalled. Compare height against the explorer. |
| `FRESH-STUCK` | Head identical to the previous run | exit **1**, **WARN**, latched | **The most dangerous mode and the quietest one.** Every state read still succeeds and looks self-consistent. **It only fires on the SECOND run** — the first run after an endpoint freezes reports a clean OK, so you are confidently wrong for up to 30 minutes. Switch endpoints. Arc mainnet advances 1 400–4 800 blocks per cycle, so this never fires on a healthy chain. |
| `FRESH-REORG` | Head went backwards | — | Reorg, or the RPC is answering for a different chain. Verify `chainId == 5042`. |
| `MONITOR-DOWN` | A *sibling* job has not stamped a heartbeat in 90 min | exit 1 | `launchctl list \| grep specular`; reload the plist. |

**Nothing detects all jobs being dead at once.** The jobs cross-check each other, but a sleeping or
powered-off Mac silences everything. Do a weekly manual `node forensics/monitor/alert.js --status`
and confirm there is a **fresh heartbeat per invariant job** — as of 2026-09-24 that is
`arc-mainnet`, `arc-mainnet-358c5e69` (the superseded V6.1 marketplace) and `arc-staging`
(§6 gap 1). Two jobs that are **not** covered by the dead-man's switch at all, because they
stamp no heartbeat: `com.specular.overdue-loans-arc-mainnet` and
`com.specular.rpc-health-sample`. Check those with `launchctl list | grep specular` and by
confirming `overdue-arc-mainnet.log` and `rpc-health.jsonl` have recent lines.

**If you retire a job, delete its heartbeat file.** A leftover `heartbeat-<instance>.json`
makes every surviving monitor raise `MONITOR_DOWN` twice an hour, for ever, about a job you
removed on purpose. That happened to `heartbeat-arc-testnet.json` after the arc-testnet job
was unloaded; it has since been deleted and the storm is gone (confirmed 2026-09-24).

### 3.6 `NFT-MOVED` (WARN)

An agent NFT is held by an address that is not the borrower of its ACTIVE loan. Drilled in full.

**Not a frozen loan.** The loan stays closeable:

| Actor | `repayLoan` |
|---|---|
| original borrower (the seller) | **works** |
| current NFT holder (the buyer) | **works** |
| anyone else | `Not the borrower` |

Owner `liquidateLoan` also still works after the transfer.

**But four things move that people get wrong:**

1. **Collateral goes to `loan.borrower` — the seller — even when the buyer repays.** Measured: the
   buyer paid 100.29 USDC and the *seller* received the 100 USDC collateral. A buyer must settle
   the open loan with the seller off-chain before closing it.
2. **A default lands on the BUYER.** Reputation and `recordDefault` key off `agentId`, so if that
   loan is liquidated the buyer takes the penalty, the capacity reset and the 180-day lockout for
   a loan the seller took out.
3. **The seller is fully de-registered** — the registry deletes `addressToAgentId[seller]`, so the
   seller cannot open new loans and `isAgentActive(seller)` is false. Its lender position and any
   locked self-stake stay behind, keyed to its address.
4. **With M-1 ON the buyer cannot borrow** (`Borrow restricted to pool creator`) — verified. **Keep
   `bindBorrowToPoolCreator` true.** With it off, the buyer could borrow against the seller's
   locked self-stake.

**Alert hygiene:** this WARN makes the monitor exit non-zero and re-latch `ALERT-ACTIVE.json`
**every 30 minutes for the life of the loan**. A legitimate agent sale therefore looks exactly like
an unacknowledged emergency. Note who moved what, `--ack` the latch, and watch that loan to
maturity.

### 3.7 `SOLV-SURPLUS` / `POOL-SLACK` (WARN)

More USDC in the contract than accounted for. On Arc, USDC is the native token, so a forced native
transfer lands as an unexplained surplus (audit I-3). Not a loss. Confirm the delta is static; if
it grows monotonically in step with activity, it is an accounting bug — escalate to §3.1.

---

## 4. Owner levers — what each one actually does

All values read on-chain 2026-09-23 (block 22 287 733); all effects executed locally the same day.
**Unless noted, the monitor does NOT alert on a change to these.**

### 4.1 Marketplace V6.2

| Lever | Current | Effect | Side effects / cost | Monitored |
|---|---|---|---|---|
| **`pause()`** | unpaused | Blocks **9 of 35** measured operations | **Freezes lender `withdrawLiquidity` and `claimInterest`, borrower `repayLoan` and `requestLoan`, `supplyLiquidity`, `createAgentPool` — and your own `liquidateLoan`.** Interest keeps accruing up to `LATE_INTEREST_CAP` (30 d) while borrowers cannot pay. Reversible. **Full table §5.** | `PAUS` CRITICAL |
| `unpause()` | — | Restores everything | none | `PAUS` |
| `setPlatformFeeRate(bps)` | 100 (1 %) | Protocol cut of interest | Capped at 500. **Retroactive** — computed at repay, so live loans pay the new rate (audit I-4). | **no** |
| `setMinSupplyAmount(wei6)` | 10 USDC | Minimum for a **new** lender slot | Capped at 100 USDC. Does not gate top-ups. **On V6.2 it is also a maintained floor: a PARTIAL withdrawal may not leave a position in `(0, minSupplyAmount)`** — a full exit is always allowed. **The pool creator is exempt on both sides** (M2). Raising it mid-incident changes what existing lenders may withdraw. | **no** |
| `setMinHoldForReputationReward(sec)` | 86 400 | Minimum loan life before an on-time repay earns points | Capped at `MIN_LOAN_DURATION` (7 d). 0 disables. | **no** |
| **`setBindBorrowToPoolCreator(bool)`** | **true** | Only the pool's creator may borrow from it | **Keep it true.** Turning it off lets a transferred agent NFT borrow against the seller's locked self-stake and the pool's lenders. One boolean, invisible to the monitor. | **no** |
| `liquidateLoan(loanId)` | — | Default an overdue loan | Owner-only, `ACTIVE` + past `endTime` + **not paused**. ~198 k gas. Waterfall in §3.1a. Irreversible. | n/a |
| `withdrawFees(amount)` | 0.000014 USDC | Move protocol fees out | Bounded by `accumulatedFees`. **Works while paused** — including out of a pool that cannot pay its lenders. | **no** |
| `compactPoolLenders(agentId)` | — | Dedup `poolLenders[]` | Safe, bounded, works while paused. | **no** |
| `resetPoolAccounting(agentId)` | — | Rebuild `totalLoaned`/`totalLiquidity`/`availableLiquidity` | **Correct fix for Case A, harmful in Case B — read §3.1 first.** Now O(1) in loan history (D7) and works on a transferred agent. | **no** |
| `seedPool` / `seedPosition` / `setMigrationFinalized` | **dead** | — | `migrationFinalized == true`. All three revert `Migration finalized`. **F-08 verified closed.** | n/a |
| `transferOwnership` / `acceptOwnership` | owner = secure wallet | Two-step handover | `renounceOwnership` reverts by design. | `OWN`, `OWN-PENDING` CRITICAL |

### 4.2 ReputationManagerV4 — the V7 credit policy

`Ownable2Step`; `renounceOwnership` reverts. Every limit below is bounded by the **immutable
`MAX_TIER_LIMIT` = 10 000 USDC**.

| Lever | Current | Effect | Monitored |
|---|---|---|---|
| `setTierLimits(uint256[6])` | 1000/5000/10000/10000/2500/5000 USDC | Per-tier credit limit. Each entry must be >0 and ≤ `MAX_TIER_LIMIT`. | `CP-CHANGED` **WARN** |
| `setLadderParameters(k, growthStep, bootstrapLimit, refDuration)` | 2 / 100 / 100 USDC / 7 d | `creditLimit = min(tierLimit, max(bootstrap, k·maxRepaidPrincipal + growthStep))`. **k is also the M2-c self-stake divisor — raising k both accelerates the ladder and shrinks the required first-loss stake.** k ≤ 10, `growthStep > 0` (k=1 with step 0 deadlocks the ladder). | `CP-CHANGED` **WARN** |
| `setDefaultLockout(sec)` | 15 552 000 (180 d) | Post-default credit freeze. ≤ 730 d. 0 removes it. | `CP-CHANGED` **WARN** |
| `setReputationRateLimit(max, window)` | 5 pts / 86 400 s | The D1/F-04 farming brake. **Measured: 5/day ⇒ exactly 100 on-time loan cycles from score 100 to the 0 %-collateral tier.** `max = 0` disables it entirely. | **no** |
| `setScoringParameters(bonus, penaltyBase, penaltyLarge, largeThreshold)` | 10 / 50 / 100 / 1 000 USDC | Bonus and default penalties. Bounds: bonus ≤ 50, base ≤ 200, large ≤ 300, threshold > 0. **Setting the penalties to 0 makes defaulting free.** | **no** |
| `setBonusReferenceAmount(wei6)` | 100 USDC | Loan size earning the full bonus. Must be > 0; **1 wei makes every dust loan earn full reputation.** | **no** |
| `setLatePenaltyParameters(base, perDay, max)` | 10 / 5 / 100 | Late-repayment reputation penalty (the hook V6.1 lacked). max ≤ 300. | **no** |
| `setValidationBonusParameters(threshold, creditBonus)` | 75 / 2 000 USDC | ERC-8004 bonus, capped at `MAX_TIER_LIMIT`. | **no** |
| **`setValidationRegistry(address)`** | unset | `creditLimitOf` calls into it. **A hostile or reverting address bricks `requestLoan` for every agent.** | **no** |
| **`authorizePool(address)`** | marketplace only | **Unbounded — any address.** The authorised address can call `recordBorrow`/`recordLoanCompletion`/`recordDefault` and write reputation and credit capacity for any agent directly. **The single most dangerous owner call in the stack.** | **no** |
| **`revokePool(address)`** | — | De-authorises a marketplace. **Bricks `repayLoan` AND `liquidateLoan` protocol-wide (`Only authorized pools`) with no pause flag.** Use only if the reputation manager itself is being abused; unwind with `authorizePool`. | **no** |
| `transferOwnership` / `acceptOwnership` | owner = secure wallet | Two-step | **no** |

### 4.3 AgentRegistryV2 — plain `Ownable`, ONE-STEP, **renounceable**

| Lever | Effect | Monitored |
|---|---|---|
| **`deactivateAgent(agentId)`** | **The per-agent kill switch.** V6.2 enforces `isActive` in `createAgentPool` and `requestLoan`. Blocks **exactly one** operation for one agent; repayment, exits, claims and liquidation all stay live. Reversible. **Prefer this over `pause()` for any single-actor incident.** | **no** |
| `reactivateAgent(agentId)` | Undo | **no** |
| `pause()` | Blocks NEW registrations only. Does **not** block NFT transfers or anything on the marketplace. | **no** |
| `transferOwnership(addr)` | **One step, instant, no acceptance, no undo.** A mistyped address is permanent. | **no** |
| **`renounceOwnership()`** | **NOT overridden — it works.** Owner becomes `0x0` and `deactivateAgent` / `pause` are gone **for ever**. Verified. | **no** |

### 4.4 AgentCreditFaucet — plain `Ownable`, ONE-STEP, **renounceable**

| Lever | Current | Effect | Monitored |
|---|---|---|---|
| `drain(amount)` | balance 19 USDC | Empty the faucet to the owner | **no** |
| `setClaimAmount(wei6)` | 1 USDC | ≤ 100 USDC | **no** |
| `setMaxEligibleAgentId(id)` | 100 | Unbounded — can open the faucet to every future agent | **no** |
| `transferOwnership` / **`renounceOwnership`** | — | One step / **permanent; strands whatever USDC the faucet holds** | **no** |

---

## 5. Pause blast radius on V6.2 (measured, not assumed)

Local hardhat replay of the exact V6.2 + V4 stack at live mainnet levers. 40 operations attempted
from the correct caller in three phases — unpaused, paused, and `deactivateAgent` — each inside its
own snapshot. `scripts/incident-drill/s5-pause-blast-radius.js`, results in
`forensics/output/testing-2026-09-23/incident-drill/s5-pause-blast-radius.json`.

**9 of 35 available operations are broken by `pause()`.** (The V6.1 runbook said "6 of 18"; the
*set* of broken families is unchanged — this probe set is just finer-grained. Nothing in V6.2 made
pause safer.)

| Operation | Unpaused | Paused | `deactivateAgent` |
|---|---|---|---|
| lender: `withdrawLiquidity` (max the pool can honour) | works | **BLOCKED** `EnforcedPause()` | works |
| lender: `withdrawLiquidity` (partial) | works | **BLOCKED** | works |
| lender: `claimInterest` | works | **BLOCKED** | works |
| lender: `supplyLiquidity` (new slot) | works | **BLOCKED** | works |
| lender: `supplyLiquidity` (top-up) | works | **BLOCKED** | works |
| borrower: `repayLoan` | works | **BLOCKED** | works |
| borrower: `requestLoan` | works | **BLOCKED** | **BLOCKED** `Agent deactivated` |
| agent: `createAgentPool` | works | **BLOCKED** | works |
| **OWNER: `liquidateLoan`** | works | **BLOCKED** | works |
| OWNER: `withdrawFees` | works | works | works |
| OWNER: `setPlatformFeeRate` / `setMinSupplyAmount` / `setMinHoldForReputationReward` / `setBindBorrowToPoolCreator` | works | works | works |
| OWNER: `compactPoolLenders` / `resetPoolAccounting` | works | works | works |
| OWNER: `transferOwnership` / `unpause` | works | works | works |
| registry: `register`, agent NFT `transferFrom` | works | works | works |
| registry owner: `deactivateAgent` / `reactivateAgent` / `pause` / `transferOwnership` / **`renounceOwnership`** | works | works | works |
| reputation V4: `initializeReputation`, `setTierLimits`, `setLadderParameters`, `setReputationRateLimit`, `setScoringParameters`, `setDefaultLockout`, **`authorizePool`**, **`revokePool`** | works | works | works |
| faucet: `claim` / `drain` / `setClaimAmount` | works | works | works |

**Blocked even unpaused** (not pause effects — don't misread them as such):

| Operation | Reason |
|---|---|
| lender: full-position `withdrawLiquidity` while loans are outstanding | `Insufficient pool liquidity` — a lender can never exit more than `availableLiquidity`, ever |
| pool creator: `withdrawLiquidity` of its own self-stake while borrowing | `Self-stake locked while borrowing` (M2-a) |
| `seedPool` / `setMigrationFinalized` | `Migration finalized` |

**Reading it.** Pause takes away every user action *and your primary recovery action*, while
leaving every risk-parameter lever, every ownership change and the whole reputation control surface
available. It is the right call only when you need to stop **new** loans and supply and you have
already decided you cannot liquidate your way out.

**The comparison that should decide the lever:**

| Lever | Operations broken | Reversible |
|---|---|---|
| `pause()` | **9** | yes, but the damage during the freeze is not |
| `registry.deactivateAgent(agentId)` | **1** | yes, `reactivateAgent` |

Note what pause does **not** stop: agent NFTs keep moving, new agents keep registering, reputation
stays writable, the faucet keeps paying out, and the owner keeps every lever. **A pause does not
freeze identity, credit policy or the control plane.**

---

## 6. Standing gaps you should know about before an incident

1. **No all-jobs-dead detector.** The monitor jobs cross-check each other's heartbeats, but a
   sleeping or powered-off Mac silences both. Weekly `alert.js --status` is the only backstop.
2. **The monitor watches the MARKETPLACE owner only.** Registry, reputation-manager and faucet
   ownership — including one-step transfer and permanent renounce — are invisible. So are
   `authorizePool`, `revokePool`, `setValidationRegistry`, `setBindBorrowToPoolCreator`, and every
   fee / limit / scoring lever. **23 of 29 successful hostile owner calls produce no signal at all.**
3. **No overdue-loan detector in the monitor.** A loan past `endTime` and unliquidated produces
   `exit 0`. Liquidation is a polling job — `forensics/monitor/check-overdue-loans.js`, run
   hourly by `com.specular.overdue-loans-arc-mainnet` (§7).
4. **The monitor cannot distinguish phantom liquidity from a real shortfall.** Same codes, opposite
   remedies (§3.1).
5. **Single owner EOA, no timelock, no multisig.** Every lever in §4 is one key away, and §3.2 has
   no good branch if that key is gone. This is the largest structural risk in the deployment.
6. **Registry and faucet are one-step `Ownable` AND renounceable.** A typo is permanent; a renounce
   destroys the per-agent kill switch for ever. (ReputationManagerV4 is `Ownable2Step` and blocks
   renounce — the V6.1 runbook's claim that it was one-step no longer applies.)
7. **`pause()` traps lender funds** (audit I-5). There is no withdraw-only mode. If you pause, you
   owe lenders an immediate, public explanation and a time-bound plan.
8. **`revokePool` bricks loan closing silently.** Treat it as a pause with no pause flag.
9. **A frozen RPC is invisible for one full cycle** and only WARNs when it is finally caught (§3.5).
10. **`NFT-MOVED` re-latches every cycle** for the life of the loan, so a legitimate agent sale is
    indistinguishable from an unhandled incident at a glance (§3.6).
11. **The marketplace is one USDC pot.** A shortfall in one pool is paid out of every other pool.
12. **No remote alert channel.** `SPECULAR_ALERT_WEBHOOK` is unset and `monitor.env` does not
    exist, so every channel needs somebody at this Mac. Closing this is one line in
    `monitor.env` (`WEBHOOK_SETUP.md`) and is the cheapest resilience win available.
13. **Two monitor jobs on one network used to share one state file** and silently killed
    `CP-CHANGED` (§3.2 box). Fixed 2026-09-24; re-check after every future supersession.
14. **The superseded Arc-STAGING stacks have no monitor at all.** Three of them are live and
    unpaused and hold 849 + 482 + 3 488 = **4 819 test USDC** between them
    (`supersededDeployments` in `src/config/arc-testnet-v6-addresses.json`, read 2026-09-24).
    Mainnet's one superseded marketplace does have a job; staging's three do not. Test money,
    but it is the same checklist item that will matter on mainnet
    (`V7_MAINNET_MIGRATION_RUNBOOK.md` §5b).

---

## 7. Routine checks the monitor does NOT do for you

```bash
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
cd ~/Specular

# 1. OVERDUE LOANS — the invariant monitor never reports these.
#    Read-only. Exit 0 = nothing overdue, 1 = liquidation candidates, 2 = could not read.
#    Already polled hourly by com.specular.overdue-loans-arc-mainnet; run it by hand for now.
node forensics/monitor/check-overdue-loans.js                 # NET=arc-staging|local to switch

# 2. ALL FOUR OWNERS — the monitor only checks the marketplace.
node scripts/incident-drill/read-live-levers.js | grep -A1 '"owner"'

# 3. THE LEVERS THIS RUNBOOK NAMES still exist on the deployed bytecode, and are owner-gated.
node scripts/incident-drill/verify-runbook-levers.js          # exit 0 = all present + gated

# 4. HEARTBEATS — the only backstop against every job being dead.
#    Expect one fresh heartbeat PER invariant job (arc-mainnet, arc-mainnet-358c5e69,
#    arc-staging). The overdue and rpc-health jobs stamp none — check those with launchctl.
node forensics/monitor/alert.js --status

# 5. READ-ONLY SMOKE: is the live config still what we think it is? Sends nothing, no key.
node scripts/smoke-test-arc-mainnet.js --read-only
node scripts/smoke-test-arc-testnet-v6.js --read-only
```

`check-overdue-loans.js` prints each overdue loan with its principal, collateral, **unsecured**
amount, days overdue and what `repayLoan` would pull right now — so you can see whether
liquidating actually recovers anything before you spend the gas. It also refuses to advise
liquidation while the contract is paused, because `liquidateLoan` is blocked by pause (§5).
All four behaviours (exit 0 / exit 1 with the full detail / exit 2 on a dead RPC / the paused
advice) were executed on 2026-09-24.

---

## 8. After the incident

1. `node forensics/monitor/alert.js --ack` — only once the underlying condition is gone.
   (`--ack` clears the latch **and** deletes `~/SPECULAR-ALERT.txt`.)
2. Confirm two consecutive clean runs (`exitCode: 0`) in the log of the job that fired —
   `forensics/monitor/v6-invariants-arc-mainnet.log` for the canonical stack,
   `v6-invariants-arc-mainnet-358c5e69.log` for the superseded V6.1 one. Also check
   `alert.js --status`: a heartbeat can still carry `lastExitCode: 2` from the incident until
   that job's next scheduled run.
3. Append a dated entry to this file: what fired, what was true, what you did, what it cost.
4. If the monitor missed it or cried wolf, add a scenario to `scripts/op-resilience/scenarios.js`
   and re-run `run-detection-matrix.js` — that matrix is the regression suite for the monitor.
5. If a *playbook* turned out to be wrong, re-run the drill that covers it
   (`scripts/incident-drill/`, see `forensics/output/testing-2026-09-23/INCIDENT_DRILL_REPORT.md`
   §9) and correct this file from the measurement, not from memory.
