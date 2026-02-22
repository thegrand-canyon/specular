# Specular Protocol — Smart Contract Security Audit

**Date:** 2026-02-17
**Auditor:** Claude Sonnet 4.5 (claude-sonnet-4-5-20250929)
**Scope:** `/contracts/core/`
**Contracts Reviewed:**
- `AgentLiquidityMarketplace.sol`
- `LendingPoolV3.sol`
- `ReputationManagerV3.sol`
- `AgentRegistryV2.sol`

**Solidity Version:** `^0.8.20`
**Framework:** OpenZeppelin (Ownable, ReentrancyGuard, Pausable, SafeERC20, ERC721, EIP712)

---

## Executive Summary

The Specular Protocol implements a P2P lending marketplace for AI agents with on-chain reputation scoring. The contracts share a common architecture: an ERC-721 agent registry, a reputation/credit manager, and two lending pools (pooled and marketplace-style). While the codebase adopts several defensive patterns (SafeERC20, ReentrancyGuard, Pausable), this audit identified **18 distinct vulnerabilities** ranging from Critical to Low severity. The most serious issues relate to a broken CEI (Checks-Effects-Interactions) pattern in `AgentLiquidityMarketplace`, interest earned being credited before funds are actually received from the borrower, interest distribution rounding loss that permanently traps funds, and a reputation initialization flaw that allows identity spoofing.

| Severity | Count |
|----------|-------|
| Critical | 2 |
| High     | 5 |
| Medium   | 6 |
| Low      | 5 |
| **Total** | **18** |

---

## Findings

---

### [C-01] CRITICAL — Broken CEI: State Updated and Tokens Transferred Before Borrower Repayment is Received (`AgentLiquidityMarketplace.repayLoan`)

**Contract:** `AgentLiquidityMarketplace.sol`
**Lines:** 270–316

**Description:**
`repayLoan` updates the pool's `availableLiquidity` and `totalLoaned`, distributes interest to lenders, marks the loan as `REPAID`, and only *then* calls `safeTransferFrom` to collect the repayment from the borrower. If the USDC `transferFrom` reverts (e.g., the borrower has insufficient allowance or balance), all state changes are rolled back by the EVM — but if an attacker can cause the `transferFrom` to succeed for a zero amount (e.g., via a malicious ERC-20 that returns `true` on zero-amount transfers), or if `usdcToken` is ever replaced by a non-reverting token, the pool would credit itself with funds it never received.

More critically, collateral is returned *before* the transfer is verified:

```solidity
// Line 291-298: state updated
pool.availableLiquidity += loan.amount + lenderInterest;
pool.totalLoaned -= loan.amount;
pool.totalEarned += lenderInterest;

// Line 295: interest distributed
_distributeInterest(loan.agentId, lenderInterest);

// Line 301: loan marked repaid
loan.state = LoanState.REPAID;

// Line 304: USDC transfer happens HERE — after everything above
usdcToken.safeTransferFrom(msg.sender, address(this), totalRepayment);

// Line 307-309: collateral returned AFTER state change, BEFORE transfer verification
if (loan.collateralAmount > 0) {
    usdcToken.safeTransfer(loan.borrower, loan.collateralAmount);
}
```

Because `loan.state` is set to `REPAID` before the transfer, the `require(loan.state == LoanState.ACTIVE)` guard on line 273 prevents re-entry or a second call — but the state/accounting is inconsistent if the transfer fails.

**Impact:** Accounting desynchronization. In the worst case with a non-standard token, interest and liquidity can be credited without any funds being received, enabling a drain of the pool by lenders claiming phantom interest.

**Fix:** Collect the repayment transfer *first*, then update state and distribute interest. Return collateral last. Strict CEI pattern:

```solidity
// 1. CHECKS (already present)
// 2. Collect repayment first
usdcToken.safeTransferFrom(msg.sender, address(this), totalRepayment);
// 3. EFFECTS — update state only after funds confirmed received
loan.state = LoanState.REPAID;
pool.availableLiquidity += loan.amount + lenderInterest;
pool.totalLoaned -= loan.amount;
pool.totalEarned += lenderInterest;
accumulatedFees += platformFee;
_distributeInterest(loan.agentId, lenderInterest);
// 4. INTERACTIONS — return collateral last
if (loan.collateralAmount > 0) {
    usdcToken.safeTransfer(loan.borrower, loan.collateralAmount);
}
reputationManager.recordLoanCompletion(loan.borrower, loan.amount, onTime);
```

