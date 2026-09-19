# Contract Source Audit — Specular Core Contracts

Source-code review of the three core contracts deployed on Arc Testnet
and Base Mainnet. Pure static analysis; cross-referenced with live state
findings from `CROSS_NETWORK_AUDIT.md`.

> **Scope:** `contracts/core/AgentLiquidityMarketplace.sol` (567 LOC),
> `contracts/core/ReputationManagerV3.sol` (270 LOC),
> `contracts/core/AgentRegistryV2.sol` (304 LOC). Read 2026-05-03.
> Solidity ^0.8.20, OpenZeppelin contracts. Read-only — **no code
> changes proposed or made**.

---

## TL;DR

The contracts are **functionally correct on the happy path** and the
known security mitigations are in place (`[C-01 FIX]`, `[C-02 FIX]`,
`[H-01 FIX]`, `[H-02 FIX]`, `[H-04 mitigation]`, `[SECURITY-01]`).
However, the static review found **2 HIGH-severity logic bugs** that
are not yet exercised in production but will surface as soon as the
relevant flows are used:

- **§S1 (HIGH)**: `claimInterest` transfers tokens out without
  decrementing `pool.availableLiquidity` → over-reports loanable
  balance → cross-pool insolvency risk under USDC shortage.
- **§S2 (HIGH)**: `AgentRegistryV2._update` overwrites
  `addressToAgentId[to]` without checking that `to` already has an
  agent → griefable orphaning of victim's existing agent NFT.

Also 6 MED and 4 LOW findings, all enumerated below.

---

## §S0 Severity scoreboard

| #     | Severity  | Contract                       | One-liner                                                                                          |
|-------|-----------|--------------------------------|----------------------------------------------------------------------------------------------------|
| §S1   | HIGH      | AgentLiquidityMarketplace      | `claimInterest` doesn't update `pool.availableLiquidity` → over-reported loanable amount           |
| §S2   | HIGH      | AgentRegistryV2                | `_update` (ERC721 transfer hook) silently orphans receiver's existing agent                        |
| §S3   | MED       | AgentLiquidityMarketplace      | `repayLoan` is `whenNotPaused` → owner pause can grief borrowers into default                      |
| §S4   | MED       | AgentLiquidityMarketplace      | `requestLoan` checks single-loan vs creditLimit, not cumulative debt → 10× exposure under cap      |
| §S5   | MED       | AgentLiquidityMarketplace      | `requestLoan` doesn't check agent `isActive` flag from registry → deactivated agents can borrow    |
| §S6   | MED       | ReputationManagerV3            | `calculateCreditLimit` reverts whole loan flow if `validationRegistry` external call reverts        |
| §S7   | MED       | ReputationManagerV3            | Score=0 (uninitialized) gets default 1k USDC credit → free credit for any address                  |
| §S8   | MED       | AgentLiquidityMarketplace      | `getActiveAgents()` is a public view that always reverts → footgun for integrators                 |
| §S9   | LOW       | AgentLiquidityMarketplace      | Owner can change `platformFeeRate` and `setScoringParameters` with no event/timelock               |
| §S10  | LOW       | AgentLiquidityMarketplace      | `claimInterest` emits no event → off-chain indexers can't track lender claims                      |
| §S11  | LOW       | ReputationManagerV3            | Reputation has no negative-state ban; defaulted agents return to 0 and keep 1k credit              |
| §S12  | LOW       | ReputationManagerV3            | Collateral table has gap at score 400-499 (jumps 25% → 100% with no intermediate)                  |
| §S13  | INFO      | AgentLiquidityMarketplace      | Source `MAX_LENDERS_PER_POOL = 200` doesn't match Base's deployed `50` → repo-vs-deployment drift  |

---

## §S1 (HIGH) — `claimInterest` over-reports `availableLiquidity`

**File:** `contracts/core/AgentLiquidityMarketplace.sol:474-482`

```solidity
function claimInterest(uint256 agentId) external nonReentrant whenNotPaused {
    LenderPosition storage position = positions[agentId][msg.sender];
    uint256 interest = position.earnedInterest;

    require(interest > 0, "No interest to claim");

    position.earnedInterest = 0;
    usdcToken.safeTransfer(msg.sender, interest);
}
```

