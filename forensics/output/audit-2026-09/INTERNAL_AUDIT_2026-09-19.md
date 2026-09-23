# Specular — Internal Adversarial Audit of the Arc MAINNET Deployment (2026-09-19)

**Scope (Sourcify exact_match to repo source, branch `arc-mainnet-launch`):**
`AgentLiquidityMarketplaceV6.sol` (`0xb9996de05fD514A0cB2B81fa25448EECD4559Aaa`), `AgentRegistryV2.sol`
(`0x6F1EbF50…fBF5`), `ReputationManagerV3.sol` (`0x1577Eb99…aE5e`), `AgentCreditFaucet.sol` (`0xD854F800…57bF`).
USDC = Arc native-token ERC-20 view `0x3600…0000` (6 dec).

**Method:** full source read of the four contracts; prior-context review (SELF_AUDIT_2026-08, ARC_MAINNET_DEPLOY_PREP,
WORLDCLASS audit-package, AUDIT_BUNDLE); baseline `npm test` (588 passing); live-chain state read-back of every lever
and owner slot; slither 0.11.4 re-run (`slither-2026-09-19.txt/.json` alongside this file); adversarial reasoning
across accounting, reputation economics under the *live* lever values, access control, liquidation, rounding, DoS,
reentrancy/native-token semantics, faucet, identity/NFT; and **a proof-of-concept Hardhat test for every finding**
under `test/audit-2026-09/`. Contracts were **not** modified.

**PoC convention:** each finding's primary `it` asserts the *secure* property, so a **failing test = CONFIRMED**.
`R00-RefutedHypotheses.test.js` holds hypotheses that were tested and hold (all green).
Run: `npx hardhat test test/audit-2026-09/*.test.js` → 19 passing / 11 failing (the 11 red tests are the confirmations).
⚠ Because `hardhat.config.js` sets `paths.tests: ./test`, plain `npm test` now also runs these and reports 11 failures —
exclude the directory in CI or flip the assertions once fixed.

---

## Executive summary

The money accounting that the 2026-08 self-audit hardened (exact solvency, H-1/§S1, H-2, H-3, D4 pro-rata loss,
§S5 counters, register() CEI, M-3) **holds** — I could not break global solvency, duplicate a lender, bypass the
aggregate credit limit, out-run the reputation rate-limit with concurrency, or reenter. Nine such hypotheses are
recorded as refuted with passing tests.

What the prior rounds missed is **identity-vs-address coupling on the loan-closing path** and **the economics of
"time-gated" reputation**:

1. **F-01 (HIGH, confirmed)** — `repayLoan` and `liquidateLoan` resolve the agent by `loan.borrower` *address* through
   `ReputationManagerV3` (`require(agentId != 0, "Not an agent")`). A borrower who transfers their agent NFT to any fresh
   wallet makes their active loan **impossible to repay or liquidate** until they move it back. Lenders' principal is
   stuck in `totalLoaned` (D4 socialisation never runs), collateral is stranded, and the borrower chooses when — if
   ever — the loan closes. Registry transfers are not pausable. Requires a marketplace redeploy (one-line fix).
2. **F-04 (HIGH, design — D1 quantified)** — under the exact live levers a self-lending agent farms 100 → 600 (0 %
   collateral, **25,000 USDC** unsecured limit) in **25 days for 0.125 USDC of fees** (+ ~0.6 USDC gas); the working
   capital (~200 USDC) is fully recovered. A 25k bust-out costs **100 points = 5 days** to re-farm. D1 is time-gated,
   not economically gated. Owner-tunable levers can raise the time cost ~5–10× today; the real fix is a model change.
3. **F-02 (MEDIUM, confirmed — the smoke-test observation)** — any top-up resets `depositTimestamp` and forfeits the
   **whole position's** interest on every in-flight loan; the forfeited interest goes to other qualified lenders — a
   borrower who self-lent the 1-USDC minimum at pool creation captures it, making its loan cost the 1 % fee only — or
   to protocol fees. Not third-party forceable; it is a UX trap with unbounded loss relative to the trigger.
