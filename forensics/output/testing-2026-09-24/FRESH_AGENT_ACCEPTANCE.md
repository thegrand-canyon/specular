# Fresh-agent acceptance test — can a stranger integrate with Specular from what is published?

**Date:** 2026-09-23 · **Target:** the *deployed* hosted service
`https://specular-agent-api-production.up.railway.app` (version `2.1.0`) and the *deployed*
arc-staging V7 contracts. **Branch:** `main`.

**Posture.** Everything below was done as a brand-new third-party agent. Four throwaway wallets,
generated for this run and funded from the deployer (keys in `keys.secret.json`, gitignored, never
printed). No local server instance was started. No insider address was hardcoded — every contract
address came from `GET /v1/networks`. Every write was `prepare → sign locally → broadcast`, and every
result was re-read **directly from chain with the real ABIs**, never trusted from the API response.
All on-chain work was on **arc-staging (chainId 5042002)**. Nothing was broadcast to arc-mainnet or
Base; both were read only.

---

## Verdict

**The product works. The documentation does not.**

All three entry points — hosted REST, hosted MCP, and the two local SDKs — drove a brand-new wallet
from nothing to a repaid loan against the same deployed V7 contracts, with exact on-chain accounting
and no manual intervention. Error quality is, with two exceptions, better than most production DeFi
APIs: 46 hostile inputs produced 46 specific, actionable messages and zero raw reverts, zero 500s,
zero silences.

But an integrator holding **only** the published pages would have failed twice before writing any
business logic:

1. **Every copy-pasteable example in every published doc returns HTTP 401.** Auth became mandatory
   on 2026-09-23; the examples were not updated. The `Authentication (required)` section at the top
   of `REMOTE_MCP.md` is contradicted 36 lines later by an endpoint table that calls auth "Optional",
   and by five code samples that omit the header.
2. **The published borrower walkthrough is wrong and, followed verbatim, burns gas on a reverted
   transaction.** It goes `register → create_pool → request_loan`. It omits `supply_liquidity`. On
   every current deployment `borrowRestrictedToPoolCreator: true`, so a loan is drawn from the
   borrower's *own* pool; a pool created one block ago holds 0 USDC. I ran the documented sequence
   exactly as written and it ended at tx `0xe1672c2b…` **status 0**.

Both are now fixed in this repo. A third issue is fixed only in prose because it is a code-side
silence: a loan repaid faster than `minHoldForReputationRewardSeconds` earns **no reputation and no
credit-ladder growth**, and nothing in the API says so — so the obvious "prove it works" integration
test (borrow, repay immediately, check the score went up) quietly proves the opposite.

**Integrate-from-docs-alone verdict (post-fix): yes.** Pre-fix: no — a stranger stalls at 401, and
if they get past that, at a reverted first loan with no doc explaining why.

---

## 1. The stranger's path, non-custodially (hosted REST only)

Wallet `0x801e256F516a2fD3E0e06A871419E707695B82DF` → **agent #66**, loan **#115**.
Driver: `rest-journey.js`; raw record: `rest-journey-result.json`.

Contract addresses were taken from `GET /v1/networks` at runtime, not from the repo:
marketplace `0x7E4D144AbEB3C695Ec2DdF00Fc710aABC04bDd18` (V6.2 + ReputationManagerV4),
registry `0x4712A978A0EADe68f0b485b981112Ae66aA622d9`, USDC `0x9F3C10985998D1354D1465c5135Aa924775bd11D`.

