# Arc Mainnet V7 — post-deploy verification

**Date:** 2026-09-23 · **Network:** Arc mainnet, chainId 5042 · **Branch:** `arc-mainnet-launch`
**Stack under test:** ReputationManagerV4 `0x12953e732e5D1aFdA640554125367d1CEC2ac4FB`,
AgentLiquidityMarketplaceV62 `0xCb23f2fb03Bfd4775Cc0e76E28f64c1e545071be` (deployed 2026-09-23T01:13Z)
**Superseded, still live:** MarketplaceV6.1 `0x358c5E69f712A4b3558333090a45A054bAeEb282` + ReputationManagerV3 `0x1577Eb9985CcA859F25ED2EDaeD16A464ADFaE5e`
**Reused:** RegistryV2 `0x6F1EbF50290f6D4A9947E9EB77f98a683684fBF5`, Faucet `0xD854F80031A8d0CB166587AafA0969Da8C3757bF`, USDC `0x3600…0000` (6-dec ERC-20)

**USDC spent: 0.000000. No transaction was sent to any network.** Every mainnet result below
comes from `eth_call` / `eth_getStorageAt`. Budget was 2 USDC; none of it was needed — the two
checks that looked like they required a write (the faucet, and the self-stake monitor family)
were both settled by a state-override `eth_call` and a local-chain run respectively.

---

## 0. Verdict at a glance

| # | Area | Verdict |
|---|---|---|
| 1 | Runbook §5 post-deploy list | **4 of 5 verified**, 1 partial (§5.2), 2 previously-open items now settled |
| 2 | Config & doc integrity | **FAILED** — 5 live-pointer bugs, 1 of them a broken monitor instruction |
| 3 | Live hosted service | **FAILED** — serves the *superseded* stack on `arc-mainnet` |
| 4 | Pre-migration agent experience | **Verified**; operable, but 3 mandatory first steps and one silent surprise |
| 5 | Superseded-stack hygiene | **Verified** — monitored, drained, retirement conditions already met |

The single most important finding is **§3**: the hosted API that agents actually call still
points `arc-mainnet` at the superseded V6.1 marketplace and tells callers their credit limit is
**1,000 USDC when the chain says 100 USDC**. Everything else is documentation or noise.

---

## 1. The runbook's own post-deploy list (`V7_MAINNET_MIGRATION_RUNBOOK.md` §5)

### §5.1 — Verify source on Sourcify v2, chain 5042, `exact_match` · **VERIFIED**

`GET https://sourcify.dev/server/v2/contract/5042/<addr>`:

| Contract | creationMatch | runtimeMatch | verifiedAt |
|---|---|---|---|
| `0xCb23f2fb…` MarketplaceV62 | `exact_match` | `exact_match` | 2026-09-23T01:14:02Z |
| `0x12953e73…` ReputationManagerV4 | `exact_match` | `exact_match` | 2026-09-23T01:13:41Z |
| `0x358c5E69…` (superseded, for reference) | `exact_match` | `exact_match` | 2026-09-19T21:44:12Z |

Both new contracts are `exact_match` on both creation and runtime bytecode. Deployed code is
present and non-trivial (21,548 and 11,446 bytes).

### §5.2 — Smoke test with real USDC, **including the two new paths** · **PARTIAL**

The core smoke test demonstrably ran. On-chain residue proves it:

```
v7.nextLoanId            = 2          (one loan exists)
V7 loan 1: agentId=1 borrower=0x800e305A… amount=0.500000 collateral=0.500000
           rateBps=1500 start=1790126128 end=1790730928 state=REPAID
   repayments[1] = { repaidAt: 1790126133, interestPaid: 1438, lateSeconds: 0 }
v7.accumulatedFees       = 14 base units (= 1 % of 1438 interest)
v7.usdcBalance           = 0.000014 USDC (== accumulatedFees exactly; nothing stranded)
v7.totalPools            = 1,  getActiveAgents = ["1"]
```

Commit `af2f5ae` records "Real-USDC smoke test 21/21". **Accepted as verified for the core flow.**

**The two new V7 paths named in §5.2 were NOT exercised on mainnet, and cannot be today.**

- `grep -n "selfStake\|requiredSelfStake" scripts/smoke-test-arc-mainnet.js` → **no matches.**
  The mainnet smoke script has 24 assertions and none of them touch the self-stake lock or the
  `requiredSelfStake` loan gate.
- It is not an oversight that can be fixed by editing the script. Both paths are gated on
  `collateralPercent < 100` (`AgentLiquidityMarketplaceV62.sol:842`). Agent #1 is at score 0 →
  tier 0 → `tierCollateralPct[0] = 100` → `_requiredSelfStake()` returns 0 and the branch is
  never entered. Confirmed live: `v7.requiredSelfStake(1, 100e6) = 0.000000 USDC`,
  `v7.selfStake(1) = (0, false)`.
- Reaching a 0 %-collateral tier needs score ≥ 600. Mainnet `maxReputationGainPerWindow = 5`
  with `reputationGainWindow = 86400` — **a hard ceiling of 5 points/day**, so score 600 is
  **≥ 120 days away** no matter how the agent behaves.

