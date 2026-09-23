# Cross-generation client regression round — 2026-09-23

**Scope.** Every read path of all three client stacks — JS SDK (`src/sdk/SpecularQuickstart.js`),
Python client (`python/specular/client.py`) and the hosted server (`mcp-server/`, booted locally)
— exercised against **all three deployed contract generations**, plus capability-detection
adversity testing and a live standing-allowance audit.

**Rules honoured.** No transaction was broadcast to Base mainnet or Arc mainnet. Every write-side
assertion ran on a local chain. `contracts/` was not modified.

| Network | chainId | Marketplace | Reputation | Generation |
|---|---|---|---|---|
| `base` | 8453 | `0x0a4e3C745aB95aceb45B05C28D89fe4Db8815F9a` | V3 `0xf19b1780…` | **V6 (2026-05 build)** — oldest, REAL USDC |
| `arc-mainnet` | 5042 | `0xCb23f2fb03Bfd4775Cc0e76E28f64c1e545071be` | V4 `0x12953e73…` | V6.2 / V7 — newest, REAL USDC |
| `arc-staging` | 5042002 | `0x7E4D144AbEB3C695Ec2DdF00Fc710aABC04bDd18` | V4 `0xD7906fDF…` | V6.2 / V7 — test USDC |

---

## 0. Headline

> **Base mainnet was broken through the hosted server and nobody had noticed.**
> Five of its thirteen read routes — `get_protocol_status`, `check_credit_score`,
> `get_available_liquidity`, `get_pool_details`, `get_lending_positions` — returned a raw
> `502 {"error":"missing revert data"}`. The two SDKs were fine on Base throughout.
>
> Separately, **one transient RPC failure permanently poisoned capability detection in the
> hosted server**, making it publish the V3 constant tier table (25,000 / 50,000 USDC) for a
> V7 deployment whose real on-chain limits are 2,500 / 5,000 — a 10× wrong credit limit, with
> no error and no recovery short of a process restart. This is SDK finding F-R1, fixed in both
> SDKs in the 2026-09 round and never carried across to the server.
>
> The write side was worse still: `prepare_supply_liquidity` and `prepare_request_loan` both
> returned a raw 502 on Base, so **no agent could lend or borrow through the hosted server on
> Base at all** — same root cause, in the transaction builders.
>
> And on Base, three wallets still carry an effectively **unlimited (MaxUint256) USDC allowance**
> to the canonical marketplace — the residue of the pre-exact-approval era. One of them holds
> 181.45 real USDC.

All of the above are fixed in this worktree, each with a failing test written first.
Patch: `cross-generation-fixes.patch` (in this directory, `git apply`-able from the repo root).

---

## 1. Generation × client × capability matrix

`OK` = answered, and every client that answered agreed on the value.
`n/a` = that client has no API for the question (not a defect; recorded so the gap is visible).
Values were compared after normalisation (`"1000"`, `"1000.0"` and `1000` compare equal).

### Reads — after the fixes in this round

| Question | base (V6 / V3) | arc-mainnet (V6.2 / V4) | arc-staging (V6.2 / V4) | js | py | mcp |
|---|---|---|---|---|---|---|
| capability detection | V6 / V3 | V6.2 / V4 | V6.2 / V4 | OK | OK | OK¹ |
| tier table + `source` | `v3-constant` | `chain` | `chain` | OK | OK | OK |
| credit info (score/limit/collateral/APR) | OK | OK | OK | OK | OK | OK |
| loan list for an address | OK (11 loans) | OK (1 loan) | OK | OK | OK | OK |
| repayment preview | OK | OK² | OK² | OK | OK | OK³ |
| active loan ids | OK | OK | OK | OK | OK | **fixed** |
| can-top-up | OK | OK | OK | OK | OK | **fixed** |
| required self-stake (V6.2 only) | clean refusal | OK | OK | OK | OK | OK |
| self-stake view (V6.2 only) | clean refusal | OK | OK | OK | OK | OK |
| protocol status / TVL | **fixed** | OK | OK | n/a | n/a | OK |
| pool list | **fixed** | OK | OK | n/a | n/a | OK |
| pool details | **fixed** | OK | OK | n/a | n/a | OK |
| lender positions | **fixed** | OK | OK | n/a | n/a | OK |

¹ values identical; key names differ (`version` vs `marketplaceVersion`, no `ordinal`) — see L-2.
² all three agree: loan 1 is `REPAID`, so there is nothing to preview.
³ the server additionally refuses to quote a **non-ACTIVE** loan where the SDKs quote one — see L-1.

Neither SDK exposes pool-list, pool-details or lender-position APIs at all; those questions can
only be asked of the hosted server, so for them "parity" was measured against direct `ethers`
reads (§4).

### Tier-table source and values, verified

| Deployment | reported `source` | tier 4 limit | tier 5 limit | verdict |
|---|---|---|---|---|
| Base V3 | `v3-constant` | 25,000 | 50,000 | correct, and **matches `ReputationManagerV3.sol`** |
| Arc mainnet V4 | `chain` | 2,500 | 5,000 | correct, read live |
| Arc staging V4 | `chain` | 2,500 | 5,000 | correct, read live |

**The v3 fallback table is NOT stale.** Checked line by line against
`contracts/core/ReputationManagerV3.sol` §311–357, in all three clients — JS
`SpecularQuickstart.tierTable()`, Python `SpecularClient.tier_table()`, server
`reads.ts:V3_TIERS` — and all three carry the identical, correct set:

| tier | minScore | limit | collateral % | rate bps | contract |
|---|---|---|---|---|---|
| 0 | 0 | 1,000 | 100 | 1500 | `else baseLimit = 1000 * 1e6` / `return 100` / `return 1500` |
| 1 | 200 | 5,000 | 100 | 1500 | `score >= 200 → 5000` |
| 2 | 400 | 10,000 | 100 | 1000 | `score >= 400 → 10000` / `return 1000` |
| 3 | 500 | 10,000 | 25 | 1000 | `score >= 500 → return 25` |
| 4 | 600 | 25,000 | 0 | 700 | `score >= 600 → 25000` / `return 0` / `return 700` |
| 5 | 800 | 50,000 | 0 | 500 | `score >= 800 → 50000` / `return 500` |

