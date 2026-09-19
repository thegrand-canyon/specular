# Contract Schema Reference

On-chain data shapes and state machines for `AgentLiquidityMarketplace.sol`.
Use this as the single source of truth when writing JS/TS callers — multiple
in-repo scripts have shipped with a wrong field name (e.g. `loan.principal`)
or an inverted state-enum reading. This doc is meant to prevent the next one.

All references below cite line numbers in
[`contracts/core/AgentLiquidityMarketplace.sol`](../../contracts/core/AgentLiquidityMarketplace.sol).

---

## `LoanState` enum

```solidity
enum LoanState {
    REQUESTED,   // 0  ← initial; only briefly during requestLoan tx
    ACTIVE,      // 1  ← funded, outstanding
    REPAID,      // 2  ← borrower repaid principal + interest
    DEFAULTED    // 3  ← owner-liquidated after endTime
}
```

**Common gotcha**: `state === 1` is **ACTIVE, not REPAID**. Multiple ad-hoc
inspector scripts have flipped this, then concluded a wallet had no active
loans when in fact every recent loan was active and unpaid.

The `REQUESTED` state is essentially never observable off-chain because
`requestLoan` (line 195) calls `_disburseLoan` (line 256) inline within the
same transaction, transitioning to `ACTIVE` before the receipt is emitted.
A loan you `getLogs` for `LoanRequested` is virtually always already
`ACTIVE` by the time you read its state.

### State machine

```
            requestLoan()                  repayLoan()
   ┌──────────────────────────┐  ┌──────────────────────────┐
   │                          ▼  │                          ▼
[off-chain] ──────► REQUESTED ─────► ACTIVE ──────► REPAID
                       │                │
                       │                │ liquidateLoan() (owner only,
                       │                ▼   after endTime)
                       └──────────► DEFAULTED
                       (never visible off-chain in practice — same tx)
```

Transitions enforced by `require` at:
- `REQUESTED → ACTIVE`: line 260 (`require(loan.state == LoanState.REQUESTED, "Invalid loan state")`)
- `ACTIVE → REPAID`: line 286 (`require(loan.state == LoanState.ACTIVE, "Loan not active")`)
- `ACTIVE → DEFAULTED`: line 367 + line 368 (`require(block.timestamp > loan.endTime, "Loan not overdue")`)

`REPAID` and `DEFAULTED` are terminal — there is no transition out of them.

---

## `Loan` struct

10 fields, in declaration order. ABI returns them as a positional tuple, so
`mp.loans(id)[N]` is a stable accessor; named-property access (`.amount`,
`.state`) works under ethers v6 named tuples but **not** under any older
ethers v5 code path that returns plain arrays.

| Idx | Field             | Solidity type | Notes                                       |
|-----|-------------------|---------------|---------------------------------------------|
| 0   | `loanId`          | `uint256`     | == the mapping key; redundant in storage    |
| 1   | `borrower`        | `address`     | always `msg.sender` of `requestLoan`        |
| 2   | `agentId`         | `uint256`     | resolved from borrower via AgentRegistryV2  |
| 3   | `amount`          | `uint256`     | **principal in USDC base units (6 dp)**     |
| 4   | `collateralAmount`| `uint256`     | USDC base units; `(amount * collateralPct) / 100` |
| 5   | `interestRate`    | `uint256`     | **basis points** (e.g. `500` = 5% APR)      |
| 6   | `startTime`       | `uint256`     | unix seconds; set in `_disburseLoan`        |
| 7   | `endTime`         | `uint256`     | `startTime + duration`                      |
| 8   | `duration`        | `uint256`     | **seconds** (== `durationDays * 1 days`)    |
| 9   | `state`           | `LoanState`   | see enum above                              |

### Common bugs to avoid

1. **Reading `loan.principal`** — the field is named `amount`, not
   `principal`. Found in demo-borrower-agent.js lines 190–192. ABI decode
   silently returns `undefined` for unknown property names on named tuples,
   so the bug surfaces as `Cannot read properties of undefined` or
   `BigInt(undefined)` at the next arithmetic op, not at the contract call.