**Conclusion:** §5.2 is verified for the V6.1-shaped flow and **structurally unverifiable on
mainnet for at least 120 days** for the V7-specific flow. Those two paths are covered on
staging (`V7_E2E_STAGING_REPORT.md`, 237/237) and by the local runs in §1/§5.3 below. This
should be recorded as an accepted gap, not left as a pending task.

### §5.3 — Monitoring: two jobs, and the `V6.2-SELFSTAKE` family · **VERIFIED, with a live defect**

**Two jobs exist and both are running**, every 1800 s:

| launchd label | Target | Env |
|---|---|---|
| `com.specular.v6-invariants-arc-mainnet` | canonical → follows V7 `0xCb23f2fb…` | `V6_EXPECTED_OWNER=0x800e305A…` |
| `com.specular.v6-invariants-arc-mainnet-legacy` | `V6_MONITOR_MARKETPLACE=0x358c5E69f712A4b3558333090a45A054bAeEb282` | same |

The legacy job correctly uses the **address** form the runbook prescribes, not the broken
`_KEY` form that `CLAUDE.md` documented (see §2). Last runs 2026-09-23T03:43Z and 03:46Z.
`forensics/monitor/heartbeat-arc-mainnet.json` shows `lastExitCode: 0, findings: 0`.

#### Is the `V6.2-SELFSTAKE` family actually wired, or merely untriggered?

**It is genuinely wired, it is emitting on mainnet right now, and its checks bite.** The
runbook's framing ("it currently reports nothing") is out of date.

*Evidence A — it already emits on mainnet.* Seven records in
`forensics/monitor/v6-invariants-arc-mainnet.log`, one per run since 01:29Z:

```json
{"ts":"2026-09-23T03:43:06.575Z","level":"INFO","msg":"V6.2-SELFSTAKE OK","net":"arc-mainnet",
 "stakes":[{"agentId":"1","creator":"0x800e305A0caDdE6289dFDFEDF38218f45C06F72C",
 "selfStake":0,"locked":false,"outstandingPrincipal":0,"required":0,"creatorPosition":null}]}
```

The emission gate is `v6-invariants.js:775` — `if (ss.length || s.pools.some(p => p.selfStake))`.
It counts *rows*, not non-zero stakes, so a zero-stake pool still emits. There is no `VERSION`
gate; the probe at lines 239–245 is a plain try/catch that leaves the field undefined on a
V6.1 deployment.

*Evidence B — the assertions fire, proven on a local chain that HAS a self-stake pool.*
A fresh V7 stack was deployed to local hardhat (chainId 31337) with three pools (self-stakes
500 / 800+live loan / 0) and the unmodified monitor pointed at it:

- Clean run: `V6.2-SELFSTAKE OK` listing all three pools, correctly reporting `locked:true`
  for the pool with outstanding principal and `locked:false` for the others. Exit 0.
- Engineered shortfall (`creditMultiple` 2→1 under a live loan): fired
  `[SS-SHORT] self-stake is below the current requirement for the outstanding principal`,
  family flipped `OK`→`WARNING`, exit 0→1.
- Engineered orphan (`hardhat_setStorageAt` evicting the creator from `poolLenders`): fired
  `[SS-ORPHAN] selfStake is non-zero but the creator holds no lender slot` at CRITICAL,
  family → `VIOLATION`, `critical:1`.
- Negative control: a V6.1 marketplace produced **zero** `SELFSTAKE` lines — the family
  degrades silently rather than throwing, exactly as documented.

*Caveat worth recording:* two of the family's four assertions are **tautological against the
current V6.2 bytecode**. `SS-UNLOCKED` (`v6-invariants.js:490-492`) asserts
`outstandingPrincipal > 0 ⇒ locked`, but `selfStake()` (`AgentLiquidityMarketplaceV62.sol:916-920`)
*derives* `locked` from `outstandingPrincipal > 0`. `SS-MISMATCH` (494–496) compares
`selfStake.amount` against `creatorPosition.amount`, and both read the same
`positions[agentId][agentAddress]` slot. They are forward-guards against a future contract
change, not live detectors. **Today's detection value in this family is `SS-ORPHAN` and
`SS-SHORT` only** — both confirmed to fire.

#### Live defect found in monitoring: a permanent CRITICAL alert storm

All three monitors are exiting 1 every 30 minutes and paging CRITICAL twice per run — not for
any invariant reason, but because of the sibling dead-man's switch at `v6-invariants.js:808-819`:

```json
{"severity":"CRITICAL","title":"MONITOR_DOWN: a sibling invariant monitor stopped running",
 "network":"arc-mainnet","details":{"stale":[{"network":"arc-testnet",
 "lastRun":"2026-09-23T01:22:13.998Z","ageSec":8453,"maxAgeSec":5400}]}}
{"severity":"CRITICAL","title":"invariant monitor exited 1 on arc-mainnet with no alert of its own (crash?)"}
```