One caveat worth recording, not a defect: `calculateCreditLimit` on V3 adds
`validationCreditBonus` when a `ValidationRegistry` is configured, so an agent's actual limit can
exceed its tier limit. All three clients already say the actual limit is
`calculateCreditLimit(address)`.

---

## 2. Findings

Severity: **HIGH** = wrong number or dead route on a real-money deployment; **MEDIUM** = wrong
number or dead route under a reachable condition; **LOW** = cosmetic or bounded.

### H-1 · HIGH · Hosted server: five read routes dead on Base mainnet

`GET /v1/base/status`, `/v1/base/agents/{addr}/credit`, `/v1/base/pools`,
`/v1/base/pools/{id}` and `/v1/base/agents/{addr}/positions` all returned
`502 {"error":"missing revert data"}` (and, for two of them,
`502 {"error":"execution reverted: \"Use front-end to query specific agents\""}`).

**Cause.** Base's canonical marketplace was deployed 2026-05-17 and predates both the 2026-08
launch levers and the §S5 O(1) counters. Verified directly against the deployed bytecode
(`eth_call` at block ~51,674,000 via `https://base-rpc.publicnode.com`):

| selector | Base V6 | Arc V6.2 |
|---|---|---|
| `minSupplyAmount()` | **absent** | present |
| `bindBorrowToPoolCreator()` | **absent** | present |
| `minHoldForReputationReward()` | **absent** | present |
| `activeLoanCount(uint256)` | **absent** | present |
| `outstandingPrincipal(uint256)` | **absent** | present |
| `getActiveAgents()` | present but **reverts** `"Use front-end to query specific agents"` | works |

Those calls sat unguarded inside `Promise.all`, so one missing selector failed the whole route.
Note the committed `AgentLiquidityMarketplaceV6.sol` **does** implement all of them — the source
in the repo is newer than Base's deployed bytecode, which is exactly why this was never caught by
a test against a locally-deployed "V6".

It is a pre-existing defect, not a regression from the recent rework: `git log -S` puts all of
these call sites in `29db5a0`, the commit that introduced the hosted server. Base is also not in
the live deployment's `SPECULAR_ENABLED_NETWORKS` today — but it is in `ALL_NETWORKS`, so any
deployment that does not set that variable serves it.

**Minimal reproduction (pre-fix):**
```bash
cd mcp-server && PORT=3411 HOST=127.0.0.1 node dist/http.js &
curl -s http://127.0.0.1:3411/v1/base/status
# {"error":"missing revert data"}
curl -s http://127.0.0.1:3411/v1/base/pools
# {"error":"execution reverted: \"Use front-end to query specific agents\""}
```

**Fix** (`mcp-server/src/reads.ts`). An `optionalView()` helper reports a view the deployment does
not implement as `null` — and rethrows anything transient, so `null` never means "the RPC failed".
`activeAgentIds()` falls back to a bounded registry scan (agentIds `1..totalAgents`, capped at
`MAX_LIST`, honestly flagged when truncated) when `getActiveAgents()` does not answer, and only
reports an explained empty list when even that is impossible. An empty list would have read as
"this protocol has no pools and you hold no positions" — a wrong answer about money.

**Verified after the fix, against live Base:** all 13 routes return 200 or a clean 400, and
`/v1/base/pools` returns the four real pools with TVL 1.5 USDC, matching direct `ethers` reads
exactly (§4).

Tests: `mcp-server/test/unit.crossgen.test.mjs` X-2 (5 cases).

---

### H-2 · HIGH · Hosted server: one transient RPC failure permanently poisons capability detection

`chain.ts` used `try { await c.marketplace.VERSION() } catch { version = 'V6' }` and cached the
result for the life of the process. ethers v6 collapses a JSON-RPC `-32005 rate limit exceeded`
**and** an HTTP 500 into the same `CALL_EXCEPTION: missing revert data` it produces for a selector
the contract does not implement — so the two are indistinguishable at that layer.

This is SDK finding **F-R1**, fixed in both SDKs in the 2026-09 round and never carried over.

**Live reproduction** — a fault-injecting RPC proxy in front of the real `arc-staging` endpoint,
returning HTTP 500 to the first `VERSION()` probe and nothing else:

```
[during fault]
  capabilities: {"marketplaceVersion":"V6","reputationVersion":"V3","v61":false,"v62":false,"reputationV4":false}
  tierSource: v3-constant | tier4: 25000.0 | tier5: 50000.0
  minSupplyAppliesToPoolCreator: True
[after the fault is cleared — same process]
  capabilities: {"marketplaceVersion":"V6","reputationVersion":"V3",...}      <-- still wrong
  tierSource: v3-constant | tier4: 25000.0 | tier5: 50000.0                   <-- still wrong
  /v1/arc-staging/agents/52/self-stake -> 400 "reports version V6"            <-- still refused
[control, no fault]
  capabilities: {"marketplaceVersion":"V6.2","reputationVersion":"V4","v61":true,"v62":true,"reputationV4":true}
  tierSource: chain | tier4: 2500.0 | tier5: 5000.0
```

**Blast radius on a real-money network.** A single RPC blip at the wrong moment makes the hosted
API, until someone restarts it:
* publish credit limits **10× too high** (25,000 / 50,000 instead of 2,500 / 5,000), flagged
  `source: "v3-constant"` — which is a *claim about the deployment*, not a caveat;
* report `minSupplyAppliesToPoolCreator: true` when V6.2 exempts the creator;
* refuse `required_self_stake` and `get_self_stake` outright, so an agent cannot see the
  first-loss capital it must post before `requestLoan` reverts "Insufficient self-stake";