| # | Step | Broadcast via | Tx hash | On-chain verification (direct RPC, real ABI) |
|---|------|---------------|---------|----------------------------------------------|
| 1 | `GET /v1/networks` | — | — | 2 networks served: `arc-mainnet`, `arc-staging`. **`base` absent.** |
| 2 | `GET /v1/arc-staging/status` | — | — | `V6.2` / reputation `V4`, 6 credit tiers read live from chain, `maxTierLimitUsdc 10000` |
| 3 | `GET …/agents/{me}/credit` | — | — | `registered:false` + a `nextStep` string naming the next two calls |
| 4 | `prepare_register_agent` → sign → **server relay** | relay | `0xdcc0ef3eb819fe92d47952f701236bfabfab5f507feb62cd6d6c6cdfd9368bc8` | `registry.isRegistered(me) == true`, `addressToAgentId(me) == 66` |
| 5 | `prepare_create_pool` → sign → **own RPC** | self | `0x3930b54d924fdd79370eef7335c34306074b3cf0b7b9b3ea089547d836f4560d` | `GET /pools/66` → `isActive:true`, 0 liquidity |
| 6 | exact approve (prerequisite, 120 USDC) | relay | `0x0fc0f6c09bd44a6d937ba772cf33fe677d8458b5f88b2f875e6d028708bd775a` | allowance 120.0 exactly, not `MaxUint256` |
| 7 | `prepare_supply_liquidity` 120 → sign → **own RPC** | self | `0xa3eb0268f88f2b6af8821e41a79d3695eef9bcd21e53e1d2f065588a414f6c41` | `agentPools(66).totalLiquidity == 120000000`; marketplace USDC balance +120; allowance back to **0** |
| 8 | `get_self_stake` / `required_self_stake` | — | — | stake 120.0, `locked:false`, required 0.0 (100 %-collateral tier ⇒ no unsecured exposure) |
| 9 | `GET …/credit` again | — | — | `creditLimitUsdc "100.0"` = min(tier 1000, ladder bootstrap 100) — with the derivation spelled out in `model.explanation` |
| 10 | exact approve (collateral, 25 USDC) | relay | `0xe2fe55fefaf2d35742a1133592d8b86aeb83a0a565262723848196aeac343e41` | allowance 25.0 |
| 11 | `prepare_request_loan` 25 / 30d → sign → **relay** | relay | `0xa609a6cb3f5c2a4db8baaabec252eb84bddc9e39494e88a678281b7d32bf57ad` | `LoanRequested{loanId:115}` + `LoanDisbursed`; `loans(115)` = borrower me, amount 25000000, collateral 25000000, rate 1500 bps, state `1` (ACTIVE) |
| 12 | `GET /loans/115`, `GET /loans/115/repayment` | — | — | due 2026-10-23, total `25.308219` USDC, `late:false` |
| 13 | exact approve (25.308219) | relay | `0x143987f4cc69f8ea327abad0b1be64e281da8377813e1b79554709e4b2f30845` | allowance 25.308219 — exactly `previewRepayment` |
| 14 | `prepare_repay_loan` → sign → **relay** | relay | `0x50a45527e3e6ce8f0cee9fa03ed26d2937bd46e356495273ac5bb519b5abaae6` | **`loans(115).state == 2` (REPAID)**; `LoanRepaid(115, 25000000, 308219)`; `InterestDistributed(66, 305137)` |
| 15 | `prepare_claim_interest` → sign → **own RPC** | self | `0x997fbf04949daebeaa02d74bab14d07d096e8f39ec48d106e003e461cd2ceb1d` | wallet USDC **+0.305137** — equal to `InterestDistributed` minus the 1 % platform fee |
| 16 | `prepare_withdraw_liquidity` 50 → sign → **relay** | relay | `0x5dd9a61b2d2466fa2a21142be496ac78c133dfde1d4590b605af557b6347d192` | wallet **+50.0**; `agentPools(66).totalLiquidity == 70000000` |

**The server is genuinely optional for settlement.** Steps 5, 7 and 15 were signed locally and
pushed straight to `arc-testnet-rpc.publicnode.com` with `eth_sendRawTransaction`, bypassing the
Specular relay entirely. They mined identically. The server never sees a key and cannot move funds;
the non-custodial claim holds.

**Closed-loop USDC accounting** (independently reconstructed from chain, not from API totals):

```
500.000000  minted
-120.000000 supply                    = 380.000000
 +25.000000 principal, -25.000000 collateral (same tx)   = 380.000000
 -25.308219 repay,     +25.000000 collateral returned    = 379.691781
  +0.305137 claim interest                               = 379.996918
 +50.000000 withdraw                                     = 429.996918   <-- matches balanceOf() exactly
```