---

### [C-02] CRITICAL — Reputation Initialization Allows Identity Spoofing (`ReputationManagerV3.initializeReputation(uint256)`)

**Contract:** `ReputationManagerV3.sol`
**Lines:** 119–127

**Description:**
The overloaded `initializeReputation(uint256 agentId)` function allows *any caller* to initialize reputation for *any agent ID* and simultaneously maps `msg.sender` to that `agentId` in the `agentIdByAddress` mapping. There is no check that `msg.sender` is the actual owner of the agent NFT with that ID.

```solidity
function initializeReputation(uint256 agentId) external {
    require(agentReputation[agentId] == 0, "Already initialized");
    require(agentId != 0, "Invalid agent ID");

    agentReputation[agentId] = 100; // Start at 100
    agentIdByAddress[msg.sender] = agentId; // <-- ANYONE can hijack this mapping
    ...
}
```

An attacker can call this with a victim agent's `agentId` before the victim does, mapping the attacker's address to that `agentId`. Any subsequent call to `agentRegistry.addressToAgentId(attacker_address)` outside of `ReputationManagerV3` will return the attacker's real agent ID (from the `AgentRegistryV2` mapping), not this internal mapping. However, functions in `ReputationManagerV3` that use `agentIdByAddress[msg.sender]` (implicitly, through the pattern) could resolve incorrectly.

Furthermore, this allows front-running: a malicious actor can watch the mempool for an agent's `initializeReputation()` (no-arg version) transaction and front-run it with `initializeReputation(agentId)`, locking the legitimate agent out of initialization (since `agentReputation[agentId]` is now non-zero).

**Impact:** DoS on legitimate agent reputation initialization; mapping corruption.

**Fix:** The `initializeReputation(uint256 agentId)` variant must verify that `msg.sender` is the owner of the NFT for `agentId`:

```solidity
function initializeReputation(uint256 agentId) external {
    require(agentRegistry.isAgentActive(msg.sender), "Caller is not an active agent");
    require(agentRegistry.addressToAgentId(msg.sender) == agentId, "AgentId mismatch");
    require(agentReputation[agentId] == 0, "Already initialized");
    ...
}
```

Alternatively, consolidate into a single function that derives `agentId` from `msg.sender` via the registry (as the no-arg overload does correctly).

---

### [H-01] HIGH — Interest Distribution Permanently Traps Funds Due to Rounding (`AgentLiquidityMarketplace._distributeInterest`)

**Contract:** `AgentLiquidityMarketplace.sol`
**Lines:** 321–337

**Description:**
Interest is distributed to each lender proportionally:

```solidity
uint256 share = (totalInterest * position.amount) / pool.totalLiquidity;
```

Due to integer division truncation, the sum of all individual `share` values will almost always be less than `totalInterest`. The difference — the "dust" — is permanently locked in the contract. It is added to `pool.totalEarned` (line 292) and to `pool.availableLiquidity` (line 290), so the accounting ledger reflects funds that exist on-chain, but no lender can ever claim them. Over time with many loans and many lenders, this trapped dust accumulates.

**Example:** 3 lenders with equal shares of 100 USDC in the pool, `totalInterest = 10`. Each gets `(10 * 100) / 300 = 3`. Total distributed = 9. 1 USDC is permanently unclaimable.

**Impact:** Permanent, irreversible loss of interest funds. With USDC (6 decimals) and many small lenders, this becomes material.

**Fix:** Track dust and credit it to the last lender, or accumulate unallocated dust as recoverable platform fees:

```solidity
uint256 distributed = 0;
for (uint256 i = 0; i < lenders.length; i++) {
    // ... calculate share ...
    distributed += share;
    position.earnedInterest += share;
}
// Credit any remainder as platform fees rather than trapping it
uint256 dust = totalInterest - distributed;
if (dust > 0) accumulatedFees += dust;
```

---

### [H-02] HIGH — `availableLiquidity` Accounting Diverges from Actual USDC Balance After Liquidation (`AgentLiquidityMarketplace.liquidateLoan`, `LendingPoolV3.liquidateLoan`)

**Contract:** `AgentLiquidityMarketplace.sol` lines 342–364; `LendingPoolV3.sol` lines 250–266

**Description:**
When a loan is liquidated, the collateral amount is added to `availableLiquidity`:

```solidity
// AgentLiquidityMarketplace.sol line 351
pool.availableLiquidity += loan.collateralAmount;
```

However, `pool.totalLiquidity` is NOT updated. After liquidation:
- `totalLiquidity` still reflects the original deposited amount (which included the loaned principal)
- `availableLiquidity` is now `collateral - principal_recovered` less than `totalLiquidity`
- The loan principal that was *not* recovered from collateral (because collateral < principal) represents a real loss

This accounting gap means that subsequent lenders checking `totalLiquidity` will see an inflated figure that does not reflect actual pool solvency. The utilization rate calculation in `getAgentPool` (line 393) will also be wrong:

```solidity
uint256 utilization = (pool.totalLoaned * 10000) / pool.totalLiquidity;
```

After a default where collateral < principal, `totalLoaned` is reduced to zero but `totalLiquidity` still contains the lost principal, showing 0% utilization on a pool that has actually lost funds.

**Impact:** Misleading financial data to lenders; lenders may be unable to withdraw their full deposited amount.

**Fix:** On liquidation, reduce `totalLiquidity` by the unrecovered portion:
```solidity
uint256 recovered = loan.collateralAmount;
uint256 loss = loan.amount > recovered ? loan.amount - recovered : 0;
pool.totalLiquidity -= loss;
pool.availableLiquidity += recovered;
pool.totalLoaned -= loan.amount;
```

---

### [H-03] HIGH — `LendingPoolV3.repayLoan` Adds Full `totalRepayment` (Principal + Interest) to `availableLiquidity` Without Segregating Interest

**Contract:** `LendingPoolV3.sol`
**Lines:** 229–234

**Description:**
On repayment, the full `totalRepayment` (principal + interest) is added to `availableLiquidity`:

```solidity
availableLiquidity += totalRepayment;   // line 233
totalLoaned -= loan.amount;             // line 234
```

But `totalLiquidity` is never updated to include the interest. This means `availableLiquidity` can permanently exceed `totalLiquidity`, creating a negative implied value for the difference (`totalLiquidity - availableLiquidity`). Any code or off-chain systems relying on `totalLiquidity` for accurate accounting will report incorrect figures.