* fall back to V6 repayment maths on a V6.1+ chain — the original F-R1 money bug.

A genuine empty return (`result: "0x"` — a real missing selector) is answered `V6/V3`, correctly.
The server could not tell that apart from a 500.

**Fix** (`mcp-server/src/chain.ts`). `isTransientRpcFailure()` classifies on the underlying
JSON-RPC error code, which ethers preserves on `info.error.code`. Measured on the live Arc
endpoints on 2026-09-23:

| condition | JSON-RPC response | what it means |
|---|---|---|
| missing selector / array out of bounds | `{"code":3,"message":"execution reverted"}` | definite answer |
| rate limit | `{"code":-32005,"message":"rate limit exceeded"}` | no answer given |

A transient failure now raises `CapabilityUnknownError` (503) and is **never cached**; a definite
one resolves the generation as before. Same treatment for the reputation `VERSION()` probe and the
`requiredSelfStake` confirmation.

Tests: `unit.crossgen.test.mjs` X-1 (3 cases, including the control that a genuinely absent
`VERSION()` still resolves to V6/V3).

---

### H-3 · HIGH · All three clients: a transient RPC error was read as "end of the loan array"

Every client discovers a wallet's loans by walking `agentLoans(addr, i)` until the call reverts,
and every one of them wrote that walk as `catch { break }`. Since a rate limit and an
out-of-bounds read are the same error object (H-2), **one rate-limited `eth_call` silently
truncated the loan list** — very often to empty.

Reproduced live and unprompted: the JS SDK returned `loans() == []` for
`0x800e305A…` on `arc-mainnet` while the Python client returned the one real loan, purely because
`tierTable()` had just fired 31 `eth_call`s and tripped the endpoint's rate limiter. The captured
payload was `{'code': -32005, 'message': 'rate limit exceeded'}`, surfaced by ethers as
`CALL_EXCEPTION: missing revert data`.

Affected, in all three clients:

| call site | wrong answer it produced |
|---|---|
| JS `loans()` / Py `loans()` / server `readAgentLoans` | a short or empty loan list — reads as "no outstanding debt" |
| JS `_loanCount()` | an under-count; this is `countBefore` for `_reconcileNewLoan()`, so after an inconclusive borrow the reconciler **adopts an OLD loan id as the new loan** |
| JS `activeLoanIds()` / Py `active_loan_ids()` (V6 path) | active loans silently dropped |
| JS `canTopUp()` / Py `can_top_up()` | returned the **permissive** `true` on any failure, so `supplyLiquidity` proceeds and forfeits in-flight interest |

**Minimal reproduction** — `test/sdk/quickstart-loan-enumeration.test.js`, which fails on the
pre-fix code with:
```
loans() returned [{"id":7,...}] instead of throwing     (the wallet has 3 loans)
_loanCount() returned 1 instead of throwing             (the wallet has 3 loans)
activeLoanIds() returned [7,8] instead of throwing      (the wallet has 3 loans)
canTopUp() answered true instead of throwing
```

**Fix.** `_loanIdAt()` (JS) / `_loan_id_at()` (Python) / the walk in `readAgentLoans` end the walk
**only** on a definite revert and raise `SPECULAR_LOAN_ENUMERATION_FAILED` /
`LoanEnumerationFailed` / a 503 otherwise. `canTopUp` keeps its permissive answer only when the
selector is genuinely absent. Controls assert that a genuine end-of-array still terminates the walk.

Tests: `test/sdk/quickstart-loan-enumeration.test.js` (6), `python/tests/test_loan_enumeration.py`
(10), `unit.crossgen.test.mjs` X-4.

---

### M-1 · MEDIUM · Hosted server: three read tools refused questions the SDKs answer correctly

On Base, the same logical question returned two different answers:

| question | JS SDK | Python | hosted server (pre-fix) |
|---|---|---|---|
| repayment preview for loan 1 | `0.100287` (`source: calculateInterest`) | `0.100287` | `400 preview_repayment is not supported on this deployment` |
| active loan ids for agent 1 | `[]` | `[]` | `400 get_active_loan_ids is not supported` |
| can-top-up pool 1 | `true` | `true` | `400 can_top_up is not supported` |

All three are answerable on V6 and the SDKs answer them correctly: V6 charges the nominal
fixed-term interest, V6 has no pending-tranche accounting so a top-up is never refused, and the
active set is the `agentLoans[]` walk. The server's own `repaymentQuote()` already implemented the
V6 branch (`source: 'calculateInterest'`) — `requireV61` upstream made it **dead code**, while the
neighbouring `get_loan_status.repayment` route reached it happily. The server was the odd one out.

**Fix.** All three answer on every generation and report which path produced the answer
(`source: 'getActiveLoanIds' | 'agentLoans-walk'`, `source: 'previewRepayment' |
'calculateInterest'`). Tool descriptions and `openapi.json` updated; three existing tests that
asserted the refusal were rewritten to assert the cross-generation answer, and the change is
called out in their comments.

---

### M-2 · MEDIUM · Hosted server: one transient failure permanently disables the paginated pool probe

`activeAgentIds()` probes for `getActiveAgents(uint256,uint256)` and remembers the answer. The
comment above it is right — *"probe for the METHOD, not for a version flag"* — because the
pagination arrived in a **later V6.2 revision** than the one first deployed. Confirmed live:

| deployment | `VERSION()` | `getActiveAgents(uint256,uint256)` | `getActiveAgents()` |
|---|---|---|---|
| arc-staging current `0x7E4D144A…` | V6.2 | works (5 of 5) | works (14) |
| arc-staging superseded `0xa736EE7B…` | **V6.2** | **missing revert data** | works (5) |