Every allowance returned to **0** after each operation. No dust, no phantom liquidity, no
`MaxUint256`.

---

## 2. MCP transport (a real MCP client, as Grok Bot would connect)

`mcp-journey.mjs`, using `@modelcontextprotocol/sdk` 1.30.0 from `mcp-server/node_modules`,
`StreamableHTTPClientTransport`, wallet `0xff7bb13d098B27871E94FCf83Ac826ae8Cd58d09` → agent #67.

| Phase | Tool | Result |
|-------|------|--------|
| connect | `initialize` | 433 ms, clean handshake, stateless (no session id) |
| discovery | `tools/list` | **25** tools; annotations correct — `readOnlyHint:true` on all reads/prepares, `destructiveHint:true` only on `broadcast_signed_transaction` |
| discovery | `list_networks`, `get_protocol_status` | identical payloads to REST |
| read | `check_credit_score` | `registered:false` → later `registered:true, agentId:67` |
| prepare | `prepare_register_agent` (`simulate:true`) | `simulation.ok:true`, gas 353 825 |
| broadcast | `broadcast_signed_transaction` | `0xc0904484b7bcbd4e8169d28d4e33a97be5dab43bccf1db474ac6de7d6192225f`, receipt **status 1** verified directly on chain |
| read-back | `get_transaction` | decoded `AgentRegistered` |

Transport conformance against the documented contract, all confirmed live:
`GET /mcp` → 405 · JSON-RPC batch → array · empty batch → `-32600` · unknown method → `-32601` ·
unknown tool → `-32602` · `Mcp-Protocol-Version: 2025-11-25` → 200 · bad version → `-32000` naming
the supported list · `Accept: */*`, `application/json` and *no* Accept header all served.

Rate limiting behaves as documented: a 140-request burst produced 36 × `429` with
`Retry-After: 9` and `{"error":"rate limit exceeded; retry in 9s"}`.

---

## 3. Entry points × lifecycle

Three entry points, one set of deployed contracts, three independently verified repaid loans.

| Step | REST (hosted) | MCP (hosted) | JS SDK (`SpecularQuickstart`) | Python (`SpecularClient`) |
|------|---------------|--------------|-------------------------------|---------------------------|
| discover networks / tiers | ✅ `/v1/networks`, `/status` | ✅ `list_networks`, `get_protocol_status` | ✅ `capabilities()`, `tierTable()` | ✅ `capabilities()`, `tier_table()` |
| register | ✅ agent #66 | ✅ agent #67 | ✅ agent #68 (`onboard()`) | ✅ agent #69 (`onboard()`) |
| create pool | ✅ | ✅ (verbatim-doc run) | ✅ (folded into `onboard()`) | ✅ (folded into `onboard()`) |
| approve USDC (exact) | ✅ prerequisite | ✅ via prepare | ✅ just-in-time | ✅ just-in-time |
| supply | ✅ 120 | — | ✅ `supply(68,120)` | ✅ `supply(69,120)` |
| check credit | ✅ limit 100.0 | ✅ | ✅ `creditInfo()` | ✅ `credit_info()` |
| borrow | ✅ **loan #115** | — | ✅ **loan #116** | ✅ **loan #117** |
| loan status / preview | ✅ | ✅ `get_transaction` | ✅ `previewRepayment` | ✅ `preview_repayment` |
| repay | ✅ state `2` on chain | — | ✅ state `2` on chain | ✅ state `2` on chain |
| claim interest | ✅ +0.305137 | — | ✅ | ✅ `claim_interest()` |
| withdraw | ✅ +50.0 | — | ✅ | ✅ |
| broadcast without the server | ✅ 3 steps via own RPC | n/a | ✅ by design (direct contract) | ✅ by design (direct contract) |

