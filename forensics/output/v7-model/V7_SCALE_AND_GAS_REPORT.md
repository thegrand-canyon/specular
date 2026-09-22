# Specular V7 — scale and gas report (`AgentLiquidityMarketplaceV62` + `ReputationManagerV4`)

**Date:** 2026-09-22 · **Branch:** `arc-mainnet-launch` (isolated worktree at `57ac03e`)
**Execution:** entirely local — Foundry (`forge 1.7.1`, solc 0.8.20, optimizer 200 runs, viaIR, evm `paris`)
and hardhat on chainId 31337. **Nothing was broadcast to Arc mainnet, Arc staging or Base.** The only
network access was one read-only `eth_getBlockByNumber` against each Arc RPC to read the real block gas limit
(§2), and it wrote nothing.

**No contract was modified.** All four harness files are new test files; `git diff -- contracts/` is empty.
The harness is attached as `forensics/output/v7-model/v7-scale-harness.patch` (4 files, 1,909 lines).

---

## 0. Headline

| | |
|---|---|
| Worst case `repayLoan` | **1,972,407** gas (50 lenders, all with pending tranches, 10 active loans, 53 days late) — **15.2× headroom** on Arc's 30M block |
| Worst case `liquidateLoan` | **1,372,392** gas (50 lenders, all tranches, self-stake first loss + both L7 passes + interest socialisation + 50-slot prune) — **21.9× headroom** |
| Paths with **< 3× block headroom** | **None** among user-facing paths. One owner-only path degrades without bound: `resetPoolAccounting` (§2.2) |
| Regressions vs V6.1 **> 10 %** | **3 rows** — `requestLoan` steady-state **+10.8 %**, `liquidateLoan` lossy **+18.7…23.7 %**, `liquidateLoan` worst case **+25.0…27.3 %**. Everything else ≤ 3.1 % |
| Soak | **26,976 operations executed** (40,000 attempted) across 5 agents / 10 lenders / 3,183 loans / 724 liquidations / 1,591 NFT transfers, **0 invariant violations**, **0 gas drift** |
| DoS surfaces found | **2 that need a decision before mainnet lending** — the lender-slot squat now also bricks the agent's own M2-c self-stake (§3, D1/D2), and `resetPoolAccounting` is unbounded in loan history (§3, D7). Plus 3 medium/low (§3, D8/D9/D13) |
| Storage | **12.3 permanent marketplace slots per loan round trip**, never reclaimed. **V6.2 adds none** vs V6.1 (2,455 vs 2,464 slots over 200 round trips) |

**The V7 change does not create a liveness risk at the shipped caps.** The largest regression is in
`liquidateLoan`, which is exactly where M2-b/L7 added work, and it still sits at 22× block headroom.
The two things that must be decided before third-party lenders are invited are both **inherited**
scale problems that V7 makes worse rather than new V7 bugs.

---

## 1. Gas curves

### 1.1 Method, and why the numbers are continuous with the 2026-09-21 report

Metering is `vm.lastCallGas().gasTotalUsed` under `forge test --isolate` — each measured call is its own
transaction with cold storage. This is the identical method used for the V6.0-vs-V6.1 table in
`forensics/output/testing-2026-09-20/CONTRACTS_V6.1_TEST_REPORT.md` §5. Figures are **execution gas**:
a real transaction adds the 21,000 intrinsic cost plus calldata (~500 B for these calls), so add ≈ 21.5 k
for a tx-level number.

Continuity is not asserted, it is **re-measured**: the prior report's own suite (`test/foundry/V61Gas.t.sol`,
unmodified) was re-run in this worktree and reproduces its published numbers exactly.

```
$ forge test --isolate --match-path test/foundry/V61Gas.t.sol -vv
  GAS | scenario | V6.0 | V6.1 | delta
  GAS | supplyLiquidity fresh (new slot) | 224427 | 227037 | +2610
  GAS | repayLoan 50 lenders, no tranches | 1681007 | 1852743 | +171736
  GAS | liquidateLoan 50 lenders, lossy, all with pending tranches | 544190 | 998361 | +454171
  GAS | claimInterest | 51234 | 51216 | -18
  [PASS] test_gas_report()
```

Those three anchors (227,037 / 1,852,743 / 998,361) reappear verbatim as the V6.1 column of the new
`test/foundry/V7Gas.t.sol` tables below, which is what makes the two reports comparable.

**Pool composition.** Both stacks are driven with an *identical* lender set: slot 0 of every pool is the
agent itself. On V6.2 the M2-c gate forces the borrower to hold a lender position, so making V6.1 do the
same keeps `poolLenders.length` equal on both sides and the bounded loops iterate the same number of times.
`N` below is `poolLenders.length`, i.e. `N = 1 agent + (N−1) third parties`.

**Agent setup.** V6.1 agent is pumped to the 0 %-collateral tier on `ReputationManagerV3` (65 synthetic
completions). V6.2 agent is pumped on `ReputationManagerV4` through the real `recordBorrow` → warp 7 d →
`recordLoanCompletion` cycle (hold time is required for the M1-1 bonus) to score ≥ 800, then one
5,000-USDC on-time repayment so the ladder clears the tier cap. Shipped scoring parameters are restored
before measurement.

### 1.2 `supplyLiquidity` — FLAT in N (growth order O(1))