Commit `af2f5ae` deliberately unloaded the arc-testnet v4 job ("superseded twice, protecting
nothing") by renaming its plist to `com.specular.v6-invariants.plist.disabled` — but left
`forensics/monitor/heartbeat-arc-testnet.json` on disk, frozen at 2026-09-23T01:22:13Z.
`alerts.checkHeartbeats()` has treated it as a dead monitor ever since. Every surviving job
(arc-mainnet, arc-mainnet-legacy, arc-staging) now raises 2 CRITICALs every 30 minutes,
forever, about a monitor that was retired on purpose.

The invariant checks themselves are unaffected and passing (`findings: 0`). The damage is
alert fatigue: that same commit's message says *"A monitor that cries wolf is one people stop
reading."* **Fix: delete `forensics/monitor/heartbeat-arc-testnet.json`.** Not in my owned
paths — listed in §2.

### §5.4 — Update `CLAUDE.md`, `src/config/chains.json`, memory · **VERIFIED (chains.json) / FIXED (CLAUDE.md)**

`src/config/chains.json` `arc-mainnet` is correct and current:

> `"description": "Circle Arc L1 mainnet (live 2026-09-16). Specular V7 (MarketplaceV6.2 + ReputationManagerV4) since 2026-09-23. …"`
> `"status": "production"`, `chainId: 5042`, `usdc.address: 0x3600…0000`, `decimals: 6`, `type: "native"`.

`CLAUDE.md` was **partly** updated — the network table row was correct, but four other places
still described mainnet as the V6.1/V3 generation. Fixed in this pass; see §2.

### §5.5 — Faucet: it points at the registry, not the marketplace, so it keeps working · **VERIFIED**

**Yes, the faucet works against the V7 stack, and a claim would succeed.** This is structural,
not incidental: `AgentCreditFaucet.sol` imports only `AgentRegistryV2` and `IERC20`. It holds
no reference to any marketplace or reputation manager, and the source comment at line 25 says
so explicitly ("No interaction with V6"). The registry was reused, so nothing it depends on moved.

Live wiring confirmed:

```
faucet.agentRegistry     = 0x6F1EbF50290f6D4A9947E9EB77f98a683684fBF5   (== the reused registry)
faucet.usdcToken         = 0x3600000000000000000000000000000000000000   (== canonical USDC)
faucet.owner             = 0x800e305A0caDdE6289dFDFEDF38218f45C06F72C   (secure wallet)
faucet.claimAmount       = 1.000000 USDC
faucet.maxEligibleAgentId= 100
faucet.balance           = 19.000000 USDC   (19 claims of head-room)
faucet.totalGranted      = 1.000000 USDC
```

Storage layout cross-checked directly: slot 2 = `0xf4240` (1,000,000 = claimAmount),
slot 3 = `0x64` (100 = maxEligibleAgentId), slot 6 = `0xf4240` (totalGranted).

**Proof that a claim would succeed, obtained with zero spend.** Three `eth_call` simulations:

1. From a non-agent address → reverts `"Not a registered agent"`. Registry lookup is live.
2. From agent #1's address (`0x800e305A…`) → reverts `"Already claimed"`. This is the decisive
   negative: the call passes `agentId != 0`, passes `agentId <= maxEligibleAgentId`, and is
   stopped **only** by the per-agent dedup. The registry resolution and eligibility gate both
   work against the V7-era chain state.
3. State-override `eth_call` zeroing `claimed[1]` (slot `keccak(abi.encode(1,4))`) and
   `claimedByAddress[0x800e305A…]` (slot `keccak(abi.encode(addr,5))`):
   **returns `0x…f4240` = 1.000000 USDC.** The full claim path executes to completion,
   including the `balanceOf >= amount` check and the `safeTransfer`.

**Who can claim:** any address that (a) holds an agent NFT with `1 <= agentId <= 100`,
(b) has not claimed under that agentId, and (c) has never claimed from that address
(`claimedByAddress`, the M-3 Sybil fix). **Who cannot:** agent #1 / the secure wallet —
`claimed(1) = true`, `claimedByAddress(0x800e305A…) = true`, `isEligible(1) = false`.

**Practical note:** `registry.totalAgents = 1`, and that one agent has already claimed. So the
faucet is functional but currently has **no eligible claimant**. The first genuinely new agent
(#2) will be paid 1 USDC. Nothing needs to be done to the faucet for V7.

---

## 2. Config and doc integrity

### (a) Live-pointer bugs — an address or key a client/operator would actually use

| file:line | Problem | Owned? |
|---|---|---|
| `backend/config/networks.js:37` | `reputation: '0x1577Eb99…'` under `'arc-mainnet'` — superseded V3 | not mine |
| `backend/config/networks.js:38` | `marketplace: '0x358c5E69…' // V6.1` — superseded | not mine |
| `CLAUDE.md:124-125` | `V6_MONITOR_MARKETPLACE_KEY=agentLiquidityMarketplace_v61_legacy` — **that key does not exist** in `src/config/arc-mainnet-addresses.json`. `v6-invariants.js:106-107` would resolve `undefined` → `process.exit(2)` → `run-with-alert.sh` pages on every run while monitoring nothing. | **FIXED** |
| `scripts/deploy-v7.js:133` | prints the same non-existent `_KEY` as post-deploy operator guidance | not mine |
| `src/config/arc-mainnet-addresses.json:29` | `"v7Note": "… Legacy contracts remain live under *_legacy keys."` — this file has no `*_legacy` key; the pair is at `agentLiquidityMarketplacePrevious` / `reputationManagerPrevious` and in `supersededDeployments[]` | not mine |

`backend/config/networks.js` carries its own header (lines 5–11) saying it is not the source of
truth and nothing imports it. That is mitigation, not a fix — the file now contains exactly the
stale-pointer failure its header warns about.

Latent, not yet broken: `src/config/arc-mainnet-addresses.json:6` has key `reputationManagerV3`
holding the **V4** address. Safe for `mcp-server/src/networks.ts:257`
(`reputationManagerV4 || reputationManagerV3`), but `src/integrations/crewai/specular_credit_tool.py:124`
and `src/integrations/langchain/SpecularCreditTool-original.js:100` read that key **and load the
V3 ABI**, so any V4-only selector is invisible to them.

### (b) Stale prose describing mainnet as the older generation

| file:line | Problem | Owned? |
|---|---|---|
| `CLAUDE.md:40` | whole bullet presents RegistryV2 + **ReputationV3 `0x1577Eb99…`** + **Marketplace V6.1 `0x358c5E69…`** as the Arc-mainnet deployment, contradicting the table two lines above | **FIXED** |
| `CLAUDE.md:48` | "No auth token set (open, per-IP rate-limited)" — wrong since commit `fe94781`; the hosted server now requires a bearer token | **FIXED** |
| `CLAUDE.md:114` | "the superseded V6.1 stack is under `*_legacy` keys" — true for staging, false for mainnet | **FIXED** |
| `CLAUDE.md:222` | heading "### V3 defaults (`ReputationManagerV3` — Base mainnet, **Arc mainnet**)" — Arc mainnet is V4/V7 | **FIXED** |
| `mcp-server/README.md:40` | table row `arc-mainnet | Arc mainnet, **V6.1**` | not mine |
| `mcp-server/src/chain.ts:105` | comment "the current Arc deployments are V6.1/V3 — nothing may assume V6.2/V4" — both Arc networks are V6.2/V4 now. Comment only; the runtime capability probe below it is dynamic and correct. | not mine |
| `docs/integrations/REMOTE_MCP.md:85` | lists V6.1-only tools but omits the V6.2-only `required_self_stake` / `get_self_stake`. Under V7 the self-stake gate is the thing that blocks an integrator's borrow. | **FIXED** |
| `docs/integrations/REMOTE_MCP.md:74` | calls `arc-staging` "V6-staging stack"; `mcp-server/README.md:38` now says "V6.2 / V7 stack" | **FIXED** |
| `src/sdk/CONTRACT_SOURCE_AUDIT.md:240` | "the reputation tier score >= 800 → 50,000 USDC is reachable on Arc" as present tense | not mine |
| `test/sdk-robustness/python/test_python_v7.py:195` | docstring says "Base mainnet and Arc mainnet are here today" re: no self-stake gate. The **assertion is still correct** (V6.1 ⇏ V6.2) — only the network list in the prose is wrong. | not mine |

### (c) Hardcoded credit limits that should now read from chain

The live on-chain tier table on ReputationManagerV4 (`MAX_TIER_LIMIT = 10,000 USDC`, immutable):

| tier | minScore | limit | collateral % | interest bps |
|---|---|---|---|---|
| 0 | 0 | 1,000 | 100 | 1500 |
| 1 | 200 | 5,000 | 100 | 1500 |
| 2 | 400 | 10,000 | 100 | 1000 |
| 3 | 500 | 10,000 | 75 | 1000 |
| 4 | 600 | **2,500** | 0 | 700 |
| 5 | 800 | **5,000** | 0 | 500 |

The 0 %-collateral tiers are capped at 2,500 / 5,000 — **not** 25,000 / 50,000. Anything still
publishing the old numbers as the live model is wrong by a factor of ten.

| file:line | Problem | Owned? |
|---|---|---|
| `CLAUDE.md:228-229` | `800–999 → 50,000 USDC` / `600–799 → 25,000 USDC` under a heading that named Arc mainnet. Contradicts `CLAUDE.md:101-102` ("read them from the contract, never hardcode 25k/50k") in the same file. | **FIXED** (heading re-scoped to Base) |
| `docs/integrations/REMOTE_MCP.md:147` | "loans capped at 50,000 USDC" presented bare. `mcp-server/README.md:183` and `mcp-server/src/validate.ts:53-67` are careful to call this an offline transport sanity bound, **not** a credit limit. | **FIXED** |
| `README.md:113-116` | pre-V7 fixed ladder as "how the protocol works"; no Arc-mainnet claim attached | not mine |

Correct and needing no action: `src/x402/CreditAssessmentServer.js:95`
(`autoApproveMaxUsdc … || 50000`) is an operator auto-approve ceiling, already documented at
lines 93–94 as deferring to `calculateCreditLimit()`. The whole x402 layer is
**arc-testnet-only** (`CreditAssessmentServer.js:82-87`, `x402Client.js:41,248-249`) and has no
Arc-mainnet pointer to be wrong about.

Low-priority pre-V7 marketing/report files repeating 25k/50k (none claims Arc mainnet):
`REPUTATION_JOURNEY.md:39,40,52,58,64,201,202,282,301`, `FOR_AI_AGENTS_ENHANCED.md:147,148`,
`DEPLOYMENT_COMPLETE.md:97,98,185`, `API_TEST_RESULTS.md:61,91,96`,
`BASE_SEPOLIA_FINAL_SUMMARY.md:97,98`, `SOCIAL_MEDIA_POSTS.md:468`, `MOLTBOOK_POST.md:9`,
`ARC_TO_BASE_MIGRATION_CAMPAIGN.md:250`, `CURRENT_USERS_FEB26.md:28,35`,
`EXTREME_LOAD_TESTING_FINAL_REPORT_2026-02-20.md:330`, `ARC_REAL_TESTING_REPORT_2026-04-26.md:7,58`.

### (d) Correct as-is — no action

`src/config/arc-mainnet-addresses.json:13,18,19,24,25` (properly structured supersession records
with the `note` at :21 explaining why V6.1 is left running); the explicitly-labelled
`source: 'v3-constant'` fallbacks in `mcp-server/src/reads.ts:133-134`,
`python/specular/client.py:877-879`, `mcp-server/src/validate.ts:70,77` — these are the right
pattern, reachable only on a genuine V3 deployment; `test/sdk-robustness/python/test_python_v7.py:348-365`,
which asserts the V3 numbers must *not* appear on V4 and is the regression guard for exactly
this class of bug; and all Base/Arbitrum/testnet addresses and historical forensics reports.

---

## 3. Live service agreement — **FAILED**

Endpoint: `https://specular-agent-api-production.up.railway.app`, reports `version 2.1.0`.

### Open endpoints · **VERIFIED**

| Endpoint | No token | Result |
|---|---|---|
| `/health` | `200` | full JSON body, both networks `ok: true`, `stale: false` |
| `/openapi.json` | `200` | full spec, 29 paths |
| `/mcp` | `401` | correctly rejected without a bearer token |

Auth with the `SPECULAR_MCP_TOKEN` bearer succeeds; `tools/list` returns **25 tools**, including
`required_self_stake` and `get_self_stake`. The token was read from `.env` and never printed.

### Does it report arc-mainnet as the V6.2 generation? · **NO — FAILED**

`GET /v1/arc-mainnet/status`:

```json
"marketplace": "0x358c5E69f712A4b3558333090a45A054bAeEb282",
"capabilities": { "marketplaceVersion": "V6.1", "reputationVersion": "V3",
                  "v61": true, "v62": false, "reputationV4": false }
```

### Does it serve the tier table from chain? · **NO — FAILED**

```json
"creditTiers": { "source": "v3-constant", "reputationVersion": "V3", "maxTierLimitUsdc": null,
                 "tiers": [ … 1000 / 5000 / 10000 / … ] }
```

Compare `GET /v1/arc-staging/status`, same server, same build:

```json
"capabilities": { "marketplaceVersion": "V6.2", "reputationVersion": "V4",
                  "v61": true, "v62": true, "reputationV4": true },
"creditTiersSource": "chain", "maxTierLimit": "10000.0"
```

### Does it expose the self-stake read tools there? · **NO — FAILED**

```
GET /v1/arc-mainnet/agents/1/self-stake            → 400
GET /v1/arc-mainnet/agents/1/required-self-stake   → 400
"get_self_stake is not supported on this deployment: the arc-mainnet marketplace
 0x358c5E69f712A4b3558333090a45A054bAeEb282 reports version V6.1 (requires V6.2 or later)."
```

The error message is excellent — it refuses rather than returning a misleading zero. It is
simply firing against the wrong contract.

### Do its addresses match `src/config/arc-mainnet-addresses.json`? · **NO — FAILED**

| Key | Served by API | Repo config (HEAD, clean) |
|---|---|---|
| `marketplace` | `0x358c5E69…` | `0xCb23f2fb…` |
| `reputation` | `0x1577Eb99…` | `0x12953e73…` |
| `registry` | `0x6F1EbF50…` | `0x6F1EbF50…` ✓ |
| `usdc` | `0x3600…0000` | `0x3600…0000` ✓ |

The API even labels its own source `"addressSource": "src/config/arc-mainnet-addresses.json"`.

### Root cause — and it is *not* a repo bug

`src/config/arc-mainnet-addresses.json` is committed at HEAD (`af2f5ae`) and clean
(`git diff HEAD` empty), and already carries `agentLiquidityMarketplace_v62` /
`reputationManagerV4`. `mcp-server/src/networks.ts:253,257` at HEAD already prefers those keys:

```ts
const marketplace = json.agentLiquidityMarketplace_v62 || json.agentLiquidityMarketplace_v6 || json.agentLiquidityMarketplace;
reputation: ethers.getAddress(json.reputationManagerV4 || json.reputationManagerV3),
```

That preference landed in `10c1720`, which the running container **does** have — arc-staging
correctly reports V6.2/V4. `findConfigFile()` (`networks.ts:104-111`) falls back to a
`mcp-server/config/` copy baked into the image, and `mcp-server/config/` does not exist in the
repo. So the deployed image carries a **config snapshot taken between `10c1720` and `af2f5ae`**.

**The hosted service has simply not been redeployed since the V7 mainnet migration.**
There is nothing to fix in the source tree. **Redeploy the Railway service from HEAD.**

### Client-visible consequence

`GET /v1/arc-mainnet/agents/0x800e305A…/credit` returns `"creditLimitUsdc": "1000.0"`.
The chain says `r4.creditLimitOf(1) = 100.000000 USDC`. **The API is overstating an agent's
credit line by 10×.** An agent that trusts it will build a `requestLoan` for up to 1,000 USDC
against a contract that reverts `"Exceeds credit limit"` above 100 — and it will do so against
the *superseded* marketplace, where the reputation it earns accrues to V3 and is invisible to V7.

---

## 4. The pre-migration agent's experience

Agent #1 is the secure wallet's own (`registry.addressToAgentId(0x800e305A…) = 1`,
`ownerOf(1) = 0x800e305A…`, `totalAgents = 1`).

### What carried over, and what did not

| Dimension | Superseded stack (V6.1 + V3) | V7 stack (V6.2 + V4) | Changed? |
|---|---|---|---|
| Agent NFT / agentId | #1, owner `0x800e305A…` | **same** — registry reused | **No** |
| `agentURI` / active | `ipfs://specular-arc-mainnet-smoke`, active | **same contract** | **No** |
| Reputation score | `r3.getReputationScore(1) = 0` | `r4.getReputationScore(1) = 0` | No (both 0) |
| `initialized` flag | — | `r4.initialized(1) = **false**` | **Reset** |
| Loan history | `r3.loanCount(1) = 5` | `r4.loanCount(1) = 1` | **Reset** |
| Credit limit | 1,000 USDC (V3 tier constant) | **100 USDC** (`min(tierLimit 1000, ladderLimit 100)`) | **−90 %** |
| Collateral | 100 % | 100 % | No |
| Interest | 1500 bps | 1500 bps | No |
| Pool | exists, creator `0x800e305A…`, 0 liquidity | exists, creator `0x800e305A…`, 0 liquidity | Re-created |
| USDC allowance | 0 | **0** | Must re-approve |
| Self-stake | n/a | `(0, false)`, `required = 0` | New, inert at tier 0 |

**The headline: the credit limit fell from 1,000 to 100 USDC**, and *not* because reputation was
lost. Agent #1 was score 0 on V3 too. It fell because V7 adds the M1 ladder on top of the tier
table: `creditLimitOf = min(tierLimit(score), ladderLimit)` where
`ladderLimit = creditMultiple·maxRepaidPrincipal + growthStep`, floored at `bootstrapLimit`.
With `maxRepaidPrincipal = 0`, the ladder pins every fresh agent at `bootstrapLimit = 100 USDC`
regardless of tier. Live: `r4.ladderLimit(1) = 100.000000`, `r4.creditLimitOf(1) = 100.000000`.
This is the model working as designed, but it is a 10× cut that no agent will anticipate.

### Is anything stranded on the old contract? · **No**

```
old pool#1:  total=0.000000  available=0.000000  loaned=0.000000  earned=0.001424  lenderCount=0
old poolLenders[1]:        empty
old getLenderPosition(1, secure): amount 0, earnedInterest 0
old loan 1: 0.500000 USDC, collateral 0.500000, state=REPAID
old activeLoanCount(1) = 0,  outstandingPrincipal(1) = 0
old accumulatedFees = 0.000014  ==  old usdcBalance = 0.000014
allowance secure → old marketplace = 0.000000
```

Every lender position is zero, the one loan is REPAID, no collateral is held, and the contract's
entire USDC balance is its own accumulated protocol fee. **Nothing belonging to an agent or a
lender is stranded.** Same for the earlier retired V6.0 `0xb9996de0…`: paused, 0 balance,
0 fees, `repV3.authorizedPools[…] = false`.

### The silent surprise: a repaid loan that earned nothing

V7 loan #1 was borrowed at `start = 1790126128` and repaid at `repaidAt = 1790126133` —
**5 seconds later**, on time, with interest paid. It still produced **zero** reputation:
`r4.getReputationScore(1) = 0`, `r4.maxRepaidPrincipal(1) = 0`, so the ladder did not advance.

That is correct behaviour, and worth stating plainly because it will surprise people.
`AgentLiquidityMarketplaceV62.sol:1047-1051`:

```solidity
bool onTime = block.timestamp <= loan.endTime;
bool heldLongEnough = minHoldForReputationReward == 0
    || (block.timestamp - loan.startTime) >= minHoldForReputationReward;
reputationManager.recordLoanCompletion(holder, loanId, loan.amount,
    onTime && heldLongEnough && paidInterest, lateSeconds);
```

Mainnet `minHoldForReputationReward = 86400`. A loan held 5 s fails `heldLongEnough`, so `onTime`
arrives at V4 as `false`; V4 then skips both the ladder advance and the bonus
(`ReputationManagerV4.sol:461-499`). No penalty either, since `lateSeconds = 0`. This is the
anti-farming lever doing its job — **a loan must be held ≥ 24 h and repaid on time to count.**

### Can a pre-migration agent operate normally on V7 today?

**Yes — but not without acting first. Nothing migrated automatically except its identity.**

Mandatory, in order:

1. **Re-approve USDC to the new marketplace.** Allowance to `0xCb23f2fb…` is **0**. Allowances
   are per-spender; the old approval is worthless. SDK approvals are exact-amount, so this is
   per-operation.
2. **Create a pool on the new marketplace.** `agentPools` is per-contract state and does not
   migrate. `requestLoan` reverts `"No pool for agent"` without it. (Agent #1 already has one
   on V7 — created during the smoke test — but a general pre-migration agent will not.)
3. **Supply liquidity to its own pool.** `bindBorrowToPoolCreator = true` on mainnet, so
   borrowing is restricted to the pool creator and `amount <= pool.availableLiquidity`.
   `minSupplyAmount = 10 USDC`, though V6.2 deliberately exempts the pool creator from that floor.

Strongly recommended:

4. **Call `initializeReputation()` on ReputationManagerV4** — `initialized(1)` is `false`. It
   sets the score to `INITIAL_SCORE = 100`. It does **not** change today's credit limit (tier 0
   runs 0–199, and the ladder pins the limit at 100 USDC either way), but it is a free 100-point
   head start toward tier 1 at score 200, and the rate limit is only 5 pts/day.