But the probe was `catch { set(false) }`, so any error pinned `false` forever. Demonstrated by
injecting a single `-32603` at the probe: the paginated call is never retried and every later
request uses the unbounded call — which the scale round measured as uncallable past ~5,472 pools,
i.e. exactly the failure the pagination exists to prevent. It also silently drops the honest
`truncated` reporting.

```
[call 1, one -32603 armed]  paginated probes: 1   legacy getActiveAgents(): 1
[call 2, no faults]         paginated probes: 1   legacy getActiveAgents(): 1   <-- never retried
[control, no fault at all]  paginated probes: 1   legacy getActiveAgents(): 0
```

**Fix.** Only a definite "no such method" is remembered; a transient failure propagates.
Test: `unit.crossgen.test.mjs` X-3 (plus the control that a genuinely absent overload is
remembered after one probe).

---

### M-3 · MEDIUM · Live: unlimited USDC allowances still standing on Base

The exact-approval model's resting state is zero. On Base it is not:

| wallet | USDC balance | allowance to V6 `0x0a4e3C74…` |
|---|---|---|
| `0x800e305A0caDdE6289dFDFEDF38218f45C06F72C` (deployer/owner) | **181.450557** | **115792089237316195423570985008687907853269984665640564039457584007913126.938218** |
| `0xF2A861b2501c9313c24124bF690548942960CBaf` | 2.000000 | same magnitude |
| `0x88B7Db655B09547BD84C4e58B421A9457CD43889` | 0.000000 | same magnitude |
| `0x8e2cDF7884494D665Fd511d680a1A3Ad45E45756` | 0.000000 | 0.0 ✔ |

These are `MaxUint256` approvals granted before the exact-approval change, drawn down by Circle
USDC's decrementing `transferFrom`. **Arc mainnet is clean — 0.0 against all three marketplaces
(canonical, superseded V6.1, retired V6.0)** — consistent with the current SDK.

Given this marketplace's §B1/§S1 history, a standing unbounded approval over a wallet holding 181
real USDC is worth clearing. Remediation is one transaction per wallet:
`await new SpecularQuickstart(wallet, 'base').revokeApproval()`, or `approve(marketplace, 0)`.
**Not executed** — no transaction was broadcast to mainnet in this round.

Note `_approveExact` (F-R15) already tightens a larger pre-existing allowance down to what the
current operation needs, so the next SDK-driven op from those wallets would clear it — but nothing
has run.

---

### M-4 · MEDIUM · `_codeHasSelector` is blind to ~1 function in 256

Capability detection probes the deployed bytecode with a substring scan for the 4-byte selector.
solc emits the dispatcher constant with the minimum number of PUSH bytes, so a selector whose
first byte is `0x00` appears as a `PUSH3` of its low three bytes (`PUSH4 0x004d9045` ==
`PUSH3 0x4d9045` numerically) and the four bytes never occur contiguously.

**Live proof** — Arc mainnet V6.2 `0xCb23f2fb03Bfd4775Cc0e76E28f64c1e545071be`:
```
minHoldForReputationReward()   selector 0x004d9045
  bytes "004d9045" present in deployed code : false
  eth_call                                  : 0x…015180  (= 86400)
```
It is the **only** one of that contract's 69 ABI functions affected today, and none of the
selectors the clients actually probe (`VERSION`, `requiredSelfStake`, `previewRepayment`) begin
with `0x00` — so this has not bitten yet. It is a latent false-negative in the mechanism the whole
capability story rests on: a client would declare a deployed function missing and silently fall back.

**Fix.** `_codeContainsSelector` also looks for the leading-zero-stripped form, in both SDKs.
Tests assert both the PUSH3 case and that a genuinely absent selector is still absent.

---

### L-1 · LOW · SDKs quote a repayment for a loan that owes nothing

`previewRepayment(loanId)` in both SDKs returns a figure for a `REPAID` loan (Base loan 1:
`total 0.100287`); the server correctly answers `Loan 1 is REPAID, not ACTIVE; nothing to repay`.
Bounded — `repay()` would revert "Loan not active" and `_withApprovalCleanup` revokes the
approval — but it is a number presented for a settled debt. Left as-is: changing it would break
callers that preview historical loans. Decide which semantic is canonical.

### L-2 · LOW · `capabilities` shape differs between clients

Same values everywhere; the SDKs use `version` and expose `ordinal`, the server uses
`marketplaceVersion` and omits `ordinal`. Cosmetic, but it is why a naive cross-client diff flags
every network.

### L-3 · LOW · A no-contract address produces misleading server diagnostics

Pointed at an address with no code, the SDKs say exactly that
(`no contract code at marketplace 0x… (wrong address, wrong network, or an RPC serving an empty
view)`). The server returns `{"error":"could not decode result data"}` and — worse — its
self-stake route reports that the deployment *"reports version V6"*, a fabricated capability
answer for an address with no code at all. (Separately: a non-checksummed address in a config
file makes the server exit at boot with `bad address checksum`, which is correct but worth knowing.)

### L-4 · LOW · The Python client has no retry helper

JS has `_retryTransient` (3 attempts, surfaces real reverts immediately); Python has no equivalent,
so under sustained rate limiting its reads fail where JS recovers. Both **surface** rather than
cache a wrong answer, which is the property that matters, so this is a robustness gap and not a
correctness one.

---

## 3. Capability detection under adversity

A fault-injecting JSON-RPC proxy sat in front of the real `arc-staging` endpoints, able to return
`-32005 rate limit exceeded`, `-32603 internal error`, HTTP 500, or an empty `0x` result for
chosen selectors. Each server case ran in a **fresh process**, because capabilities are cached per
process.