```
$ forge test --isolate --match-path test/foundry/V7Gas.t.sol --match-test test_gas_supply -vv
```

| Scenario | N=1 | N=10 | N=25 | N=50 | growth | V6.1 @N=50 | Δ | flag |
|---|---|---|---|---|---|---|---|---|
| fresh slot (N=1 is the first-ever supply, cold pool) | 227,076 | 158,676 | 158,676 | 158,676 | **flat** | 158,637 | +39 | — |
| top-up, no loan in flight — case (a) | 78,684 | 78,684 | 78,684 | 78,684 | **flat** | 78,645 | +39 | — |
| top-up mid-loan, pending create — case (b) | 130,158 | 95,958 | 95,958 | 95,958 | **flat** | 95,919 | +39 | — |
| top-up merge — case (d) | 85,131 | 85,131 | 85,131 | 85,131 | **flat** | 85,092 | +39 | — |
| top-up fold — case (c) | 85,131 | 85,131 | 85,131 | 85,131 | **flat** | 85,092 | +39 | — |
| fold with the active-loan set at its 10 cap | — | — | — | 129,943 | **flat** | 129,904 | +39 | — |

`supplyLiquidity` touches no per-lender loop: it is O(1) in `poolLenders` and O(`activeLoanIds`) ≤ 10 in
the fold/merge arms. **V6.2 adds a constant +39 gas** (one extra `SLOAD` of `pool.agentAddress` for the
creator's `minSupplyAmount` exemption). The N=1 rows are higher only because the pool's own storage slots
are cold on the first supply.

### 1.3 `requestLoan` — FLAT in N; +48 k steady-state regression

| Scenario | N=1 | N=10 | N=25 | N=50 | growth | V6.1 | Δ | % | flag |
|---|---|---|---|---|---|---|---|---|---|
| first loan, no tranches | 504,427 | 514,027 | 514,027 | 514,027 | **flat** | 499,750 | **+14,277** | +2.9 % | — |
| all lenders carry a pending tranche (repeat loan) | 496,927 | 496,927 | 496,927 | 496,927 | **flat** | 448,450 | **+48,477** | **+10.8 %** | **FLAG** |
| the 10th (last legal) concurrent loan | — | — | — | 428,527 | **flat** | 380,050 | **+48,477** | **+12.7 %** | **FLAG** |

`requestLoan` does not loop over lenders at all — `_countActiveLoans` is the O(1) `activeLoanCount`
counter (the §S5 fix), and the credit/collateral/self-stake checks are all O(1). Flat in N, confirmed.

**Read the +48,477, not the +14,277.** On the *first* loan of an agent's life V3's `recordBorrow` also
writes two zero→non-zero slots, so the delta looks like +14 k. On every subsequent loan V3's slots are
already warm while V4's `openLoans[loanId]` is a **fresh** zero→non-zero slot every time (it is `delete`d
on close), so the steady-state overhead is +48 k. The components are: the `openLoans` slot (20,000), the
`positions[agentId][creator]` self-stake read, the external `reputationManager.creditMultiple()` call, and
the extra calldata word for `loanId`. It is constant per loan and does not grow with anything.

### 1.4 `repayLoan` — LINEAR in N (the `_distributeInterest` loop)

| Scenario | N=1 | N=10 | N=25 | N=50 | V6.1 @N=50 | Δ | % | flag |
|---|---|---|---|---|---|---|---|---|
| on time, no tranches | 256,029 | 550,944 | 1,041,431 | **1,858,912** | 1,852,743 | +6,169 | +0.3 % | — |
| on time, all lenders with pending tranches | 256,129 | 551,944 | 1,043,931 | **1,863,912** | 1,857,120 | +6,792 | +0.4 % | — |
| + 10 active loans on the agent | — | — | — | **1,887,912** | 1,881,743 | +6,169 | +0.3 % | — |
| 3 d late (inside the 30-day cap) | — | — | — | **1,948,369** | 1,910,693 | +37,676 | +2.0 % | — |
| 53 d late (beyond the cap) | — | — | — | **1,948,407** | 1,910,712 | +37,695 | +2.0 % | — |
| **53 d late + 10 active loans + tranches — WORST** | — | — | — | **1,972,407** | 1,934,712 | +37,695 | +2.0 % | — |

Growth order is **linear in N**, ≈ **32,700 gas per lender** (`(1,858,912 − 256,029) / 49`), which is the
two `qualifiedAmountAt` passes plus one `earnedInterest` SSTORE per lender. Bounded by
`MAX_LENDERS_PER_POOL = 50`. Pending tranches add ~100 gas/lender; a late repayment adds a fixed ~90 k
(V6.1 lateness records) of which V6.2's share is +37.7 k (the M1-5 late-penalty write path in
`ReputationManagerV4`: `lateCount` + the score update + `LateRepaymentRecorded`).

**No V6.2 regression on `repayLoan` at any N** — the largest is +2.0 %.

### 1.5 `liquidateLoan` — LINEAR in N; the one real regression

Two curves. In both the pool creator holds only the **minimum legal** self-stake (`loan/2` at `k = 2`),
so M2-b's first-loss pass cannot absorb the whole loss and the socialisation loops still run — otherwise
V6.2 measures *cheaper* than V6.1 purely because the creator ate the loss alone.

