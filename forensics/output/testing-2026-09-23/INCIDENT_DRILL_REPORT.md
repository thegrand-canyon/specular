# Incident-response drill — V6.2 + ReputationManagerV4

**Run:** 2026-09-23 · **Target:** the real V7 stack, deployed to a LOCAL hardhat chain
**Levers:** read live from Arc mainnet at block 22 287 733 and mirrored exactly
**Broadcast to Arc/Base:** none. Every transaction in this report is local; the only live-network
traffic was read-only `eth_call`s (`scripts/incident-drill/read-live-levers.js`).

Evidence: `forensics/output/testing-2026-09-23/incident-drill/*.json`
Harness: `forensics/output/testing-2026-09-23/incident-drill.patch` (`git apply`, adds `scripts/incident-drill/`)

---

## Why this exists

`forensics/monitor/INCIDENT_RUNBOOK.md` was written against V6.1 + ReputationManagerV3 and had
never been executed against V6.2 + V4, which are what is live on Arc mainnet. A runbook nobody
has run is a hypothesis. This drill executes it: for each scenario, **detect → decide → act →
verify → measure**.

Eleven runbook statements turned out to be wrong or missing. They are listed in §8.

---

## 0. Setup and control

`scripts/incident-drill/deploy-v7-local.js` deploys AgentRegistryV2 + ReputationManagerV4 +
AgentLiquidityMarketplaceV62 + AgentCreditFaucet + MockUSDC and sets the levers to the values
read live from mainnet the same day:

| Lever | Live Arc mainnet | Local replica |
|---|---|---|
| `platformFeeRate` | 100 bps | 100 bps |
| `minSupplyAmount` | 10 USDC | 10 USDC |
| `minHoldForReputationReward` | 86 400 s | 86 400 s |
| `bindBorrowToPoolCreator` (M-1) | true | true |
| `migrationFinalized` | true | true |
| `maxReputationGainPerWindow` / window | 5 / 86 400 s | 5 / 86 400 s |
| `creditMultiple` (k) / `growthStep` / `bootstrapLimit` | 2 / 100 / 100 USDC | same |
| `defaultLockout` | 15 552 000 s (180 d) | same |
| `MAX_TIER_LIMIT` (immutable) | 10 000 USDC | same |
| tier limits / collateral % | 1000/5000/10000/10000/2500/5000 · 100/100/100/75/0/0 | same |

**Control (S0):** the unmodified monitor (`forensics/monitor/v6-invariants.js`,
`V6_MONITOR_NETWORK=local`) runs clean on the healthy baseline — `exitCode 0`, no findings,
212 ms. Every "it detected it" result below is measured against that silence.

The monitor was **not modified** for this drill. It already speaks V6.2 (`selfStake`,
`requiredSelfStake`) and V4 (`tierLimits`, `creditMultiple`, `MAX_TIER_LIMIT`).

---

## 1. Insolvency / phantom liquidity

Evidence: `incident-drill/s1-insolvency.json`. Storage slot map asserted against the contract's
own getters (13 slots) before any poke.

The drill separates two incidents the runbook treats as one:

### 1A — phantom liquidity (books wrong, USDC intact)

`pool.availableLiquidity` inflated by 500 USDC via `hardhat_setStorageAt`. V6.2 cannot produce
this state itself; it models a future accounting bug of the §S1 shape.

| | |
|---|---|
| **Time to detect** | next scheduled monitor run — ≤ 30 min. Monitor runtime 232 ms local |
| **Codes** | `S1(CRITICAL)`, `SOLV(CRITICAL)`, `POOL-SLACK(WARN)`, exit 1, alert latched |
| **Lever** | `resetPoolAccounting(agentId)` |
| **Recovery** | **Full.** availableLiquidity restored to 1 900.000000 exactly; monitor clean on the next run; lender exit still works |
| **Residual damage** | none |

### 1B — real shortfall (books right, USDC gone)

11 000.29 USDC moved out of the marketplace by impersonating it; **no storage figure touched**.
This models any future token-path bug or hostile withdrawal.