Expectations to reset:

5. **Budget for 100 USDC of credit, not 1,000.** And expect the hosted API to disagree until it
   is redeployed (§3).
6. **Hold each loan ≥ 24 h.** Otherwise it builds no reputation at all.
7. **Ignore self-stake for now.** `requiredSelfStake` is 0 at 100 % collateral and stays 0 until
   score 600, which is ≥ 120 days away at 5 pts/day.
8. **Anything still on the old marketplace stays claimable** — it is unpaused on purpose. Call
   `claimInterest` / `withdrawLiquidity` there, not on V7.

---

## 5. Superseded-stack hygiene — **VERIFIED. Not retired.**

**Is it still monitored?** Yes. `com.specular.v6-invariants-arc-mainnet-legacy`, every 1800 s,
`V6_MONITOR_MARKETPLACE=0x358c5E69f712A4b3558333090a45A054bAeEb282`, last run 2026-09-23T03:46Z.
Two caveats, neither fatal:

- Both mainnet jobs run with `V6_MONITOR_NETWORK=arc-mainnet`, so they share one log
  (`v6-invariants-arc-mainnet.log`), one `state-arc-mainnet.json` and one
  `heartbeat-arc-mainnet.json`. They interleave and clobber each other's state. The log does
  record which marketplace each snapshot covers (164 records for `0x358c5E69…`, 7 for
  `0xCb23f2fb…`), so history is recoverable, but the heartbeat cannot distinguish them — if the
  legacy job died, the canonical job's heartbeat would keep the pair looking alive.
