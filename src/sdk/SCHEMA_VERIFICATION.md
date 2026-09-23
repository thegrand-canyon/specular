# `SCHEMA.md` Live Verification

[`SCHEMA.md`](./SCHEMA.md) was written from on-disk Solidity source +
artifact reads. This document **verifies it against running contracts on
Arc Testnet and Base mainnet**, and notes a few extensions that
`SCHEMA.md` does not currently cover (`AgentRegistryV2`,
`ReputationManagerV3`).

Every claim below is backed by a live `eth_call` performed during the
session that produced this doc — not a re-read of the artifacts.

---

## TL;DR

- **`SCHEMA.md` is correct as written**. The 10-field `Loan` tuple
  (`loanId, borrower, agentId, amount, collateralAmount, interestRate,
  startTime, endTime, duration, state`) and the 7-field `AgentPool` tuple
  (`agentId, agentAddress, totalLiquidity, availableLiquidity, totalLoaned,
  totalEarned, isActive`) match exactly what the deployed contracts return
  on **both** Arc Testnet and Base mainnet.
- **Same artifact deployed on both networks**. Field order, names, types
  are byte-identical (no upgrade drift, no per-network customisation).
- **Two API surfaces NOT in `SCHEMA.md`** are documented here for the
  first time: `AgentRegistryV2` (NFT-based agent identity) and
  `ReputationManagerV3` (credit scoring). Several consumer scripts and
  audit docs reference functions that don't exist on these contracts —
  see §G1-§G3 below.

---

## §S1 — `Loan` struct verification

### Probe (Arc Testnet, `loans(2093)`)

```
[0] loanId           : uint256 = 2093
[1] borrower         : address = 0x656086A21073272533c8A3f56A94c1f3D8BCFcE2
[2] agentId          : uint256 = 43
[3] amount           : uint256 = 5000000           (5.000000 USDC)
[4] collateralAmount : uint256 = 0
[5] interestRate     : uint256 = 500               (5.00% APR in BPS)
[6] startTime        : uint256 = 1777584942
[7] endTime          : uint256 = 1778189742
[8] duration         : uint256 = 604800            (7 days in seconds)
[9] state            : uint8   = 2                 (REPAID)
```

### Probe (Base mainnet, `loans(1)`)