4. **F-08 (MEDIUM, owner blast-radius, confirmed live)** — `migrationFinalized == false` on mainnet: `seedPool` /
   `seedPosition` are live owner powers that can seed a position and drain any funded pool. **One owner tx fixes it.**
5. **F-03 (MEDIUM)** — late repayment has *no* cost (nominal-duration interest, no reputation penalty); THREAT_MODEL.md's
   claim to the contrary is false for V3. Combined with F-01 this is open-ended free credit at the 0 %-collateral tier.

Live exposure today is nil (pool #1 has 0 liquidity, 4 loans all closed, faucet unfunded). **Do not solicit third-party
lender USDC until F-01 is redeployed and F-08 is finalised.**

---

## Severity table

| ID | Sev | Finding | Status | PoC (red = confirmed) | Fix type |
|----|-----|---------|--------|------------------------|----------|
| F-01 | **HIGH** | Borrower freezes an active loan (un-repayable, un-liquidatable) by transferring the agent NFT; un-freezes at will | **CONFIRMED** | `test/audit-2026-09/F01-NFTTransferFreezesLoan.test.js:46,50` | **REDEPLOY** (marketplace only) |
| F-04 | **HIGH** (design) | D1 farming to 0 %-collateral tier: 25 days, 0.125 USDC fees; bust-out penalty re-farmed in 5 days | **CONFIRMED** (numbers) | `F04-D1FarmingEconomics.test.js:64,84` | Lever now (partial) + **REDEPLOY** ReputationManager for the model |
| F-02 | MEDIUM | Top-up resets `depositTimestamp` → forfeits whole position's in-flight interest; self-lending borrower captures it | **CONFIRMED** | `F02-TopUpForfeitsInterest.test.js:44,75` | **REDEPLOY** (accrual model); SDK guard now |
| F-03 | MEDIUM | Late repayment: nominal-duration interest, `onTime=false` applies **no** penalty; borrower front-runs liquidation | **CONFIRMED** | `F03-LateRepayNoPenalty.test.js:43` | **REDEPLOY** (marketplace and/or ReputationManager) |
| F-08 | MEDIUM | `migrationFinalized == false` on mainnet → owner key can seed positions and drain pools | **CONFIRMED** (live state + PoC) | `F08-MigrationNotFinalized.test.js:29` | **OWNER TX** `setMigrationFinalized()` |
| F-05 | LOW | Loss > Σ principal is silently dropped; unclaimed interest becomes FCFS, last claimant reverts "Drain underflow" | **CONFIRMED** | `F05-LossExceedsPrincipal.test.js:60` | **REDEPLOY** |
| F-06 | LOW (griefing) | 50-slot squat costs 50 USDC *recoverable* at live `minSupplyAmount`; no eviction tool | **CONFIRMED** | `F06-SlotSquat.test.js:35` | Lever now (≤100 USDC → 5k lock); REDEPLOY for eviction |
| F-07 | LOW | `deactivateAgent` is a no-op for the marketplace — no per-agent kill switch | **CONFIRMED** | `F07-DeactivatedAgentCanBorrow.test.js:27` | **REDEPLOY** |
| I-1 | Info | Registry / Reputation / Faucet remain one-step `Ownable` with `renounceOwnership` (D5 fixed only the marketplace) | PLAUSIBLE (by reading) | — | REDEPLOY or accept |
| I-2 | Info | `resetPoolAccounting` after an F-05-style under-recovered liquidation re-creates phantom liquidity (owner tool) | PLAUSIBLE (by reading) | — | Runbook note |
| I-3 | Info | Native-USDC specifics: forced native donations break the `==` monitor; sub-1e12 native dust invisible; exact-balance repay fails because gas is the same asset | PLAUSIBLE | — | Monitor/SDK |
| I-4 | Info | `setPlatformFeeRate` applies retroactively to loans already active (fee computed at repay) | PLAUSIBLE | — | Accept / snapshot at request (REDEPLOY) |
| I-5 | Info | `pause()` freezes lender `withdraw`/`claim` — D5 residual | Known | — | Accept |
| I-6 | Info | THREAT_MODEL.md states a late-repay penalty exists; it does not | Doc | — | Fix doc |

Refuted (green tests in `R00-RefutedHypotheses.test.js`): R-1 NFT-transfer credit-limit reset (D2), R-2 rate-limit
bypass via 10 concurrent loans, R-3 §B1/H-2 duplicate-lender, R-4 faucet NFT-cycling (M-3), R-5 H-3 aggregate limit,
R-6 dust-loan reputation, R-7 M-1 bypass via transfer/second pool, R-8 H-1 fee-routing solvency, R-9 `msg.value`
into non-payable entrypoints. Also refuted by reasoning (below): reentrancy via the native-USDC ERC-20 view, SafeERC20
code-size assumptions, cross-pool credit bypass with multiple agents per wallet.

---

## Findings

### F-01 — Agent NFT transfer freezes an active loan (HIGH)

**Mechanism.** `repayLoan` (L534) calls `reputationManager.recordLoanCompletion(loan.borrower, …)` and `liquidateLoan`
(L650) calls `recordDefault(loan.borrower, …)`. Both resolve `agentRegistry.addressToAgentId(borrower)` and
`require(agentId != 0, "Not an agent")` (ReputationManagerV3 L230, L276). `AgentRegistryV2._update` deletes
`addressToAgentId[from]` on every transfer (L307). ERC-721 transfers are not gated by the registry's `whenNotPaused`.
So after `transferFrom(borrower, anyFreshWallet, agentId)`:

- `liquidateLoan` reverts `Not an agent` — the loan can never be defaulted, `_socializeLoss` never runs, `totalLoaned`
  and `outstandingPrincipal`/`activeLoanCount` never decrement, collateral stays in the contract.
- `repayLoan` reverts too — but only the borrower can un-freeze (transfer back), and then repays with nominal interest
  and no penalty regardless of how late (F-03).

The self-audit's D2/F3 reviewed NFT transfers for credit-limit reset and mapping collision, not for the *closing* path.

**Impact with real USDC.** For a 0 %-collateral loan (score ≥ 600, up to 25k/50k) this is open-ended credit the owner
cannot terminate; lenders cannot exit that principal (`availableLiquidity` excludes it) and the loss is never
socialised. For collateralised loans, the borrower's collateral is stranded as well. Even a *legitimate* agent sale with
an open loan bricks that loan. Also a subtler variant: after transferring away and re-registering, `repayLoan` credits
the on-time bonus to the borrower's *new* agentId.

**PoC.** `F01-NFTTransferFreezesLoan.test.js` — both primary tests fail with `Not an agent`; the demonstration test
shows transfer-back → repay succeeds 8 days late with an unchanged score, solvency intact.

**Fix (REDEPLOY marketplace only — ReputationManagerV3 can stay).** Resolve the agent from the loan's agentId, not the
historical address. The registry keeps `addressToAgentId[ownerOf(id)] == id` in `_update`, so:

```solidity
// repayLoan
address holder = agentRegistry.ownerOf(loan.agentId);
reputationManager.recordLoanCompletion(holder, loan.amount, onTime && heldLongEnough && paidInterest);
// liquidateLoan
reputationManager.recordDefault(agentRegistry.ownerOf(loan.agentId), loan.amount);
```
Cleaner long-term: add `recordLoanCompletionById(uint256 agentId, …)` / `recordDefaultById` to the reputation manager
and stop routing through addresses at all. Also consider `require(activeLoanCount[id] == 0)` in a registry transfer
hook (needs a registry→marketplace link) — optional, the above is sufficient.

**Interim (no redeploy):** none on-chain. Monitor registry `Transfer` events for agents with `activeLoanCount > 0`
and disclose to lenders; keep third-party liquidity out until redeployed.

---

### F-04 — D1 reputation economics under the live levers (HIGH, design)

See the dedicated section below for numbers. **PoC:** `F04-D1FarmingEconomics.test.js` (fees ≥ 250 USDC and
penalty ≥ 500 pts both fail: actual 0.125 USDC and 100 pts).

**Fix.** Owner-tunable *today* (partial): `setReputationRateLimit(5, 1 days)` (→ 100 days to 600),
`setScoringParameters(10, 200, 300, 10_000e6)` (max penalties → a 25k default costs 300 pts = 15 days at 20/day or
60 days at 5/day), `setBonusReferenceAmount(1000e6)` (forces 1,000-USDC loans; fees ×10 — still ~1.3 USDC).
Model fix (REDEPLOY ReputationManager): bonus ∝ interest paid to **non-self** lenders (exclude the borrower's own
lender share in `_distributeInterest` and pass "third-party interest" to the reputation call); default → drop to the
floor of the tier below plus a lock-out window; slashable stake or attestation for the 0 %-collateral tiers.

---

### F-02 — Top-up resets `depositTimestamp` (MEDIUM)

**Mechanism.** `supplyLiquidity` L249 sets `position.depositTimestamp = block.timestamp` on *every* supply (W1
sandwich defence). `_distributeInterest` L559/584 qualifies a lender only if `depositTimestamp <= loanStartTime` and
then shares by the *whole* `p.amount`. Consequences:

- A 1-base-unit top-up on a 10,000-USDC position forfeits that position's share of **every** in-flight loan (up to
  10 concurrent, up to 365 days). Loss is unbounded relative to the trigger.