- Both are drowning in the `MONITOR_DOWN` storm described in §1.

**Does it hold anything?** Effectively no. USDC balance `0.000014`, which is **exactly**
`accumulatedFees = 0.000014`. Zero lender positions, zero pool liquidity, `poolLenders[1]` empty.

**Does it have open loans?** No. `activeLoanCount(1) = 0`, `getActiveLoanIds(1) = []`,
`outstandingPrincipal(1) = 0`. Its only loan, #1 (0.5 USDC), is `REPAID`.

**Under what exact conditions may it be retired?** Per runbook §6, only when it holds nothing
beyond its own `accumulatedFees` **and** has zero ACTIVE loans. **Both conditions are already
met.** The retirement sequence, when the owner chooses to run it, is:

```
withdrawFees(accumulatedFees)          # 14 base units
→ pause()
→ reputationManagerV3.revokePool(0x358c5E69f712A4b3558333090a45A054bAeEb282)
```

**Not performed.** Beyond the explicit instruction not to, two things argue for waiting:
runbook §8 makes the rollback path depend on this contract being live and unpaused, and the
hosted API is still routing every `arc-mainnet` caller to it (§3). **Retiring it before the
Railway redeploy would take the live agent surface down.** Order matters: redeploy the API
first, confirm it serves `0xCb23f2fb…`, then consider retirement. Precondition to re-check at
that time: still zero active loans and no third-party lender has supplied in the interim.