Additionally, `withdrawLiquidity` uses `availableLiquidity` as its check but decrements `totalLiquidity`:
```solidity
availableLiquidity -= _amount;
totalLiquidity -= _amount;
```
After interest accrual, `totalLiquidity` could underflow if more than `totalLiquidity` worth of `availableLiquidity` is present (though Solidity 0.8+ would revert, making `withdrawLiquidity` permanently DoS'd once interest exceeds the total deposited).

**Impact:** Permanent accounting mismatch; `withdrawLiquidity` becomes DoS'd once interest income exceeds the original deposited liquidity.

**Fix:** Maintain a separate `totalInterestEarned` variable and update `totalLiquidity` when interest is received:
```solidity
uint256 interest = totalRepayment - loan.amount;
totalLiquidity += interest; // Interest grows the pool
availableLiquidity += totalRepayment;
totalLoaned -= loan.amount;
```

---

### [H-04] HIGH — Unbounded `poolLenders` Array Enables Gas Limit DoS (`AgentLiquidityMarketplace._distributeInterest`)

**Contract:** `AgentLiquidityMarketplace.sol`
**Lines:** 321–337

**Description:**
`_distributeInterest` iterates over the entire `poolLenders[agentId]` array:

```solidity
for (uint256 i = 0; i < lenders.length; i++) { ... }
```

There is no cap on how many lenders can supply liquidity to an agent's pool. If a pool accumulates hundreds or thousands of lenders (which is expected in a lending marketplace), `repayLoan` will exceed the block gas limit and revert, permanently preventing loan repayment. This is a griefing attack: a malicious actor can create many dust-deposit wallets to inflate `poolLenders` until `repayLoan` becomes uncallable.

**Impact:** Permanent DoS on `repayLoan` for any sufficiently popular pool. Loans can never be repaid; they can only be liquidated by the owner.

**Fix:** Replace push-based interest distribution with a pull-based accumulator pattern (similar to Compound/Aave):
- Maintain a global `rewardPerToken` accumulator per pool
- On each interest payment, increment `rewardPerToken` by `interestAmount / totalLiquidity`
- Each lender tracks their `rewardPerTokenPaid` snapshot
- `claimInterest` computes `(rewardPerToken - rewardPerTokenPaid) * position.amount / PRECISION`

This avoids all loops in the repayment critical path.

---

### [H-05] HIGH — Agent NFT Transfer Breaks Cross-Contract Identity: `addressToAgentId` Desynchronized

**Contract:** `AgentRegistryV2.sol` lines 286–303; affects `AgentLiquidityMarketplace.sol`, `LendingPoolV3.sol`, `ReputationManagerV3.sol`

**Description:**
`AgentRegistryV2._update` correctly updates `addressToAgentId` when the NFT is transferred:

```solidity
if (from != address(0)) {
    delete addressToAgentId[from];
}
if (to != address(0)) {
    addressToAgentId[to] = tokenId;
    agents[tokenId].owner = to;
}
```

However, open loans in `AgentLiquidityMarketplace` and `LendingPoolV3` store `borrower = msg.sender` (the original address). After an NFT transfer, the *new* owner can call `requestLoan` and borrow more against the same agent's reputation and pool, while the old address retains any existing loans. Additionally:

1. `ReputationManagerV3.agentIdByAddress` is a *separate* mapping that is NOT updated on NFT transfer. The old address in this mapping permanently desynchronizes from the registry.
2. Active loans reference the old borrower address. The new owner cannot repay old loans (line 272: `require(msg.sender == loan.borrower)`), creating permanently stuck loans.
3. The new owner inherits the reputation score built by the old owner, potentially enabling a reputation marketplace where established agents are sold.

**Impact:** Permanently unrepayable loans; reputation score resale market; accounting inconsistencies.

**Fix:** Restrict NFT transfer while any active loans exist. In `_update`, check that the agent has no active loans. Alternatively, redesign so that `borrower` in loan structs is the `agentId` (uint256) rather than an address.

---

### [M-01] MEDIUM — `LendingPoolV3`: Collateral Collected Before Loan ID Exists, No Refund on Auto-Approve Failure

**Contract:** `LendingPoolV3.sol`
**Lines:** 119–150

**Description:**
In `requestLoan`, collateral is transferred from the borrower *before* the loan struct is stored, and before the auto-approve check:

```solidity
if (collateralAmount > 0) {
    usdcToken.safeTransferFrom(msg.sender, address(this), collateralAmount); // line 124
}

uint256 loanId = nextLoanId++;
loans[loanId] = Loan({ ..., state: LoanState.REQUESTED });

if (_canAutoApprove(msg.sender, _amount)) {
    _approveLoanInternal(loanId); // if this reverts, collateral is stuck
}
```

If `_approveLoanInternal` reverts (e.g., `availableLiquidity` changed between `_canAutoApprove` check and `_approveLoanInternal` execution due to another transaction), the collateral is trapped in the contract with no mechanism to retrieve it, since the loan state is `REQUESTED` and there is no "cancel loan" function.

**Impact:** Permanent loss of collateral for borrowers whose auto-approve fails due to a race condition.

**Fix:** Add a `cancelLoan` function that allows a borrower to cancel a `REQUESTED` loan and recover collateral, or recheck liquidity inside `_approveLoanInternal` and handle failure gracefully.

---

### [M-02] MEDIUM — Interest Is Calculated on Fixed `loan.duration`, Not Actual Elapsed Time

**Contract:** `AgentLiquidityMarketplace.sol` lines 276–279; `LendingPoolV3.sol` lines 218–222

**Description:**
Both contracts calculate interest based on the *fixed loan duration*, not the actual time elapsed since disbursement:

```solidity
// AgentLiquidityMarketplace
uint256 interest = calculateInterest(loan.amount, loan.interestRate, loan.duration);

// LendingPoolV3
uint256 interest = calculateInterest(loan.amount, loan.interestRate, loan.durationDays);
```

This means:
1. A borrower who repays on day 1 of a 365-day loan still pays the full year's interest.
2. A borrower who repays 2 years late on a 30-day loan pays only 30 days of interest (massively under-paying relative to time outstanding).
3. There is no economic incentive for early repayment, and late repayment carries no interest penalty beyond reputation score loss.

**Impact:** Systematic interest miscalculation that benefits either borrowers (late repayment) or protocol (early repayment) unfairly. Lenders are misled about the yield curve.

**Fix:** Calculate interest based on `block.timestamp - loan.startTime`:
```solidity
uint256 elapsed = block.timestamp - loan.startTime;
uint256 interest = (loan.amount * loan.interestRate * elapsed) / (BASIS_POINTS * 365 days);
```

---

### [M-03] MEDIUM — `ReputationManagerV3.calculateCreditLimit` Makes External Call to Untrusted `ValidationRegistry`

**Contract:** `ReputationManagerV3.sol`
**Lines:** 229–233

**Description:**
The credit limit calculation makes an external call to `validationRegistry.getSummary(...)` with a user-controlled `agentId` and an empty `address[]` array:

```solidity
(,, , uint256 avgScore) = validationRegistry.getSummary(agentId, new address[](0), "");
```

1. `validationRegistry` can be set by the owner to any arbitrary address. If compromised or malicious, it can return inflated `avgScore` values, granting unlimited credit limits.
2. This external call occurs inside `calculateCreditLimit`, which is called by `requestLoan` in both lending contracts. A malicious `ValidationRegistry` could reenter the lending pool.
3. There is no validation that `validationRegistry` implements the expected interface correctly (no `IERC8004ValidationRegistry` type check).

**Impact:** Owner can boost arbitrary agent credit limits by deploying a malicious ValidationRegistry; reentrancy vector through credit limit calculation.

**Fix:**
- Use a try/catch around the external call and default to base limit on failure
- Add a `nonReentrant` guard or ensure `calculateCreditLimit` is called before any state changes
- Emit an event and implement a timelock when `setValidationRegistry` is called

---

### [M-04] MEDIUM — No Upper Bound on `setAutoApproveConfig._maxAmount` in `LendingPoolV3`

**Contract:** `LendingPoolV3.sol`
**Lines:** 305–315

**Description:**
The owner can set `maxAutoApproveAmount` to any arbitrary value, including values larger than `totalLiquidity`:

```solidity
function setAutoApproveConfig(bool _enabled, uint256 _maxAmount, uint256 _minReputation) external onlyOwner {
    autoApproveEnabled = _enabled;
    maxAutoApproveAmount = _maxAmount;      // no upper bound check
    minReputationForAutoApprove = _minReputation; // no lower bound check
    ...
}
```

Combined with `minReputationForAutoApprove = 0`, the owner could configure the pool to auto-approve any loan amount for any agent with zero reputation, bypassing the credit limit system entirely. Similarly, setting `minReputationForAutoApprove` to 0 defeats the reputation gate.

**Impact:** Owner can silently configure the pool to auto-approve loans that bypass all risk controls. This is a significant trust assumption not documented in the NatSpec.

**Fix:** Add bounds:
```solidity
require(_maxAmount <= 100_000 * 1e6, "maxAmount too high");
require(_minReputation >= 100, "minReputation too low");
```

---

### [M-05] MEDIUM — `AgentLiquidityMarketplace.requestLoan` Does Not Validate That Agent Has No Other Active Loans

**Contract:** `AgentLiquidityMarketplace.sol`
**Lines:** 186–237

**Description:**
An agent can call `requestLoan` multiple times, taking out multiple simultaneous active loans against the same pool. The credit limit check (`require(amount <= creditLimit)` on line 200) applies per loan, not across all outstanding loans. An agent with a $50,000 credit limit could take out 10 separate $50,000 loans if the pool has sufficient liquidity, for a total of $500,000 in outstanding debt.

The `LendingPoolV3` has the same issue.

**Impact:** Credit limit is not actually enforced; agents can over-leverage by taking multiple simultaneous loans.

**Fix:** Track total outstanding loan balance per agent and check against the credit limit:
```solidity
mapping(address => uint256) public totalOutstandingDebt;
require(totalOutstandingDebt[msg.sender] + amount <= creditLimit, "Exceeds credit limit");
```

---

### [M-06] MEDIUM — EIP-712 Signature Replay Across Chains and Missing Nonce in `AgentRegistryV2.setAgentWallet`

**Contract:** `AgentRegistryV2.sol`
**Lines:** 129–150

**Description:**
The `setAgentWallet` function uses EIP-712 signatures with a `deadline` but no `nonce`. The struct hash is:

```solidity
keccak256("SetWallet(uint256 agentId,address newWallet,uint256 deadline)")
```

Without a nonce:
1. **Signature reuse within the deadline window:** If a valid signature is submitted once (e.g., to temporarily set a wallet), the same signature can be resubmitted repeatedly until `deadline` expires. The function doesn't invalidate the signature after use.
2. **Cross-chain replay:** If the protocol is deployed on multiple chains with the same domain separator version, a signature valid on one chain is valid on all others (EIP-712 domain should include `chainId`, which OpenZeppelin's `EIP712` base contract does include — but this should be verified in the constructor configuration).

**Impact:** An attacker who intercepts a `setAgentWallet` signature can replay it to update the wallet to the attacker-controlled address any number of times before the deadline.

**Fix:** Add a per-agent nonce to the struct hash and increment it on each successful call:
```solidity
bytes32 structHash = keccak256(
    abi.encode(SET_WALLET_TYPEHASH, agentId, newWallet, nonces[agentId]++, deadline)
);
```

---

### [L-01] LOW — `AgentRegistryV2`: NFT Transfer Allows Recipient to Overwrite Existing `addressToAgentId` Mapping

**Contract:** `AgentRegistryV2.sol`
**Lines:** 296–299

**Description:**
In `_update`, when an NFT is transferred to an address that is *already* a registered agent:

```solidity
if (to != address(0)) {
    addressToAgentId[to] = tokenId; // silently overwrites existing entry
    agents[tokenId].owner = to;
}
```

If `to` already has an agent ID (e.g., they transferred their old NFT and then received another), their mapping silently points to the newly received token, potentially losing reference to their original agent ID with its established reputation.

**Fix:** Add a check:
```solidity
require(addressToAgentId[to] == 0, "Recipient already has an agent");
```

---

### [L-02] LOW — `AgentLiquidityMarketplace.claimInterest` Does Not Follow CEI Pattern

**Contract:** `AgentLiquidityMarketplace.sol`
**Lines:** 444–452

**Description:**
`claimInterest` follows CEI correctly (zeroes `earnedInterest` before the transfer), but does NOT reduce `pool.availableLiquidity` or `pool.totalEarned` when interest is claimed. After `_distributeInterest` credits lender positions, the interest amount exists in both `pool.availableLiquidity` (line 290) and `position.earnedInterest`. When `claimInterest` is called, the USDC is transferred out, but `pool.availableLiquidity` still reflects the interest as if it's still in the pool. This inflates the apparent pool liquidity and could lead to over-lending.

**Fix:** Decrement `pool.availableLiquidity` when interest is claimed:
```solidity
pool.availableLiquidity -= interest;
```

---

### [L-03] LOW — `LendingPoolV3.depositLiquidity` Has No Access Control

**Contract:** `LendingPoolV3.sol`
**Lines:** 272–281

**Description:**
`depositLiquidity` has no `whenNotPaused` modifier and no restriction on who can deposit. While this may be intentional, a paused contract should generally reject new liquidity deposits to prevent user confusion. Additionally, there is no corresponding record of *who* deposited what amount, making it impossible to withdraw liquidity fairly — only the owner can withdraw (`withdrawLiquidity` is `onlyOwner`), meaning depositors permanently cede control of their funds.

**Impact:** Retail depositors have no way to withdraw their own funds; only the owner can withdraw, making this a custodial pool.

**Fix:** Either implement per-depositor accounting with withdrawal rights (like `AgentLiquidityMarketplace`), or clearly document that this is an owner-controlled pool. Add `whenNotPaused` to `depositLiquidity`.

---

### [L-04] LOW — `ReputationManagerV3.recordDefault` Missing `ReputationUpdated` Event Ordering

**Contract:** `ReputationManagerV3.sol`
**Lines:** 180–197

**Description:**
`recordDefault` emits `DefaultRecorded` before `ReputationUpdated`. While this doesn't affect contract behavior, off-chain indexers and event listeners that process events in emission order may see a default recorded without yet knowing the resulting score change.

Additionally, `recordDefault` does not emit a `LoanCompleted` event (unlike `recordLoanCompletion`). A default is a loan completion of a sort, but defaulted loans are not tracked in `totalRepaid`, making the `totalRepaid` metric incomplete for risk analysis.

**Fix:** Reorder events for consistency. Consider whether `totalRepaid` should track the collateral recovered on default.

---

### [L-05] LOW — Front-Running: Reputation Score Can Change Between `requestLoan` and `_disburseLoan` in `AgentLiquidityMarketplace`

**Contract:** `AgentLiquidityMarketplace.sol`
**Lines:** 199–264

**Description:**
In `requestLoan`, the interest rate is fetched from `reputationManager.calculateInterestRate(msg.sender)` and stored in the loan struct before disbursement. However, the reputation score could be updated by another transaction (e.g., a concurrent default liquidation on a *different* pool) between the credit check and disbursement within the same `requestLoan` call (since `_disburseLoan` is called at the end). The interest rate stored may be stale with respect to the agent's current risk profile.

In `LendingPoolV3`, this window is even wider: the interest rate is calculated inside `_approveLoanInternal`, which can be called by the owner any time after `requestLoan` is called, potentially days later. The interest rate is set at approval time using the score at *that* moment, not the score at request time.

**Impact:** Low likelihood, but a temporarily high-reputation agent could lock in favorable terms before a known default is processed.

**Fix:** For `LendingPoolV3`, recalculate the credit limit and collateral requirement at approval time, not just at request time. Document the time-of-check vs time-of-use window explicitly.

---

## Summary Table

| ID | Severity | Contract | Title |
|----|----------|----------|-------|
| C-01 | Critical | AgentLiquidityMarketplace | Broken CEI: state updated before repayment transfer |
| C-02 | Critical | ReputationManagerV3 | `initializeReputation(uint256)` allows identity spoofing |
| H-01 | High | AgentLiquidityMarketplace | Interest distribution rounding permanently traps funds |
| H-02 | High | ALM + LendingPoolV3 | `totalLiquidity` not updated after default, misleading accounting |
| H-03 | High | LendingPoolV3 | `availableLiquidity` exceeds `totalLiquidity` after interest, causing DoS on `withdrawLiquidity` |
| H-04 | High | AgentLiquidityMarketplace | Unbounded lender array enables gas-limit DoS on `repayLoan` |
| H-05 | High | AgentRegistryV2 + lending | NFT transfer breaks cross-contract identity, leaves unrepayable loans |
| M-01 | Medium | LendingPoolV3 | Collateral locked with no refund path if auto-approve fails |
| M-02 | Medium | ALM + LendingPoolV3 | Interest calculated on fixed duration, not elapsed time |
| M-03 | Medium | ReputationManagerV3 | Untrusted external call to ValidationRegistry in credit calculation |
| M-04 | Medium | LendingPoolV3 | No bounds on `setAutoApproveConfig`, owner can bypass all risk controls |
| M-05 | Medium | ALM + LendingPoolV3 | Credit limit not enforced across multiple simultaneous loans |
| M-06 | Medium | AgentRegistryV2 | Missing nonce in EIP-712 signature allows replay attacks |
| L-01 | Low | AgentRegistryV2 | NFT transfer silently overwrites existing addressToAgentId mapping |
| L-02 | Low | AgentLiquidityMarketplace | `claimInterest` does not reduce `pool.availableLiquidity`, inflating pool state |
| L-03 | Low | LendingPoolV3 | `depositLiquidity` has no access control or depositor tracking |
| L-04 | Low | ReputationManagerV3 | Event ordering issue; defaults not tracked in `totalRepaid` |
| L-05 | Low | ALM + LendingPoolV3 | Front-running reputation score changes during loan request window |

---

## Recommendations (Prioritized)

1. **Immediate (before any mainnet deployment):** Fix C-01 and C-02. The CEI violation in `repayLoan` and the identity spoofing in reputation initialization are fundamental correctness bugs.

2. **Before launch:** Fix H-01 through H-05. The gas-limit DoS on `repayLoan` (H-04) and the identity-breaking NFT transfer issue (H-05) are exploitable on launch. The accounting divergence issues (H-02, H-03) will silently corrupt pool state from the first default.

3. **Before mainnet with real funds:** Fix M-01 through M-06. The credit limit bypass (M-05) and signature replay (M-06) are particularly important.

4. **Recommended before audit sign-off:** Consider an economic simulation of the interest distribution rounding (H-01) to quantify expected dust accumulation at scale.

5. **Architecture suggestion:** The dual lending pool approach (pooled `LendingPoolV3` + marketplace `AgentLiquidityMarketplace`) sharing the same `ReputationManagerV3` is sound, but the cross-contract identity model (NFT ownership = borrower identity) needs hardening. Consider storing `agentId` (uint256) in all loan structs rather than the raw address, and resolving the address-to-ID mapping only at the start of each transaction.

---

*This audit was performed on a point-in-time snapshot of the codebase. It does not constitute a guarantee of security. Additional audits, formal verification, and extensive testing are recommended before production deployment.*