| # | scenario | JS SDK | Python | hosted server |
|---|---|---|---|---|
| 1 | `-32005` during `VERSION()` | raises `CALL_EXCEPTION`, **not cached**; correct on retry | raises `Web3RPCError`, **not cached**; correct on retry | **poisoned permanently** → fixed |
| 2 | HTTP 500 during the probe | clean `SPECULAR_VERSION_UNKNOWN`, recovers | clean `RuntimeError`, recovers | **reported V6/V3 + v3-constant table, no error** → fixed |
| 3 | genuine empty `0x` (real missing selector) | V6/V3 ✔ | V6/V3 ✔ | V6/V3 ✔ |
| 4 | address with **no contract code** | explicit "no contract code at …" ✔ | explicit "no contract code at …" ✔ | `could not decode result data`, and claims "reports version V6" (L-3) |
| 5 | superseded V6.0 `0xDbDf60AE…` | V6, `v3-constant`, clean refusal of V6.2 views ✔ | ✔ | ✔ |
| 6 | superseded V6.1 `0xB2d88bbF…` | V6.1, `v3-constant`, clean refusal ✔ | ✔ | ✔ |
| 7 | superseded V6.2 `0xa736EE7B…` (pre scale-fix) | V6.2, `chain`, self-stake works ✔ | ✔ | ✔ |
| 8 | **V6.2 predating a later-added method** (`getActiveAgents(uint256,uint256)`) | n/a | n/a | probes the METHOD ✔, but cached a transient failure as "absent" → fixed (M-2) |

The key result: **neither SDK can be made to cache a wrong capability answer from a transient
failure**, on any of the four fault shapes. The F-R1 fix holds. The hosted server was the only
place it was still reachable, and case 2 is the cleanest demonstration — a single HTTP 500 and the
API publishes 10×-wrong credit limits with no error at all.

Server-side addresses were swapped without touching `src/config/` by pointing
`SPECULAR_REPO_ROOT` at a scratch tree holding edited copies of the config files.

---

## 4. Base mainnet — verified on-chain state

Read directly with `ethers` at block **51,674,862** (`https://base-rpc.publicnode.com`) and
cross-checked against all three clients. Every figure agrees.

| | value |
|---|---|
| marketplace (canonical V6) | `0x0a4e3C745aB95aceb45B05C28D89fe4Db8815F9a` |
| `paused` | **false** |
| `owner` | `0x800e305A0caDdE6289dFDFEDF38218f45C06F72C` (secure wallet) ✔ |
| `totalPools` / active | 4 / 4 |
| `nextLoanId` | 15 → **14 loans, all `REPAID`** (0 ACTIVE, 0 DEFAULTED) |
| `totalAgents` (registry) | 7 |
| TVL (`Σ totalLiquidity`) | **1.500000 USDC** |
| available (`Σ availableLiquidity`) | 1.505977 USDC |
| loaned out | **0.000000 USDC** |
| marketplace USDC balance | 1.506031 USDC |
| `platformFeeRate` | 100 bps |
| `MAX_ACTIVE_LOANS_PER_AGENT` | 10 |
| levers (`minSupplyAmount`, `bindBorrowToPoolCreator`, `minHoldForReputationReward`) | **not present in this build** |

Pools:

| agentId | agent | totalLiquidity | availableLiquidity | totalLoaned | totalEarned |
|---|---|---|---|---|---|
| 1 | `0x800e305A…F72C` | 1.500000 | 1.501705 | 0 | 0.001705 |
| 5 | `0xF2A861b2…CBaf` | 0 | 0.001424 | 0 | 0.001424 |
| 6 | `0x88B7Db65…3889` | 0 | 0.001424 | 0 | 0.001424 |
| 7 | `0x8e2cDF78…5756` | 0 | 0.001424 | 0 | 0.001424 |

Loans: 11 for agent 1 (0.1 + 10 × 0.05 USDC), 1 each for agents 5, 6, 7 (0.5 USDC) — **all
REPAID**, all at 1500 bps, all 7-day terms, every one fully collateralised (collateral ==
principal, consistent with score 110 → the 100 %-collateral tier).

**§S1 invariant holds.** `Σ availableLiquidity` (1.505977) ≤ marketplace USDC balance (1.506031);
the 0.000054 difference is real USDC in excess of the accounting, not phantom liquidity.
Pools 5/6/7 showing `totalLiquidity 0` with `availableLiquidity 0.001424` is correct accounting,
not a leak: the lender withdrew principal and the figure is unclaimed interest.

Cross-client agreement on Base, post-fix — every one of these came back identical from direct
`ethers`, the JS SDK, the Python client and the hosted server:

```
capabilities         V6 / V3,  v61=false, v62=false, reputationV4=false
tier table           source=v3-constant, 1000/5000/10000/10000/25000/50000
credit (agent 1)     score 110, limit 1000.0 USDC, collateral 100%, rate 1500 bps
loans (agent 1)      11, all REPAID
pools                4 active, TVL 1.5, available 1.505977, loaned 0.0
positions (0x800e…)  supplied 1.5, claimable 0.001705, 1 position
```

**Nothing about the client rework misreports Base's numbers.** The rework's damage on Base was
availability (H-1) and the two silent-truncation classes (H-3, M-1), never a wrong figure.

---

## 5. Exact-approval audit

### Static audit of every USDC-pulling path

| path | approval source | exact? |
|---|---|---|
| `onboard()` | none — the blanket up-front approval was removed; `approveTx` is always `null` | ✔ |
| `borrow()` collateral | `amt * calculateCollateralRequirement(agent) / 100`, matching the contract | ✔ |
| `borrow()` shortfall fallback | bounded buffer `collateral + principal`, revoked after the tx | ✔ bounded |
| `repay()` | `previewRepayment(loanId).total` (V6.1+) or `amount + calculateInterest(...)` (V6), plus late headroom clamped at `duration + LATE_INTEREST_CAP` | ✔ bounded |
| `repay()` bump path | re-priced from chain, still clamped; revoked after | ✔ bounded |
| `supply()` | exactly `amt` | ✔ |
| `withdraw()` / `claim()` | no USDC pull, no approval | ✔ |
| failure paths | `_withApprovalCleanup` revokes whenever an approve was sent and the op then threw | ✔ |