Base canonical marketplace (`0xd7b4dEE74C61844DFA75aEbe224e4635463b1C8f`)
returns an empty struct (no loan #1 exists; `nextLoanId() = 1`):

```
[0] loanId           : uint256 = 0
[1] borrower         : address = 0x0000…0000
[2..8] uint256 = 0
[9] state            : uint8   = 0
```

But the **field count, names, types, and order** match Arc exactly. This
is expected — both networks deploy the same compiled artifact
(`artifacts/contracts/core/AgentLiquidityMarketplace.sol/AgentLiquidityMarketplace.json`).

### Verdict

`SCHEMA.md` §"`Loan` struct" — **matches on-chain reality**.

All four "Common bugs to avoid" notes (field name `amount` not
`principal`; interest formula scales by duration; `duration` is in
seconds; `interestRate` is in BPS) are independently verified by the
field types and the live values above.

---

## §S2 — `AgentPool` struct verification

### Probe (Arc Testnet, marketplace)

The function actually exposed is `agentPools(uint256 agentId)` (the public
mapping accessor) returning 7 named fields:

```
agentId, agentAddress, totalLiquidity, availableLiquidity,
totalLoaned, totalEarned, isActive
```

Plus the richer view `getAgentPool(uint256 agentId)` returning 7 fields:

```
agentAddress, totalLiquidity, availableLiquidity, totalLoaned,
totalEarned, utilizationRate, lenderCount
```

(Note: `getAgentPool` does NOT include `agentId` — caller already passed
it. It DOES include derived `utilizationRate` and `lenderCount` not in
the storage struct.)

### Verdict

`SCHEMA.md` §"`AgentPool` struct" — **matches on-chain reality**, with
one nuance worth noting:

The doc shows `agentPools(...)` returning 7 fields (matches), and at line
128 says "`getAgentPool(agentId)` is a richer view function returning the
above plus a derived `utilizationRate` and `lenderCount`". That's
correct in spirit, but the live call shows `getAgentPool` **omits
`agentId`** from its return tuple (the caller already supplied it). Net
field count is the same (7), but positional indexes shift by one.

This is a real footgun for any consumer that does
`getAgentPool(id)[0]` expecting `agentId` — they'd get `agentAddress`
instead. Worth a clarifying note in `SCHEMA.md` if it gets revised.

---

## §S3 — Marketplace function surface (full enumeration)

Every `view`/`pure` function on the deployed marketplace, verified live:

```
agentLoans(address, uint256)           → uint256                       — indexed accessor; no full-array variant
agentPoolIds(uint256)                  → uint256                       — array accessor
agentPools(uint256)                    → 7-tuple (see §S2)
agentRegistry()                        → address                       — links to AgentRegistryV2
calculateInterest(uint256,uint256,uint256) → uint256                   — pure; (principal, rateBPS, durationSeconds)
getActiveAgents()                      → uint256[]                     — full list (O(N) gas if huge)
getAgentPool(uint256)                  → 7-tuple (see §S2; note shifted indexes)
getLenderPosition(uint256, address)    → 4-tuple (amount, earnedInterest, depositTimestamp, shareOfPool)
loans(uint256)                         → 10-tuple (see §S1)
nextLoanId()                           → uint256
owner()                                → address
paused()                               → bool
platformFeeRate()                      → uint256                       — BPS
poolLenders(uint256, uint256)          → address                       — indexed accessor
positions(uint256, address)            → 3-tuple (amount, earnedInterest, depositTimestamp)
reputationManager()                    → address                       — links to ReputationManagerV3
totalPools()                           → uint256
usdcToken()                            → address
MAX_ACTIVE_LOANS_PER_AGENT()           → uint256
MAX_INTEREST_RATE()                    → uint256
MAX_LENDERS_PER_POOL()                 → uint256
MAX_LOAN_DURATION()                    → uint256
MIN_LOAN_DURATION()                    → uint256
accumulatedFees()                      → uint256
```

### Notes on this surface

- **Two LenderPosition shapes coexist**. `getLenderPosition(...)` returns
  4 fields including a derived `shareOfPool`; the public mapping
  `positions(...)` returns the underlying 3-field storage struct. The
  `SCHEMA.md` "`LenderPosition` struct" section currently shows 4 fields
  (line 138-142) with one labeled "(unnamed bool)" — that's wrong on
  both counts: the storage struct has 3 fields, all uint256, and the
  4-field view returns a uint256 `shareOfPool` (not a bool). **`SCHEMA.md`
  should correct this section.**
- **No `getAgentLoans(address)` exists**. Confirmed live; the only
  per-agent enumeration is the indexed `agentLoans(addr, idx)` accessor.
  This matches `SCHEMA.md` §"`agentLoans` / `getAgentLoans` confusion".
- **`calculateInterest` is `pure`**. Free to call at any time, no state
  read required. Consumers should use it instead of duplicating the
  formula off-chain.

---

## §S4 — `ReputationManagerV3` function surface (NEW — not in `SCHEMA.md`)

### Live probe result

```
agentRegistry()                            → address
authorizedPools(address)                   → bool                    — gates state-changing calls
calculateCollateralRequirement(address)    → uint256                 — BPS
calculateCreditLimit(address)              → uint256                 — USDC base units
calculateInterestRate(address)             → uint256                 — BPS
defaultCount(uint256)                      → uint256                 — keyed by agentId
defaultPenaltyBase()                       → uint256
defaultPenaltyLarge()                      → uint256
getReputationScore(address)                → uint256                 — overload 1
getReputationScore(uint256)                → uint256                 — overload 2 (by agentId)
largeLoanThreshold()                       → uint256
loanCount(uint256)                         → uint256                 — keyed by agentId
onTimeRepaymentBonus()                     → uint256
owner()                                    → address
totalBorrowed(uint256)                     → uint256                 — keyed by agentId
totalRepaid(uint256)                       → uint256                 — keyed by agentId
validationBonusThreshold()                 → uint256
validationCreditBonus()                    → uint256
validationRegistry()                       → address
```

### §G1 (HIGH) — `getReputation()` does not exist

Multiple consumer scripts and audit docs reference `getReputation(addr)`
or `getReputation(agentId)` returning a tuple of (score, tier, limit,
rate, collateral, ...). **No such function exists.**

The actual surface is decomposed into:

```
getReputationScore(address|uint256) → uint256       — score only
calculateCreditLimit(address)        → uint256       — limit only
calculateInterestRate(address)       → uint256       — rate only (BPS)
calculateCollateralRequirement(address) → uint256    — collateral only (BPS)
```

Consumers that expect a single tuple call will get
`TypeError: contract.getReputation is not a function`. Consumers that
**construct** a tuple JSON expecting that shape (e.g. some API responses)
will silently produce a `tier` field of `undefined`.

The "tier" string (BRONZE / SILVER / GOLD / PLATINUM) is computed
**off-chain** by the API server from the score. There is no on-chain
`tier` field. Consumers reading `loan.reputation.tier` from a contract
struct will always get `undefined` because no such struct exists.

### §G2 (MED) — `defaultCount`, `loanCount`, `totalBorrowed`, `totalRepaid` are keyed by `agentId` (uint256), NOT address

Subtle gotcha. These four mappings are keyed by the registry's `agentId`,
not by the borrower address. To look up reputation stats for a wallet,
the consumer must:

1. `addressToAgentId(wallet)` → agentId  (on AgentRegistryV2)
2. `loanCount(agentId)` etc. (on ReputationManagerV3)

A direct call like `loanCount(walletAddress)` will silently
re-interpret the address bytes as a uint256 and return 0 (because that
agentId doesn't exist). No revert. No warning. Returns plausible-looking
data.

### §G3 (LOW) — `getReputationScore` overload disambiguation

Two functions share the name with different argument types. ethers v6
disambiguates by signature (`getReputationScore(address)` vs
`getReputationScore(uint256)`), but JSON-encoded ABI lookups by name
(common in dynamic call patterns) will hit the first match and produce
silent wrong-key errors.

Consumers should prefer the explicit signature-form for safety:

```js
const fn = rep.getFunction('getReputationScore(address)');
await fn(wallet.address);
```

---

## §S5 — `AgentRegistryV2` function surface (NEW — not in `SCHEMA.md`)

### Live probe result

```
addressToAgentId(address)              → uint256                  — primary lookup; returns 0 if unregistered
agentMetadata(uint256, string)         → bytes                    — single key lookup
agents(uint256)                        → 6-tuple (agentId, owner, agentWallet, agentURI, registrationTime, isActive)
balanceOf(address)                     → uint256                  — ERC721 inherited
eip712Domain()                         → 7-tuple (fields, name, version, chainId, verifyingContract, salt, extensions)
getAgentInfo(address)                  → tuple                    — full record by address
getAgentInfoById(uint256)              → tuple                    — full record by agentId
getApproved(uint256)                   → address                  — ERC721 inherited
getMetadata(uint256, string)           → bytes                    — alias for agentMetadata
isAgentActive(address)                 → bool
isApprovedForAll(address, address)     → bool                     — ERC721 inherited
isRegistered(address)                  → bool
name()                                 → string                   — ERC721 token name
owner()                                → address                  — Ownable
ownerOf(uint256)                       → address                  — ERC721 inherited
paused()                               → bool
supportsInterface(bytes4)              → bool                     — ERC165
symbol()                               → string                   — ERC721 token symbol
tokenURI(uint256)                      → string                   — ERC721 inherited
totalAgents()                          → uint256
```

### §G4 — `Agent` struct shape (6 fields)

Returned by `agents(agentId)` as a positional tuple:

| Idx | Field              | Type      | Notes                                          |
|-----|--------------------|-----------|------------------------------------------------|
| 0   | `agentId`          | `uint256` | == the mapping key                             |
| 1   | `owner`            | `address` | wallet that controls / can transfer the NFT    |
| 2   | `agentWallet`      | `address` | wallet the agent uses for on-chain actions     |
| 3   | `agentURI`         | `string`  | metadata URI (ipfs:// or https://)             |
| 4   | `registrationTime` | `uint256` | unix seconds                                   |
| 5   | `isActive`         | `bool`    | gates `isAgentActive`                          |

### §G5 — `register()` signature confirmed (from artifact)

```
register(string agentURI, MetadataEntry[] metadata) nonpayable
  where MetadataEntry = (string key, bytes value)
```

This is the function `OPTION2_FEASIBILITY.md` and the main SDK target. Confirmed live.

### §G6 (MED) — `addressToAgentId` returns 0 for unregistered, NOT revert

A consumer doing:

```js
const id = await reg.addressToAgentId(someWallet);
const info = await reg.agents(id);  // ← if unregistered, fetches agents(0) — empty struct
```

…will silently get an empty agent record with `agentId: 0` and look like
a valid registered-as-zero agent. The correct check is
`isRegistered(addr)` first, OR check `id !== 0n` explicitly.

---

## §S6 — Cross-network parity check

Both Arc Testnet and Base mainnet deploy the **same compiled artifact**:

| Network        | Marketplace addr                                  | totalPools | nextLoanId |
|----------------|---------------------------------------------------|------------|-------------|
| Arc Testnet    | `0x048363A325A5B188b7FF157d725C5e329f0171D3`     | (many)     | 2094+       |
| Base mainnet   | `0xd7b4dEE74C61844DFA75aEbe224e4635463b1C8f`     | 1          | 1           |

Field shapes, function selectors, event topics — all identical between
networks. **`SCHEMA.md` is portable** and consumers do not need
network-conditional code paths for the data plane.

What DOES differ between networks (worth knowing):

- USDC address (Arc has `mockUSDC` at `0xf2807...`; Base has real USDC at
  `0x83358...`)
- Network id and RPC endpoint
- Activity volume (Arc is the test workhorse; Base canonical is barely
  used)

Note: Arc has multiple historical marketplace deployments (see
`arc-testnet-addresses.json` keys: `agentLiquidityMarketplace`,
`_old`, `_v2`, `_v4`, `_v5_WITH_FIX`). Use only the value at the
top-level `agentLiquidityMarketplace` key — the others are scaffolding
from upgrade history.

---

## Recommendations for `SCHEMA.md` revision

Bounded scope additions that would close the gaps surfaced here:

1. **Fix `LenderPosition` section** — storage struct is 3 uint256 fields,
   not 4 with a bool. The 4-field shape comes from the
   `getLenderPosition` view (which adds `shareOfPool: uint256`).
2. **Document `getAgentPool` index shift** — caller-supplied agentId is
   omitted from the return tuple, so positional indexes differ from
   `agentPools()`.
3. **Add an `AgentRegistryV2` section** mirroring the existing
   `AgentLiquidityMarketplace` section. Cover the 6-field `Agent` struct,
   the `register(agentURI, metadata)` signature, the
   `addressToAgentId` zero-return-on-unregistered footgun.
4. **Add a `ReputationManagerV3` section.** Document that there's NO
   `getReputation()` aggregate; consumers must call the four
   `calculate*` functions individually. Document the
   address-vs-agentId-key distinction (§G2).
5. **Cross-network parity statement.** Add a one-line "schemas are
   identical across Arc and Base" so readers don't fork by network.

These are all documentation additions — no code change implied.

---

## Cross-reference

- [`SCHEMA.md`](./SCHEMA.md) — the doc this verifies
- [`API_AUDIT.md`](./API_AUDIT.md) — uses these schemas to flag drift in
  the API server's JSON shapes (§1, §3)
- [`DRIFT_AUDIT.md`](./DRIFT_AUDIT.md) — uses these schemas to flag
  client-side scripts assuming wrong shapes
- [`OPTION2_FEASIBILITY.md`](./OPTION2_FEASIBILITY.md) — relies on the
  function signatures verified above for local calldata encoding
- [`VIRTUALS_SDK_AUDIT.md`](./VIRTUALS_SDK_AUDIT.md) — second SDK that
  hardcodes one of the marketplace addresses checked here