The two SDKs talk to the contracts directly rather than through the hosted API, and both resolved
the **same** V7 marketplace from `src/config/arc-testnet-v6-addresses.json` — so all three surfaces
demonstrably target the same deployment.

---

## 4. Doc divergences, with corrected text

`file:line` refers to the state **before** this run. Items marked **FIXED** were corrected in this
commit and the corrected commands re-executed against the live server (all 200).

### D1 — Every published example is unauthenticated and returns 401 · **blocker** · FIXED

`docs/integrations/REMOTE_MCP.md:46-51`, `:141-148`, `:129-131` ·
`docs/integrations/GROK_BOT.md:70-75` · `docs/integrations/MUSE_CONNECTOR.md:90-99` ·
`mcp-server/README.md:150-155`

Every one, run verbatim, returns `401 {"error":"missing or invalid bearer token"}` — including
`tools/list`, which is exactly what a platform calls first when wiring up a connector. Corrected to
carry `-H "authorization: Bearer $SPECULAR_MCP_TOKEN"` / `Authorization` header, and each corrected
form was executed live (200, 25 tools).

### D2 — `REMOTE_MCP.md` contradicts itself on whether auth is required · **high** · FIXED

`docs/integrations/REMOTE_MCP.md:39` said:

> `Auth | Optional Authorization: Bearer <SPECULAR_MCP_TOKEN>; if the operator did not set a token the endpoint is open`

36 lines above, the page's own heading reads "Authentication (required since 2026-09-23)". Same
conditional phrasing at `GROK_BOT.md:15` and `MUSE_CONNECTOR.md:16`. Corrected to
"**Required on the hosted deployment**", with the self-hosted-open case kept as the exception.

### D3 — The borrower walkthrough omits `supply_liquidity` and reverts as written · **blocker** · FIXED

`docs/integrations/REMOTE_MCP.md:104-115` · `mcp-server/README.md:136-145` ·
`docs/integrations/MUSE_CONNECTOR.md:77-82` · `docs/integrations/GROK_BOT.md:36-42`

