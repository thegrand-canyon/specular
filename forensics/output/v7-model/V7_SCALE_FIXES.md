# V7 scale-and-gas fixes — `AgentLiquidityMarketplaceV62` + `ReputationManagerV4`

**Date:** 2026-09-22 · **Branch:** `arc-mainnet-launch` (isolated worktree, synced to `767ed14`)
**Spec:** `forensics/output/v7-model/V7_SCALE_AND_GAS_REPORT.md` §6 (the prioritised must-fix list).
**Execution:** entirely local — Foundry (solc 0.8.20, optimizer 200 runs, viaIR) and hardhat on
chainId 31337. **Nothing was deployed or broadcast to any network.** No RPC was contacted at all.

Patch: `forensics/output/v7-model/v7-scale-fixes.patch` (`git apply` from the repo root; includes the
four harness files from `v7-scale-harness.patch` plus the new `test/foundry/V7ScaleFixes.t.sol`, so it
applies to a clean checkout of `arc-mainnet-launch` on its own).

---

## 0. Status

| # | Finding | Priority | Status |
|---|---|---|---|
| 1 | Lender-slot squat (D1) + it bricks the agent's own M2-c stake (D2) | P1 | **Fixed** — maintained floor + reserved creator slot |
| 2 | `resetPoolAccounting` unbounded in `agentLoans[]` (D7) | P1 | **Fixed** — rebuilt from `activeLoanIds` |
| 3 | `openLoans` loanId collision across marketplaces (D9) | P2 | **Fixed** — namespaced per authorized marketplace |
| 4 | `requiredSelfStake` returns 0 after an agent-NFT transfer (D13) | P2 | **Fixed (view)** — resolved by agentId. Economic half unchanged: **keep M-1 ON** |
| 5 | `getActiveAgents()` unbounded (D8) | P2 | **Fixed** — paginated overload added; old form kept and documented as legacy |
| 8 | Effective third-party lender cap is 49, not 50 | doc | **Documented in code** — and now a hard, deliberate guarantee |
| 7 | `repayLoan` reaches a 30M block near 530 lenders | doc | **Documented in code** at `MAX_LENDERS_PER_POOL`. Cap **not** raised |

| | |
|---|---|
| Bytecode, marketplace | 21,192 → **21,440 B** (+248), **3,136 B** of headroom against the 24,576 limit |
| Bytecode, reputation manager | 11,070 → **11,413 B** (+343), 13,163 B of headroom |
| Worst user-facing gas regression | `withdrawLiquidity` partial trim **+2,274 (+3.26 %)**; one boundary `supplyLiquidity` case +4,578 (+2.89 %) |
| Worst-case paths | `repayLoan` 1,972,711 (15.2× headroom) · `liquidateLoan` 1,372,614 (21.9× headroom) — both essentially unmoved |
| `npm test` | **860 passing / 5 pending / 0 failing** (baseline identical) |
| `npx hardhat test test/v7/*.js` | **95 passing** (baseline identical) |
| `forge test` (excl. soak) | **55 passed / 0 failed** — 42 pre-existing + 13 new |
| Soak | 26,989 ops executed, **0 invariant violations** |
| Slither High/Medium | **0 new**; one Medium (`incorrect-equality`) removed |

The V7 economic properties are intact: M2-a self-stake lock, M2-b first-loss ordering, M2-c gate,
the M1 ladder and the capped owner-settable tier table are untouched. F-01/F-02/F-03/F-05/F-07
regression suites all still pass (`test/v7/V62-PriorFixesRegression.test.js`, 95/95).

---

## 1. P1 — the lender-slot squat (D1 + D2)

### Mechanism

`minSupplyAmount` (the F-C lever, 10 USDC live on Arc mainnet) was enforced **only when a NEW slot was
claimed** — V6.2 line ~325, gated on `!isInPoolLenders[agentId][msg.sender]` — and was never re-checked
on withdrawal. So:

1. squatter supplies exactly `minSupplyAmount`, taking a slot;
2. squatter withdraws all but **one base unit** (0.000001 USDC). The H-2 slot-free condition is
   `position.amount == 0 && position.earnedInterest == 0`, which a dust remainder never satisfies;
3. the slot is held forever for 1 base unit. Fifty of those and `poolLenders` is full.

`compactPoolLenders` only de-duplicates; it does not evict. There was **no on-chain remedy**.