- Withdrawals do **not** reset the timestamp (asymmetry, variant C): a lender may shrink mid-loan and stay qualified.
- Forfeited interest is redistributed to remaining qualified lenders. A borrower that self-lent the 1-USDC minimum
  at pool creation is *permanently* qualified; when a real lender tops up, the borrower receives ~100 % of the interest
  it pays (variant A: 148.5 of 150 USDC back; net loan cost = the 1 % fee). Socially, the borrower is incentivised to
  ask lenders to "add more" while loans are open.
- If nobody else qualifies the interest goes to `accumulatedFees` (variant B — the mainnet smoke-test observation).

**Forceability.** No third party can touch another lender's position; `seedPosition` is owner-only (but live — F-08).
Interaction with H-2 slot reclaim is benign (full withdraw + re-supply *should* re-qualify from the new time).
`minSupplyAmount` does not apply to top-ups, so the cheapest trigger is 1 base unit. The SDK `supply()`
(`src/sdk/SpecularQuickstart.js:321`) performs no active-loan check and issues no warning.

**Severity.** MEDIUM — real funds loss, but victim-triggered by a normal action, no on-chain warning, unbounded ratio.

**Fix.**
*Minimal (REDEPLOY):* never reset the timestamp of qualified principal; hold top-ups in a pending tranche.
```solidity
struct LenderPosition { uint256 amount; uint256 earnedInterest; uint256 depositTimestamp;
                        uint256 pendingAmount; uint256 pendingTimestamp; }
// supplyLiquidity:
if (activeLoanCount[agentId] == 0) {            // nothing in flight: merge everything, reset is harmless
    position.amount += position.pendingAmount + amount; position.pendingAmount = 0;
    position.depositTimestamp = block.timestamp;
} else {                                        // loans in flight: only the NEW tranche is unqualified
    position.pendingAmount += amount; position.pendingTimestamp = block.timestamp;
}
// _distributeInterest qualified amount:
q = (p.depositTimestamp <= start ? p.amount : 0) + (p.pendingTimestamp <= start ? p.pendingAmount : 0);
```
(withdraw takes from pending first, then amount; promote pending→amount lazily whenever `activeLoanCount == 0`).
A weighted-average timestamp is **not** recommended: with `a0` old capital held for `T` it re-admits a JIT top-up of
`a0·T/(now−start)`, partially re-opening W1.
*Proper (REDEPLOY):* time-weighted accrual — at disbursement the nominal interest is known, so stream it as a
`rewardPerShare` over `[startTime, endTime]` with lender checkpoints on every supply/withdraw (StakingRewards pattern);
on early repay distribute the remainder at repay. This also closes D6 (JIT) and removes both 50-lender loops.
*Now (no redeploy):* SDK/dashboard guard — refuse or warn on `supply()` when `activeLoanCount(agentId) > 0 &&
position.amount > 0`; document the behaviour.