| | |
|---|---|
| **Time to detect** | ≤ 30 min. Monitor runtime 235 ms |
| **Codes** | `S1(CRITICAL)`, `SOLV(CRITICAL)` — **identical to 1A** |
| **Recovery** | **None on-chain** |

Every candidate lever was executed:

| Lever | Result |
|---|---|
| `resetPoolAccounting(agentId)` | **Makes it worse.** Rebuilds the books from the lender *positions* — i.e. from the claims — so it re-asserts 1 900 USDC of liquidity against a 1 000 USDC balance. Monitor still `S1`/`SOLV`. This is audit finding I-2, reproduced. |
| do nothing | First-come-first-served race, proven: lenderP withdrew 1 000 in full; lenderQ reverted `ERC20InsufficientBalance(marketplace, 0, 900000000)`. **The socialisation logic only runs inside `liquidateLoan` on a specific defaulted loan — a bare shortfall is NOT shared.** |
| `pause()` | Stops the race by freezing everyone (`EnforcedPause()` on the lender exit) including repayment and `liquidateLoan`. Recovers nothing. **The owner can still `withdrawFees` out of a pool that cannot pay its lenders.** |
| `setMinSupplyAmount(100 USDC)` + `registry.deactivateAgent(agentId)` | New lender blocked (`Below minimum supply`), new borrowing blocked (`Agent deactivated`), **existing lenders still exit and the borrower still repays.** The correct first move. Recovers nothing. |
| send USDC to the contract from treasury | **The only repair.** A plain ERC-20 transfer; no contract function involved. Monitor goes clean, lenders whole. |

**Honest answer:** on a real shortfall you cannot make lenders whole with any lever V6.2 exposes.
`withdrawFees` only moves money out, `seedPool`/`seedPosition` are dead (migration finalised),
`resetPoolAccounting` rewrites the books rather than the balance. You can stop the bleeding and
then decide who gets paid — or you top the contract up from treasury.

**Two further facts the runbook does not state:**

1. **The monitor cannot tell 1A from 1B.** Same codes, opposite remedies, and applying 1A's remedy
   to 1B is actively harmful. The operator has to compare the USDC balance against Σ lender claims
   by hand before touching `resetPoolAccounting`.
2. **The marketplace is one USDC pot shared by every pool.** In the race above, pool G's lender was
   paid out of the *other* pools' liquidity. A shortfall anywhere is a shortfall everywhere, and
   per-pool conservation (`POOL`) can look perfect while the contract is globally insolvent.

---

## 2. Large default with the M2 first-loss self-stake

Evidence: `incident-drill/s2-large-default.json`. Every reputation point was earned by a real
loan cycle at the live levers — no storage pokes anywhere in this scenario.