V6.2 made it strictly worse than V6.1: M2-c requires `positions[agentId][pool.agentAddress].amount > 0`
before any sub-100 %-collateral loan, and that position exists only by calling `supplyLiquidity`, which
pushes onto the same capped array. The creator was exempt from `minSupplyAmount` but **not** from the
capacity check — so a squatted pool could never support unsecured borrowing again (report D2).

### The fix, and why this one

Two changes, because the finding has two independent halves.

**(a) `minSupplyAmount` is now a MAINTAINED floor** (`withdrawLiquidity`). A partial withdrawal that
would leave `0 < remaining < minSupplyAmount` is refused with `"Remaining below minimum supply"`.

Options considered (the report's (a)/(b)/(c)):

* *Owner eviction of sub-minimum positions* — rejected. It hands the owner a new power to move other
  people's capital, which is the F-08 shape the V7 design deliberately avoids, and it is reactive:
  the pool is already bricked by the time anyone notices.
* *Force a full exit instead of reverting* — rejected. `withdrawLiquidity(agentId, X)` transferring
  more than `X` is a genuinely nasty surprise for an integrator's accounting and for any contract
  lender. The client's remedy for a revert is one call with the full balance; the remedy for a silent
  over-transfer is a reconciliation bug.
* *Reject the dust-leaving partial withdrawal* — **chosen.** A few lines, explicit, and it closes the
  mechanism at its root rather than cleaning up after it.

Two exemptions keep the legitimate cases working, and both are tested:

* **A full exit is ALWAYS allowed.** This includes a position that is below a *raised* minimum — the
  owner may raise `minSupplyAmount` at any time, and an existing 2-USDC position under a new 100-USDC
  floor can still be withdrawn in full (it just cannot be withdrawn *partially*).
* **The pool creator is exempt**, symmetrically with the M2-a supply-side exemption. M2-c can
  legitimately require less than `minSupplyAmount` (a 50-USDC loan at the 75 %-collateral tier needs
  only 6.25 USDC of stake at `k = 2`), and the creator's position is already locked by M2-a while
  borrowing. Without this, the floor would make small honest borrowing impossible.

**(b) The last lender slot is RESERVED for the pool creator** (`_claimLenderSlot`). A third party may
not take the 50th slot while `isInPoolLenders[agentId][pool.agentAddress]` is false; it is refused with
`"Last slot reserved for agent self-stake"`. The creator itself is never refused for this reason.

This is what actually closes D2, and it holds *regardless of how much capital the attacker is willing
to lock* — (a) alone only raises the price. The reservation is checked **only at the boundary**
(`len == MAX_LENDERS_PER_POOL - 1`), so the ordinary supply path pays nothing for it.

`seedPosition` now goes through the same helper, so operator error during a migration cannot brick the
agent's self-stake either. Its revert string changes from `"Lender cap"` to
`"Pool lender capacity reached"` (owner-only, pre-finalization path).

### Reproduction tests

`test/foundry/V7ScaleFixes.t.sol` — six tests, all of which fail on the pre-fix contracts:

| Test | Asserts |
|---|---|
| `test_P1_squat_cannot_leave_a_dust_position` | the D1 withdraw is refused; the squatter still holds the full floor |
| `test_P1_full_exit_is_always_allowed` | a full exit works and frees the slot |
| `test_P1_partial_withdrawal_above_the_floor_still_works` | 100 → 10 USDC partial is untouched |
| `test_P1_position_below_a_raised_minimum_is_still_withdrawable` | owner raises the floor 1 → 100 USDC; the 2-USDC position still exits in full |
| `test_P1_creator_is_exempt_from_the_withdraw_floor` | creator may hold and partially withdraw a sub-floor self-stake |
| `test_P1_last_slot_is_reserved_for_the_creator_self_stake` | 49 third parties fill the pool, the 50th is refused, **the agent then supplies and borrows** |
| `test_P1_reservation_released_once_the_creator_holds_a_slot` | with the creator in, the pool is simply full at 50 |

`test/foundry/V7Dos.t.sol` D1/D2 were rewritten to assert the fixed outcome (they failed with
`Remaining below minimum supply` immediately after the fix, which is the demonstration).

### Gas delta

| path | report | fixed | Δ |
|---|---|---|---|
| `withdrawLiquidity` LIFO trim (partial), any N | 69,683 | **71,957** | +2,274 (+3.26 %) |
| `withdrawLiquidity` full exit @N=50 | 195,118 | **195,202** | +84 (+0.04 %) |
| `supplyLiquidity` fresh slot, N < 49 | 158,676 | **158,773** | +97 (+0.06 %) |
| `supplyLiquidity` fresh slot **at the boundary** (N=50) | 158,676 | **163,254** | +4,578 (+2.89 %) |

The floor check is ordered so a **full exit never even reads `minSupplyAmount`** — the path that must
always work is also the cheapest. The partial path pays one cold SLOAD. The boundary supply pays two
cold SLOADs (`pool.agentAddress` + the creator's membership flag) and only on the 50th slot.

### Client-visible behaviour changes

1. **`withdrawLiquidity` can now revert `"Remaining below minimum supply"`.** A client that lets a user
   withdraw an arbitrary amount must either clamp the input so the remainder is `0` or
   `>= minSupplyAmount()`, or catch this string and offer "withdraw everything". Read
   `minSupplyAmount()` (currently 10 USDC on Arc mainnet, 1 USDC on staging); when it is `0` nothing
   changes at all.
2. **`supplyLiquidity` can now revert `"Last slot reserved for agent self-stake"`.** Surface it as a
   distinct message — it means "this pool is full *for third parties*", not "something went wrong".
   `MAX_THIRD_PARTY_LENDERS_PER_POOL` (= 49) is published on the contract for exactly this.
3. The effective third-party cap of 49 is now a **guarantee**, not an accident (see §6).

### Residual, accepted and documented

* The squat is **priced, not eliminated**: 49 slots now cost 49 × `minSupplyAmount` of genuinely
  locked, at-risk capital (490 USDC at the live lever) instead of 49 base units. That is simply
  "being a lender", and those lenders bear default loss like any other. It still denies the pool
  *third-party* liquidity; it can no longer deny the agent its own credit line. With
  `minSupplyAmount == 0` the squat is free again — **the F-C lever must stay on**.
* A lender who withdraws all principal but leaves unclaimed `earnedInterest` keeps its slot until it
  calls `claimInterest` (the deliberate audit-2026-08 behaviour that keeps `resetPoolAccounting`'s
  interest sum complete). That is a second, much more expensive way to hold a slot: it requires having
  had real principal at risk across a full loan. Not changed here; worth watching.
* D3/D4 (a squat raising a borrower's repay cost and another lender's exit cost) are **not** closed —
  the gas curves are inherent to `MAX_LENDERS_PER_POOL` and are unchanged. What changed is that the
  attacker can no longer buy them for dust.

---

## 2. P1 — `resetPoolAccounting` unbounded walk (D7)

### Mechanism

`resetPoolAccounting` rebuilt `totalLoaned` by walking `agentLoans[pool.agentAddress]`, which is
append-only and never pruned: 4,625 gas per historical loan, 59,006 gas at 1 loan, 1,904,707 at 400.
It lost 3× block headroom at ≈ 2,140 lifetime loans and became **uncallable at ≈ 6,473**. This is the
§S5 failure shape surviving inside the owner's *emergency repair tool* — the one function reached for
when a pool is already broken, on exactly the high-activity agent most likely to break it. (The live
Arc v4 agent #43 already had 777+ lifetime loans; the soak drives 3,183 in one campaign.)

### The fix

Rebuild `totalLoaned` from `activeLoanIds[agentId]` — bounded by `MAX_ACTIVE_LOANS_PER_AGENT = 10`,
already maintained at disburse/close, and already the authority everywhere else in the contract. No
pagination is needed, so the paginated alternative (`resetPoolAccountingFrom`) was not taken: it would
add API surface and an operator footgun (a half-applied reset) for no benefit over an O(1) bound.

Two consequences, both deliberate:

* **The `"Agent transferred; resync via migration helpers"` guard is removed.** It existed *only*
  because `agentLoans` is ADDRESS-keyed, so a transferred NFT split the history across two addresses
  and the walk would undercount. `activeLoanIds` is agentId-keyed and follows the agent, so the reason
  is gone — and the tool now works on a transferred agent, which is precisely when an operator is most
  likely to need it. (Owner-only; it re-derives state from positions and the active set, so it cannot
  invent liquidity.)
* The rebuilt figure counts exactly the loans the contract itself treats as outstanding, so it can no
  longer disagree with `activeLoanCount` / `outstandingPrincipal`.

`agentLoans[]` still grows without bound (it is the per-agent loan history and clients read it), but
**nothing iterates it on any reachable path any more** — the only remaining walk is
`_countActiveLoansFromArray`, an unused `internal` function retained for test reference, which the
optimizer does not emit.

### Reproduction tests

| Test | Asserts |
|---|---|
| `test_P1_resetPoolAccounting_is_flat_in_loan_history` | gas @200 loans < gas @1 loan + 5,000 (pre-fix: 131,562 vs 16,102) |
| `test_P1_resetPoolAccounting_still_rebuilds_totalLoaned` | with two loans open: `totalLoaned`, `totalLiquidity`, `availableLiquidity` all exact |
| `test_P1_resetPoolAccounting_works_after_an_nft_transfer` | no longer reverts; rebuilds correctly (pre-fix: `Agent transferred; resync via migration helpers`) |
| `V7Dos::test_D7_...` | flat, and < 10M (3× block headroom) at 400 loans of history |

### Gas delta

| path | report | fixed | Δ |
|---|---|---|---|
| `resetPoolAccounting` (50 lenders, 1 loan of history) | 398,723 | **385,609** | **−13,114 (−3.3 %)** |
| `resetPoolAccounting` @400 loans of history | 1,904,707 | **≈ flat** (falls slightly as storage warms) | — |

It gets *cheaper* even in the best case, because the removed `agentRegistry.ownerOf()` external call
and the `agentLoans` array copy-to-memory both went away.

### Client-visible behaviour change

`resetPoolAccounting(agentId)` no longer reverts for a transferred agent. Operator runbooks that route
transferred agents to `seedPool`/`seedPosition` can stop doing so.

---

## 3. P2 — `openLoans` loanId collision across marketplaces (D9)

### Mechanism

`ReputationManagerV4.openLoans` was keyed by the bare `loanId`, and every marketplace starts
`nextLoanId` at 1. Authorizing a second V6.2 on the same manager — the side-by-side pattern in
`V7_MAINNET_MIGRATION_RUNBOOK.md` — made the second one's `requestLoan` revert `"Loan already recorded"`
for any id currently open on the first. It cleared as soon as that loan closed, so the failure was
**intermittent**, which makes it worse to diagnose than a permanent one.

### The fix, and why namespacing rather than forbidding

`openLoansByKey` is keyed by `keccak256(abi.encode(msg.sender, loanId))` — the calling marketplace's
own namespace. `loanKey(pool, loanId)` and `openLoans(pool, loanId)` are published for clients.

The alternative was an explicit revert in `authorizePool` forbidding a second marketplace. **Rejected**,
for one decisive reason: `ReputationManagerV4` ships **no reputation seeder, on purpose** (that is the
F-08 owner-drain shape). Running a new marketplace side by side on the same manager is therefore the
*only* way to upgrade the marketplace without wiping every agent's score — exactly the pain the V7
migration is paying today. Forbidding it would make that permanent, to save a keccak per loan.

### Reproduction tests

| Test | Asserts |
|---|---|
| `test_P2_two_marketplaces_do_not_collide_on_loanId` | both marketplaces open loanId 1; both records exist with the right amounts; closing one leaves the other byte-identical |
| `V7Dos::test_D9_...` | as above, plus `loanKey(mpA,1) != loanKey(mpB,1)` |

### Gas delta

`requestLoan` +601 (+0.12 %), `repayLoan` +304 (+0.02 % at N=50), `liquidateLoan` +222…+326 (+0.02 %).
That is the keccak plus the two view indirections in §4; the whole of it is under 0.15 % on every path.
**Storage is unchanged** — 2,455 permanent marketplace slots per 200 round trips, identical to the
report's measurement.

### Client-visible behaviour change — **BREAKING**

**The one-argument `openLoans(uint256 loanId)` getter is gone.** It is replaced by
`openLoans(address pool, uint256 loanId) → (uint128 amount, uint64 start, uint64 agentId)`, the same
tuple shape as before. The old form was *removed* rather than left returning zeros for a raw id, so a
stale client fails loudly instead of silently reading an empty record. Call sites updated in this
patch: `test/v7/M1-ReputationManagerV4.test.js`, `test/v7/M2-SelfStake.test.js`,
`test/v7/V62-PriorFixesRegression.test.js`, `test/sdk-v7/02-v7-integration.test.js`.

**Not updated (follow-up):** `scripts/e2e-v7/v5-loanid-passthrough.js` reads `rep.openLoans(loanX)` in
five places; it is a staging e2e script, not part of any suite, and it must be updated before it is run
again against a redeployed manager. The SDK, the Python client, the MCP/REST server and the monitor do
**not** read `openLoans` at all (verified by grep) — no other client is affected.

---

## 4. P2 — `requiredSelfStake` returns 0 after an agent-NFT transfer (D13)

### Mechanism

`requiredSelfStake(agentId, additionalAmount)` resolved the collateral tier with
`reputationManager.calculateCollateralRequirement(pool.agentAddress)`. `AgentRegistryV2` **deletes**
`addressToAgentId[seller]` when the agent NFT is transferred, so the lookup fell through to agentId 0 →
score 0 → tier 0 → 100 % collateral → `_requiredSelfStake` returns 0: *"no first-loss stake needed"*.
Measured 500 USDC before the transfer, **0 after**. Same class as the 2026-09-20 `canTopUp` bug: a view
that disagrees with the transaction, which evaluates the tier of the *caller* (the new holder, who
resolves correctly).

### The fix

`ReputationManagerV4` gains `collateralRequirementOf(uint256 agentId)` and `interestRateOf(uint256)`,
mirroring the existing `creditLimitOf(uint256)`; the address-keyed forms now delegate to them, so there
is one implementation and they cannot drift. `requiredSelfStake` resolves by `agentId`. Nothing else
about M2-c changed — the transaction path was already correct.

### Reproduction test

`test_P2_requiredSelfStake_survives_an_nft_transfer` — asserts `after == before` (pre-fix:
`0 != 500000000`) and that `collateralRequirementOf(1)` still reports the agent's real tier.

### Gas delta

Included in the +601 / +304 above (one internal jump each). `requiredSelfStake` itself is a view.

### Residual — **this does not make an agent NFT safe to sell**

Only the **view** was wrong. The economics are unchanged and still depend on the M-1 lever:

> The M2 self-stake is `positions[agentId][pool.agentAddress]` — the **seller's** capital, locked by
> M2-a and first-loss under M2-b. With `bindBorrowToPoolCreator` **off**, the buyer of the NFT borrows
> unsecured against it and the seller cannot withdraw it. **Keep M-1 ON.**

`V7Dos::test_D13_...` still asserts that residual explicitly, so it cannot regress unnoticed.
Making the stake follow the NFT would need a stake-migration path on transfer; out of scope here, and
it deserves its own design pass.

---

## 5. P2 — `getActiveAgents()` unbounded (D8)

### Mechanism

5,482 gas per pool; past a 30M `eth_call` cap at ≈ 5,472 pools. It is a view, so it cannot brick a
transaction — but the dashboard and the hosted API both call it and would simply start failing, on a
node-dependent threshold, with no warning.

### The fix

```solidity
function getActiveAgents(uint256 start, uint256 count)
    external view returns (uint256[] memory active, uint256 nextStart);
```

`count` is how many `agentPoolIds` entries to **scan**, not how many actives to return — a page may
return fewer than `count`. `nextStart` is the cursor and equals `totalPools()` when the walk is done;
an out-of-range `start` returns an empty page rather than reverting. The zero-argument overload is
**kept** (backward compatible, ~90 bytes) and its NatSpec now says plainly that it is legacy and
unbounded.

### Reproduction test

`test_P2_getActiveAgents_is_paginable` — 10 pools, walked in pages of 4, reassembled and compared
element-by-element against the unpaginated result; plus the out-of-range case.

### Gas delta

None on any state-changing path (the +44 on `createAgentPool` and +22 on `claimInterest` are
selector-dispatch growth from the added public functions, not this function).

### Client-visible behaviour change — **follow-up required**

`mcp-server/src/reads.ts` still calls the unbounded form at lines **276**, **498** and **842**. Those
should move to the paginated form (ethers needs the explicit signature for an overload:
`c.marketplace["getActiveAgents(uint256,uint256)"](start, count)`) and `mcp-server/abi/…V62.json` must
be regenerated. **Not done in this patch** — the hosted server has its own test and deploy path, and
another agent is working in the main checkout. It is not urgent: Arc mainnet has 1 pool today and the
cliff is ~5,472.

---

## 6. Documented, not changed

**The effective third-party lender cap is 49, not 50.** It was previously an emergent property (the
creator consumes a slot it cannot vacate while borrowing); it is now a deliberate, enforced reservation
(§1b). Published on the contract as `MAX_THIRD_PARTY_LENDERS_PER_POOL` and documented at
`MAX_LENDERS_PER_POOL`. Every "N=50" row in the gas tables means 49 third parties **plus** the agent.

**`repayLoan` reaches a 30M block at roughly 530 lenders.** ~32,700 gas per lender on `repayLoan` and
~24,600 on `liquidateLoan`; at 50 that is 1.97 M / 1.37 M, i.e. 15.2× / 21.9× headroom on Arc.
Extrapolated, a cap of 200 would still fit (~6.6 M) but a cap of 500 would not.
**`MAX_LENDERS_PER_POOL` was NOT raised**, and the constant now carries a do-not-raise-without-
re-measuring note naming both figures.

---

## 7. Validation

### Gas, versus the report's published numbers

Same methodology: `forge test --isolate`, `vm.lastCallGas().gasTotalUsed`, identical scenarios. The
report's own V6.1 control column reproduces verbatim, so the two runs are comparable.

| Path | Report (V6.2) | Fixed | Δ | % |
|---|---|---|---|---|
| `supplyLiquidity` fresh slot (N < 49) | 158,676 | 158,773 | +97 | +0.06 % |
| `supplyLiquidity` fresh slot **@N=50 boundary** | 158,676 | **163,254** | +4,578 | **+2.89 %** |
| `supplyLiquidity` top-up (all four arms) | 78,684 / 95,958 / 85,131 | +134 each | +134 | +0.17 % |
| `withdrawLiquidity` **partial (LIFO trim)** | 69,683 | **71,957** | +2,274 | **+3.26 %** |
| `withdrawLiquidity` full exit @N=50 | 195,118 | 195,202 | +84 | +0.04 % |
| `repayLoan` on time @N=50 | 1,858,912 | 1,859,216 | +304 | +0.02 % |
| `repayLoan` **WORST** (53 d late, 10 active, tranches, N=50) | 1,972,407 | **1,972,711** | +304 | +0.02 % |
| `liquidateLoan` lossy @N=50 | 1,185,087 | 1,185,413 | +326 | +0.03 % |
| `liquidateLoan` **WORST** (every path, N=50) | 1,372,392 | **1,372,614** | +222 | +0.02 % |
| `requestLoan` (any N) | 514,027 | 514,628 | +601 | +0.12 % |
| `claimInterest` | 51,168 | 51,190 | +22 | +0.04 % |
| `resetPoolAccounting` (1 loan of history) | 398,723 | **385,609** | **−13,114** | **−3.29 %** |

Block headroom is unchanged to two significant figures: `repayLoan` **15.2×**, `liquidateLoan`
**21.9×**. Every other path stays above 50×.

### Suites

```
$ npm test
  860 passing (2m) · 5 pending · 0 failing            [baseline: 860 / 5 / 0]

$ npx hardhat test test/v7/M1-ReputationManagerV4.test.js \
                   test/v7/M2-SelfStake.test.js \
                   test/v7/V62-PriorFixesRegression.test.js
  95 passing                                          [baseline: 95]

$ forge test --gas-limit 100000000000000 --no-match-path "test/foundry/V7Soak.t.sol"
  Ran 8 test suites: 55 tests passed, 0 failed, 0 skipped
  V6Invariants 6 · V61Invariants 6 · V7Invariants 7 · V61Gas 1 · V7Gas 6
  · V7Dos 13 · V7Storage 3 · V7ScaleFixes 13        [baseline: 42; +13 new]

$ SOAK_OPS=40000 forge test --match-path test/foundry/V7Soak.t.sol --gas-limit 100000000000000
  SOAK | ops executed 26989 · invariant violations 0 · nextLoanId 3227
                                                      [baseline: 26,976 ops, 0 violations]
```

Storage is unchanged: 2,455 permanent marketplace slots per 200 loan round trips (report: 2,455).

### The DoS matrix, re-run

`test/foundry/V7Dos.t.sol` was updated in place so the matrix is now a **regression suite** for the
fixed behaviour. Immediately after the fix, before the assertions were rewritten, the 7 rows below
failed — which is the demonstration that each previously-successful attack no longer works:

| # | Pre-fix outcome | Post-fix |
|---|---|---|
| **D1** | 50 slots for 50 base units, permanently | **BLOCKED** — `Remaining below minimum supply`. A slot costs a full, locked `minSupplyAmount` |
| **D2** | agent can never post its M2-c stake; no on-chain remedy | **BLOCKED** — 50th third party refused `Last slot reserved for agent self-stake`; the agent supplies and borrows on a fully squatted pool |
| **D3** | +576,483 gas on every future repay, bought for dust | **PRICED** — gas curve unchanged (inherent to the 50-lender cap), now costs 49 × `minSupplyAmount` of at-risk capital |
| **D4** | exit cost 72 k → 195 k, bought for dust | **PRICED** — same |
| **D7** | uncallable past ≈ 6,473 loans | **FLAT** — O(≤10); asserted < 10M at 400 loans |
| **D9** | second marketplace reverts `Loan already recorded` | **NO COLLISION** — distinct keys, independent lifecycles |
| **D13** | view collapses 500 USDC → 0 | **AGREES** — resolved by agentId. Economic residual asserted, M-1 must stay ON |

D5, D6, D8, D10, D11, D12 are unchanged and still pass. D8's unbounded view remains, with the
paginated form added alongside (§5).

### Slither

```
$ slither contracts/core/AgentLiquidityMarketplaceV62.sol \
    --solc-remaps "@openzeppelin/=node_modules/@openzeppelin/"
```

Run against the pre-fix sources and the fixed sources, with line numbers normalised and compared:

* **High/Medium findings before:** 10 — 1 High (`incorrect-exp`, inside OpenZeppelin's `Math.mulDiv`),
  11 `divide-before-multiply` occurrences (all pre-existing: `calculateInterest`, the M1-5 late
  penalty, OZ Math), 6 `incorrect-equality`, 1 `unused-return` (the ERC-8004 `getSummary` call).
* **After:** 9. **Zero new High or Medium.** One Medium removed — the `incorrect-equality` on
  `recordBorrow`'s `openLoans[loanId].start == 0` check, which the namespaced key replaced.

---

## 8. Files changed

| File | Change |
|---|---|
| `contracts/core/AgentLiquidityMarketplaceV62.sol` | `_claimLenderSlot` (creator-slot reservation, shared by `supplyLiquidity` + `seedPosition`); maintained `minSupplyAmount` floor in `withdrawLiquidity`; `resetPoolAccounting` rebuilt from `activeLoanIds`; `requiredSelfStake` resolved by agentId; `getActiveAgents(start, count)`; `MAX_THIRD_PARTY_LENDERS_PER_POOL`; cap/headroom NatSpec |
| `contracts/core/ReputationManagerV4.sol` | `openLoansByKey` namespaced by `keccak256(pool, loanId)`; `loanKey()`; `openLoans(pool, loanId)`; `collateralRequirementOf(agentId)`; `interestRateOf(agentId)` |
| `test/foundry/V7ScaleFixes.t.sol` | **new** — 13 tests, one per finding, each written to fail pre-fix |
| `test/foundry/V7Dos.t.sol` | D1/D2/D3/D4/D7/D9/D13 rewritten to assert the fixed outcomes |
| `test/v7/*.js`, `test/sdk-v7/02-v7-integration.test.js` | `openLoans` call sites take the pool address |

## 9. Open items

1. **`scripts/e2e-v7/v5-loanid-passthrough.js`** still calls the removed one-argument `openLoans`.
   Update before the next staging e2e run.
2. **`mcp-server/src/reads.ts:276,498,842`** still call the unbounded `getActiveAgents()`; the hosted
   server's ABI needs regenerating for the paginated form. Not urgent (1 pool live, cliff ≈ 5,472).
3. **D3/D4 remain open by design** — bounded, priced, and inherent to `MAX_LENDERS_PER_POOL`.
4. **The `earnedInterest` slot-retention path** (§1, residual) is a second, far costlier way to hold a
   slot. Not closed here.
5. **The M-1 lever must stay ON** until the self-stake follows the agent NFT (§4 residual).
6. **The F-C lever (`minSupplyAmount`) must stay > 0** — the maintained floor is a no-op at 0.
7. Nothing here touches F-04's residual attacker EV. The V7 model still **prices** the bust-out rather
   than closing it; see `V7_DESIGN_AND_VALIDATION.md` §6.