The function:
1. Zeros the lender's `earnedInterest`
2. Transfers the USDC to the lender

It does **not** decrement `pool.availableLiquidity`. But on `repayLoan`
(line 309) the full `lenderInterest` was added into `availableLiquidity`:

```solidity
pool.availableLiquidity += loan.amount + lenderInterest;
```

So once any lender claims, `pool.availableLiquidity` reports a number
that is **strictly higher** than the USDC actually held by the contract
for that pool.

### Exploit / failure scenario

1. Pool 43 has `availableLiquidity = 1933.35`, contract holds 1933.35
   USDC for it.
2. Lender A calls `claimInterest(43)` and withdraws 27.13 USDC.
3. `pool.availableLiquidity` is still 1933.35.
4. An agent with sufficient credit calls `requestLoan(1933, 7 days)` —
   the check `amount <= pool.availableLiquidity` passes.
5. `_disburseLoan` calls `usdcToken.safeTransfer(loan.borrower,
   loan.amount)` for 1933 USDC.
6. The contract holds 1906.21 USDC for pool 43 + N for other pools.
   The transfer succeeds **by drawing from other pools' USDC** — the
   marketplace holds a single pooled USDC balance across all 40 pools.
7. Now those other pools' `availableLiquidity` claims exceed the
   real USDC held → next `withdrawLiquidity` from another lender on a
   different pool can revert or DOS depending on order.

### Live status

- Live evidence (`CROSS_NETWORK_AUDIT.md §N13`): `claimedSoFar = 0`
  on every Arc and Base pool. **Bug not yet triggered in production.**
- However, any UI button that calls `claimInterest` will start the
  drift immediately.

### `resetPoolAccounting` only partially compensates

`resetPoolAccounting` (line 520) recomputes `availableLiquidity =
totalLiquidity + totalEarned - actualLoaned` — this **also doesn't
subtract claimed interest**, so the bug is reproducible after every
reset. The reset is owner-only and emits an event but doesn't fix
this class of drift.

### Recommendation

A correct fix would either decrement `pool.availableLiquidity` and
`pool.totalEarned` on claim (matching the increments on repay), OR
track claimed-per-pool separately. **No code changes proposed here**
— this is a documentation-only audit.

---

## §S2 (HIGH) — Agent NFT transfer silently orphans receiver's existing agent

**File:** `contracts/core/AgentRegistryV2.sol:286-303`

```solidity
function _update(address to, uint256 tokenId, address auth)
    internal override returns (address) {
    address from = _ownerOf(tokenId);

    if (from != address(0)) {
        delete addressToAgentId[from];
    }
    if (to != address(0)) {
        addressToAgentId[to] = tokenId;     // ← unconditional overwrite
        agents[tokenId].owner = to;
    }
    return super._update(to, tokenId, auth);
}
```

`addressToAgentId[to] = tokenId` is unconditional. If `to` is **already
registered as a different agent** (say agent ID `X`), the assignment
overwrites the mapping. After the transfer:

- Agent NFT `X` still exists, still owned by `to`
- `addressToAgentId[to]` now resolves to the *transferred* token
- Agent `X` is **orphaned**: no address resolves back to it via
  `addressToAgentId`, so `recordBorrow`, `requestLoan`, `getReputationScore`
  all silently use the wrong agentId for `to`'s queries

### Grief vector

1. Attacker registers agent A (cheap)
2. Victim is registered as agent V with reputation/credit history
3. Attacker transfers their agent A's NFT to victim's address
4. `_update` runs: `addressToAgentId[victim] = A`
5. Now whenever victim calls `requestLoan`, the marketplace looks up
   `addressToAgentId[victim] → A` — borrows are charged against the
   attacker's freshly-minted, low-reputation agent A
6. Victim's actual agent V still has all the reputation but is
   inaccessible from victim's address

The receiver has no veto on incoming ERC-721 transfers (no
`_safeMint`/`onERC721Received` opt-in for non-contract addresses), so
this attack cannot be prevented by the victim.

### Mitigations the contract is missing