`_approveExact` is exact in **both** directions (F-R15): a *larger* pre-existing allowance is
tightened down rather than accepted as "already covered". No `MaxUint256` appears anywhere in the
current SDK, Python client or the server's `prepare_*` builders.

### Live allowances

See **M-3**: Arc mainnet clean (0.0 everywhere); Base carries three legacy `MaxUint256` approvals,
one over a wallet holding 181.45 real USDC.

### Local write-parity

Both generations were driven through the **real deployed bytecode** on local
**mainnet-fork** chains — Base fork pinned at block 51,673,882 reporting `chainId 8453`, Arc
staging fork pinned at 63,533,731 reporting `chainId 5042002` — so the clients resolved their
normal addresses from `src/config/*.json` and only the RPC URLs were redirected. Nothing was
broadcast to a real network. Each client used its own wallet.

| step | base/JS | base/Py | base/MCP | arc/JS | arc/Py | arc/MCP |
|---|---|---|---|---|---|---|
| onboard (register + createAgentPool) | PASS | PASS | PASS | PASS | PASS | PASS |
| supply liquidity | PASS | PASS | **FAIL → fixed (X-8)** | PASS | PASS | PASS |
| borrow | PASS | PASS | **FAIL → fixed (X-8)** | PASS | PASS | PASS |
| repay | PASS | PASS | PASS | PASS | PASS | PASS |
| claim interest | PASS | PASS | PASS | PASS | PASS | PASS |
| withdraw | PASS | PASS | PASS | PASS | PASS | PASS |
| FAIL-path: borrow over the credit limit | clean, allowance → 0 | clean, allowance → 0 | (blocked upstream) | clean, allowance → 0 | clean, allowance → 0 | **allowance left at 200 USDC** |
| FAIL-path: repay someone else's loan | `Not the borrower`, allowance → 0 | same | reason lost; allowance left at 50.616438 | same | same | same |
| FAIL-path: supply below `minSupplyAmount` (3rd party) | n/a (no minimum on V6) | n/a | n/a | `Below minimum supply`, allowance → 0 | same | reason lost; allowance left at 1 USDC |
| V6.2 creator exempt from `minSupplyAmount` | n/a (plain V6, succeeds) | n/a | n/a | PASS (1 USDC < 10) | PASS | PASS |
| V6.2 maintained minimum on withdraw | n/a (partial withdraw succeeds — plain V6, no crash) | n/a | n/a | `Remaining below minimum supply` | same | reason surfaced, guidance **wrong → fixed (X-10)** |
| V6.2 self-stake withdraw lock | n/a (withdraw succeeds — plain V6, no crash) | n/a | n/a | **pre-empted, 0 tx**, `SPECULAR_SELF_STAKE_LOCKED` | **pre-empted**, `SelfStakeLocked` | **pre-empted by warning**, correct plain language |
| reserved last lender slot | `Pool lender capacity reached` at the 51st (V6: all 50 open — correct) | same | same | `Last slot reserved for agent self-stake` at the 50th third party | same | reason surfaced, no explanation **→ fixed (X-10)** |
| V6.2-only reads on the OLD generation | clean `SPECULAR_UNSUPPORTED_ON_DEPLOYMENT` | clean `UnsupportedOnDeployment` | clean HTTP 400 | n/a | n/a | n/a |

**Collateral — PASS everywhere.** Decoded from the USDC `Transfer` logs of each `requestLoan`
receipt: pulled `50000000`, expected `amount × calculateCollateralRequirement / 100`
= `50000000 × 100 / 100`, and `loans(id).collateralAmount == 50000000`. Identical on both
generations and all three clients.

**Cross-client parity — no divergence.** For identical inputs the resulting on-chain state is
byte-identical across clients within each generation: loan `{50000000 principal, 50000000
collateral, 1500 bps, 30 d, REPAID}`, pool `totalEarned 610274`, position `0/0`, wallet USDC net
`-6164` (the 1 % platform fee on 0.616438 interest), allowance `0`.
The one cross-*generation* difference is by design, not a client bug: one on-time repayment scores
**+10 on Base/RMv3** and **0 on Arc/RMv4**, because RMv4 §M1-1 scales the bonus by hold time and an
immediate repay has `effHeld ≈ 0`.

**Every approve transaction observed** (decoded from the calldata of each tx the wallet sent, via a
block-range scan):

* **`MaxUint256`: never.** Not one approve in any of the six runs was `MaxUint256` or any absurd
  value, and every spender was the marketplace. The MCP broadcast relay additionally *refuses* one:
  a signed `approve(marketplace, MaxUint256)` is rejected with
  `USDC approve of unlimited exceeds the exact-approval cap (100000 USDC)`; `1e12 USDC` likewise;
  `10 USDC` accepted.
* **Resting allowance after every completed path: 0**, for both the agent wallet and the
  third-party lender wallet, on both generations, in all three clients.
* **Failure paths:** JS and Python leave **0** every time (`_withApprovalCleanup`). The MCP
  surface left **5 dangling allowances** (1, 10, 200 and 50.616438 USDC) — see X-12.
* Largest transient approval: **2400 USDC** on base/JS and base/Py — the X-9 over-approval below.
  It was revoked to 0 within the same operation.

---

### Additional findings from the write track

#### H-4 · CRITICAL · `prepare_supply_liquidity` and `prepare_request_loan` were dead on Base

The same unguarded-`Promise.all` pattern as H-1, in the **write** builders
(`mcp-server/src/prepare.ts`): `minSupplyAmount()` in `supply_liquidity`, and
`bindBorrowToPoolCreator()` / `activeLoanCount()` / `outstandingPrincipal()` in `request_loan`.
All four are absent from Base's V6 bytecode, so both returned `502 {"error":"execution reverted"}`.

**No agent could lend or borrow through the hosted server on Base at all.**