---

### F-03 — Late repayment has no cost (MEDIUM)

**Mechanism.** `repayLoan` charges `calculateInterest(amount, rate, loan.duration)` — nominal duration, never elapsed
time. `recordLoanCompletion(…, onTime=false)` has no penalty branch (ReputationManagerV3 L234–266). The only sanction is
owner-initiated `liquidateLoan`, which `repayLoan` can front-run at any time. THREAT_MODEL.md's "Default penalty is
enforced via recordLoanCompletion(onTime=false)" is incorrect.

**Impact.** Past `endTime` every extra day of a 0 %-collateral loan is free; with F-01 the borrower can also make
liquidation impossible during that period. The liquidation cron is the only backstop and it races the borrower.

**PoC.** `F03-LateRepayNoPenalty.test.js` — 293 days late: paid exactly the 7-day interest, score unchanged; second
test shows the front-run. **Fix (REDEPLOY):** `interest = calculateInterest(amount, rate, max(duration, elapsed))`
(and/or a late-fee multiplier), plus a late penalty in `recordLoanCompletion` (`onTime=false → −penaltyBase/2`), and
consider permissionless `liquidateLoan` after a grace period.

---

### F-08 — Migration helpers live on mainnet (MEDIUM, owner blast radius)

**Live state (read 2026-09-19):** `migrationFinalized = false`, owner = secure wallet, `pendingOwner = 0`. Nothing was
migrated to this deployment, so `seedPool`/`seedPosition` have no legitimate remaining use. A compromised/coerced owner
key can `seedPool(totalLiquidity ×2)` then `seedPosition(attacker, X)` and `withdrawLiquidity(X)` from any funded pool
(the Σpositions ≤ totalLiquidity check is satisfied by the first call). Also `seedPool` zeroes `totalLoaned` on a pool
with active loans, which would make the next `repayLoan` underflow-revert.

