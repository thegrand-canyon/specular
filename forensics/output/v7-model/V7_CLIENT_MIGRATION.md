# V7 client migration — SDKs, Python client and the hosted MCP/REST server

**Scope:** the off-chain layers only. No contract was modified, and **nothing was deployed or broadcast to any
network** by this work — every test runs on the in-process hardhat chain (`chainId 31337`) or against mocks.
**Date:** 2026-09-22 · **Branch:** `arc-mainnet-launch`
**Companion:** `forensics/output/v7-model/V7_DESIGN_AND_VALIDATION.md` (the contract-side design; §8 is the
interface-change list this document implements).

---

## 0. The problem in one paragraph

V7 ships as a **redeploy**, not an upgrade: `ReputationManagerV4` + `AgentLiquidityMarketplaceV62`
(`VERSION() == "V6.2"`). It adds a first-loss **self-stake** an agent must post in its own pool, **locks** that
position while the agent borrows, moves the **credit tier table on chain** where the owner can change it, and
**does not carry reputation across the deploy**. Meanwhile **Base mainnet and Arc mainnet stay on V6.1 / V3**.
So every client now has to serve three marketplace generations and two reputation generations *at once*, decide
which it is talking to from the chain rather than from a config file, and stop shipping a hardcoded copy of a table
that is now mutable state.

---

## 1. The three-way capability matrix

Detection is by **deployed bytecode plus `VERSION()`**, never by "an `eth_call` failed" — a 429/timeout is
indistinguishable from a missing selector at the client layer, which is the F-R1 finding from the 2026-09
robustness round. The V6/V6.1 probe already worked that way; this round extends it to a third generation and to
the reputation manager.

| generation | `VERSION()` | `v61` | `v62` | what it adds | live where (2026-09-22) |
|---|---|---|---|---|---|
| **V6** | *(selector absent)* | ✗ | ✗ | baseline | Base mainnet `0x0a4e…5F9a` |
| **V6.1** | `"V6.1"` | ✓ | ✗ | `previewRepayment`, `canTopUp`, `getActiveLoanIds`, `LATE_INTEREST_CAP`, elapsed-time late interest | Arc mainnet `0x358c…b282` |
| **V6.2 (V7)** | `"V6.2"` | ✓ | ✓ | `requiredSelfStake`, `selfStake`, first-loss lock, creator exempt from `minSupplyAmount`, `loanId` passed to reputation | Arc staging `0xa736…6300` |

| reputation | `VERSION()` | `v4` | what it adds |
|---|---|---|---|
| **V3** | *(selector absent)* | ✗ | tier table compiled in (25,000 / 50,000) |
| **V4 (V7)** | `"V4"` | ✓ | tier table **on chain and owner-settable**, credit ladder, post-default lockout, `MAX_TIER_LIMIT` ceiling, late penalty |

Three rules the implementation follows everywhere:

1. **Ordering, not equality.** `versionOrdinal('V6') = 6`, `'V6.1' = 6.1`, `'V6.2' = 6.2`; gates are `>=`. An
   unparseable answer sorts as `6` — the most conservative generation — so nothing newer is ever attempted on a
   contract the client cannot identify.
2. **Belt and braces on V6.2.** A contract claiming `"V6.2"` is only treated as `v62` once the self-stake view is
   confirmed (bytecode selector in the SDKs, a live `requiredSelfStake(0,0)` call in the server). A mislabelled or
   partially-migrated deployment cannot make a client skip the pre-checks that exist to prevent a revert.
3. **Probe failures fail in the safe direction, and the direction depends on the stake.** For repayment sizing the
   safe direction is to *surface* the error (guessing V6 under-approves a late repay and the loan cannot be closed
   — unchanged from the F-R1/F-R2 behaviour). For the V7 *pre-checks* the safe direction is to *proceed*: the gate
   is enforced on chain regardless, so a failed probe costs the caller a written explanation, never the ability to
   transact.