```
curl -sXPOST -d '{"from":"0x…","agentId":12,"amount":"100"}' .../v1/base/tx/prepare/supply_liquidity
# 502 ; server log names the failing call data:"0x048398c5"  (minSupplyAmount)
curl -sXPOST -d '{"from":"0x…","amount":"50","durationDays":30}' .../v1/base/tx/prepare/request_loan
# 502 ; log shows data:"0x4f39d6b2"  (bindBorrowToPoolCreator)
```

Everything else (`withdraw_liquidity`, `repay_loan`, `claim_interest`, `approve_usdc`,
`register_agent`, `create_pool`) already worked on V6 — it was exactly these two.

**Fixed** with the same `optionalView()` treatment (X-8). The credit-limit pre-check degrades
honestly rather than disappearing: without `outstandingPrincipal` it compares the requested amount
alone and *says* that already-outstanding principal is not included. Verified live against Base:
both routes now return a prepared transaction with an exact-amount prerequisite approve
(`1.0 USDC` / `0.5 USDC` collateral, never `MaxUint256`).

#### M-5 · MEDIUM · JS and Python over-approve 2× on any revert containing "exceeds"

`isAllowanceShortfall` / `_is_allowance_shortfall` tested `/allowance|exceeds|transfer amount/i`.
`Exceeds credit limit` matched, so `_borrowInner` treated a credit-limit refusal as an allowance
shortfall and re-approved `collateral + principal`: **1200 USDC then 2400 USDC then 0** on Base for
a borrow that could never succeed, plus two wasted transactions. Bounded and always revoked, but the
exact-approval model should not widen an approval because a *different* rule refused the borrow —
and the same regex would fire on `Exceeds pool liquidity`.

**Fixed** in both clients: a `NOT_ALLOWANCE_REVERTS` guard runs first. Tests assert that the two
genuine shapes (legacy string revert and the OpenZeppelin v5 custom error `0xfb8f41b2`) are still
recognised.

#### M-6 · MEDIUM · The MCP write flow never cleans up its own prerequisite approval

`prepare` returns a `prerequisite` approve and says "send and confirm it first". When the main
transaction then reverts, that approval stands — observed 5 times, up to 200 USDC. Both SDKs revoke
automatically; the server cannot (it holds no key), so it now **says so** in
`signingInstructions`: if the main transaction fails or is abandoned, send
`prepare_approve_usdc {amount:"0"}` too. A structured `cleanup` transaction alongside
`prerequisite` would be the stronger fix and is left as a recommendation.

#### M-7 · MEDIUM · The broadcast relay destroys the revert reason

Every reverting relay returned `broadcast rejected by RPC: The transaction would revert: could not
coalesce error`. `explainRevert` reads `err.reason`, `err.data` and `err.info.error.data`, but
ethers puts the node's nested payload on `err.error.data.data` for `eth_sendRawTransaction`.
Every real reason was lost: `Below minimum supply`, `Remaining below minimum supply`,
`Last slot reserved for agent self-stake`, `Exceeds credit limit`,
`Self-stake locked while borrowing`, `Not the borrower`. **Not fixed** — it needs an
`err.error.data.data` probe in `explainRevert` and a relay-path test. Observed against hardhat,
which rejects reverting transactions at send time, as Base and Arc endpoints also do.

#### M-8 · MEDIUM · `Remaining below minimum supply` got the opposite advice