- No "max 1 agent per address" check in `_update`
- `register()` checks `addressToAgentId[msg.sender] == 0` (line 75) but
  the same check is not enforced on transfers
- No event signaling that a previous agent was orphaned

### Live status

Both Arc (81 agents) and Base (3 agents) likely include addresses with
multiple historical NFTs. Probe needed to enumerate, but the bug is
exploitable today.

---

## §S3 (MED) — `repayLoan` blocked by pause → griefable defaults

**File:** `contracts/core/AgentLiquidityMarketplace.sol:283`

```solidity
function repayLoan(uint256 loanId) external nonReentrant whenNotPaused {
```

`whenNotPaused` blocks repayment while the contract is paused. Combined
with `liquidateLoan` (line 365) which is **not** `whenNotPaused`:

1. Borrower has loan due in 1 hour
2. Owner pauses the contract
3. Borrower can't call `repayLoan` for the next 1 hour
4. Loan endTime passes
5. Owner unpauses (or doesn't) and calls `liquidateLoan` immediately
6. Borrower's reputation is hit with a default penalty (50-100 points
   per `recordDefault`), collateral is seized

This is a centralization grief vector. Pause is intended for emergency
defense, but blocking repayment turns it into a weapon against
borrowers.

### Recommendation

Pause should typically allow `repayLoan` and `withdrawLiquidity` (the
"exit" paths), only blocking new debt origination (`requestLoan`,
`supplyLiquidity`). No code changes proposed.

---

## §S4 (MED) — `requestLoan` allows 10× cumulative exposure under credit cap

**File:** `contracts/core/AgentLiquidityMarketplace.sol:208-213`

```solidity
uint256 creditLimit = reputationManager.calculateCreditLimit(msg.sender);
require(amount <= creditLimit, "Exceeds credit limit");

uint256 activeLoans = _countActiveLoans(msg.sender);
require(activeLoans < MAX_ACTIVE_LOANS_PER_AGENT, "Too many active loans");
```

The credit-limit check (`amount <= creditLimit`) is per-loan. The
concurrent-loan check (`activeLoans < 10`) caps at 10 loans, but each
can be up to `creditLimit`. So a top-tier agent (`creditLimit = 50_000
USDC`) can have **10 simultaneous loans of 50k = 500_000 USDC** of
real exposure.

### Live evidence

`AgentLiquidityMarketplace.MAX_ACTIVE_LOANS_PER_AGENT = 10` confirmed
on both Arc and Base. The reputation tier `score >= 800 → 50_000 USDC`
is reachable on Arc (top scores observed in the 800+ range during the
§N12 cycle wallet check).

### Recommendation

Either:
- Track `totalActiveDebt[agent]` and check `totalActiveDebt + amount
  <= creditLimit`, OR
- Reduce `MAX_ACTIVE_LOANS_PER_AGENT` materially (e.g. 1-3), OR
- Document the 10× exposure as intentional in `calculateCreditLimit`'s
  NatSpec

No code changes proposed.

---

## §S5 (MED) — Deactivated agents can still borrow

**File:** `contracts/core/AgentLiquidityMarketplace.sol:196-198`

```solidity
uint256 agentId = agentRegistry.addressToAgentId(msg.sender);
require(agentId != 0, "Not a registered agent");
require(agentPools[agentId].isActive, "No pool for agent");
```

The check is `agentPools[agentId].isActive`, **not**
`agentRegistry.isAgentActive(msg.sender)`. The marketplace's own pool
flag is checked, but the registry's `Agent.isActive` flag (settable by
`deactivateAgent`, `AgentRegistryV2.sol:190`) is ignored.

So an agent the registry owner has deactivated (presumably for cause)
can still:
- Take new loans from their pool
- Have their reputation increase via `recordLoanCompletion`
- Generate collateral/interest flows

### Recommendation

Add a `require(agentRegistry.isAgentActive(msg.sender), "Agent
deactivated")` near the start of `requestLoan` and `supplyLiquidity`.
No code changes proposed.

---

## §S6 (MED) — `validationRegistry` reverts brick all loans

**File:** `contracts/core/ReputationManagerV3.sol:235-240`