**PoC.** `F08-MigrationNotFinalized.test.js` — primary test fails (seedPosition does not revert); demonstration drains
a 10,000-USDC lender position. **Fix: OWNER TX** `setMigrationFinalized()` — irreversible, no redeploy.

---

### F-05 — Loss beyond principal strands unclaimed interest (LOW)

`availableLiquidity` includes unclaimed `earnedInterest`, which is lendable. `_socializeLoss` only scales
`position.amount` and caps at `totalPrincipal`; any loss beyond principal is dropped, so booked `earnedInterest` becomes
unbacked and `claimInterest` turns FCFS ("Drain underflow" for the last claimant — here the *defaulting* borrower, as a
lender, claims first). Global solvency still holds. **PoC:** `F05-LossExceedsPrincipal.test.js`. **Fix (REDEPLOY):**
either socialise across `earnedInterest` in a second pass, or exclude unclaimed interest from lendable liquidity
(`require(amount <= availableLiquidity − pool.unclaimedInterest)` with an aggregate tracked at distribute/claim).
**I-2 runbook note:** do not run `resetPoolAccounting` on such a pool — it rebuilds `availableLiquidity` from booked
interest and would re-create phantom liquidity.

---

### F-06 — Lender-slot squat is cheap and unevictable (LOW, griefing)

At the live `minSupplyAmount = 1 USDC`, 50 Sybil addresses lock a pool with **50 USDC of recoverable capital** and
collect a share of its interest. `compactPoolLenders` only dedups; there is no eviction. **PoC:** `F06-SlotSquat.test.js`.
**Lever now:** `setMinSupplyAmount(100e6)` (cap) → 5,000 USDC to squat a pool. **REDEPLOY:** replace the bounded lender
array with the accrual model (F-02 "proper" fix) so the cap disappears, or add owner eviction of zero-yield squatters.