2. **Computing interest as `loan.interestRate * principal / 10000n`** —
   misses the duration scaling. The contract's actual formula
   ([`calculateInterest`](../../contracts/core/AgentLiquidityMarketplace.sol)
   line 399) is:
   ```
   interest = (principal * annualRateBPS / 10000) * durationSeconds / 365 days
   ```
   For a 5%-APR, 7-day, 100-USDC loan the difference is ~50× (correct value
   ≈ 0.0959 USDC; the buggy formula gives 5.0 USDC).

   Always call the contract's `calculateInterest(principal, rateBPS, durationSeconds)`
   directly — it's `pure` and free.

3. **Treating `duration` as days** — it's stored as **seconds** (multiplied by
   `1 days` in `requestLoan` line 204). The `durationDays` param at the API
   surface is in days; the struct field is in seconds. They are not the same
   field.

4. **Off-by-one on `interestRate`** — units are basis points (1/10000), not
   percent. A field reading `500` means **5%**, not 500%.

---

## `AgentPool` struct

7 fields. Returned positionally from `agentPools(uint256 agentId)`.

| Idx | Field                | Solidity type | Notes                                  |
|-----|----------------------|---------------|----------------------------------------|
| 0   | `agentId`            | `uint256`     | == the mapping key                     |
| 1   | `agentAddress`       | `address`     | resolved from registry at `createAgentPool` |
| 2   | `totalLiquidity`     | `uint256`     | USDC base units; lifetime supplied     |
| 3   | `availableLiquidity` | `uint256`     | USDC base units; available for borrow  |
| 4   | `totalLoaned`        | `uint256`     | USDC base units; currently outstanding |
| 5   | `totalEarned`        | `uint256`     | USDC base units; lender interest accrued |
| 6   | `isActive`           | `bool`        | gates `requestLoan` (line 198)         |

Invariant: `totalLiquidity == availableLiquidity + totalLoaned` after
accounting (subject to interest-distribution rounding handled inside the
contract). The owner-only `resetPoolAccounting(agentId)` (line 520) re-derives
`totalLoaned` from a walk of `agentLoans` and emits `PoolAccountingReset` if
they drift.

`getAgentPool(agentId)` (line 412) is a richer view function returning the
above plus a derived `utilizationRate` and `lenderCount`. Prefer it for
human-facing displays.

---

## `LenderPosition` struct

4 fields per `(agentId, lender)` pair.

| Idx | Field              | Solidity type | Notes                                    |
|-----|--------------------|---------------|------------------------------------------|
| 0   | `amount`           | `uint256`     | USDC base units; principal supplied      |
| 1   | `earnedInterest`   | `uint256`     | USDC base units; interest accrued so far |
| 2   | `depositTimestamp` | `uint256`     | unix seconds                             |
| 3   | (unnamed bool)     | `bool`        | "When they deposited" — see source       |

Note: the third field's comment in source is ambiguous; check
[contract line ~75–80] before relying on field 3 in new code.

---

## Events

Index of every event the marketplace emits. Use these to drive ETL / log
analysis rather than polling state, which is noisy.

```solidity
event PoolCreated(uint256 indexed agentId, address indexed agentAddress);
event LiquiditySupplied(uint256 indexed agentId, address indexed lender, uint256 amount);
event LiquidityWithdrawn(uint256 indexed agentId, address indexed lender, uint256 amount);
event LoanRequested(uint256 indexed loanId, uint256 indexed agentId, address indexed borrower, uint256 amount);
event LoanDisbursed(uint256 indexed loanId, uint256 amount);
event LoanRepaid(uint256 indexed loanId, uint256 principal, uint256 interest);
event LoanDefaulted(uint256 indexed loanId);
event InterestDistributed(uint256 indexed agentId, uint256 totalInterest);
event PoolAccountingReset(uint256 indexed agentId, uint256 oldTotalLoaned, uint256 newTotalLoaned, uint256 newAvailableLiquidity);
```

### Notable parsing detail

`LoanRepaid` emits the field as `principal` (not `amount`) — this is the
**only** place in the public surface that uses the word `principal`. It's
the same value as `loan.amount`. Don't let this leak back into struct
field-name assumptions.

`LoanRequested` and `LoanDisbursed` always come from the same transaction
(see "REQUESTED state" note above). When subscribing, treat them as a
single logical event; if you only see one, your log filter dropped the
other.

---

## Function surface (selected)

Signatures most JS callers reach for. Full ABI lives in the artifacts
directory.