```solidity
if (address(validationRegistry) != address(0) && validationCreditBonus > 0) {
    (,, , uint256 avgScore) = validationRegistry.getSummary(agentId, new address[](0), "");
    if (avgScore >= validationBonusThreshold) {
        baseLimit += validationCreditBonus;
    }
}
```

The external call is **unwrapped** — no try/catch. If
`validationRegistry.getSummary` reverts (e.g. registry is paused, has
gas-griefing logic, returns malformed data, or is upgraded to a
selfdestruct'd contract), every call to `calculateCreditLimit` reverts,
which means **every `requestLoan` reverts** because line 208 of the
marketplace calls it.

`validationRegistry` is owner-set and addressed in
`arc-testnet-addresses.json` as `0xD97AeE…cEa`. If that address is ever
upgraded or compromised, the entire lending flow on the network can be
DOSed.

### Recommendation

Wrap the external call in `try/catch` and treat any failure as
"avgScore = 0" (no bonus) instead of reverting. No code changes
proposed.

---

## §S7 (MED) — Score 0 grants 1k USDC credit by default

**File:** `contracts/core/ReputationManagerV3.sol:225-232`

```solidity
uint256 score = agentReputation[agentId];

uint256 baseLimit;
if (score >= 800) baseLimit = 50000 * 1e6;
else if (score >= 600) baseLimit = 25000 * 1e6;
else if (score >= 400) baseLimit = 10000 * 1e6;
else if (score >= 200) baseLimit = 5000 * 1e6;
else baseLimit = 1000 * 1e6;  // ← also catches uninitialized (score=0)
```

A freshly-registered agent with `agentReputation[agentId] = 0` (i.e.
never called `initializeReputation`) falls into the same bucket as a
score-200 agent and gets **1000 USDC credit limit out of the gate**.

Combined with `MAX_ACTIVE_LOANS_PER_AGENT = 10` (§S4) and 0%
collateral if the agent has somehow accrued reputation through other
means — wait, no: collateral table at `score >= 500` requires 25%, and
default (incl. score 0) is 100%. So fresh agents *do* need to post
100% collateral. But that just means the credit limit gate is decorative
for new agents.

### Why it still matters

If a future code path ever uses `calculateCreditLimit` without enforcing
collateral, score-0 agents auto-qualify for 1k USDC. Worth flagging as a
default-bias to be aware of.

### Recommendation

Either:
- Make `else baseLimit = 0` for uninitialized scores (require explicit
  init), OR
- Document that the 1k USDC default is intentional on-ramp behavior

No code changes proposed.

---

## §S8 (MED) — `getActiveAgents()` reverts unconditionally

**File:** `contracts/core/AgentLiquidityMarketplace.sol:464-469`

```solidity
function getActiveAgents() external view returns (uint256[] memory) {
    // Note: This requires tracking active agent IDs separately for gas efficiency
    // For now, front-end should query by known agent IDs
    // TODO: Add agentId array tracking if needed
    revert("Use front-end to query specific agents");
}
```

A public, externally-callable view function that always reverts is a
**bug-class footgun** for any integrator generating client code from
the ABI:

- Naive integrators see the ABI signature, call it, get a revert with
  no error data
- Etherscan/blockscout "Read Contract" UIs would surface this and
  confuse users
- The TODO in the body is acknowledged 6+ months old code (per repo
  history); the workaround (`agentPoolIds` array, line 76) already
  exists and could be wrapped instead

### Recommendation

Either delete the function (would change ABI) or have it return
`agentPoolIds` directly. No code changes proposed.

---

## §S9 (LOW) — Owner-tunable parameters lack timelock or events

`setPlatformFeeRate` (line 510), `setScoringParameters`
(`ReputationManagerV3.sol:87`), `setValidationBonusParameters` (line
106), and `setValidationRegistry` (line 79) all execute immediately
when called by owner.

Concerning combinations:
- Owner can call `setPlatformFeeRate(500)` (5% max per check on line
  511) immediately before a large interest distribution lands, capturing
  more for the protocol vs lenders
- Owner can call `setScoringParameters(0, 0, 0, 0)` to neutralize the
  on-time bonus and default penalty before specific borrowers act

Mitigation: ownership has been transferred to a fresh wallet
(`0x800e305A0c…`, per `arc-testnet-addresses.json`), and `setPlatformFeeRate`
is capped at 5%. Risk is reduced but not eliminated.

### Recommendation

Add a 24-48h timelock for these setters, or move ownership to a
multisig + timelock. No code changes proposed.

---

## §S10 (LOW) — `claimInterest` emits no event

Already noted in §S1. Independent of the accounting bug, the lack of
event makes it impossible for off-chain indexers to track when lenders
claim, which is needed for tax reporting, P&L UI, and APY display.

---

## §S11 (LOW) — No "permanent ban" for serial defaulters

**File:** `contracts/core/ReputationManagerV3.sol:197`

```solidity
uint256 newScore = oldScore > penalty ? oldScore - penalty : 0;
```

Reputation floors at 0. A defaulter at score 0 still falls into the
"else" bucket of `calculateCreditLimit` and gets 1000 USDC credit
(albeit with 100% collateral per `calculateCollateralRequirement`). So
defaulters can keep cycling — there's no "you defaulted N times, you
can never borrow here again" mechanism.

### Recommendation

Track `defaultCount[agentId]` (already exists, line 28) and add a
hard-stop in `requestLoan` (e.g. `defaultCount > 5` → revert). No code
changes proposed.

---

## §S12 (LOW) — Collateral table gap at score 400-499

**File:** `contracts/core/ReputationManagerV3.sol:248-256`

```solidity
function calculateCollateralRequirement(address agent) external view returns (uint256) {
    uint256 score = agentReputation[agentId];

    if (score >= 800) return 0;
    if (score >= 600) return 0;
    if (score >= 500) return 25;
    return 100;
}
```

| Score range | Collateral | Interest rate (`calculateInterestRate`) |
|-------------|-----------:|-----------------------------------------|
| 800-1000    | 0%         | 5% APR                                  |
| 600-799     | 0%         | 7% APR                                  |
| 500-599     | 25%        | 10% APR (also covers 400-499)           |
| 400-499     | 100%       | 10% APR                                 |
| 200-399     | 100%       | 15% APR (also covers <200)              |
| 0-199       | 100%       | 15% APR                                 |

Two cliffs:
- 500 → 499: collateral jumps 25% → 100%
- 800 → 799: nothing breaks, but reads weird that 600 and 800 are equal

Also: the `>= 600 return 0` is redundant since `>= 800` would have
caught it. The duplication suggests a copy-paste from a prior version
where 600-799 had non-zero collateral.

### Recommendation

Smooth the collateral curve (e.g. linear interpolation) or document the
intentional cliff. Remove the `>= 600 return 0` since `>= 800` shadows
it. No code changes proposed.

---

## §S13 (INFO) — Source `MAX_LENDERS_PER_POOL = 200` doesn't match Base

**File:** `contracts/core/AgentLiquidityMarketplace.sol:83`

```solidity
uint256 public constant MAX_LENDERS_PER_POOL = 200;
```

Live values (`CROSS_NETWORK_AUDIT.md §N1`):
```
ARC : 200  ← matches source
BASE: 50   ← differs
```

The repo source matches Arc (pre-H-04) but **does not match the
deployed Base contract**. This means either:

(a) Base was deployed from a different branch with `MAX_LENDERS = 50`
    that was never merged back to main, OR
(b) The repo source has been updated to revert the H-04 fix back to 200
    after Base deployment

Either way, **the source-of-truth in this repo is misleading for Base
debugging**. Anyone reading `AgentLiquidityMarketplace.sol` on `main`
sees `200` and would assume the running Base contract uses 200, which
is false.

`agentLiquidityMarketplace_v5_WITH_FIX` per `arc-testnet-addresses.json`
is the Arc deployment of a 50-cap version, but it's not authorized.

### Recommendation

- Tag the source with a `pragma`/comment block listing per-network
  build constants
- Or vendor a separate `AgentLiquidityMarketplace_v5.sol` and keep both
  in tree until v5 is authorized on Arc

No code changes proposed.

---

## §S14 — Things checked and found OK

- **Reentrancy**: All state-changing user functions in marketplace use
  `nonReentrant`. CEI pattern is correctly applied in `repayLoan`
  (`[C-01 FIX]`, line 301-329) and in `_disburseLoan` (state set to
  ACTIVE before token transfer at line 267-272).
- **Integer overflow**: Solidity ^0.8.20 with default checked math.
  All multiplication/division uses BPS (10000) which fits well within
  uint256 even at max liquidity.
- **`safeTransferFrom` / `safeTransfer`**: Used consistently via
  `SafeERC20`. No raw `transfer`.
- **`onlyOwner` access control**: `withdrawFees`, `liquidateLoan`,
  `pause`, `unpause`, `setPlatformFeeRate`, `resetPoolAccounting` are
  all correctly gated.
- **`onlyAuthorizedPool` in reputation**: `recordBorrow`,
  `recordLoanCompletion`, `recordDefault` only callable from
  authorized marketplace addresses. No silent reputation manipulation.
- **EIP-712 signature for `setAgentWallet`** (`AgentRegistryV2.sol:129`):
  Includes `deadline` to prevent replay; verifies signer == NFT owner.
  Solid implementation.
- **`[C-02 FIX]` for `initializeReputation(uint256)`**: Verifies caller
  owns the agent NFT via `addressToAgentId` lookup before initializing,
  preventing front-run / identity hijack.
- **`[H-02 FIX]` in `liquidateLoan`**: Correctly subtracts unrecovered
  loss from `totalLiquidity` so accounting reflects real pool value
  after partial recovery.
- **`[H-01 FIX]` in `_distributeInterest`**: Tracks distributed amount
  and credits rounding dust to `accumulatedFees` instead of trapping
  it. *Note: cross-checked against §N13 where 600 wei dust on Arc
  pool 43 ended up in availableLiquidity not accumulatedFees — meaning
  the deployed Arc bytecode predates this fix in source.*

---

## §S15 Cross-check against live findings

| Source-only finding | Live evidence in CROSS_NETWORK_AUDIT |
|---------------------|--------------------------------------|
| §S1 (claimInterest leak) | §N13: `claimedSoFar = 0` on every pool — **bug not yet triggered** |
| §S13 (source doesn't match Base MAX_LENDERS) | §N1: Arc=200, Base=50 — **confirmed source-vs-deployment drift** |
| §S5 (deactivated agents can borrow) | Unverified — no agents currently deactivated on either network |
| §S6 (validationRegistry can DOS lending) | §N3: `validationRegistry` getter exists on Base reputation, missing on Arc — **Arc reputation may not have this code path at all**, requiring source review of the actual deployed Arc bytecode |
| §S2 (NFT transfer orphans agent) | Unverified — needs probe to enumerate addresses with >1 agent NFT |
| H-01 dust fix in source vs missing on Arc | §N13: 600 wei stuck in pool 43 `availableLiquidity` — **Arc bytecode predates `[H-01 FIX]`** |

---

## §S16 Method

For each contract:
1. Read full source top-to-bottom
2. Map all `external`/`public` functions and their access modifiers
3. Trace each user-facing flow (supply → borrow → repay → claim →
   withdraw) for state mutations and invariant violations
4. Check `_update`/internal hooks for transfer-time invariants
5. Flag any unchecked external calls, missing events, missing access
   control, missing pause guards
6. Cross-reference findings against live state from
   `CROSS_NETWORK_AUDIT.md`

No live calls were made for this audit; all findings are derivable from
source inspection alone. Cross-references to live state come from prior
audit work.

---

## §S17 Cross-references

- [`CROSS_NETWORK_AUDIT.md`](./CROSS_NETWORK_AUDIT.md) — live state for
  §S1, §S6, §S13 confirmation
- [`SCHEMA_VERIFICATION.md`](./SCHEMA_VERIFICATION.md) — ABI-level
  reference; matches §S0 function table
- [`API_AUDIT.md`](./API_AUDIT.md) — server-side; §S8 (`getActiveAgents`
  revert) is what would surface to API consumers via the `/agents` route