---

### F-07 — No per-agent kill switch (LOW)

The marketplace never reads `agents[id].isActive` / `isAgentActive()`. A deactivated agent can create a pool, take
supply and borrow. The only response to a detected bad actor is global `pause()`, which also freezes honest lenders'
exits (I-5). **PoC:** `F07-DeactivatedAgentCanBorrow.test.js`. **Fix (REDEPLOY):**
`require(agentRegistry.isAgentActive(msg.sender), "Agent deactivated")` in `requestLoan` (and `createAgentPool`).

---

## Native-token-as-ERC-20 (Arc USDC `0x3600…`) — assessed, no contract impact found

- **Code-size assumptions:** OZ 5.4 `SafeERC20._callOptionalReturn` reverts `AddressEmptyCode` if the token returns no
  data *and* has no code. Live `eth_getCode(0x3600…)` = 3,598 bytes and the smoke test executed transfers, so the
  path is sound. ✔
- **Dual view consistency:** marketplace `balanceOf` (6-dec) = 1,480 base units = `accumulatedFees`; native balance =
  1.48e15 wei — exactly 1e12 × the ERC-20 view. The contract only ever uses the 6-dec view. ✔
- **msg.value / payable:** no payable entrypoints; `msg.value` into any function reverts (R-9). Forced native donations
  (selfdestruct) can still land and would make the invariant monitor's `balance == Σavail + fees + coll` **false-alarm**
  (funds are not at risk) — make the monitor `>=` and alert on the delta (I-3).
- **Gas in the same asset:** a borrower holding *exactly* `principal + interest` fails `transferFrom` after gas is
  reserved — SDK should approve/check `+ gas headroom` (I-3, UX only). Sub-1e12-wei native dust is invisible to the
  6-dec view; harmless.