`REASON_MAP`'s `/Below minimum supply/i` also matched the V6.2 **withdraw**-side revert, so a
failed withdrawal was answered with supply-side guidance ("the pool CREATOR supplying into its own
pool is exempt"). The correct remedy is the opposite: withdraw in full, or leave at least the
minimum. **Fixed** with a more specific entry ordered first. (`prepare_withdraw_liquidity` still
has no *pre-check* for this rule — unlike the self-stake lock, which it handles well — left as a
recommendation.)

#### L-5 · LOW · An EIP-7702-delegated EOA cannot register, and nothing said why

`AgentRegistryV2.register()` uses `_safeMint`; a 7702 delegation designator makes
`to.code.length > 0`, so OZ calls `onERC721Received` on the delegate, which reverts
`ERC721InvalidReceiver` (`0x64a0ae92`). All three clients reported only "(unknown custom error)".
**Fixed** server-side: the ERC-721 errors are in `CUSTOM_ERRORS` and the reason map explains the
delegation cause. The SDKs still surface the raw selector.

#### L-6 · LOW · No explanation for the reserved lender slot

`AgentLiquidityMarketplaceV62.sol` asks clients to surface
`Last slot reserved for agent self-stake` as a distinct refusal; the server returned the generic
capacity message. **Fixed.**

#### L-7 · LOW · `register_agent` on a real-money network claimed to move USDC

`realMoneyWarning` was applied unconditionally, so `register_agent` and `create_pool` warned
"this transaction moves real USDC" while their own summary said "No USDC moves." **Fixed** — those
actions now get a real-money warning that is true (a real on-chain write costing real gas).

#### L-8 · LOW · The JS SDK can reuse a nonce on a fast-mining chain

ethers caches `eth_getTransactionCount` for 250 ms, so the SDK's back-to-back `approve → act` pair
gets the same nonce when the approve mines in under 250 ms: `supply FAILED: nonce has already been
used`. Deterministic repro with `new JsonRpcProvider(url, undefined, {cacheTimeout:-1})` passing
and the default failing. Python is unaffected (web3.py does not cache and the client reads
`'pending'` explicitly). Not reachable on Base/Arc block times, but it breaks local-node
integration testing and any future fast chain. The failure was clean — `_withApprovalCleanup`
revoked the 300 USDC approval to 0. **Not fixed**; the one-line remedy is to construct the SDK's
provider with `cacheTimeout: -1`, or to read the nonce with `'pending'` as the Python client does.

#### L-9 · LOW · Stale MCP instructions

`mcp.ts` INSTRUCTIONS still said the three read tools "return a 'not supported' error on pre-V6.1
deployments", which stopped being true with the M-1 fix. **Fixed.**

---

## 6. Changes in this worktree

Patch: **`forensics/output/testing-2026-09-23/cross-generation-fixes.patch`**
(`git apply` from the repo root). Every fix has a test that fails without it.

| file | change |
|---|---|
| `mcp-server/src/chain.ts` | `isTransientRpcFailure()`, `CapabilityUnknownError`; capability probes never cache a transient failure (H-2) |
| `mcp-server/src/reads.ts` | `optionalView()` + null-reporting for views the oldest generation lacks; registry-scan fallback for pool enumeration; `activeLoanIdsFor()` and the V6 `can_top_up` / `preview_repayment` answers; loan-walk termination (H-1, H-3, M-1, M-2) |
| `mcp-server/src/prepare.ts` | the same `optionalView()` treatment for the two dead write builders; `Remaining below minimum supply` and `Last slot reserved…` reason entries; ERC-721 custom errors; approval-cleanup instruction; honest real-money warning (H-4, M-6, M-8, L-5, L-6, L-7) |
| `mcp-server/src/tools.ts`, `mcp.ts`, `openapi.json` | the three tools are no longer documented as "V6.1 only" (M-1, L-9) |
| `src/sdk/SpecularQuickstart.js` | `_isTransientRpcFailure`, `_loanIdAt`, `_codeContainsSelector`, `NOT_ALLOWANCE_REVERTS`; `canTopUp` and `creditInfo` hardened (H-3, M-4, M-5) |
| `python/specular/client.py` | the same, plus `LoanEnumerationFailed` (H-3, M-4, M-5) |
| `mcp-server/test/unit.crossgen.test.mjs` | **new** — 16 cases (X-1 … X-11) |
| `test/sdk/quickstart-loan-enumeration.test.js` | **new** — 12 cases |
| `python/tests/test_loan_enumeration.py` | **new** — 14 cases |
| `mcp-server/test/unit.v61.test.mjs` | three tests rewritten for the deliberate M-1 behaviour change |

Left unfixed, with the reason: **M-7** (relay revert reasons — needs an `err.error.data.data`
probe plus a relay-path test), **L-1** (SDK previews a settled loan — a semantics decision),
**L-4** (Python has no retry helper), **L-8** (ethers nonce cache — a provider-construction
change), and the stronger form of **M-6** (a structured `cleanup` transaction).

**Deliberate behaviour change to review:** `preview_repayment`, `can_top_up` and
`get_active_loan_ids` now answer on V6 instead of returning a 400. That is what makes the three
clients agree; if the refusal was intentional API policy, the SDKs are the ones that need changing
instead.

### Test results after the changes

| suite | result |
|---|---|
| `mcp-server` full (`node --test "test/*.test.mjs"`, unit + integration) | **151 / 151** |
| `npx hardhat test test/sdk/*.test.js` | **76 / 76** |
| `python -m unittest tests.test_loan_enumeration` | **14 / 14** |
| `npm run test:types` | clean |

---

## 7. What was not covered

* **Live write paths on Base and Arc mainnet** — deliberately out of scope; nothing was broadcast.
  Writes ran only on the two local mainnet forks.
* **`arc` (the legacy Arc testnet config)** — only the three generations named in the brief were
  exercised.
* **V6.1, the middle generation** — no V6.1 deployment remains in the config files, so the write
  track covered V6 and V6.2 only. V6.1 *reads* were covered via the superseded address
  `0xB2d88bbF…` in the adversity suite.
* **A LATE repay** (the V6.1/V6.2 per-second accrual and its bounded headroom approval) — every
  loan was repaid on time, so every repay approval was exact to the base unit (`50616438`). That
  is the one path where a non-zero residual allowance is expected by design, and therefore the one
  path where the clients' revoke-after-repay logic actually matters. Worth a dedicated round.
* **The borrow-side self-stake gate** (`Insufficient self-stake`) — unreachable: both generations
  sit at score 0 ⇒ 100 % collateral ⇒ `requiredSelfStake == 0`. Reaching a sub-100 % tier needs
  ~95 repayment cycles with real hold time on RMv4. Only the M2-a *withdraw* lock was exercised.
* **`compactPoolLenders` and the 50-lender interest distribution** — only the slot-cap boundary
  was driven.
* The `superseded` entries in each config were exercised **through the clients** and, for the
  server, through a `SPECULAR_REPO_ROOT` override; the live server's own address resolution was
  not repointed.

### Reproduction scripts

All under
`/private/tmp/claude-501/-Users-peterschroeder-Specular/b8e35165-c44e-47a9-9bde-3fae8946f2e1/scratchpad/`
(scratch, not committed): `fault-rpc.mjs` (fault-injecting proxy), `adversity.sh`,
`adversity2.sh`, `adversity3.sh`, `adversity-sdk.mjs`, `adversity-py.py`, `js-reads.mjs`,
`py-reads.py`, `mcp-probe.mjs`, `run-parity.sh`, `compare.py`, `base-state.mjs`,
`allowance-audit.mjs`, `probe-base*.mjs`.

The write track is under `…/scratchpad/writeparity/`: `hh-base.config.js` / `hh-arc.config.js`
(pinned fork configs), `setup.js`, `prep.js`, `harness.js`, `runJs.js`, `run_py.py`, `runMcp.js`,
`mcpBaseTail.js`, `audit.js` → `audit.json` (the approval ledger), `parity.js`, `unsupported.js`,
`nonce-repro.js`. Two hardhat-forking notes recorded there: overriding `chainId` to a real chain
id needs `networks.hardhat.chains[<id>].hardforkHistory` **and** one mined block before any
`eth_call` (the fork block is "historical" to EDR); and Base USDC balances live in storage slot 9
(`balanceAndBlacklistStates`) while Arc MockUSDC uses slot 0 (OZ `_balances`).