For completeness, the earlier V6.0 `0xb9996de05fD514A0cB2B81fa25448EECD4559Aaa` is **fully and
correctly retired**: `paused = true`, USDC balance 0, `accumulatedFees` 0, owner = secure wallet,
`repV3.authorizedPools[…] = false`.

### §5b — supersession record

`supersededDeployments` exists and contains the `0x358c5E69…` entry with `supersededAt`,
`version` and a `note` explaining why it is left running. The list has one entry; the earlier
V6.0 retirement predates the append convention and is recorded separately as
`agentLiquidityMarketplace_v6_0_retired`. Both addresses are therefore still nameable, and both
have (or had) a monitor. **The §5b failure mode — an address you cannot name — has not recurred.**
The `v7Note` at line 29 claiming `*_legacy` keys is wrong and is listed in §2(a).

---

## 6. Spend log

| # | Action | Tx hash | Cost |
|---|---|---|---|
| — | *(none)* | — | — |

**Total USDC spent: 0.000000 of the 2.00 authorised.** No transaction was signed or broadcast on
Arc mainnet, Arc testnet, Base, or any other real network. All mainnet evidence is `eth_call`,
`eth_getStorageAt`, `eth_getCode`, `eth_getBalance` and `eth_blockNumber`. The one call that
mutates state in simulation — the faucet `claim()` — was run as an `eth_call` with a
`stateDiff` override, which is discarded by the node. The local-chain work in §1 ran against
hardhat chainId 31337 with throwaway keys.