**Setup.** A fresh agent climbed score 100 → 600 in **exactly 100 on-time loan cycles** (the
5 pts/day rate limit caps each cycle at 5 points, confirming the runbook's "~100 days" estimate),
then climbed the M1 credit ladder 300 → 700 → 1 500, reaching the tier-4 cap of 2 500 USDC.
It then trimmed its own self-stake to exactly the M2-c minimum (`requiredSelfStake` = 1 200 USDC
= exposure / k, k = 2) and drew **2 400 USDC at 0 % collateral, 700 bps**.

Lenders: victimA 1 000 and victimB 500 supplied **before** the loan; lateLender 500 supplied
**one day after the loan started**.

### M2-a — the lock held

`withdrawLiquidity` by the pool creator mid-loan reverted **`Self-stake locked while borrowing`**.

### M2-b — first-loss ordering held

Liquidation emitted `SelfStakeAbsorbedLoss(agentId=3, creator, 1200000000)` **before** any other
lender was touched. Loss = 2 400 (zero collateral):

| Lender | Principal before | After | Lost | % | Qualified for the defaulted loan |
|---|---|---|---|---|---|
| **agent self-stake (creator)** | 1 200 | 0 | **1 200** | **100 %** | n/a — absorbed first, outside the pro-rata pass |
| victimA (in before the loan) | 1 000 | 200 | 800 | 80 % | 200 |
| victimB (in before the loan) | 500 | 100 | 400 | 80 % | 100 |
| **lateLender (in AFTER loan start)** | 500 | **500** | **0** | **0 %** | **0** |

The self-stake absorbed exactly half the loss, which is `1/k` by construction. **L7 also held:**
the lender who joined mid-loan bore none of that loan's loss, and its `qualifiedAmountAt` at the
loan's `startTime` was 0.

### Credit ladder reset and lockout

| | |
|---|---|
| score | 615 → **375** (penalty **240** = `max(50, 100 × 2400/1000)`, exactly as specified) |
| `maxRepaidPrincipal` | 1 500 → **0** |
| `calculateCreditLimit` | 2 500 → **0** |
| `isLockedOut` | **true**, 180 days |
| `defaultCount` | 1 |

### Nothing stranded

Per-pool conservation exact after the loss: claims 828.004818 == backing 828.004818, delta 0.
Every survivor (both victims, the late lender, and the creator's unclaimed interest) successfully
withdrew or claimed. Monitor clean (`exit 0`) after the liquidation.

### Cost and the residual

Liquidation gas **197 611**. The attacker risked 1 200 of its own capital to extract 2 400, of
which 1 200 came from third-party lenders — a net gain of 1 200 for 1 200 at risk, plus ~100
loan cycles of fees and locked capital. That is F-04 **priced, not closed**, exactly as
`CLAUDE.md` states.

### The detection gap this scenario exposed

**The monitor never told anyone the loan was overdue.** With the loan one full day past `endTime`
and unliquidated, the monitor exited **0 with no findings**. There is no overdue-ACTIVE-loan check
in `v6-invariants.js`. Liquidation — the protocol's only recovery action — is **not alert-driven**;
an operator only liquidates if they happen to look. Time to detect a defaulting borrower: **never,
by the monitor**.

**Remedy shipped with this drill:** `scripts/incident-drill/check-overdue-loans.js` — read-only,
lists every ACTIVE loan past `endTime` with principal, collateral, unsecured amount, days overdue
and what `repayLoan` would pull right now; exits 1 when there are candidates so it can be crontab'd
next to the monitor. Verified against a rigged local chain (2 overdue loans found, exit 1) and
read-only against live Arc mainnet (0 overdue, exit 0). The runbook now lists it as a daily job.

---

## 3. Agent NFT moves mid-loan (the F-01 class)

Evidence: `incident-drill/s3-nft-move.json`.

An agent with a live 100 USDC / 100 USDC-collateral loan transferred its NFT to a fresh address.

**Detection:** `NFT-MOVED(WARN)`, **exit 1**, alert latched, 232 ms. The detector fires.

**Who can do what:**

| Actor | Action | Result |
|---|---|---|
| stranger | `repayLoan` | `Not the borrower` |
| original borrower (seller) | `repayLoan` | **works** |
| current NFT holder (buyer) | `repayLoan` | **works** |
| buyer | `requestLoan` | `Borrow restricted to pool creator` (M-1 lever ON) |
| seller | `requestLoan` | `Not a registered agent` — the registry deleted `addressToAgentId[seller]` |
| buyer | `createAgentPool` | `Pool already exists` |
| owner | `liquidateLoan` after transfer | **works** |

**Where the money goes.** Collateral always returns to `loan.borrower`. When the **buyer** repaid,
it paid 100.287671 USDC and the **seller** received the 100 USDC collateral. That is a real
value transfer from buyer to seller, and it is intentional (the collateral is escrowed for a
specific wallet, not for the agent identity) — but it is a trap for anyone who buys an agent
without settling the open loan off-chain first.

**Where the credit consequence goes.** Reputation and default both key off `agentId`, so they land
on whoever holds the NFT. On the liquidation branch the **buyer** took the default, the capacity
reset and the 180-day lockout for a loan the **seller** took out. A seller can knowingly sell an
agent with a doomed loan attached.

**Alert-fatigue note.** `NFT-MOVED` is WARN, but it makes the monitor exit **non-zero and latch
`ALERT-ACTIVE.json` on every 30-minute cycle for the whole life of the loan**. A legitimate agent
sale therefore produces a standing incident latch that looks exactly like an unacknowledged
emergency.

**D13 view consistency:** `requiredSelfStake(agentId, …)` resolves by agentId and returned a
consistent figure after the transfer (0 here — the tier is 100 % collateral).

---

## 4. Owner key hostile for one hour

Evidence: `incident-drill/s4-hostile-owner.json`. **34 state-changing owner calls enumerated by
reading the four contracts, and every one executed against the local replica.**

| | |
|---|---|
| succeeded | **29** |
| blocked by design | 5 |
| **seen by the monitor** | **6** |
| **invisible to the monitor** | **23** |

### What the monitor sees, and how fast

| Call | Code | Severity | Latency |
|---|---|---|---|
| `marketplace.pause()` | `PAUS` | CRITICAL | ≤ 30 min |
| `marketplace.transferOwnership` (step 1) | `OWN-PENDING` | CRITICAL | ≤ 30 min |
| `marketplace.transferOwnership` + `acceptOwnership` | `OWN` | CRITICAL | ≤ 30 min |
| `reputation.setTierLimits` | `CP-CHANGED` | **WARN** | ≤ 30 min |
| `reputation.setLadderParameters` | `CP-CHANGED` | **WARN** | ≤ 30 min |
| `reputation.setDefaultLockout` | `CP-CHANGED` | **WARN** | ≤ 30 min |

### What the monitor never sees — 23 calls

`setPlatformFeeRate` · `setMinSupplyAmount` · `setMinHoldForReputationReward` ·
**`setBindBorrowToPoolCreator`** · `withdrawFees` · `resetPoolAccounting` · `compactPoolLenders` ·
`reputation.setReputationRateLimit` · `reputation.setScoringParameters` ·
`reputation.setLatePenaltyParameters` · `reputation.setBonusReferenceAmount` ·
**`reputation.authorizePool`** · **`reputation.revokePool`** · `reputation.setValidationRegistry` ·
`registry.deactivateAgent` · `registry.pause` · **`registry.transferOwnership`** ·
**`registry.renounceOwnership`** · `faucet.drain` · `faucet.setClaimAmount` ·
`faucet.setMaxEligibleAgentId` · `faucet.transferOwnership` · `faucet.renounceOwnership`

**The monitor reads the marketplace owner and nothing else.** The registry, reputation-manager and
faucet owners are never checked. A hostile key can take all three and the monitor stays green.

### The four that matter most

1. **`reputation.authorizePool(any address)` — unbounded.** Any EOA can be made able to call
   `recordBorrow` / `recordLoanCompletion` / `recordDefault` and write reputation and credit
   capacity for any agent, directly. Invisible.
2. **`reputation.revokePool(the live marketplace)` — one transaction, protocol-wide brick.**
   Verified: `repayLoan` reverts `Only authorized pools` **and** `liquidateLoan` reverts
   `Only authorized pools`. Loans can never close, collateral is stuck, and **there is no pause
   flag to show for it**. Invisible.
3. **`reputation.setValidationRegistry(hostile address)` — one transaction, borrowing brick.**
   `creditLimitOf` calls into it, so `requestLoan` reverts for every agent. Invisible.
4. **`registry.renounceOwnership()` — permanent.** AgentRegistryV2 is plain `Ownable` with **no
   renounce override**. Verified: owner becomes `0x0` and `deactivateAgent` is gone for ever —
   i.e. the runbook's recommended per-agent kill switch can be destroyed by one transaction that
   the monitor does not watch. `AgentCreditFaucet` is the same. (The marketplace and
   ReputationManagerV4 both override `renounceOwnership` to revert.)

Also note `setBindBorrowToPoolCreator(false)`: turning M-1 off lets a bought or stolen agent NFT
borrow against the **seller's** locked self-stake and the pool's lenders. One boolean, invisible.

### The full chain, executed

Owner authorises itself on the reputation manager, removes every brake, forges credit for an agent
it controls, and draws a real pool down. 35 transactions from the owner key:

```
rep.authorizePool(attacker)
rep.setReputationRateLimit(0, 1)              # D1 brake off
rep.setScoringParameters(50, 0, 0, 1 wei)     # max bonus, ZERO default penalty
rep.setBonusReferenceAmount(1 wei)
rep.setDefaultLockout(0)                      # no post-default freeze
rep.setTierLimits(all at MAX_TIER_LIMIT)
rep.setLadderParameters(k=10, step=MAX, bootstrap=MAX, refDuration=1s)
rep.recordBorrow + rep.recordLoanCompletion  x 14 pairs   # forged, from the authorized EOA
```

Result: score **800**, `maxRepaidPrincipal` **10 000 USDC**, credit limit **10 000 USDC**,
collateral requirement **0 %**, required self-stake **500 USDC** (k = 10 divides it down).
The agent then drew **5 561 USDC** — the entire pool, including a third party's 5 000 — having
risked **561 USDC** of its own. Roughly **10:1**.

**The monitor's entire reaction to that chain: `CP-CHANGED(WARN)`, exit 1.** Nothing about
`authorizePool`, nothing about the forged reputation writes, nothing about the draw (which is a
perfectly legitimate loan by then). Time to see it: up to 30 minutes, at WARN.

### What the key provably CANNOT do — all 16 probes blocked

| Attempt | Blocked by |
|---|---|
| tier limit above `MAX_TIER_LIMIT` | `Tier limit exceeds ceiling` (immutable 10 000 USDC) |
| `creditMultiple` above 10 | `creditMultiple too high` |
| `growthStep` above `MAX_TIER_LIMIT` | `growthStep exceeds ceiling` |
| platform fee above 5 % | `Fee too high` |
| `minSupplyAmount` above 100 USDC | `Min supply too high (>100 USDC)` |
| default lockout beyond 2 years | `Lockout too long` |
| re-open migration | `Migration finalized` |
| **mint a lender position (`seedPosition`)** | `Migration finalized` — **F-08 verified closed** |
| **mint pool liquidity (`seedPool`)** | `Migration finalized` — **F-08 verified closed** |
| withdraw more than `accumulatedFees` | `Insufficient fees` |
| renounce marketplace ownership | `Ownership cannot be renounced` |
| renounce reputation-manager ownership | `Ownership cannot be renounced` |
| liquidate a loan that is not overdue | `Loan not overdue` |
| liquidate while paused | `EnforcedPause()` |
| transfer an agent NFT it does not hold | `ERC721InsufficientApproval` |
| set a reputation score directly | no such function exists on ReputationManagerV4 |

So the bound on a hostile key is real but weak: **it cannot mint balances or positions, and it
cannot raise unsecured exposure above 10 000 USDC per agent** — but within that bound it can
manufacture that exposure for an agent it controls, and it can brick the protocol outright.

### Containment with a single EOA and no timelock

Executed and measured. **Six transactions**, two of which must be signed by the *new* wallet:

```
marketplace.transferOwnership(cold)   →  marketplace.acceptOwnership()   [from cold]
reputation.transferOwnership(cold)    →  reputation.acceptOwnership()    [from cold]
registry.transferOwnership(cold)                                          [ONE STEP]
faucet.transferOwnership(cold)                                            [ONE STEP]
```

Verified afterwards: the old key can no longer `pause()`, `authorizePool` or `deactivateAgent`
(all `OwnableUnauthorizedAccount`). **This only works while you still control the key.** The
registry and faucet move in a single unconfirmed step, so a mistyped address there is permanent.

If you do *not* control the key any more there is **no containment**: no timelock, no multisig, no
guardian role, and the one lever that would slow an attacker down (`pause()`) is itself an
owner-only function. The honest instruction is: publish, tell lenders to withdraw while the
contract is unpaused, and treat the deployment as lost.

---

## 5. Pause blast radius on V6.2

Evidence: `incident-drill/s5-pause-blast-radius.json`. 40 operations probed from the correct
caller, each in its own snapshot, in three phases: unpaused, paused, and
`registry.deactivateAgent` — so the two levers can be compared directly.

**Headline: 9 of 35 available operations are broken by `pause()`.** The V6.1 figure was 6 of 18;
the *set* of broken operation families is unchanged, the count differs because this probe set is
finer-grained (partial vs maximal withdrawal, new slot vs top-up). **No V6.2 change made pause
safer or more dangerous — it is the same trap, re-confirmed.**

### Broken by `pause()`

| Operation | Paused |
|---|---|
| lender: `withdrawLiquidity` (max the pool can honour) | **BLOCKED** `EnforcedPause()` |
| lender: `withdrawLiquidity` (partial) | **BLOCKED** `EnforcedPause()` |
| lender: `claimInterest` | **BLOCKED** `EnforcedPause()` |
| lender: `supplyLiquidity` (new slot) | **BLOCKED** `EnforcedPause()` |
| lender: `supplyLiquidity` (top-up) | **BLOCKED** `EnforcedPause()` |
| borrower: `repayLoan` | **BLOCKED** `EnforcedPause()` |
| borrower: `requestLoan` | **BLOCKED** `EnforcedPause()` |
| agent: `createAgentPool` | **BLOCKED** `EnforcedPause()` |
| **OWNER: `liquidateLoan`** | **BLOCKED** `EnforcedPause()` |

### Survives `pause()` — everything else

| Group | Operations that still work while paused |
|---|---|
| marketplace owner | `withdrawFees`, `setPlatformFeeRate`, `setMinSupplyAmount`, `setMinHoldForReputationReward`, `setBindBorrowToPoolCreator`, `compactPoolLenders`, `resetPoolAccounting`, `transferOwnership`, `unpause` |
| registry (any caller) | `register`, agent NFT `transferFrom` |
| registry owner | `deactivateAgent`, `reactivateAgent`, `pause`, `transferOwnership`, **`renounceOwnership`** |
| reputation V4 | `initializeReputation`, `setTierLimits`, `setLadderParameters`, `setReputationRateLimit`, `setScoringParameters`, `setDefaultLockout`, `revokePool`, `authorizePool` |
| faucet | `claim`, `drain`, `setClaimAmount` |

### Blocked even unpaused (not pause effects)

| Operation | Reason |
|---|---|
| lender: `withdrawLiquidity` of the FULL position with loans outstanding | `Insufficient pool liquidity` — a lender can never exit more than `availableLiquidity`, pause or no pause |
| pool creator: `withdrawLiquidity` of its own self-stake while borrowing | `Self-stake locked while borrowing` (M2-a) |
| `seedPool` / `setMigrationFinalized` | `Migration finalized` |

### The comparison that decides the lever

| Lever | Operations broken |
|---|---|
| `pause()` | **9** — including every lender exit, every repayment and your own `liquidateLoan` |
| `registry.deactivateAgent(agentId)` | **1** — `requestLoan` for that one agent (`Agent deactivated`) |

`deactivateAgent` leaves exits, claims, repayment, liquidation, supply and every other agent
untouched. For a single-actor incident it is nine times less destructive and it is reversible with
`reactivateAgent`.

---

## 6. Stuck or lying RPC

Evidence: `incident-drill/s6-rpc-blind.json`. Driven through
`scripts/op-resilience/fault-rpc.js`.

| Case | Exit | Code | Alert latched |
|---|---|---|---|
| control: healthy RPC | 0 | — | no |
| dead endpoint (ECONNREFUSED) | **2** | `MONITOR-FAILED(CRITICAL)` | **yes** |
| every call returns a JSON-RPC error | **2** | `MONITOR-FAILED(CRITICAL)` | **yes** |
| stale head (2 h old), state reads all succeed | **1** | `FRESH(CRITICAL)` | **yes** |
| frozen/pinned head — run 1 of 2 | 0 | — | no |
| frozen/pinned head — run 2 of 2 | **1** | `FRESH-STUCK(WARN)` | **yes** |
| slow endpoint (8 s/call) vs a 5 s watchdog | **2** | `[WATCHDOG](CRITICAL)` | **yes** |
| `run-with-alert.sh` on a dead RPC (the launchd path) | **2** | — | **yes** |

**No false OKs.** Every blind mode exits non-zero and raises an alert, and the launchd wrapper
fans a monitor failure out even when the monitor itself never got far enough to alert on its own.

Two honest caveats the runbook must carry:

1. **A frozen endpoint is invisible for one full cycle.** `FRESH-STUCK` compares against the
   *previous* run's block number, so the first run after an endpoint pins reports a clean OK. On a
   30-minute schedule that is up to 30 minutes of confident, wrong "all clear".
2. **`FRESH-STUCK` is only WARN**, while a dead endpoint is CRITICAL — the more dangerous failure
   is the quieter one.

---

## 7. Per-scenario summary

| # | Scenario | Time to detect | Lever used | Recovery | Residual damage |
|---|---|---|---|---|---|
| 1A | Phantom liquidity | ≤ 30 min, CRITICAL | `resetPoolAccounting` | **Full** | none |
| 1B | Real USDC shortfall | ≤ 30 min, CRITICAL (same codes as 1A) | `setMinSupplyAmount` + `deactivateAgent` to contain; treasury top-up to repair | **None on-chain** | full shortfall falls on whoever withdraws last |
| 2 | Large default | **Never — no overdue-loan check.** Liquidation must be polled | `liquidateLoan` (197 611 gas) | Partial by design: self-stake absorbed 50 % | victims lost 80 % of principal; mid-loan lender 0; ladder reset + 180 d lockout engaged; conservation exact; nothing stranded |
| 3 | Agent NFT moved mid-loan | ≤ 30 min, `NFT-MOVED(WARN)`, exit 1 | none needed | Loan closeable by borrower **or** holder; liquidation still works | collateral goes to the seller even when the buyer repays; a default lands on the buyer |
| 4 | Hostile owner key | 6 of 29 calls seen; the worst chain shows as **one WARN** | rotate all four owners — 6 tx — **only while you still hold the key** | None if the key is gone | up to `MAX_TIER_LIMIT` (10 000 USDC) unsecured per agent-pool; protocol brickable in one tx |
| 5 | Pause blast radius | n/a (`PAUS` CRITICAL if you did not do it) | — | — | **9 of 35 operations frozen**, including lender exits, repayment and `liquidateLoan` |
| 6 | Stuck / lying RPC | immediate, except a frozen head which needs 2 runs | second endpoint | n/a | up to one blind cycle on a freshly frozen endpoint |

---

## 8. Runbook statements that were WRONG or MISSING

| # | Runbook said | Drill found |
|---|---|---|
| 1 | §3.1 "**Do not run `resetPoolAccounting`**" (blanket) | Too blunt. It is the **correct and complete** fix for phantom liquidity (1A, restored exactly), and **harmful** on a real shortfall (1B, re-asserts liquidity that is not there). The runbook must make the operator establish which case they are in first — and must say the monitor cannot tell them. |
| 2 | §3.1a liquidation "socialises the shortfall pro-rata across lender principal … records a default (−50 pts, −100 above 10 000 USDC)" | Wrong on V6.2 + V4 in three ways. (a) The creator's **self-stake absorbs first and in full** (M2-b), outside the pro-rata pass. (b) The pro-rata basis is the principal **qualified at the loan's `startTime`** (L7), not all principal — a mid-loan lender bears nothing. (c) The penalty is `max(50, 100 × amount / 1 000 USDC)` capped at 1 000 — **240 points measured for a 2 400 USDC default** — plus `maxRepaidPrincipal → 0` and a **180-day lockout**. The −50/−100/10 000 figures are ReputationManagerV3's. |
| 3 | §5 "Blocks **6 of 18** measured operations" | 9 of 35 on V6.2's finer probe set. Same operation families; the number in the runbook is not comparable and should be stated as the list, not the ratio. |
| 4 | §6 gap 3 "Registry / **Reputation** / Faucet are one-step `Ownable`" | **ReputationManagerV4 is `Ownable2Step` and overrides `renounceOwnership` to revert.** Only the registry and the faucet are one-step — and both are **renounceable**, which the runbook never says. `registry.renounceOwnership()` permanently destroys `deactivateAgent`, the lever the runbook itself recommends. |
| 5 | §3.3 "`registry.deactivateAgent(agentId)` **is** a per-agent kill switch" | True, and now quantified: it breaks **exactly one** operation (`requestLoan` for that agent) against pause's nine, and is reversible. Worth promoting from a footnote to the default containment move. |
| 6 | §4 lever table | Missing every V7 lever: `setTierLimits`, `setLadderParameters`, `setDefaultLockout`, `setLatePenaltyParameters`, `setBonusReferenceAmount`, `setValidationRegistry`, `setValidationBonusParameters`, `authorizePool`, `reactivateAgent`, `faucet.setClaimAmount` / `setMaxEligibleAgentId`. |
| 7 | §4 `setMinSupplyAmount` "Does not apply to top-ups by existing lenders" | Still true, but incomplete on V6.2: it is now a **maintained floor** — a *partial* withdrawal may not leave a position in `(0, minSupplyAmount)` — and the **pool creator is exempt on both sides** (M2). Raising it mid-incident changes what existing lenders may withdraw. |
| 8 | §2.1 "`node scripts/op-resilience/read-mainnet-levers.js`" | That script loads the **ReputationManagerV3 ABI** against the V4 address and the V6.1 ABI against V6.2. It still runs, but silently omits the tier table, ladder parameters, lockout, late-penalty parameters, V4 `pendingOwner` and the M2 self-stake views — i.e. most of what a V7 incident turns on. |
| 9 | §2.3 "As of 2026-09-22 Arc mainnet holds 0.000014 USDC, 1 pool, 0 active loans, 1 agent" | Stale pointer — that was the V6.1 marketplace. The canonical V6.2 at `0xCb23f2fb…` holds `accumulatedFees` 0.000014, 1 pool, `nextLoanId` 2, 1 agent, unpaused, `migrationFinalized` true, owner = secure wallet (read live 2026-09-23, block 22 287 733). |
| 10 | — (absent) | **There is no overdue-loan detector.** The monitor exits 0 with a loan a day past `endTime`. `liquidateLoan` is the protocol's only recovery action and nothing pages anyone to run it. Closed by `scripts/incident-drill/check-overdue-loans.js`, now a daily job in runbook §7. |
| 11 | — (absent) | **The monitor checks only the MARKETPLACE owner.** Registry, reputation-manager and faucet ownership changes — including one-step transfer and permanent renounce — are invisible. So are `authorizePool`, `revokePool`, `setValidationRegistry`, `setBindBorrowToPoolCreator`, and every fee/limit/scoring lever. 23 of 29 successful hostile owner calls produce no signal at all. |

Three further additions the rewritten runbook now carries: the marketplace is one USDC pot across
all pools (§1); a frozen RPC is invisible for one full cycle and only WARNs (§6); and a legitimate
agent sale latches a standing non-zero alert for the life of the loan (§3).

---

## 9. Reproducing this

```bash
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
cd ~/Specular
git apply forensics/output/testing-2026-09-23/incident-drill.patch

npx hardhat node                                    # terminal 1
npx hardhat compile                                 # terminal 2
node scripts/incident-drill/read-live-levers.js     # READ-ONLY against Arc mainnet
npx hardhat run --network localhost scripts/incident-drill/deploy-v7-local.js
for s in s0-baseline s2-large-default s3-nft-move s5-pause-blast-radius s1-insolvency s4-hostile-owner; do
  npx hardhat run --network localhost scripts/incident-drill/$s.js
done
node scripts/incident-drill/s6-rpc-blind.js

# the daily job the monitor does not do (read-only, safe against mainnet)
node scripts/incident-drill/check-overdue-loans.js
```

Results land in `forensics/output/testing-2026-09-23/incident-drill/`. Every scenario runs inside
`evm_snapshot`/`evm_revert`, so they can be re-run in any order against one deployment.
`deploy-v7-local.js` overwrites `src/config/local-addresses.json`, which is the file the monitor
reads for `V6_MONITOR_NETWORK=local`.