ABIs are now **supersets**. `AgentLiquidityMarketplaceV62` is a strict superset of `V6` (it adds only the two
views), so it is loaded directly and every V6/V6.1 call still encodes byte-identically. `ReputationManagerV4` is
*not* a superset — it replaces the three `record*` write signatures with `loanId`-carrying ones — so V3 and V4 are
**unioned** (dedup by canonical signature, V3 first). Those writes are `onlyAuthorizedPool`; no client calls them.

Address resolution prefers the V7 keys where a config publishes them:
`agentLiquidityMarketplace_v62 || agentLiquidityMarketplace_v6 || agentLiquidityMarketplace`, and
`reputationManagerV4 || reputationManagerV3`. `src/config/arc-testnet-v6-addresses.json` already carries both.

---

## 2. JS SDK — `src/sdk/SpecularQuickstart.js` (+ `.d.ts`)

**New module `src/sdk/abis.js`** — superset ABI loading and the V3∪V4 union, shared by the SDK and any tooling
that needs the same handles.

### New surface

| member | behaviour |
|---|---|
| `static versionOrdinal(v)` | `'V6'→6`, `'V6.1'→6.1`, `'V6.2'→6.2`; junk → `6`. |
| `capabilities()` | `{version, ordinal, v61, v62, reputationVersion, reputationV4}`, cached per instance. |
| `reputationVersion()` | `'V3'` / `'V4'`, from deployed bytecode; a transient failure throws `SPECULAR_VERSION_UNKNOWN` rather than being cached as `'V3'`. |
| `requiredSelfStake(agentId, additionalAmount?)` | base units. Throws `SPECULAR_UNSUPPORTED_ON_DEPLOYMENT` on V6/V6.1. |
| `selfStake(agentId)` | `{amount, amountUsdc, locked, required, requiredUsdc, shortfall, shortfallUsdc}`. Same gate. |
| `tierTable()` | `{source:'chain'\|'v3-constant', maxTierLimit, tiers[6]}` — **read from the contract** on V4. |

### Changed behaviour

* **`borrow()`** now runs the M2-c gate before sending anything. When the tier's collateral is `< 100 %` and the
  deployment is V6.2, it reads `requiredSelfStake(agentId, amount)` and `selfStake(agentId)` and, if short, throws
  `SPECULAR_INSUFFICIENT_SELF_STAKE` carrying `{agentId, required, current, shortfall}` and a message naming the
  exact `sdk.supply(...)` call to make. **No transaction and no approval is sent** on that path — which matters,
  because the contract's own check sits *after* the collateral pull would have been approved.
* **`withdraw()`** now runs the M2-a check: if this wallet is `pool.agentAddress` and `outstandingPrincipal > 0`,
  it throws `SPECULAR_SELF_STAKE_LOCKED` with the outstanding figure. Ordinary lenders are untouched.
* **`creditInfo()`** is additively enriched. Always: `marketplaceVersion`, `reputationVersion`. On V4:
  `agentId, tier, tierLimit, ladderLimit, maxRepaidPrincipal, maxTierLimit, lockedOut, lockedUntil,
  limitExplanation`. On V6.2: `selfStake`. These keys are **absent** on older deployments rather than faked, and a
  failed capability probe degrades to exactly the old V3-shaped result.
* **Exact approvals are unchanged and re-asserted.** No path added here approves anything; `supply()` (used to post
  the stake) already approves the exact amount and leaves a zero resting allowance. The integration suite asserts
  the full approval list for a whole lifecycle and that `MaxUint256` never appears.

`SpecularQuickstart.d.ts` gains `SpecularCapabilities`, `SelfStakeInfo`, `CreditTier`, `CreditTierTable`, the new
methods, the new `CreditInfo` optional fields, and documents the two new error codes on `borrow`/`withdraw`.
`SpecularNetwork` was also corrected to include `arc-staging` and `arc-mainnet`, which the runtime already accepted.

---

## 3. Python client — `python/specular/client.py`

Full parity, method for method. The 2026-09 robustness round found Python materially weaker than JS; this round
keeps them level.