---

## 7. Still open, in priority order

1. **CRITICAL — redeploy the hosted Railway service from HEAD.** It serves the superseded V6.1
   marketplace on `arc-mainnet`, reports V6.1/V3, serves `v3-constant` tiers instead of chain
   tiers, 400s the self-stake tools, and **overstates agent credit 10×** (1,000 vs 100 USDC).
   No code change needed; the repo is already correct. Verify after redeploy:
   `/v1/arc-mainnet/status` → `marketplace: 0xCb23f2fb…`, `v62: true`, `reputationV4: true`,
   `creditTiers.source: "chain"`, `maxTierLimitUsdc: "10000.0"`, and
   `/v1/arc-mainnet/agents/1/self-stake` → 200.
2. **HIGH — stop the monitor alert storm.** Delete `forensics/monitor/heartbeat-arc-testnet.json`.
   Three jobs are each raising 2 CRITICALs every 30 minutes about a monitor that was
   deliberately unloaded in `af2f5ae`. Real findings will be lost in the noise.
3. **HIGH — fix the two live stale pointers in `backend/config/networks.js:37-38`**, or delete
   the `arc-mainnet` block. Its own header says nothing imports it; that makes deletion cheap
   and leaving it wrong pointless.
4. **MEDIUM — fix the non-existent monitor key in `scripts/deploy-v7.js:133`**
   (`V6_MONITOR_MARKETPLACE_KEY=agentLiquidityMarketplace_v61_legacy` → the address form). As
   printed, the next V7 deploy hands the operator an instruction that produces a permanently
   alerting job monitoring nothing.