Verbatim reproduction (`doc-walkthrough-verbatim.js`, agent #67):

```
1. check_credit_score       -> registered
2. prepare_create_pool      -> 0x4e3507c850ce13502f091f86c8c4688ef74cfde17cee2f4dbcc35f86a3246e80  status 1
3. prepare_request_loan 25  -> HTTP 200, simulation.ok: FALSE
   "The pool does not hold enough available USDC for this amount."
   warnings: ["Pool #67 has only 0.0 USDC available; the request for 25.0 USDC will revert.", ...]
4. (doc says: send prerequisite, then the loan tx)
   approve 0x22879e9feee4f94caaaa9eb1f3f494798a748c29b81613a81e29c3faa29b1cf9  status 1
   LOAN  0xe1672c2bf748f85c8d76d4b62cf05da35735aa04faf5cf2408e60d15708cf32c  status 0   <-- REVERTED
```

The cause is a product fact the docs never state: `get_protocol_status.parameters` reports
`borrowRestrictedToPoolCreator: true`, so a loan is drawn from the borrower's own pool. The docs
mention `prepare_supply_liquidity` only under "**Lenders** use…" (`REMOTE_MCP.md:117`), framing it as
somebody else's job. Corrected walkthroughs now make supply a mandatory numbered step in all four
files, note that the pool creator is exempt from `minSupplyUsdc`, state the ~2× USDC budget at the
100 %-collateral tier, point at `required_self_stake`/`get_self_stake` as a separate gate below
100 % collateral, and tell the integrator to stop on `simulation.ok === false`.

Note the API told the truth throughout — `simulate: true` returned `ok:false` with an accurate
plain-language reason and a precise warning. Only the *documented step order* was wrong. A side
effect worth knowing: the reverted attempt leaves a dangling 25 USDC allowance from the prerequisite
approve (confirmed on chain for agent #67).

### D4 — `base` is documented as an available network but is not enabled · **high** · FIXED

`docs/integrations/REMOTE_MCP.md:74-76` · `GROK_BOT.md:54` · `MUSE_CONNECTOR.md:60` ·
`mcp-server/README.md:39`

`GET /` and `GET /v1/networks` both report exactly two networks, `arc-mainnet` and `arc-staging`.
`GET /v1/base/status` → `400 Network "base" is not enabled on this server (enabled: arc-mainnet,
arc-staging)`. All four pages listed `base` as one of three usable networks. Corrected to mark it
not-enabled on the hosted deployment and to name `list_networks` as the authority.

### D5 — `arc-mainnet` documented as V6.1; it is V6.2/V7 · **medium** · FIXED

`mcp-server/README.md:40` said "Arc mainnet, V6.1". Live `GET /v1/arc-mainnet/status` returns
`marketplaceVersion: V6.2`, `reputationVersion: V4`, `v62: true`. Corrected, and the table is now
explicitly labelled a snapshot with `/v1/networks` named as the live source.

### D6 — Reputation silently does not move on a fast repay · **high** · documented (code fix recommended)

Not previously mentioned anywhere. After loan #115 was borrowed and repaid on time, on chain:

```
loanCount(66)            1
totalRepaid(66)          25.0 USDC
maxRepaidPrincipal(66)   0.0        <-- credit ladder did NOT advance
getReputationScore(66)   0
creditLimitOf(66)        100.0      <-- still the bootstrap
LoanCompleted(66, 115, 25000000, onTime=false)
```

`AgentLiquidityMarketplaceV62.sol:1045-1051` passes
`onTime && heldLongEnough && paidInterest`, and `heldLongEnough` requires
`minHoldForReputationReward` (86 400 s) to have elapsed. A ~20-second repay therefore reports
`onTime=false`, and `ReputationManagerV4.recordLoanCompletion` takes neither the late branch nor the
on-time branch — no penalty, but also **no ladder growth**. This is the intended anti-farming lever,
not a contract bug. It is a product-comprehension trap: the natural first integration test is
"borrow, repay, confirm the score rose", and it will always fail with no explanation. `/status` does
expose `minHoldForReputationRewardSeconds`, but nothing says what it does, and
`prepare_repay_loan` emits no warning. Now documented in all three integration pages plus the
server README. See **C5** for the recommended code fix.

### D7 — `tools/list` returns 25 tools, doc asserts 20 · **low** · FIXED

`docs/integrations/GROK_BOT.md:73` — the inline comment on the verification command said `# 20`.
Actual: 25. An integrator checking the doc's own assertion would think the connection was wrong.

### D8 — Open-route list and protocol-version range were both inaccurate · **low** · FIXED

`REMOTE_MCP.md:11-12` said only `/health` and `/openapi.json` stay open; `GET /` and `/rpc-health`
are open too (both verified 200 with no token). `REMOTE_MCP.md:38` said protocol versions
"`2025-06-18` and earlier" while `:161` said `2024-11-05 … 2025-11-25` — the server accepts
`2025-11-25`. `:161` also said an unsupported version gets "400"; it is a JSON-RPC `-32000`.

### D9 — Default arc-staging RPC list stale · **low** · FIXED

`mcp-server/README.md:60` lists three defaults for `arc-staging`; the deployment reports two
(`arc-testnet.drpc.org` is gone). Corrected, plus a note that the public Arc endpoints rate-limit
burst writes — I hit `-32005 rate limit exceeded` on `rpc.testnet.arc.io` while funding wallets,
which an integrator broadcasting its own transactions will meet too.

### D10 — Muse error table missing 503/504 and the `simulation.ok:false` case · **medium** · FIXED

`MUSE_CONNECTOR.md:107-113` listed 400/401/413/429/502 only. `REMOTE_MCP.md:156` documents 503 and
504 with `Retry-After`; more importantly, a prepared transaction that **would revert** comes back as
HTTP **200** with `simulation.ok:false`. A connector treating 200 as success signs reverting
transactions — which is exactly what D3's verbatim run did. Both now in the table.

---

## 5. Error quality — 46 hostile inputs (`error-battery.js`)

No raw revert strings, no 500s, no silent successes, no ethers internals leaked. Full record in
`error-battery-result.json`. Representative rows:

| What a newcomer does | HTTP | Message | Grade |
|----------------------|------|---------|-------|
| no bearer token | 401 | `missing or invalid bearer token` | ⚠️ correct but doesn't say where to get one |
| network `arc-testnet` | 400 | `Unknown network "arc-testnet". Valid: base, arc-staging, arc-mainnet.` | ⚠️ lists `base`, which this server refuses |
| network `base` | 400 | `Network "base" is not enabled on this server (enabled: arc-mainnet, arc-staging).` | ✅ |
| address `0xdeadbeef` | 400 | `address must be a 0x-prefixed 20-byte hex address` | ✅ |
| bad EIP-55 checksum | 400 | `address has an invalid EIP-55 checksum: 0x801E…` | ✅ echoes the offender |
| all-lowercase address | 200 | accepted, normalised | ✅ |
| `amount: 25` (number) | 200 | works | ✅ |
| `amount: "25"` (string) | 200 | works | ✅ |
| `amount: 12.5` | 200 | works | ✅ |
| `amount: 12.1234567` | 400 | `amount must be a positive decimal with at most 6 decimal places (got "12.1234567")` | ✅ |
| **`amount: 25000000` (base units)** | 400 | `amount=25000000 USDC exceeds this server's per-call cap of 100000 USDC (raise SPECULAR_MAX_AMOUNT_USDC to change)` | ❌ **worst message in the set** |
| `amount: 0` / `-5` / `"twenty-five"` / absent | 400 | each names the rule and echoes the value | ✅ |
| supply 5 USDC under the 10 minimum | 200 | `Amount is below the pool's minimum supply… the pool CREATOR supplying into its own pool is exempt…` | ✅ explains the exemption |
| borrow 500 over a 100 limit | 200 | leads with *"The pool does not hold enough available USDC"*; the credit breach is warning #2 | ⚠️ right facts, wrong headline |
| borrow 99999 | 400 | `exceeds this server's per-call cap of 50000 USDC (raise SPECULAR_MAX_AMOUNT_USDC to change)` | ⚠️ names the **wrong** env var |
| `durationDays` 3 / 9999 / 30.5 | 400 | `below min 7` / `exceeds max 365` / `must be an integer number of days` | ✅ |
| borrow from an unregistered wallet | 200 | `This wallet is not registered as an agent… Send register_agent first, then create_pool.` | ✅ |
| borrow with no pool | 200 | `This agent has no liquidity pool yet. Send create_pool first.` | ✅ |
| loan `999999` | 400 | `Loan 999999 does not exist on arc-staging (highest loanId is 117)` | ✅ tells you the bound |
| **withdraw while self-staked** | 200 | `You are the creator of this pool, so your position is the agent's first-loss self-stake and is locked for as long as the agent carries outstanding principal. Repay… (get_active_loan_ids, then prepare_repay_loan)… claim_interest works while locked.` | ✅ **best message in the set** |
| **repay someone else's active loan** | 200 | `Only the wallet that borrowed this loan (or… the current holder of the agent NFT) can repay it.` + a warning naming both addresses | ✅ |
| repay an already-repaid loan | 200 | `This loan is not ACTIVE (already repaid or defaulted).` + `Loan #115 is REPAID, not ACTIVE` | ✅ |
| claim from a pool you never funded | 200 | `There is no claimable interest for this wallet in this pool.` | ✅ |
| register twice | 200 | `This wallet is already registered; skip register_agent.` | ✅ |
| broadcast `0xdeadbeef` | 400 | `signedTransaction could not be decoded: data short segment too short` | ⚠️ slight library flavour |
| broadcast a native transfer | 400 | `Specular transactions must carry value 0; refusing to relay a native-token transfer` | ✅ |
| broadcast an unlimited approve | 400 | `USDC approve of unlimited exceeds the exact-approval cap (100000 USDC); approve only what the next call needs` | ✅ |
| broadcast a tx signed for chainId 8453 | 400 | `transaction chainId 8453 does not match arc-staging (chainId 5042002)` | ✅ |
| non-JSON body | 400 | `malformed JSON body` | ✅ |
| unknown MCP tool | `-32602` | `Unknown tool: borrow_all_the_money` | ✅ |

**The worst message a newcomer would hit** is the base-units one. Passing `25000000` for 25 USDC is
*the* canonical first-day mistake with a 6-decimal token, and the response (a) never mentions units,
and (b) instructs a third-party integrator to change `SPECULAR_MAX_AMOUNT_USDC`, a server-side
environment variable they do not control and cannot see. It reads as "you are the operator, go fix
your config" to someone who is neither. Everything else in the table is genuinely good.

---

## 6. Latency and wall-clock

Measured from a US-West laptop against the Railway deployment.

| Class | n | median | range |
|-------|---|--------|-------|
| REST reads (`GET /v1/…`) | 14 | 329 ms | 80 ms – 1 899 ms (`/status`, cold tier-table read) |
| REST prepares (`POST …/tx/prepare/*`) | 7 | 249 ms | 170 – 502 ms |
| REST relay (`POST …/tx/broadcast`, server→RPC only) | 7 | 159 ms | 121 – 409 ms |
| MCP `tools/call` | 9 | 241 ms | 97 – 1 366 ms |
| MCP `initialize` handshake | 1 | 433 ms | — |
| Validation rejections (400s) | 46 | 71 ms | 56 – 607 ms |
| Broadcast → 1 confirmation (chain, not server) | 10 | 4 744 ms | 4 696 – 9 025 ms |

Overall REST call distribution: p50 269 ms, p90 502 ms.

**Wall-clock from nothing to a repaid loan:**

| Entry point | discovery → repaid | full lifecycle incl. claim + withdraw |
|-------------|--------------------|----------------------------------------|
| **REST (hosted)** | **59.7 s** | 74.3 s |
| Python `SpecularClient` | 57.5 s | 61.8 s |
| JS `SpecularQuickstart` | 38.7 s (onboard already mined) / ~50 s cold | 50.2 s |
| MCP (discovery + read + prepare + broadcast) | 10.3 s for its slice | — |

The number is dominated by chain finality, not by Specular: 10 transactions × ~4.7 s = ~47 s of the
REST run's 59.7 s. **Total time spent inside Specular's API across the whole 74.3 s REST journey was
9.8 s, spread over 28 calls.** A fresh agent can be borrowing inside a minute.

---

## 7. Code bugs found (reported, not fixed)

**C1 · `openapi.json` advertises auth as optional while the server enforces it.** The generated
document declares `security: [{"bearerAuth": []}, {}]`. The empty alternative means "no auth also
acceptable". Meta Muse Connectors are built *by pointing at this document* — a connector generated
faithfully from it will omit credentials and 401 on every call. The `bearerAuth` description
("Only enforced when the server sets SPECULAR_MCP_TOKEN") compounds it. The generator should drop
the `{}` alternative when a token is configured. Documented as a caveat meanwhile.

**C2 · Unknown-network errors advertise a network the server refuses.**
`Unknown network "arc-testnet". Valid: base, arc-staging, arc-mainnet.` sends the reader straight to
`base`, which then answers `Network "base" is not enabled on this server`. The valid-names list
should be filtered by `SPECULAR_ENABLED_NETWORKS`, exactly as the second message already is.

**C3 · The loan cap error names the wrong environment variable.** `amount=99999` is rejected against
the 50 000 loan cap (`SPECULAR_MAX_LOAN_USDC`) but the message says "raise `SPECULAR_MAX_AMOUNT_USDC`
to change" — the *other* variable, which is set to 100 000. Both cap messages also leak
operator-facing remediation to API consumers who cannot act on it.

**C4 · No units hint on a base-units amount.** `amount: 25000000` should produce something like
"amounts are in USDC display units — did you mean 25?" rather than a per-call-cap message. See §5.

**C5 · Fast repay silently forfeits reputation and ladder growth.** See D6. The contract behaviour is
deliberate, but the API should surface it: `prepare_repay_loan` already knows `loan.startTime` and
the deployment's `minHoldForReputationReward`, so it can emit a warning like *"Repaying now
(held 20 s of the required 86 400 s) earns no reputation and will not raise the credit limit;
repaying after <timestamp> will."* Same for the `preview_repayment` payload.

**C6 · Python client returns un-prefixed tx hashes; every explorer link it builds is dead.**
`python/specular/client.py:570` — `_send` returns `tx_hash.hex()`. Under web3.py v6 that yielded
`0x…`; under v7/v8 (`requirements.txt` says `web3>=6.0.0`; pip resolved **8.0.0**) `HexBytes.hex()`
no longer prefixes. Observed live:

```
onboard()      -> registerTx 'e06099ed523ef67d071a9ad28cf6979e20e2ffcd74fbc7214d15337b0ed68c5e'
borrow()       -> explorerUrl 'https://testnet.arcscan.app/tx/1081710890790dc20ab131ceba85c721…'   (404s)
```

Fix: `"0x" + tx_hash.hex()` if not already prefixed, or pin `web3>=6,<7`.

**C7 · SDK parity gap.** JS `SpecularQuickstart.claim(agentId)` vs Python
`SpecularClient.claim_interest(agent_id)`. Same operation, different name; an integrator porting
between them hits `AttributeError`. (Python also has no `claim` alias.)

**C8 · `@specular/sdk` is not published to npm.** `src/sdk/SpecularQuickstart.js:9` instructs
`require('@specular/sdk')`; `npm view @specular/sdk` → **E404**. A stranger cannot install the JS
SDK by the documented name — it works only from a repo checkout. (The Python package does install
cleanly via the documented `cd python && pip install -e .`.)

**C9 · `docs/integrations/` never mentions the SDKs.** The three published integration pages cover
REST and MCP only. Neither the JS SDK nor the Python client is linked from any of them, so a
stranger arriving at the documented entry point never learns they exist.

**C10 · Over-limit borrow leads with the wrong reason.** Requesting 500 against a 100 limit returns
`plainLanguage: "The pool does not hold enough available USDC…"`; the credit-limit breach is only
`warnings[1]`. Both are true, but the credit limit is the binding constraint an agent should act on.

---

## 8. Funds used (arc-staging only)

| Item | Amount |
|------|--------|
| Native funded to 4 throwaway wallets | 12.0 (cap was 25) |
| Native actually consumed as gas | **0.1230** |
| Test MockUSDC minted | 2 000 (4 × 500) |
| Still in staging pools | 70 USDC each in pools #66, #68, #69 |
| Broadcasts to arc-mainnet or Base | **0** — reads only, as required |

Wallets: `0x801e256F…82DF` (REST, agent 66), `0xff7bb13d…8d09` (MCP, agent 67),
`0x510496d6…d13F` (JS SDK, agent 68), `0x01Db1568…be48` (Python, agent 69).
Private keys are in `forensics/output/testing-2026-09-24/keys.secret.json`, gitignored via
`.gitignore:69`, and appear in no report, log or commit.

---

## 9. Artifacts

| File | What |
|------|------|
| `rest-journey.js` / `rest-journey-result.json` | full hosted-REST lifecycle, per-call latencies |
| `mcp-journey.mjs` / `mcp-journey-result.json` | real MCP client run, tool annotations, MCP error probes |
| `jssdk-journey.js` / `jssdk-journey-result.json` | JS SDK shortened path |
| `python-journey.py` / `python-journey-result.json` | Python client shortened path |
| `doc-walkthrough-verbatim.js` / `doc-walkthrough-result.json` | the documented borrower flow reproduced verbatim to its reverted transaction |
| `error-battery.js` / `error-battery-result.json` | 46 hostile inputs with verbatim responses |
| `verify-onchain.js` | independent on-chain verification with the real ABIs |
| `keys.secret.json` | throwaway keys (**gitignored**) |