```solidity
// Pool management
function createAgentPool() external;
function getAgentPool(uint256 agentId) external view
    returns (address, uint256, uint256, uint256, uint256, uint256, uint256);

// Lending
function supplyLiquidity(uint256 agentId, uint256 amount) external;
function withdrawLiquidity(uint256 agentId, uint256 amount) external;

// Borrowing
function requestLoan(uint256 amount, uint256 durationDays) external returns (uint256);
//   ^^ durationDays is in DAYS. range [MIN_LOAN_DURATION/1 days, MAX_LOAN_DURATION/1 days]
//   ^^ enforced by assertDurationDays() in src/sdk/duration.js
function repayLoan(uint256 loanId) external;

// Owner-only liquidation
function liquidateLoan(uint256 loanId) external;

// Pure / view helpers
function calculateInterest(uint256 principal, uint256 annualRateBPS, uint256 durationSeconds)
    public pure returns (uint256);
function loans(uint256 loanId) external view returns (...the 10-field tuple above...);
function agentLoans(address borrower, uint256 index) external view returns (uint256);
function nextLoanId() external view returns (uint256);
function MAX_ACTIVE_LOANS_PER_AGENT() external view returns (uint256);
```

### `agentLoans` / `getAgentLoans` confusion

The mapping `agentLoans` is exposed only as the indexed accessor
`agentLoans(address, uint256)`. There is **no** `getAgentLoans(address)`
function returning the full array — multiple repo scripts have called it
and crashed. To enumerate, walk indices upward until the call reverts; or
binary-search if you expect length > 100.

`MAX_ACTIVE_LOANS_PER_AGENT()` returns the per-borrower cap (currently 10).
Concurrent borrow tests that exceed this cap will have the surplus txs
revert with `"Too many active loans"`, even though the burst superficially
looks like a stress-test win.

---

## Caller gotchas: BigInt × JSON.stringify

ethers v6 returns every uint as a native JavaScript `bigint`. The most common
trap when bridging on-chain values into the `SpecularSDK` API surface (or any
other JSON over HTTP) is:

```js
const loanId = parsed.args.loanId;          // bigint, e.g. 2093n
JSON.stringify({ loanId });                  // ❌ TypeError: Do not know how to serialize a BigInt
```

This bites `SpecularSDK.repayLoan(loanId)` directly — its body is
`JSON.stringify({ loanId })` to call the unsigned-tx-builder API. If you pass
the bigint straight from a parsed event log, the SDK throws **before** the
network call, with no hint about the offending field.

### Safe call patterns

```js
// 1. Convert at the SDK boundary
await sdk.repayLoan(Number(loanId));        // safe up to 2^53 — fine for any realistic loanId
await sdk.repayLoan(loanId.toString());     // safe for any size; the mock API parses with BigInt() inside encodeFunctionData

// 2. Or extract the loanId as a string from the receipt yourself
const log = receipt.logs.find(l => l.topics[0] === ev.topicHash);
const loanIdStr = ethers.toBigInt(log.topics[1]).toString();
await sdk.repayLoan(loanIdStr);
```

### Where this also lurks

- Any `fetch(..., { body: JSON.stringify(payload) })` where `payload` includes
  a uint pulled from a contract call.
- `console.log({ loan })` is fine — Node's util.inspect handles bigints.
  But `JSON.stringify(loan)` of a struct tuple silently breaks the same way.
- Stress-test logging that captures raw event args: `JSON.stringify(parsed.args)`
  throws as soon as one field is a uint.

### Why the SDK does not pre-convert

The SDK accepts the loanId opaquely and forwards it to the unsigned-tx
builder. Converting bigints inside the SDK would mask user error in callers
that legitimately want to pass strings or numbers. The validated contract is
"caller passes a JSON-serializable value"; this doc records that contract.

Verified empirically (Arc Testnet, loan #2093, this session): with
`Number(loanId)` conversion the SDK's `repayLoan` succeeds end-to-end in
~3.2 s, status=1, state transitions ACTIVE → REPAID.

---

## Cross-reference

- [`receipt.js`](./receipt.js) / [`RECEIPT.md`](./RECEIPT.md) — resilient
  receipt fetching for any `tx.wait()` against unreliable RPCs.
- [`duration.js`](./duration.js) — `assertDurationDays` for `requestLoan`.
- [`nonce.js`](./nonce.js) — `NonceCounter` for serializing concurrent sends.
- [`gasDefaults.js`](./gasDefaults.js) — sane gas limits per network.
- [Base deployments](../../BASE_DEPLOYMENTS.md) — canonical / V3-test / early
  marketplace addresses on Base mainnet.
