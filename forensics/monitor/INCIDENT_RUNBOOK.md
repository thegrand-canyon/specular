# Specular Invariant Monitor — Incident Runbook

**Scope:** what a human does when `com.specular.v6-invariants-*` fires.
**Owner:** the holder of the secure wallet `0x800e305A0caDdE6289dFDFEDF38218f45C06F72C`.
**Written:** 2026-09-20 (operational-resilience round). Lever values verified on-chain 2026-09-22.

> **Read this first, before you touch anything:**
> **`pause()` FREEZES LENDER EXITS.** It also freezes borrower repayments *and your own
> `liquidateLoan`.* It is not a "make it safe" button — it is a "stop the world, including
> the recovery tools" button. Measured blast radius is in §5. Do not reach for it reflexively.

---

## 0. TL;DR triage card

| You see | First move | Then |
|---|---|---|
| `SOLV` / `POOL` / `S1` (money doesn't add up) | **Do not pause yet.** Snapshot state (§2.1). Confirm with a second RPC. | §3.1 |
| `OWN` / `OWN-PENDING` (ownership moved) | **Assume key compromise.** §3.2 — this is the only case where you act in seconds. | §3.2 |
| `PAUS` (paused and you didn't do it) | Same as `OWN` — someone else has the key. | §3.2 |
| `B1` / `S5-*` / `ALI` / `PT` / `LATE-*` (state corruption) | Snapshot, stop new inflow, no pause. | §3.3 |
| `FRESH` / `FRESH-STUCK` / `MONITOR-FAILED` / `MONITOR-DOWN` | You are **blind**, not necessarily broken. | §3.4 |
| `NFT-MOVED` (WARN) | Informational credit event. | §3.5 |
| `SOLV-SURPLUS` / `POOL-SLACK` (WARN) | Usually a donation or rounding. | §3.6 |

---

## 1. How an alert reaches you

Every 30 minutes `launchd` runs `forensics/monitor/run-with-alert.sh <network>`, which runs
`v6-invariants.js` and fans **any** non-zero exit out to:

1. `forensics/monitor/ALERT-ACTIVE.json` — a **latch**. Its existence means "unacknowledged
   incident". It is never cleared automatically.
2. `~/SPECULAR-ALERT.txt` — plain text in your home directory.
3. A macOS notification banner (plus a spoken alert for CRITICAL).
4. `forensics/monitor/alerts.log` — append-only JSONL history.
5. `SPECULAR_ALERT_WEBHOOK` — **only if you set it** in `forensics/monitor/monitor.env`
   (gitignored). Nothing is hardcoded; with the variable unset the webhook channel is a no-op.

Check state at any time:

```bash
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
node forensics/monitor/alert.js --status     # latch + per-network heartbeats
node forensics/monitor/alert.js --self-test  # prove the channels still work
node forensics/monitor/alert.js --ack        # clear the latch AFTER you have handled it
```

**Exit codes:** `0` clear · `1` invariant violation (or a sibling monitor is down) ·
`2` the monitor could not complete — RPC dead/slow/stale, config broken. **Treat 2 as
seriously as 1**: it means the deployment is unmonitored, not that it is fine.

---

## 2. Triage — do these before deciding anything

### 2.1 Snapshot the truth

```bash
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
cd ~/Specular

# full, verbose, un-quieted run against mainnet
V6_MONITOR_NETWORK=arc-mainnet V6_EXPECTED_OWNER=0x800e305A0caDdE6289dFDFEDF38218f45C06F72C \
  node forensics/monitor/v6-invariants.js --verbose --no-alert | tee /tmp/incident-$(date +%s).json

# every owner lever and balance, read-only
node scripts/op-resilience/read-mainnet-levers.js
```

### 2.2 Rule out the monitor before you believe the alert

A false alarm from a bad RPC is more likely than a broken contract. Re-run against a
**different** endpoint:

```bash
ARC_MAINNET_RPC_URL=<second endpoint> V6_MONITOR_NETWORK=arc-mainnet \
  node forensics/monitor/v6-invariants.js --no-alert
```

Two independent endpoints agreeing is the bar for acting. One endpoint disagreeing with
the other is itself the finding (§3.4).

### 2.3 Size the exposure before choosing a lever

From the snapshot: `usdcBalance`, `sumAvail`, `sumActiveCollateral`, number of ACTIVE loans,
number of distinct lenders. **If total third-party lender principal is zero, almost nothing is
urgent** — take the slow, reversible path. As of 2026-09-22 Arc mainnet holds 0.000014 USDC,
1 pool, 0 active loans, 1 agent: there is nothing to lose and no reason to pause.

---

## 3. Playbooks by finding

### 3.1 Money doesn't add up — `SOLV`, `POOL`, `S1`, `FEE`, `LOAN-TOTAL`, `LOAN-OUTSTANDING`

These mean lender claims exceed backing somewhere. Order of operations:

1. **Confirm on a second RPC** (§2.2). Arc's USDC is the native token exposed through an
   ERC-20 view; a forced native donation inflates the balance and shows up as
   `SOLV-SURPLUS`, not a shortfall. A *shortfall* is real.
2. **Stop the bleeding without pausing.** `setMinSupplyAmount(100e6)` (the contract's maximum)
   makes a new lender slot cost 100 USDC — it does **not** stop top-ups by existing lenders and
   does **not** block anything else. This is the cheapest "slow it down" lever.
3. **Do not run `resetPoolAccounting`.** Audit finding I-2: on a pool whose loss exceeded
   principal, it rebuilds `availableLiquidity` from booked interest and *re-creates* phantom
   liquidity. It is a migration tool, not a repair tool.
4. Identify the pool from the `POOL` row (`agentId`, `claims` vs `backing`). If exactly one
   pool is wrong and it has one borrower, the targeted action is to close that borrower's
   loans (§3.1a), not to pause the whole marketplace.
5. **Pause only if** the delta is growing between two consecutive monitor runs **and**
   third-party lender principal is at risk. Read §5 first, and tell lenders immediately —
   pausing traps their money.

**3.1a Closing a bad loan:** `liquidateLoan(loanId)` is owner-only, requires the loan to be
`ACTIVE` and `block.timestamp > endTime`, **and requires the contract to be UNPAUSED**. It
seizes collateral into `availableLiquidity`, socialises the shortfall pro-rata across lender
principal (and, V6.1 F-05, across unclaimed interest), decrements the counters, and records a
default (−50 pts, −100 above 10,000 USDC) against the **current NFT holder**.

### 3.2 Ownership or pause changed underneath you — `OWN`, `OWN-PENDING`, `PAUS`

This is the only scenario measured in seconds. If the owner is not the secure wallet, or a
`pendingOwner` is set that you did not set, or the contract is paused and you did not pause it:

1. Assume the secure wallet's key is compromised.
2. If you **still control** the owner key: `transferOwnership(<fresh cold wallet>)` immediately,
   then `acceptOwnership()` from that wallet (Ownable2Step — both steps are required).
   `renounceOwnership` is disabled in V6.1 (it is a `view` override), so nobody can orphan the
   contract.
3. If you **do not** control it any more: you cannot regain it. Publish a disclosure, tell every
   lender to `withdrawLiquidity` **while the contract is still unpaused**, and treat the
   deployment as lost. There is no timelock and no multisig on this deployment — see §6.
4. Registry, ReputationManager and Faucet are separate one-step `Ownable` contracts (audit I-1).
   Check all four owners in the `read-mainnet-levers.js` output, not just the marketplace.

### 3.3 State corruption — `B1`, `S5-COUNTER`, `S5-CAP`, `ALI`, `ALI-LEN`, `PT`, `PT-TS`, `QUAL-REVERT`, `LATE-*`

V6.1's code cannot produce these states, so if one appears the cause is either a monitor bug
(check `scripts/op-resilience/storage.js` still matches the deployed layout) or something
genuinely novel. Nothing here is fixable with a lever except:

- `B1` duplicate lenders → `compactPoolLenders(agentId)` dedups in place, works **even while
  paused**, bounded to 50 iterations. Safe.
- `QUAL-REVERT` is the serious one: `qualifiedAmountAt` reverting means `_distributeInterest`
  reverts too, so **every repayment on that pool is bricked**. Borrowers cannot close loans.
  There is no lever for this; it needs a redeploy and a migration.
- `S5-CAP`/`ALI` corruption means the concurrency limit is not being enforced — stop new
  borrowing. V6.1 enforces `isActive` in `createAgentPool`/`requestLoan` (audit F-07 fixed), so
  `registry.deactivateAgent(agentId)` **is** a per-agent kill switch on this deployment.

### 3.4 You are blind — `FRESH`, `FRESH-STUCK`, `FRESH-REORG`, `MONITOR-FAILED`, `MONITOR-DOWN`, `[WATCHDOG]`

| Code | Meaning | Action |
|---|---|---|
| `MONITOR-FAILED` | RPC dead, erroring, or slower than `V6_RPC_TIMEOUT_MS` | Try a second endpoint. If both fail, the chain or your network is down — re-run manually every few minutes until it clears. |
| `[WATCHDOG]` | Run exceeded `V6_MAX_RUNTIME_SEC` (600 s) | The endpoint is degraded. A run that outlives the interval also *delays the next one* — launchd schedules the next start from the previous process's exit. |
| `FRESH` | Chain head older than `V6_MAX_BLOCK_AGE_SEC` (1800 s) | Endpoint is serving stale data, or the chain has stalled. Compare block height against a block explorer. |
| `FRESH-STUCK` | Head identical to the previous run | Endpoint pinned to a snapshot. **Every state read still succeeds and looks self-consistent** — this is the most dangerous failure mode, because without this check the monitor reports OK for ever. Switch endpoints. Arc mainnet advances 1,400–4,800 blocks per 30-min cycle, so this never fires on a healthy chain. |
| `FRESH-REORG` | Head went backwards | Either a reorg or the RPC is answering for a different chain. Verify `chainId == 5042`. |
| `MONITOR-DOWN` | A *sibling* network's job has not stamped a heartbeat in 90 min | `launchctl list \| grep specular`; reload the plist. |

**Nothing detects all jobs being dead at once.** The jobs cross-check each other, but if the
Mac is asleep, powered off, or the repo has moved, everything is silent. Do a weekly manual
`node forensics/monitor/alert.js --status` and confirm both heartbeats are fresh. (§6 gap 1.)

### 3.5 `NFT-MOVED` (WARN)

An agent NFT is held by an address that is not the borrower of its ACTIVE loan. V6.1's F-01 fix
means the loan can still be repaid and liquidated (the marketplace resolves the agent by
`agentId` through `ownerOf`), so this is **not** the frozen-loan bug. But it is a real credit
event: the reputation outcome and the right to repay moved to the buyer, while the collateral
still returns to the original borrower. Note who moved what, and watch that loan to maturity.

### 3.6 `SOLV-SURPLUS` / `POOL-SLACK` (WARN)

More USDC in the contract than accounted for. On Arc, USDC is the native token, so a forced
native transfer lands as an unexplained surplus (audit I-3). Not a loss. Confirm the delta is
static; if it grows monotonically in step with activity, it is an accounting bug, not a
donation — escalate to §3.1.

---

## 4. Owner levers on V6.1 — what each one actually does

Values read on-chain 2026-09-22 (`forensics/output/testing-2026-09-20/arc-mainnet-levers.json`).

| Lever | Current | Effect | Side effects / cost |
|---|---|---|---|
| **`pause()`** | unpaused | Blocks **6 of 18** measured operations | **Freezes lender `withdrawLiquidity` AND `claimInterest`. Freezes borrower `repayLoan`. Freezes your own `liquidateLoan`.** Also blocks `supplyLiquidity`, `requestLoan`, `createAgentPool`. Interest keeps accruing on live loans up to `LATE_INTEREST_CAP` (30 days) while borrowers cannot pay. Reversible with `unpause()`. **Full table in §5.** |
| `unpause()` | — | Restores everything | None. |
| `setPlatformFeeRate(bps)` | 100 (1 %) | Protocol cut of interest | Capped at 500. **Applies retroactively** — the fee is computed at repay, so already-active loans pay the new rate (audit I-4). Raising it mid-loan silently changes lender yield. |
| `setMinSupplyAmount(wei6)` | 10 USDC | Minimum for a **new** lender slot | Capped at 100 USDC. Does **not** apply to top-ups by existing lenders. Raising it to 100 makes a 50-slot squat cost 5,000 USDC (audit F-06) but also locks out small lenders. |
| `setMinHoldForReputationReward(sec)` | 86 400 | Minimum loan life before an on-time repay earns points | 0 disables. Slows reputation farming; no effect on money. |
| `setBindBorrowToPoolCreator(bool)` | true | Only the pool's creator address may borrow from it | Leaving it true means an NFT sale does not hand the buyer borrowing rights. Turning it off widens the blast radius of a stolen agent. |
| `reputation.setReputationRateLimit(max, window)` | 5 pts / 86 400 s | Caps reputation gain per window | The main brake on D1/F-04 farming. 5/day ⇒ ~100 days from score 100 to the 0 %-collateral tier. Lowering further slows honest agents equally. |
| `reputation.setScoringParameters(bonus, penaltyBase, penaltyLarge, largeThreshold)` | 10 / 50 / 100 / 10 000 USDC | Bonus and default penalties | Raising penalties makes a bust-out cost more calendar time to re-farm. Not retroactive. |
| `reputation.setBonusReferenceAmount(wei6)` | 100 USDC | Loan size that earns the full bonus | Raising it forces larger loans (and larger fees) per reputation point. |
| **`reputation.revokePool(address)`** | marketplace authorized | De-authorises the marketplace from writing reputation | **Blunt.** After this, `repayLoan` and `liquidateLoan` revert (both call into the reputation manager) — it bricks loan closing exactly like a pause, but *without* a pause flag to make it obvious to anyone. Use only if the reputation manager itself is being abused; unwind with `authorizePool`. |
| `registry.deactivateAgent(agentId)` | — | V6.1 enforces `isActive` in `createAgentPool`/`requestLoan` | **The per-agent kill switch.** Stops one bad agent from borrowing without touching anyone else. Preferred over `pause()` for a single-actor incident. Does not affect its existing loans. |
| `registry.pause()` | unpaused | Blocks registration | Does **not** block NFT transfers. |
| `liquidateLoan(loanId)` | — | Default an overdue loan | Owner-only, `ACTIVE` + past `endTime` + **not paused**. Seizes collateral, socialises the shortfall pro-rata, records a default. Irreversible. |
| `withdrawFees(amount)` | 0.000014 USDC | Move protocol fees out | **Works while paused** (no `whenNotPaused`). |
| `compactPoolLenders(agentId)` | — | Dedup `poolLenders[]` | Safe, bounded, works while paused. |
| `resetPoolAccounting(agentId)` | — | Rebuild `totalLoaned`/`availableLiquidity` | **DANGEROUS** — audit I-2: after an under-recovered liquidation it re-creates phantom liquidity. Do not use during a solvency incident. |
| `seedPool` / `seedPosition` | **disabled** | — | `migrationFinalized == true` on Arc mainnet (F-08 closed at deploy). Both revert. |
| `transferOwnership` / `acceptOwnership` | owner = secure wallet | Two-step handover | `renounceOwnership` disabled in V6.1. Registry/Reputation/Faucet are **one-step** `Ownable` (audit I-1) — a mistyped address there is unrecoverable. |
| `faucet.drain(amount)` | balance 19 USDC | Empty the faucet | Use if the faucet is being farmed. |

---

## 5. Pause blast radius (measured, not assumed)

Local hardhat replay of the exact V6.1 stack; every call attempted from the correct caller both
unpaused and paused (`scripts/op-resilience/pause-blast-radius.js`, results in
`forensics/output/testing-2026-09-20/pause-blast-radius.json`):

| Operation | Unpaused | Paused |
|---|---|---|
| lender: `withdrawLiquidity` | works | **BLOCKED** `EnforcedPause()` |
| lender: `claimInterest` | works | **BLOCKED** `EnforcedPause()` |
| lender: `supplyLiquidity` | works | **BLOCKED** `EnforcedPause()` |
| borrower: `repayLoan` | works | **BLOCKED** `EnforcedPause()` |
| borrower: `requestLoan` | works | **BLOCKED** `EnforcedPause()` |
| **owner: `liquidateLoan`** | works | **BLOCKED** `EnforcedPause()` |
| owner: `withdrawFees` | works | works |
| owner: `setPlatformFeeRate` / `setMinSupplyAmount` / `setMinHoldForReputationReward` / `setBindBorrowToPoolCreator` | works | works |
| owner: `compactPoolLenders` / `resetPoolAccounting` | works | works |
| owner: `transferOwnership` | works | works |
| registry: `register` | works | works |
| registry: agent NFT `transferFrom` | works | works |

**Reading:** pausing takes away every user action *and your primary recovery action*, while
leaving every risk-parameter lever and ownership change available. `pause()` is therefore the
right call only when you need to stop **new** loans and supply and you have already decided you
cannot liquidate your way out. In every other case a targeted lever (`deactivateAgent`,
`setMinSupplyAmount`, `setReputationRateLimit`) does less damage.

Note what pause does **not** stop: agent NFTs keep moving, new agents keep registering, and
reputation stays readable. A pause does not freeze identity.

---

## 6. Standing gaps you should know about before an incident

1. **No all-jobs-dead detector.** The monitor jobs cross-check each other's heartbeats, but a
   sleeping/off Mac silences both. Weekly `alert.js --status` is the only backstop today.
2. **Single owner EOA, no timelock, no multisig.** Every lever in §4 is one key away, and §3.2
   has no good branch if that key is gone.
3. **Registry / Reputation / Faucet are one-step `Ownable`** (audit I-1) — a typo in
   `transferOwnership` on those three is permanent.
4. **`pause()` traps lender funds** (audit I-5). There is no withdraw-only mode. If you pause,
   you owe lenders an immediate, public explanation and a time-bound plan.
5. **Late repayment still earns no reputation penalty.** V6.1 charges elapsed-time interest
   (F-03 fix) and records `lateRepayCount`/`lateSecondsTotal` on-chain, but ReputationManagerV3
   has no late hook — scoring off that data is an off-chain job today.
6. **`revokePool` bricks loan closing silently.** Treat it as a pause with no pause flag.

---

## 7. After the incident

1. `node forensics/monitor/alert.js --ack` — only once the underlying condition is gone.
2. Confirm two consecutive clean runs (`exitCode: 0`) in
   `forensics/monitor/v6-invariants-arc-mainnet.log`.
3. Append a dated entry to this file: what fired, what was true, what you did, what it cost.
4. If the monitor missed it or cried wolf, add a scenario to
   `scripts/op-resilience/scenarios.js` and re-run `run-detection-matrix.js` — that matrix is
   the regression suite for the monitor itself.