- **Reentrancy through the token:** whether or not the native view invokes recipient hooks, every state-changing
  marketplace function is `nonReentrant` with CEI (`repayLoan` pulls funds first; `_disburseLoan` records reputation
  after transfer but inside `requestLoan`'s guard). Faucet `claim` is `nonReentrant`; `register()` is CEI. No path found.

---

## D1 economics — the numbers under the live levers

Levers read on-chain: rate limit **20 pts / 86,400 s**, `minHold` **86,400 s**, fee **100 bps**, `bonusReferenceAmount`
**100 USDC**, `onTimeRepaymentBonus` 10, `defaultPenaltyBase` 50 / `Large` 100 (> 10k), Arc gas ≈ 20.1 gwei paid in USDC.

| Step | Value |
|------|-------|
| Free start | `initializeReputation()` → score 100 (1k limit, 100 % collateral, 15 % APR) |
| Per 100-USDC 7-day loan | interest 0.287671 USDC → fee **0.002877**; +10 pts; lender share recaptured by the self-lender |
| Rate cap binds at | 2 loans/day (20 pts) — concurrency cannot exceed it (R-2) |
| **100 → 600** (0 % collateral, **25,000** USDC limit) | **25 days, 50 loans, 0.12462 USDC fees** (measured), ~0.58 USDC gas |
| 100 → 800 (**50,000** limit) | 35 days, ~0.18 USDC fees |
| 100 → 500 (25 % collateral, 10k → 7.5k net unsecured) | 20 days |
| Working capital | ~200 USDC self-lend + ~100 USDC float, **all recovered** |
| Bust-out (measured) | 25,000 USDC loan, collateral 0, lender position 25,000 → **0** after liquidation |
| Penalty | −100 (>10k) → 500; **5 days** to re-farm to 600; −50 for ≤10k → 2.5 days |
| Parallelism | linear in Sybil agents (each needs its own pool + lenders); per-agent cost as above |

Conclusion: the D1 mitigations make farming *slow* (25–35 calendar days) but essentially *free* (< 1 USDC), and the
default penalty is worth ~5 days. The 2026-08 self-audit's honesty note ("mitigated, not eliminated") is correct; the
DEPLOY_PREP estimate of "~50 days" is optimistic (25 days from the free initialised score). **D1 is NOT mitigated
economically.** With the owner-tunable levers alone the best achievable posture today is: rate limit 5/day (100 days to
600), penalties 200/300 (a 25k default = 60 days), reference 1,000 USDC — still fee-free, but the calendar cost
becomes comparable to a real credit history. The structural fix needs interest paid to *non-self* lenders and/or stake.

---

## What an external auditor should focus on

1. **Identity model end-to-end** — every place an agent is resolved by *address* vs *agentId* (F-01 is one instance;
   `recordBorrow`, `agentLoans[address]`, `resetPoolAccounting`'s `ownerOf` check, `calculateCreditLimit(address)`).
   Prove the loan state machine can always reach a terminal state regardless of NFT ownership.
2. **Interest attribution model** (`depositTimestamp` qualification) — F-02/D6/D7 are all symptoms of attributing
   interest by a single timestamp and current balance. Evaluate the accrual redesign rather than patches.
3. **Reputation economics** — F-04/D1 and F-03; the bonus/penalty asymmetry and self-lending recapture.
4. **Owner privilege surface** — migration helpers (F-08), `resetPoolAccounting` (I-2), retroactive fee (I-4), one-step
   ownership on three of four contracts (I-1), pause freezing exits (I-5).
5. **Unclaimed-interest-as-liquidity** — F-05 and the `claimInterest` "Drain underflow" reachability in general.
6. Native-USDC semantics on Arc (hooks/precompile behaviour) — confirm with Circle docs; my analysis found no impact.

---

## Owner actions recommended BEFORE more USDC is funded (ordered)

1. **`setMigrationFinalized()`** on `0xb9996de0…` (F-08) — one tx, irreversible, no downside.
2. **Do not solicit third-party lenders** until a marketplace redeploy with the F-01 one-line fix (and ideally F-03/F-07)
   is live. Until then treat the deployment as owner-only/self-lending.
3. Tighten D1 levers now: `reputation.setReputationRateLimit(5, 86400)`,
   `reputation.setScoringParameters(10, 200, 300, 10000e6)`, `reputation.setBonusReferenceAmount(1000e6)`.
4. `v6.setMinSupplyAmount(100e6)` (F-06) unless small lenders are a product goal.
5. Patch the SDK/dashboard `supply()` to refuse/warn on top-ups while `activeLoanCount(agentId) > 0` (F-02 interim) and
   add gas headroom to the repay approval (I-3).
6. Extend the invariant monitor: registry `Transfer` events for agents with open loans (F-01 detector); make the
   balance check `>=` with a delta alarm (I-3).
7. Keep the faucet unfunded or fund ≤ cohort × claim with the cohort small (D10 — a single actor can drain 100 × 10 USDC
   for ~0.5 USDC of gas).
8. Correct THREAT_MODEL.md (I-6) and exclude `test/audit-2026-09/` from CI or flip the assertions after fixes.

---

## Slither 0.11.4 re-run (`slither-2026-09-19.txt`)

47 results over 55 contracts. On the four deployed contracts nothing new vs the 2026-08 triage: `divide-before-multiply`
in `calculateInterest` (accepted, matched by SDK), `timestamp` (expected), `unused-return` on `getSummary`
(registry unset), and one new **benign** `incorrect-equality` in `_socializeLoss` (`totalPrincipal == 0` / `p.amount == 0`
guards). The reentrancy/unused-return hits are in `contracts/bridge/*` and `ValidationRegistry` — not deployed on Arc.

## Files

- Report: `forensics/output/audit-2026-09/INTERNAL_AUDIT_2026-09-19.md`
- Slither: `forensics/output/audit-2026-09/slither-2026-09-19.{txt,json}`
- PoCs: `test/audit-2026-09/{_fixture.js, F01…F08-*.test.js, R00-RefutedHypotheses.test.js}`