5. **MEDIUM — give the two mainnet monitor jobs separate log/state/heartbeat identities.** They
   currently share all three, so the legacy job's liveness is not independently observable.
6. **MEDIUM — correct `src/config/arc-mainnet-addresses.json:29`** (`v7Note` cites `*_legacy`
   keys this file does not have), and consider unifying the three supersession naming
   conventions now in use across the config files.
7. **MEDIUM — record §5.2's two V7 paths as an accepted gap, not a pending task.** They are
   unreachable on mainnet for ≥120 days by the D1 rate limit. Coverage exists on staging and
   locally. Leaving them on the checklist implies work that cannot be done.
8. **LOW — `mcp-server/README.md:40`, `mcp-server/src/chain.ts:105`,
   `src/sdk/CONTRACT_SOURCE_AUDIT.md:240`, `test/sdk-robustness/python/test_python_v7.py:195`**:
   prose calling Arc mainnet V6.1/V3. No behavioural impact; `chain.ts`'s runtime probe is
   dynamic and correct.
9. **LOW — `src/integrations/crewai/specular_credit_tool.py:124` and
   `src/integrations/langchain/SpecularCreditTool-original.js:100`** read the
   `reputationManagerV3` key (which now holds the V4 address) while loading the **V3 ABI**.
   Works today; silently blind to every V4-only selector.
10. **LOW — consider `SS-UNLOCKED` / `SS-MISMATCH`.** Both are tautological against current
    V6.2 bytecode. Keep them as forward-guards, but do not count them as live detection.

### Unchanged from the runbook's §7, and still true

Residual attacker EV remains positive (~24 %/yr) — **F-04 is priced, not closed**, and must not
be described as fixed. Single owner EOA, no multisig or timelock, remains the largest structural
risk. No external audit of V6.1, V6.2 or V4; Gate 1 of `ARC_MAINNET_DEPLOY_PREP.md` is open by
owner decision.

---

## Appendix — reproduction

```bash
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"

# Sourcify (§1.1)
curl -s https://sourcify.dev/server/v2/contract/5042/0xCb23f2fb03Bfd4775Cc0e76E28f64c1e545071be

# Hosted service (§3) — token from .env, never echoed
curl -s -H "Authorization: Bearer $SPECULAR_MCP_TOKEN" \
  https://specular-agent-api-production.up.railway.app/v1/arc-mainnet/status

# Monitor self-stake family against a local chain that has a self-stake pool (§1.3)
npx hardhat node &
npx hardhat run --network localhost <setup-local-v7.js>   # writes src/config/local-addresses.json
V6_MONITOR_NETWORK=local node forensics/monitor/v6-invariants.js --no-alert

# Superseded-marketplace monitor, as actually configured
V6_MONITOR_NETWORK=arc-mainnet \
V6_MONITOR_MARKETPLACE=0x358c5E69f712A4b3558333090a45A054bAeEb282 \
  node forensics/monitor/v6-invariants.js
```

Faucet `claim()` state-override simulation (§1.5), slots
`keccak256(abi.encode(1, 4))` = `claimed[1]` and
`keccak256(abi.encode(0x800e305A…, 5))` = `claimedByAddress[…]`, both overridden to zero:

```js
await provider.send('eth_call', [
  { to: FAUCET, from: SECURE, data: iface.encodeFunctionData('claim', []) },
  'latest',
  { [FAUCET]: { stateDiff: { [slotClaimed1]: ZERO, [slotClaimedAddr]: ZERO } } },
]);
// => 0x00000000000000000000000000000000000000000000000000000000000f4240  (1.000000 USDC)
```