| JS | Python |
|---|---|
| `SpecularQuickstart.versionOrdinal` | `SpecularClient.version_ordinal` |
| `capabilities()` | `capabilities()` → dict with the same keys (snake_case) |
| `reputationVersion()` | `reputation_version()` |
| `requiredSelfStake()` | `required_self_stake()` |
| `selfStake()` | `self_stake()` → `SelfStakeInfo` dataclass |
| `tierTable()` | `tier_table()` → `{'source', 'max_tier_limit', 'tiers': [CreditTier]}` |
| `SPECULAR_INSUFFICIENT_SELF_STAKE` | `InsufficientSelfStake` (`.agent_id/.required/.current/.shortfall`) |
| `SPECULAR_SELF_STAKE_LOCKED` | `SelfStakeLocked` (`.agent_id/.outstanding_principal`) |
| `SPECULAR_UNSUPPORTED_ON_DEPLOYMENT` | `UnsupportedOnDeployment` |

`borrow()` and `withdraw()` run the same pre-checks in the same order, `credit_info()` returns the same enriched
fields on `CreditInfo` (new optional attributes, so existing constructor calls still work), `_code_has_selector`
gained a `which=` argument so the reputation manager is probed from its own bytecode, and ABI loading mirrors the
JS superset/union rules. The new types and errors are exported from `specular/__init__.py`.

---

## 4. Hosted server — `mcp-server/`

Built on top of the 2026-09-22 RPC-resilience round (multi-endpoint failover, health/backoff, circuit breaker,
JSON-RPC cache, coalescing, request deadlines). **Nothing in that layer was changed or bypassed**; every new read
goes through the same resilient provider, and the two new routes are `kind: 'read'` so they inherit the route-level
response cache as well.

### New tools / routes

| tool | route | notes |
|---|---|---|
| `required_self_stake` | `GET /v1/{network}/agents/{agentId}/required-self-stake?additionalAmount=` | requirement, current holding, exact shortfall, `creditMultiple`, and an actionable `note`. **V6.2 only.** |
| `get_self_stake` | `GET /v1/{network}/agents/{agentId}/self-stake` | amount, `locked`, outstanding principal, requirement, `withdrawableUsdc`, excess over requirement, claimable interest. **V6.2 only.** |

Both return a clean `400 UNSUPPORTED_ON_DEPLOYMENT` on V6/V6.1 — explicitly *"there is nothing to report — not
'zero required'"*, so an agent cannot read the refusal as "no stake needed".

### Changed tools

* **`prepare_request_loan`** — on V6.2 adds `requiredSelfStakeUsdc`, `currentSelfStakeUsdc`,
  `selfStakeShortfallUsdc` to `call.args`, extends `humanReadableSummary`, and emits an `INSUFFICIENT SELF-STAKE`
  warning naming the exact top-up. On V4 it also reads `isLockedOut` / `lockedUntil` and warns that a post-default
  lockout makes the request fail *"no matter how small the amount"*. Neither view is read at a 100 %-collateral
  tier (no unsecured exposure ⇒ no requirement ⇒ no RPC).
* **`prepare_withdraw_liquidity`** — on V6.2, when `from` is the pool creator, reports `selfStakeUsdc` /
  `selfStakeLocked` and warns. When locked it **suppresses the generic "only has X available" warning**, mirroring
  the contract's own ordering (the lock is checked before the liquidity require precisely so a fully-drawn pool
  does not mask the real reason). An unlocked creator is still told the position is first-loss capital.
* **`prepare_supply_liquidity`** — the pool creator supplying into its own pool is **exempt from
  `minSupplyAmount`** on V6.2, so the "below the minimum supply" warning no longer fires there; instead it says so
  and notes the position will be locked. Non-creators and V6.1 deployments are unchanged.
* **`check_credit_score`** — adds `credit.model` (tier index, tier limit, ladder limit, `maxRepaidPrincipal`,
  `MAX_TIER_LIMIT`, `lockedOut`, `lockedUntilIso`, plain-language `explanation`) on V4, and `selfStake` on V6.2.
  Both are `null` elsewhere.