**(a) Lossy, every lender carrying a pending tranche** (the V6.1 report's published worst case):

| N | V6.1 | V6.2 | Δ | % | flag |
|---|---|---|---|---|---|
| 1 | 129,346 | 160,074 | +30,728 | **+23.7 %** | **FLAG** |
| 10 | 288,961 | 349,670 | +60,709 | **+21.0 %** | **FLAG** |
| 25 | 554,986 | 661,222 | +106,236 | **+19.1 %** | **FLAG** |
| 50 | **998,361** | **1,185,087** | +186,726 | **+18.7 %** | **FLAG** |

**(b) WORST CASE — every socialisation path in one call.** 50 lender slots each holding principal,
unclaimed interest *and* an unqualified pending tranche; the loss is 2× the self-stake (the maximum M2-c
allows at `k = 2`), so: M2-b takes the creator's whole position → L7 pass 1 (qualified basis) cannot cover
the remainder → L7 pass 2 (whole-principal basis) runs → the loss still exceeds Σ principal so
`_socializeInterestLoss` runs (three loops) → every lender ends empty so `_pruneEmptyLenders` pops all 50:

| N | V6.1 | V6.2 | Δ | % | flag |
|---|---|---|---|---|---|
| 1 | 132,312 | 168,504 | +36,192 | **+27.3 %** | **FLAG** |
| 10 | 310,275 | 390,934 | +80,659 | **+26.0 %** | **FLAG** |
| 25 | 605,331 | 758,979 | +153,648 | **+25.4 %** | **FLAG** |
| 50 | **1,097,091** | **1,372,392** | +275,301 | **+25.1 %** | **FLAG** |

The test asserts that all three paths actually ran, rather than assuming it: after the call the creator's
position is 0 (M2-b), a third party's *unqualified* pending dust is also 0 (only L7 pass 2 can take that),
and Σ `earnedInterest` strictly decreased (F-05). Without those assertions the scenario silently degrades
into a cheap one.

Growth order is **linear in N**, ≈ **24,600 gas per lender** on V6.2 vs ≈ 19,700 on V6.1. The +25 % is
structural and expected: L7 replaced V6.1's single pro-rata pass with two basis passes, and M2-b added the
first-loss `_takeFrom`. **At N=50 it is 4.6 % of an Arc block — 21.9× headroom.** This is the number to
re-measure if `MAX_LENDERS_PER_POOL` is ever raised (see §6, item 7).

### 1.6 `withdrawLiquidity`, `claimInterest`, `createAgentPool`, `register`

| Scenario | N=1/2 | N=10 | N=25 | N=50 | growth | V6.1 @N=50 | Δ | flag |
|---|---|---|---|---|---|---|---|---|
| `withdrawLiquidity` LIFO trim (pending shrunk) | 69,683 | 69,683 | 69,683 | 69,683 | **flat** | 67,560 | +2,123 (+3.1 %) | — |
| `withdrawLiquidity` **full exit** (slot freed) | 66,651 | 92,518 | 130,993 | **195,118** | **linear** | 192,995 | +2,123 (+1.1 %) | — |
| `claimInterest` | 51,168 | 51,168 | 51,168 | 51,168 | **flat** | 51,216 | −48 | — |
| `compactPoolLenders` (owner) | — | — | — | 399,136 | linear | 399,136 | 0 | — |
| `resetPoolAccounting` (owner, 1 loan of history) | — | — | — | 398,723 | see §2.2 | 398,723 | 0 | — |
| `createAgentPool` | 138,730 | | | | flat | 138,708 | +22 | — |
| `registry.register` | 260,310 | | | | flat | 260,310 | 0 | — |

The **full-exit** row is worth calling out: it is linear because `_removePoolLender` does a linear search
over `poolLenders`. 62 k at N=1 → 195 k at N=50, ≈ 2,700 gas per lender. Inherited unchanged from V6.1,
bounded at 50, and it is the mechanism behind griefing surface D4 (§3).

### 1.7 `ReputationManagerV4` measured directly — FLAT in repayment history

`history` is the number of prior completed loans on the agent. Measured at 0 and at 500.

| Call | RMV3 @0 | RMV3 @500 | **RMV4 @0** | **RMV4 @500** | growth | Δ vs V3 |
|---|---|---|---|---|---|---|
| `recordBorrow` | 78,485 | 78,485 | **65,637** | **65,637** | **flat** | −12,848 |
| `recordLoanCompletion` (on time) | 54,150 | 51,370 | **60,578** | **57,807** | **flat** | +6,428 |
| `recordLoanCompletion` (33 d late) | 39,767 | 39,767 | **77,741** | **77,741** | **flat** | +37,974 |
| `recordDefault` | 68,386 | 68,386 | **97,487** | **97,487** | **flat** | +29,101 |
| `calculateCreditLimit` (view; runs inside `requestLoan`) | 13,498 | 13,464 | **9,743** | **9,743** | **flat** | −3,755 |
| `calculateCollateralRequirement` (view; ditto) | 10,833 | 10,808 | **15,583** | **13,336** | **flat** | +2,528 |
| `requiredSelfStake` (view, V6.2 only) | n/a | n/a | **27,850** | **25,603** | **flat** | new |

**`ReputationManagerV4` holds no per-agent unbounded state.** `maxRepaidPrincipal`, `lockedUntil`,
`lateCount`, `totalBorrowed/Repaid`, `loanCount`, `defaultCount` are all scalars; `openLoans` is keyed by
`loanId` and `delete`d on every close. Every figure above is identical at 0 and 500 loans of history
(the small deltas on the on-time/view rows are warm-slot effects, not growth). The tier table is six
fixed-size arrays and `tierOf` iterates 6 entries.

Independently confirmed end-to-end over 300 sequential on-time loans on one agent (§3, D6): `repayLoan`
**falls** from 256,043 to 201,984 as slots warm, `maxRepaidPrincipal` holds at 5,000 USDC and
`creditLimitOf` holds at 5,000 USDC.

---

## 2. Block-limit headroom

### 2.1 The limit, read from the chain

```
$ curl -s -X POST -H 'Content-Type: application/json' \
    --data '{"jsonrpc":"2.0","method":"eth_getBlockByNumber","params":["latest",false],"id":1}' \
    https://rpc.mainnet.arc.io
=== https://rpc.mainnet.arc.io
number 22214469 gasLimit 30000000 gasUsed 1644514
=== https://rpc.testnet.arc.io
number 63457255 gasLimit 30000000 gasUsed 3156716
```

**Arc mainnet and testnet both report a 30,000,000 block gas limit.** Read-only; nothing was sent.
Figures below are execution gas as measured; add ~21.5 k for the tx envelope (it moves nothing materially).

### 2.2 Headroom per state-changing path (worst case measured)

| Path | Worst-case gas | % of a 30M block | **Headroom** | < 3×? |
|---|---|---|---|---|
| `repayLoan` (50 lenders, tranches, 10 active, 53 d late) | **1,972,407** | 6.57 % | **15.2×** | no |
| `liquidateLoan` (50 lenders, every socialisation path) | **1,372,392** | 4.57 % | **21.9×** | no |
| `requestLoan` (any N, 10th concurrent) | 514,027 | 1.71 % | 58.4× | no |
| `compactPoolLenders` (owner, 50 lenders) | 399,136 | 1.33 % | 75.2× | no |
| **`resetPoolAccounting` (owner)** | **unbounded in `agentLoans[]`** | — | **see below** | **YES, at scale** |
| `registry.register` | 260,310 | 0.87 % | 115× | no |
| `supplyLiquidity` (first supply into a cold pool) | 227,076 | 0.76 % | 132× | no |
| `withdrawLiquidity` (full exit at 50 lenders) | 195,118 | 0.65 % | 154× | no |
| `createAgentPool` | 138,730 | 0.46 % | 216× | no |
| `RMV4.recordDefault` (direct, owner tooling) | 97,487 | 0.32 % | 308× | no |
| `claimInterest` | 51,168 | 0.17 % | 586× | no |
| `pause` / `unpause` / setters / `withdrawFees` | < 60,000 | < 0.2 % | > 500× | no |

**`resetPoolAccounting` is the only path without 3× headroom, and only once an agent accumulates history.**
Measured (§3, D7): 59,006 gas at 1 loan, 1,904,707 gas at 400 loans → **4,625 gas per historical loan**,
because it walks `agentLoans[pool.agentAddress]`, which is append-only and never pruned.

* 3× headroom (10M) is lost at ≈ **2,140 lifetime loans** for one agent.
* The call becomes **uncallable** at ≈ **6,473 lifetime loans**.

For calibration: the live Arc v4 agent #43 already had **777+ lifetime loans** (CLAUDE.md), and the soak in
§4 drove 3,183 loans in one campaign. This is the §S5 failure shape — an O(N) walk over an unbounded
per-agent loan array — surviving in the owner's *emergency repair tool*, i.e. exactly the function an
operator reaches for when a pool is already broken. It is not on the user hot path, which is why it is
P1-operational rather than P0.

Read-only views are not block-limited but are `eth_call`-gas-limited by the node:
`getActiveAgents()` costs **5,482 gas per pool** and passes 30M at ≈ **5,472 pools** (§3, D8).

---

## 3. DoS / griefing matrix

All rows are `test/foundry/V7Dos.t.sol`, run with `--isolate`, with the live Arc-mainnet
`minSupplyAmount = 10 USDC` lever enabled. 13/13 pass.

```
$ forge test --isolate --match-path test/foundry/V7Dos.t.sol -vv
Suite result: ok. 13 passed; 0 failed; 0 skipped
```

| # | Attempted | Outcome | Severity |
|---|---|---|---|
| **D1** | Fill all 50 `poolLenders` slots with dust: supply `minSupplyAmount` (10 USDC) from 50 addresses, then withdraw all but **1 base unit** so the H-2 slot-free condition (`amount == 0 && earnedInterest == 0`) never fires | **SUCCEEDS, permanently.** 50/50 slots occupied for **50 base units (0.00005 USDC)** of locked capital and 11,590,562 gas total. A genuine lender is then refused `"Pool lender capacity reached"` forever | **HIGH (inherited F-06)** |
| **D2** | Same squat, then check what the *agent* can do | **New in V6.2: the agent can never post its M2-c self-stake** — `supplyLiquidity` reverts `"Pool lender capacity reached"` for the pool creator too (the creator is exempt from `minSupplyAmount`, **not** from the capacity check). It is on a 0 %-collateral tier, so `requestLoan` can never succeed. `compactPoolLenders` does **not** evict dust holders (50 slots before, 50 after) — there is **no on-chain remedy** | **HIGH (V7 escalation)** |
| **D3** | Use the squat to raise a *third party's* `repayLoan` cost | **SUCCEEDS.** 256,029 gas at 1 lender → **832,512** with 49 dust squatters. The attacker adds **576,483 gas to every future repayment** the borrower makes, forever (and up to +1.6 M if the squatters hold real principal — §1.4) | **MEDIUM** |
| **D4** | Use the squat to raise another lender's exit cost | **SUCCEEDS.** `withdrawLiquidity` full exit 71,998 → **195,118** (+123,120), via the linear `_removePoolLender` search | **LOW** (bounded, 154× headroom) |
| **D5** | Fill `activeLoanIds` to its 10 cap and thrash it (repay the oldest, reopen, ×20) | **BOUNDED.** The 11th loan is refused `"Too many active loans"`; worst `repayLoan` while thrashing is **313,351** gas; the active set never drifts from 10 | none |
| **D6** | Drive `maxRepaidPrincipal` and the ladder over 300 sequential on-time loans | **NO GROWTH.** `repayLoan` #1 = 256,043 → #300 = **201,984** (falls). `maxRepaidPrincipal` 5,000 USDC, `creditLimitOf` 5,000 USDC, stable | none |
| **D7** | Grow `agentLoans[]` and call the owner's `resetPoolAccounting` | **DEGRADES WITHOUT BOUND.** 59,006 gas @1 loan → **1,904,707 @400**; **4,625 gas per historical loan**; < 3× block headroom past ≈ 2,140 loans, uncallable past ≈ **6,473**. Self-inflicted by the agent, but it disables the *owner's* repair tool for that pool | **HIGH (operational)** |
| **D8** | Spam pools (`agentPoolIds` growth) and call `getActiveAgents()` | **DEGRADES WITHOUT BOUND.** 14,443 gas @2 pools → **2,750,452 @501**; **5,482 gas per pool**; passes 30M at ≈ **5,472 pools**. It is a view, so it cannot brick a transaction, but the dashboard/API path that calls it will start failing on nodes with an `eth_call` gas cap | **MEDIUM** |
| **D9** | Authorize a **second** V6.2 marketplace on the same `ReputationManagerV4` (the side-by-side migration shape) | **LIVENESS HAZARD.** Both marketplaces start `nextLoanId` at 1. `openLoans` is keyed by bare `loanId`, so the second marketplace's `requestLoan` reverts `"Loan already recorded"` for any id currently open on the first. It clears when the first loan closes, so it is intermittent rather than permanent — which makes it worse to diagnose | **MEDIUM** |
| **D10** | Leave a defaulted loan un-liquidated and try to recover the self-stake | **FROZEN INDEFINITELY.** After 10 simulated years overdue, `withdrawLiquidity(1)` by the creator still reverts `"Self-stake locked while borrowing"`; 2,500 USDC stays locked. Only `liquidateLoan` (owner-only) releases it | **MEDIUM (owner blast radius, known)** |
| **D11** | Have a third-party lender push the agent below its required self-stake | **REFUTED.** A lender exit cannot touch `positions[agentId][creator]`; it is refused `"Insufficient pool liquidity"` while the loan is out, and the stake is unchanged (500 USDC required, 500 USDC held) | none |
| **D12** | `pause()` while a loan is open | **CONFIRMS the known blast radius:** `repayLoan`, `liquidateLoan` *and* `withdrawLiquidity` are all blocked simultaneously — the borrower cannot close and the owner cannot liquidate | known, documented |
| **D13** | Transfer the agent NFT and read `requiredSelfStake` | **VIEW/TX MISMATCH.** 500 USDC before the transfer → **0 after**. The view resolves the tier through `pool.agentAddress`, whose `addressToAgentId` entry the registry *deletes* on transfer → agentId 0 → score 0 → 100 % collateral → "no stake needed". With the M-1 lever off, the **buyer then borrows 1,000 USDC unsecured against the seller's 2,500 USDC of locked first-loss capital**, which the seller cannot withdraw | **MEDIUM (LOW if M-1 stays ON)** |

### 3.1 Does self-stake interact badly with the 50-lender cap? Yes, two ways.

1. **The creator occupies a slot it cannot vacate while borrowing.** M2-c requires
   `positions[agentId][pool.agentAddress].amount > 0` for any sub-100 %-collateral loan, and that position
   only exists by calling `supplyLiquidity`, which pushes onto `poolLenders`. M2-a then forbids withdrawing
   it while `outstandingPrincipal > 0`. So **the effective third-party lender cap for any unsecured
   borrower is 49, not 50**, and the borrower's own slot is permanently consumed for the life of the loan.
   Every 50-lender figure in §1 therefore describes 49 third parties plus the agent.
2. **The capacity check has no creator exemption.** The 2026-09-22 design change exempted
   `pool.agentAddress` from `minSupplyAmount` but not from
   `require(poolLenders[agentId].length < MAX_LENDERS_PER_POOL)`. D2 shows the consequence: whoever fills
   the 50 slots first decides whether the agent can ever borrow unsecured, and no owner tool reverses it.

---

## 4. Soak

`test/foundry/V7Soak.t.sol` — **one** monotonically-growing state, not a Foundry invariant campaign (those
reset between runs, which would hide exactly the gas drift this is looking for). 5 agents (spread across
the 0 %, 75 % and 100 % collateral tiers) × 10 lenders + 5 NFT-transfer destinations, seeded
`keccak` PRNG, time travel, and 11 op classes. Each op is executed as an external self-call so every step
gets a fresh memory frame — running 25,000 ops inside one frame hits quadratic memory-expansion cost
(`MemoryOOG`) long before anything interesting happens.

Invariants asserted after **every successful operation**:

| | Invariant |
|---|---|
| (a) | exact solvency: `usdc.balanceOf(marketplace) == Σ availableLiquidity + accumulatedFees + Σ active collateral` |
| (a2) | per-pool conservation: `totalLiquidity == Σ position.amount` **and** `availableLiquidity + totalLoaned == Σ position.amount + Σ earnedInterest` |
| (b) | `pendingTranche.amount ≤ position.amount` for every lender |
| (h) | `outstandingPrincipal[agentId] == Σ ACTIVE principal` (ghost-tracked independently) |
| (M2) | `selfStake(agentId).amount == positions[agentId][pool.agentAddress].amount` |
| (M2a) | `selfStake(agentId).locked == (outstandingPrincipal[agentId] > 0)` — **exactly**, both directions |
| (M2c) | after every successful `requestLoan`, `selfStake ≥ requiredSelfStake` |
| (q) | `creditLimitOf(agentId) ≤ tierLimit(score) ≤ MAX_TIER_LIMIT` |
| (M1) | `maxRepaidPrincipal` is monotone non-decreasing, except a reset to exactly 0 in the same op as a default |
| (M1-3) | every liquidation leaves the agent locked out and its ladder at 0 |

```
$ SOAK_OPS=40000 forge test --match-path test/foundry/V7Soak.t.sol --gas-limit 100000000000000 -vv
[PASS] test_soak() (gas: 13310556386)
  SOAK | ops attempted 40000
  SOAK | ops executed 26976
  SOAK | invariant violations 0
  SOAK | final block.timestamp 14861498304
  SOAK | nextLoanId 3184
  ...
Suite result: ok. 1 passed; 0 failed; 0 skipped; finished in 14.66s
```

**26,976 operations executed, 0 invariant violations.** Executed-op profile:

| op | count | | op | count |
|---|---|---|---|---|
| `supplyLiquidity` | 8,725 | | `requestLoan` | 3,183 |
| `withdrawLiquidity` partial | 3,199 | | `repayLoan` early / on time / late / beyond cap | 622 / 588 / 596 / 653 |
| `withdrawLiquidity` full | 1,610 | | `liquidateLoan` (defaults) | **724** |
| `claimInterest` | 2,447 | | NFT transfers | 1,591 |
| time warps | 2,431 | | deactivate / reactivate | 304 / 303 |

Refusals observed (all correct): `Exceeds credit limit` 1,391 · `Self-stake locked while borrowing` 133 ·
`Insufficient self-stake` 2 · `Top-up would forfeit in-flight interest` 3 · `No interest to claim` 827.
The self-stake lock, the ladder cap, the F-02 top-up guard and the F-07 deactivation gate all fired in a
single campaign.

### 4.1 Gas drift — none

Average gas per op, bucketed into deciles of the run (decile 0 = the first 10 % of ops, decile 9 = the last):

| op | d0 | d1 | d2 | d3 | d4 | d5 | d6 | d7 | d8 | d9 | trend |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `repayLoan` | 147,679 | 149,175 | 144,836 | 148,805 | 146,986 | 143,447 | 149,333 | 144,960 | 148,224 | 147,325 | **flat** (−0.2 %) |
| `requestLoan` | 395,723 | 400,029 | 401,387 | 397,652 | 399,705 | 399,595 | 400,364 | 399,477 | 401,362 | 397,115 | **flat** (+0.4 %) |
| `supplyLiquidity` | 27,370 | 21,703 | 21,553 | 21,772 | 21,221 | 21,357 | 21,205 | 21,278 | 21,601 | 21,970 | **falls** (slots warm) |
| `liquidateLoan` | 29,600 | 24,832 | 24,901 | 24,661 | 24,891 | 24,834 | 24,754 | 24,743 | 24,904 | 24,834 | **falls** |

Nothing gets more expensive as state grows. `nextLoanId` reached 3,184 and simulated time advanced ~470
years; the last decile is as cheap as the first. (These are non-`--isolate` numbers with warm storage, so
they are lower than §1 — the *shape* is the result, not the level.)

---

## 5. Storage growth

`test/foundry/V7Storage.t.sol`, measured by exact state diff (`vm.startStateDiffRecording` /
`vm.stopAndReturnStateDiff`), counting slots that go **zero → non-zero** (permanent state, 20,000 gas once,
never reclaimed) and slots freed.

### 5.1 Per lifecycle step

```
$ forge test --match-path test/foundry/V7Storage.t.sol --gas-limit 100000000000000 -vv
```

| Step | new slots | freed | **net** | of which marketplace / reputation / registry |
|---|---|---|---|---|
| `registry.register` | 10 | 0 | **+10** | 0 / 0 / 10 |
| `createAgentPool` | 5 | 0 | **+5** | 5 / 0 / 0 |
| `initializeReputation` | 2 | 0 | **+2** | 0 / 2 / 0 |
| `supplyLiquidity` — first lender slot | 8 | 0 | **+8** | 7 / 0 / 0 (+1 USDC) |
| `supplyLiquidity` — creator self-stake slot | 4 | 0 | **+4** | 4 / 0 / 0 |
| `requestLoan` #1 | 20 | 0 | **+20** | 17 / 3 / 0 |
| `repayLoan` #1 | 8 | 6 | **+2** | 6 / 2 / 0 |
| **`requestLoan` #2 (marginal)** | 17 | 0 | **+17** | 16 / 1 / 0 |
| **`repayLoan` #2 (marginal)** | 2 | 6 | **−4** | 2 / 0 / 0 |
| `repayLoan` first LATE one | 6 | 6 | **0** | 5 / 1 / 0 |
| `liquidateLoan` (default) | 2 | 7 | **−5** | 0 / 2 / 0 |

Steady-state marginal cost of one loan round trip: **+17 − 4 = +13 net permanent slots**, of which
**~12.3 land on the marketplace** and **~0 on the reputation manager** (`openLoans` is written on
`recordBorrow` and `delete`d on close — it leaks nothing, on repayment *or* on default).

### 5.2 Long-lived agent — 200 round trips, and the V6.1 control

```
  STOR | 200 loan round trips (request + on-time repay) | newSlots=2459 | freedSlots=0 | rewritten=5 | new(mp/rep/registry/usdc)=2455/4/0/0
  STOR | V6.1: 200 loan round trips | newMarketplaceSlots=2464
```

| | permanent marketplace slots, 200 round trips | per round trip |
|---|---|---|
| V6.1 | 2,464 | 12.32 |
| **V6.2** | **2,455** | **12.28** |

**V6.2 adds no permanent storage growth.** This confirms the design doc's claim ("V6.2 adds no storage at
all") by measurement rather than by reading the layout: the small difference is the extra lender slot in
the V6.2 fixture, not a change in per-loan cost.

### 5.3 Projection for a long-lived agent

At 12.3 marketplace slots per loan round trip (the `loans[id]` struct, the `agentLoans[]` push, the
`repayments[id]` record, and the `activeLoanIds` churn), never pruned:

| lifetime loans | permanent slots | raw key+value bytes | one-off storage gas |
|---|---|---|---|
| 1,000 | 12,300 | ~0.79 MB | ~246 M |
| 5,000 | 61,400 | ~3.93 MB | ~1.23 G |
| 10,000 | 122,800 | ~7.86 MB | ~2.46 G |
| **6,473** (the D7 cliff) | ~79,600 | ~5.09 MB | — |

State size itself is not a problem on Arc — it is paid for a slot at a time by the agent that creates it,
and the hot paths are all O(1) in it (§1.7, §4.1). **What is unbounded and does bite is `agentLoans[]`**,
because `resetPoolAccounting` walks it (§2.2, D7). Nothing else grows without bound per agent:
`activeLoanIds` ≤ 10, `poolLenders` ≤ 50, `openLoans` is deleted on close, and every
`ReputationManagerV4` per-agent field is a scalar.

Globally unbounded: `agentPoolIds` (one entry per pool, walked only by the `getActiveAgents()` view — D8)
and `nextLoanId`/`loans` (one struct per loan ever, never iterated on any hot path).

---

## 6. Must-fix list before mainnet, prioritised

### P1 — decide before third-party lenders are invited

1. **The lender-slot squat now bricks the borrower too (D1 + D2).** 50 base units of USDC and ~11.6 M gas
   permanently occupy all 50 slots of any pool. That already locked out genuine lenders on V6.1
   (F-06, accepted as "still a lever"). **V6.2 makes it strictly worse: the pool creator needs one of those
   same 50 slots to post its M2-c first-loss stake, and it has no exemption from the capacity check.** A
   squatted agent can never take an unsecured loan, and `compactPoolLenders` does not evict dust.
   *Options, cheapest first:* (a) reserve index 0 of `poolLenders` for `pool.agentAddress` so the creator's
   slot can never be taken; (b) let the owner evict positions below `minSupplyAmount` (returning the dust);
   (c) make `minSupplyAmount` a **maintained** floor — on `withdrawLiquidity`, force a full exit if the
   remaining position would fall below it. (c) closes D1, D3 and D4 at once and is a few lines, but it
   changes lender UX and needs its own regression pass.
2. **`resetPoolAccounting` is unbounded in `agentLoans[]` (D7).** 4,625 gas per historical loan; < 3× block
   headroom past ~2,140 loans; uncallable past ~6,473. This is the §S5 shape in the owner's *emergency
   repair tool* — the one function reached for when a pool is already broken, on exactly the high-activity
   agent most likely to break it. *Fix:* rebuild `totalLoaned` from `activeLoanIds[agentId]` (≤ 10 entries,
   already maintained and already the authority elsewhere) instead of walking `agentLoans`, or add a
   paginated `resetPoolAccountingFrom(agentId, start, count)`.

### P2 — fix or explicitly accept, in writing

3. **`ReputationManagerV4`'s `loanId` namespace is global, not per-marketplace (D9).** Authorizing two
   V6.2 marketplaces on one manager makes `requestLoan` fail intermittently with
   `"Loan already recorded"`. *Fix:* key `openLoans` by `keccak(msg.sender, loanId)`. *Or:* never authorize
   two marketplaces on one manager, and state that as a hard rule in
   `V7_MAINNET_MIGRATION_RUNBOOK.md` — the runbook's side-by-side pattern is exactly the shape that trips it.
4. **`requiredSelfStake` returns 0 after an agent-NFT transfer (D13).** Same class as the 2026-09-20
   `canTopUp` bug: a view that disagrees with the transaction. It resolves the collateral tier through
   `pool.agentAddress`, which the registry un-maps on transfer. *Fix:* resolve the tier by `agentId`
   (an agentId-keyed `collateralRequirementOf(agentId)` on V4, mirroring `creditLimitOf`). *Meanwhile:*
   **keep the M-1 lever ON** — with it off, a buyer borrows unsecured against the seller's locked
   first-loss capital, which the seller cannot withdraw.
5. **`getActiveAgents()` is unbounded (D8)** — 5,482 gas per pool, past 30M at ~5,472 pools. A view, so it
   cannot brick a transaction, but the dashboard and the hosted API depend on it. *Fix:* paginate
   (`getActiveAgents(uint256 start, uint256 count)`), and stop calling the unbounded form off-chain.

### P3 — accept, document, and watch

6. **`liquidateLoan` is +25 % vs V6.1** (1,372,392 worst case, 21.9× headroom). Structural: L7's two basis
   passes plus M2-b's first-loss `_takeFrom`. Accept.
7. **Do not raise `MAX_LENDERS_PER_POOL` without re-measuring.** `repayLoan` costs ~32,700 gas per lender
   and `liquidateLoan` ~24,600. At 50 that is 1.97 M / 1.37 M. Extrapolated, `repayLoan` reaches 30M at
   roughly **530 lenders** — so a cap raised to 200 would still fit (~6.6 M) but a cap of 500 would not.
   The whole §S5 class of failure comes back the moment that loop is unbounded.
8. **The effective third-party lender cap is 49**, not 50, for any agent borrowing below 100 % collateral
   (§3.1). Document it in the SDK/MCP and the dashboard so a 50th genuine lender's refusal is explainable.
9. **`requestLoan` costs +48 k per loan in steady state vs V6.1** (§1.3) — the fresh `openLoans` slot each
   loan. Deliberate (it is what makes the M1-1 hold-time bonus exact). Accept; it is ~0.16 % of a block.
10. **The self-stake is frozen for as long as the owner does not liquidate (D10).** Keep the liquidation
    cron running and alerting; an un-liquidated default freezes the agent's own capital indefinitely.
11. **`pause()` still blocks repay + liquidate + lender exit simultaneously (D12).** Known; prefer
    `registry.deactivateAgent` as the per-agent kill switch.

---

## 7. Files, totals and reproduction

New test files (the whole harness; **no contract was touched**):

| File | What it does |
|---|---|
| `test/foundry/V7Gas.t.sol` | V6.1-vs-V6.2 gas curves, 99 measured rows across 6 tests, identical scenarios on both stacks |
| `test/foundry/V7Dos.t.sol` | 13 concrete DoS/griefing attempts, each with its outcome asserted |
| `test/foundry/V7Soak.t.sol` | 26,976-op randomised soak with 10 invariants after every op and per-decile gas drift |
| `test/foundry/V7Storage.t.sol` | exact state-diff storage accounting, V6.2 and the V6.1 control |

Attached as `forensics/output/v7-model/v7-scale-harness.patch` (`git apply` from the repo root).

Totals after this round, all green:

```
$ forge test --gas-limit 100000000000000 --no-match-path "test/foundry/V7Soak.t.sol"
Ran 7 test suites: 42 tests passed, 0 failed, 0 skipped (42 total tests)
   V6Invariants 6 · V61Invariants 6 · V7Invariants 7 · V61Gas 1 · V7Gas 6 · V7Dos 13 · V7Storage 3

$ npx hardhat test test/v7/M1-ReputationManagerV4.test.js test/v7/M2-SelfStake.test.js test/v7/V62-PriorFixesRegression.test.js
  95 passing (5s)
```

Reproduce:

```bash
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
forge test --isolate --match-path test/foundry/V61Gas.t.sol -vv        # continuity with 2026-09-21
forge test --isolate --match-path test/foundry/V7Gas.t.sol   -vv        # §1 gas curves
forge test --isolate --match-path test/foundry/V7Dos.t.sol   -vv        # §3 DoS matrix
forge test --match-path test/foundry/V7Storage.t.sol --gas-limit 100000000000000 -vv   # §5
SOAK_OPS=40000 forge test --match-path test/foundry/V7Soak.t.sol --gas-limit 100000000000000 -vv  # §4, ~15 s
```

The soak and storage suites need the raised `--gas-limit`: Foundry's default test gas limit is 2^30, and a
single test driving 40,000 operations exceeds it. `SOAK_OPS` shortens the campaign for CI.