* **`get_protocol_status`** — adds `capabilities` (the matrix above) and **`creditTiers`: the tier table read live
  from the contract**, plus `parameters.minSupplyAppliesToPoolCreator`.

### Revert translations

| revert | added / changed |
|---|---|
| `Insufficient self-stake` | **new** — explains the V7 rule and names `required_self_stake` → `prepare_supply_liquidity` → retry. |
| `Self-stake locked while borrowing` | **new** — explains the lock, the way out (repay), that ordinary lenders are not locked, and that `claim_interest` still works. |
| `Exceeds credit limit` | **changed** — now also points at `credit.model.lockedOut`, because on V7 the limit is exactly 0 during a lockout. |
| `Below minimum supply` | **changed** — mentions the V6.2 creator exemption. |

### Regenerated artefacts

`mcp-server/abi/` now carries five ABIs (added `AgentLiquidityMarketplaceV62.json`, `ReputationManagerV4.json`);
`mcp-server/openapi.json` is regenerated from the tool registry and contains the two new paths. `mcp.ts`'s
`INSTRUCTIONS` gained the generation matrix, the self-stake workflow, "never hardcode credit limits or tier
thresholds", and "reputation does NOT carry across a V7 redeploy".

---

## 5. Every hardcoded-tier site found and fixed

Found by grepping the repo for `25000 / 25,000 / 50000 / 50,000`, `score >= 800|600|500|400|200`, `tierFor`,
`creditLimit`, `PRIME|Excellent`, across `src/`, `python/`, `mcp-server/`, `frontend/`, `test/` and the docs.

| # | file:line (pre-change) | what it was | fix |
|---|---|---|---|
| 1 | `mcp-server/src/reads.ts:107-114` | `tierFor(score)` — a full hardcoded table (limits **25,000 / 50,000**, collateral %, APR) | replaced by `creditTierTable(cfg)`, which **reads `tierLimits` / `tierCollateralPct` / `tierInterestBps` / `tierMinScore` / `unsecuredTierExposure` / `MAX_TIER_LIMIT` from the contract** on V4, and returns the V3 constants explicitly labelled `source:'v3-constant'` otherwise. Only the tier **name** (`tierNameFor`) stays client-side — presentation, not protocol. Cached per network (`SPECULAR_TIER_TABLE_CACHE_MS`, 60 s) so the RPC budget is unaffected. |
| 2 | `mcp-server/src/validate.ts:53-54` | `MAX_LOAN_USDC = 50_000`, documented as *"highest credit limit any reputation tier grants (score 800+ ⇒ 50,000 USDC)"* | now `maxLoanUsdc()` — an **offline transport sanity bound** for the pure encoder, env-overridable via `SPECULAR_MAX_LOAN_USDC`, documented as explicitly *not* a credit limit. The authoritative limit is `calculateCreditLimit` (read in `prepareTx`) and `get_protocol_status.creditTiers`. The old constant is kept and deprecated for compatibility. |
| 3 | `mcp-server/README.md:181` | *"loans capped at 50,000"* in the env docs | rewritten; documents `SPECULAR_MAX_LOAN_USDC` and `SPECULAR_TIER_TABLE_CACHE_MS` and points at `creditTiers`. Network table updated (arc-staging = V6.2/V7, arc-mainnet = V6.1) and the two new routes listed. |
| 4 | `src/integrations/langchain/SpecularCreditTool.js:278-283` | `_getTier` returned labels with **collateral baked in** — `'Standard (25% collateral)'`, `'Basic (50% collateral)'` (the 50 % was never a real V3 tier, and none of it holds on V7) | label only (`Elite/Premium/Standard/Building/Basic/Starter`), with the band boundaries corrected to the real six tiers; collateral/limit/APR come from `calculateCollateralRequirement` / `calculateCreditLimit`, which `getCreditProfile` already reports. |
| 5 | `src/integrations/crewai/specular_credit_tool.py:355-365` | identical Python copy of #4 | identical fix. |
| 6 | `src/x402/CreditAssessmentServer.js:382` | `autoApproveEligible: score >= 100 && limit <= 50000` — a protocol tier ceiling smuggled into an underwriting rule | now `limit <= this.cfg.autoApproveMaxUsdc` (`CREDIT_AUTO_APPROVE_MAX_USDC`, default 50,000), documented as **this service's own appetite**, not the protocol's table; the figure is echoed in the response as `autoApproveMaxUsdc`. |
| 7 | `CLAUDE.md` — "Reputation & Loan Model" | one table presented as *the* tier table (25,000 / 50,000) | now states the table is on-chain and owner-settable, lists **V7 defaults and V3 defaults separately as orientation only**, names the read path in each client, and records that reputation does not migrate across a V7 deploy. |
| 8 | `src/test-suite/api-comprehensive-test.js:54-56` | `creditLimitUsdc >= 50000` as the "maximum credit limit" assertion | compares the two agents' limits instead, so it holds on whatever table the deployment runs. |
| 9 | `src/test-suite/risk-scenario-modeling.js:212` | `const primeLimit = 50000; // Credit limit at PRIME` | `SPECULAR_TOP_TIER_LIMIT_USDC` env override with the V3 default as a documented fallback. |

**Checked and deliberately left alone** (not tier assumptions): `frontend/dashboard.html:360-362` (mock demo data
for an unrelated multi-asset mock-up), `src/bots/LenderBot.js:17` (`totalCapital`, a bot's own budget),
`src/test-suite/network-effects-simulation.js` / `gas-analysis.js` (scenario inputs and gas figures),
`src/integrations/eliza`, `src/utils/formatting.js`, `src/integrations/natural-language` and
`src/x402/CreditAssessmentServer.js:363-367` (score-band *labels* with no limit or collateral attached),
`test/sdk-robustness/*` (`USDC(50_000)` mint amounts).

---

## 6. Tests

| suite | command | result |
|---|---|---|
| root hardhat (all of `test/`) | `npm test` | see §6.1 |
| SDK suites only | `npx hardhat test "test/sdk*/*.js"` | see §6.1 |
| hosted server | `cd mcp-server && npm test` | see §6.1 |
| Python client | `python -m unittest discover -s python/tests` and `-s test/sdk-robustness/python` | see §6.1 |

### New files

| file | tests | covers |
|---|---|---|
| `test/sdk-v7/helpers/v7stack.js` | — | deploys the FULL V7 stack locally (registry + `ReputationManagerV4` + `AgentLiquidityMarketplaceV62` + MockUSDC), wires `SpecularQuickstart` by hand and records every `approve` amount. `minSupplyAmount` is set to 50 USDC — above the self-stake a small loan needs — so M2's creator exemption is genuinely exercised. |
| `test/sdk-v7/01-capability-matrix.test.js` | 12 | `versionOrdinal`; V6 / V6.1 / V6.2 detection incl. the "claims V6.2 without the selector" case; `selfStake`/`requiredSelfStake` refusing on V6.1; `tierTable()` from chain, following an `setTierLimits` change, refusing to exceed `MAX_TIER_LIMIT`, and the honest V3 label; probe failures failing open; no self-stake read at 100 % collateral; no `MaxUint256`. |
| `test/sdk-v7/02-v7-integration.test.js` | 16 | the full lifecycle **onboard → self-stake → borrow → repay → withdraw** driven through the SDK, plus both new revert paths caught client-side *and* proven to revert on chain when bypassed; aggregate-exposure staking for a second loan; ordinary lenders unaffected by the lock; exact approvals across the whole run; `loanId` plumbed into V4's `openLoans`; the post-default lockout explained and the self-stake absorbing the loss first. |
| `mcp-server/test/unit.v62.test.mjs` | 39 | capability matrix, both new tools (and their `UnsupportedOnDeploymentError` on V6/V6.1), the three changed prepares, the four revert translations, the chain-read tier table (incl. an owner-changed limit), and the enriched `check_credit_score`. |
| `test/sdk-robustness/python/test_python_v7.py` | 29 | the JS suite's assertions, run against the Python client. |

### Changed files

`mcp-server/test/integration.http.test.mjs` — the live arc-staging assertions assumed a *populated* chain
(`totalPools > 0`, at least one pool, loan #1 exists). Arc staging was redeployed to the V7 stack on 2026-09-22, so
those rows legitimately no longer exist. The route contract (status codes, shapes, `400` on a bad id) is still
asserted unconditionally; the per-row assertions now run only when the chain holds a row, and the new
`capabilities` / `creditTiers` fields are asserted always. **This is an environmental fix, not a coverage cut** —
the failure predates this change set.

---

## 7. What an external integrator must change

1. **Detect the generation; do not configure it.** Call `sdk.capabilities()` / `client.capabilities()` /
   `get_protocol_status.capabilities`. Base and Arc mainnet are V6.1 today and V6.2 elsewhere; an integration that
   assumes either breaks on the other.
2. **Delete your tier table.** Any hardcoded 25,000 / 50,000 / "25 % collateral above 500" is wrong on V7 *and*
   can be changed by the owner at any time on a live V7 deployment. Read `tierTable()` / `tier_table()` /
   `get_protocol_status.creditTiers`, and read an agent's actual limit from `calculateCreditLimit`.
3. **Post a self-stake before borrowing on V6.2.** At any tier below 100 % collateral,
   `selfStake >= (outstandingPrincipal + amount) × (100 − collateral%) / 100 / creditMultiple`. Supply it into your
   **own** pool. Budget for it: it is real capital, locked, and lost first on a default. A second loan needs more.
4. **Expect the stake to be locked.** `withdrawLiquidity` from the pool creator reverts while any principal is
   outstanding. Plan liquidity around that; `claimInterest` is *not* blocked.
5. **The pool creator is exempt from `minSupplyAmount`** in its own pool on V6.2 — so a small honest stake
   (e.g. 6.25 USDC) is legal even under a 10 USDC minimum. Do not pre-reject it client-side.
6. **A credit limit of 0 may mean a lockout, not a mistake.** After a default the limit is exactly 0 for
   `defaultLockout` (180 days shipped) and `maxRepaidPrincipal` resets to 0. Check `lockedOut` / `lockedUntil`
   before reporting a bug.
7. **Do not assume a prior score exists.** `ReputationManagerV4` starts empty by design — no migration helper.
   Agent NFTs and `agentId`s survive (the registry is not redeployed), but every agent must call
   `initializeReputation()` again and re-climb the ladder.
8. **Operator tooling that writes reputation must be updated.** `recordBorrow(borrower, loanId, amount)`,
   `recordLoanCompletion(borrower, loanId, amount, onTime, lateSeconds)`, `recordDefault(borrower, loanId, amount)`
   — the `loanId` is required, not optional, and `LoanRecorded` / `LoanCompleted` / `DefaultRecorded` gained an
   indexed `loanId`.
9. **Approvals stay exact.** Nothing here relaxes the 2026-07 rule: approve exactly what the next call pulls, never
   `MaxUint256`, and revoke leftovers.

---

## 8. Not done / follow-ups

* `forensics/monitor/v6-invariants.js` was **not** extended with the V7 invariants §8.5 of the design doc proposes
  (`selfStake >= requiredSelfStake` for every borrowing agent below 100 % collateral, `creditLimitOf <=
  MAX_TIER_LIMIT`, an alert on `TierLimitsUpdated`). That is monitoring, not a client interface, and was out of
  scope for this round.
* The V7 events (`SelfStakeAbsorbedLoss`, `CreditCapacityUpdated`, `AgentLockedOut`, `LateRepaymentRecorded`,
  `LadderParametersUpdated`, `TierLimitsUpdated`, …) decode correctly through the superset ABIs — the MCP
  `get_transaction` route will render them — but no dedicated event-subscription surface was added to
  `src/EventListener.js`.
* The `frontend/` pages were not rebuilt against the on-chain tier table; they render mock data today and carry no
  live tier assumptions (§5), so nothing there is *wrong*, but a real dashboard should read `creditTiers`.
* No contract change, no deployment, no broadcast.
