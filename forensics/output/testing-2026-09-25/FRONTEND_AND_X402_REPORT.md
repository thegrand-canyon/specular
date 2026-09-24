# Frontend & x402 — first test pass

**Date:** 2026-09-24/25 · **Branch:** `main` · **Scope:** the web frontend and the x402 payment layer, neither of which had been exercised before in this testing programme.

**Rules observed:** no transactions on Arc mainnet or Base — every chain interaction in this report is `eth_call`/`getCode` only. `contracts/` untouched. Throwaway keys generated per run, never funded, never written to the repo.

---

## 0. Headline

**Yes — the public site currently shows incorrect information.**

Three specific things, in descending order of harm:

1. **`specular.financial` publishes a dead contract address for Base mainnet.** Under *05 Infrastructure → Base Mainnet → LiquidityMarketplace* it lists `0xd7b4dEE74C61844DFA75aEbe224e4635463b1C8f`. Verified on Base this session: that contract has `paused = true`. It is the **archived v4** — the one with the §B1/§S1 bugs, deliberately paused on 2026-05-17. The canonical marketplace is `0x0a4e3C745aB95aceb45B05C28D89fe4Db8815F9a` (`paused = false`). A reader who trusts the site and approves USDC to the published address is approving a paused, known-buggy contract.

2. **Every credit number on the site is fiction.** "Max Borrow $50k", "2.9% to 10.9%", "Collateral 150%", "100–200%", "score 500" on registration. The live V7 tier table on Arc mainnet says: hard ceiling **10,000 USDC** (`MAX_TIER_LIMIT`), rates **5–15 %**, collateral **0–100 %**, initial score **0**, and a brand-new agent's actual `calculateCreditLimit()` is **100 USDC**. The site overstates the maximum credit line by 5× against the tier cap and by 500× against what a new agent actually gets.

3. **Arc mainnet — the live production network since 2026-09-19 — does not appear on the site at all**, and the REST API the site advertises (`api.specular.network`) **does not resolve** (NXDOMAIN).

Separately, the two deployed sites disagree with each other: `specular.financial` is a static marketing page built from code **not in this repo**, while `specular.vercel.app` is this repo's `frontend/` Vite app pointed at **Base Sepolia**.

**The 2026-07 x402 fixes all still hold** (21/21 regression tests green, plus live re-verification). But the audit's **M1 fix was never applied to `SpecularX402Server`**, and a previously-unfound bug means the x402 paywall **cannot actually collect payment on any real USDC network**. Details in §5–§7.

---

## 1. Inventory

### 1.1 Frontend — what exists

`CLAUDE.md` names `public/app.html` and a root `index.html`. **Neither exists**, on disk or in git history. The current surfaces are:

| Path | Tracked | What it is | Served where |
|---|---|---|---|
| `frontend/index.html` + `frontend/src/` | yes | Vite + React app, Base Sepolia | **`specular.vercel.app`** (confirmed byte-identical head) |
| `frontend/dashboard.html` | yes | 87 KB self-contained mockup, zero chain access | not served publicly |
| `frontend/leaderboard.html` + `js/leaderboard.js` | yes | Arc testnet reputation table | not served publicly |
| `frontend/status.html` | yes | live protocol status, reads chain directly | not served publicly |
| `frontend/js/` (router, pages/, wallet, siwa) | yes | a second, separate SPA — **has no entry HTML** | dead code |
| `frontend/build.html`, `get-started.html` | yes | both load `/src/get-started-main.jsx` | via `frontend/vercel.json` rewrites |
| `landing/`, `dashboard/` | **untracked** | older standalone prototypes | not served |
| *(not in this repo)* | — | the 140 KB static page actually at `specular.financial` | **`specular.financial`** |

Root `vercel.json` routes `/(.*)` to `src/api/MultiNetworkAPI.js` — i.e. the repo-root Vercel project is the API, not a site.

**The live marketing site's source is not in this repository.** `grep` for its copy ("Where capital meets autonomy") returns nothing across the tree. Whatever is deployed to `specular.financial` is maintained somewhere else, which is why it has drifted from `src/config/*.json`.

### 1.2 x402 — what exists

Two independent implementations:

| Path | Role | Keys | Moves money |
|---|---|---|---|
| `src/x402/CreditAssessmentServer.js` | HTTP 402 paywall over a credit assessment, EIP-3009 | `SERVER_PRIVATE_KEY` (optional settlement signer) | yes — broadcasts `transferWithAuthorization` |
| `src/x402/x402Client.js` | buyer side: handles 402, signs EIP-3009 | caller's wallet | yes — signs transfer authorizations |
| `src/sdk/x402/SpecularX402Server.js` | seller middleware that auto-supplies revenue into a Specular pool | `SELLER_KEY` **or `PRIVATE_KEY`** | yes — real USDC, default network **Base mainnet** |
| `src/sdk/x402/SpecularX402Client.js` | viem/x402 buyer wrapper | caller's wallet | yes |

---

## 2. User-visible values vs chain truth

All rows verified this session against the named chain (read-only). Script: `verify-frontend-addresses.js`.

### 2.1 Addresses on the live `specular.financial`

| Shown as | Address | On-chain result | Verdict |
|---|---|---|---|
| Base · AgentRegistryV2 | `0xb9996de0…59Aaa` | code, `owner`=secure, `totalAgents`=7 | **correct** |
| Base · ReputationManagerV3 | `0xf19b1780…B0527` | code, `owner`=secure | **correct** |
| Base · **LiquidityMarketplace** | `0xd7b4dEE7…b1C8f` | code, **`paused = true`** — archived v4 | **WRONG** — canonical is `0x0a4e3C74…815F9a` (`paused = false`) |
| Base · USDC | `0x833589fC…02913` | Circle USDC | correct |
| Arbitrum One · Registry | `0x6F1EbF50…84fBF5` | code, unpaused, `totalAgents`=0 | correct (matches `arbitrum-addresses.json`) |
| Arbitrum One · ReputationV3 | `0x1577Eb99…DFaE5e` | code, `owner`=secure | correct |
| Arbitrum One · Marketplace | `0xb9996de0…59Aaa` | code, unpaused | correct |
| Arbitrum One · USDC | `0xaf88d065…e5831` | Circle USDC | correct |
| Arc Testnet · all four | `0x741C03c0…`, `0x94F2fa47…`, `0x048363A3…`, `0xf2807051…` | all have code, marketplace unpaused | correct |
| **Arc Mainnet · anything** | — | — | **MISSING** — the live production stack is absent |

> Note for the record: the Arbitrum block *looks* like it carries Arc-mainnet addresses, because the same deployer at the same nonces produced identical CREATE addresses on both chains. It is genuinely Arbitrum and it is correct. The only wrong address on the site is the Base marketplace.

### 2.2 Credit model on the live site vs the V7 chain

Chain truth read live from Arc mainnet `ReputationManagerV4` `0x12953e73…2ac4FB` (script: `read-v7-tiers.js`):

```
MAX_TIER_LIMIT = 10,000 USDC
tier 0  score>=  0 | limit  1,000 | collateral 100% | 15%
tier 1  score>=200 | limit  5,000 | collateral 100% | 15%
tier 2  score>=400 | limit 10,000 | collateral 100% | 10%
tier 3  score>=500 | limit 10,000 | collateral  75% | 10%
tier 4  score>=600 | limit  2,500 | collateral   0% |  7%
tier 5  score>=800 | limit  5,000 | collateral   0% |  5%
```

| Claim on `specular.financial` | Chain (V7, Arc mainnet) | Verdict |
|---|---|---|
| "Max Borrow **$50k**" | ceiling is **10,000 USDC**; 5,000 at the top tier; a new agent gets **100** | **WRONG** |
| "Rates **2.9 % to 10.9 %**" | **5 % – 15 %** | **WRONG** |
| "Collateral **150 %**" / "**100–200 %**" | **0 % – 100 %** | **WRONG** |
| "score **500**" on registration | initial score **0** | **WRONG** |
| "Score 1000 · 2.9 % APR · 100 % collateral" | no 1000 tier; 800+ is 5 % / 0 % | **WRONG** |
| "Pool utilization 78 %", "4.28 % APY", "Yield earned 42.80 USDC" | page makes **zero** network calls — all hardcoded | **fabricated, labelled "live"** |
| Collateral menu: wstETH, WBTC, T-Bills, Stocks, Commodities, LP tokens | protocol takes **USDC only** | **WRONG** |
| `api.specular.network` REST endpoints | **NXDOMAIN** | **dead** |

The homepage is 100 % static: no `fetch`, no RPC URL, no `window.ethereum`, no ethers (verified in-page). The "agent.specular **live**" badge, the score, the rate and the loan counters are all copy.

> `CLAUDE.md`'s own tier table is stale too — it still lists 50,000 / 25,000 limits and five tiers. It should be regenerated from `ReputationManagerV4`.

### 2.3 Addresses in repo frontend code

| File | Value | Verdict |
|---|---|---|
| `frontend/src/config.js` | 4 Base Sepolia addresses | **all four have code** — correct |
| `frontend/src/components/GetStarted.jsx` | Base / Arc-testnet / Arbitrum blocks | **correct** (Base points at canonical V6) — but **no Arc mainnet entry** |
| `frontend/status.html` | Base V6, Arc testnet V6 | correct; **Arc mainnet absent** (now added, §4) |
| `frontend/js/config.js` | Arc testnet v4 stack | correct for Arc testnet |
| `frontend/js/leaderboard.js` | registry `0xF72AdE17…83CDE0` | **WRONG — no code at that address on Arc testnet, and a bad EIP-55 checksum**; marketplace `0xD1cf6E78…927559` is the deprecated v3 |

---

## 3. Does it work? Console and network findings

Pages opened in Chrome; console and network read directly.

| Page | Finding | Severity |
|---|---|---|
| `specular.financial` | **no page errors** (only MetaMask extension noise). All 33 links resolve — whitepaper, brand kit, GitHub, X, all three explorers all HTTP 200. | clean |
| `specular.financial` | advertises `api.specular.network` — **NXDOMAIN**, every documented REST endpoint unreachable | **HIGH** |
| `specular.vercel.app` | loads clean, no page errors. Base Sepolia only. Wallet connect present; not exercised (no transactions). | ok |
| `frontend/dashboard.html` | **`SyntaxError: missing ) after argument list` at line 592.** The whole inline `<script>` fails to parse, so **every function is undefined and every button on the page is dead.** Confirmed: `typeof window.goA === 'undefined'`; clicking "Deploy an Agent" throws `ReferenceError: goA is not defined`. | **CRITICAL** (total page failure) |
| `frontend/dashboard.html` | Docs panel lists four contracts that **do not exist in this protocol**: `SpecularIdentity 0x7a2F…e4B1`, `SpecularPool 0x3cD8…91aF` ("ERC-4626 vault"), `SpecularLending 0xb5E2…c7D3`, `SpecularCollateral 0x9fA1…28eC` | **HIGH** (fabricated) |
| `frontend/leaderboard.html` | **`TypeError: bad address checksum`** on load → page shows "Failed to load leaderboard" **always**. Address also has **no code** on Arc testnet. | **CRITICAL** |
| `frontend/leaderboard.html` | `agents(uint256)` ABI is a 5-field shape; the deployed `AgentRegistryV2` returns 6 (`owner` missing, string in the wrong slot) → `BAD_DATA` on **every** agent, zero rows | **HIGH** |
| `frontend/leaderboard.html` | walks all 189 agents × 6 sequential `eth_call` + 150 ms sleep — minutes of spinner, worse as the registry grows | MEDIUM |
| `frontend/status.html` | **Base Mainnet panel failed on every load** — `missing revert data … CALL_EXCEPTION`. Reproduced 6/6 in-page. Root cause: default ethers JSON-RPC batching; `mainnet.base.org` rejects the 8-call batch. With `batchMaxCount: 1` all 8 values return. | **HIGH** |
| `frontend/status.html` | one `Promise.all` — a single unavailable getter blanked the entire panel | MEDIUM |
| `frontend/status.html` | no Arc mainnet panel | MEDIUM |
| `frontend/js/pages/borrow.js`, `pool-detail.js` | render `${Number(interestRate)}% APR` where the contract returns **basis points** → displays **"1500% APR"** instead of 15 %. `borrow.js` also divided by `100n` instead of `10000n`, overstating quoted interest **100×**. | **HIGH** |
| `frontend/js/api.js` | `DEFAULT_BASE = 'http://localhost:3001'` — the SPA's API client points at localhost | MEDIUM (dead SPA anyway) |
| `frontend/js/` SPA | has no entry HTML anywhere in the repo — unreachable code | MEDIUM |
| `specular.financial/get-started` | instructs `npm install @specular/sdk` and `npx @specular/sdk generate-wallet`. **`@specular/sdk` is not published** — npm registry returns `{"error":"Not found"}`. Also imports `{ Specular }`, a symbol the repo SDK does not export, and links the paused Base v4 again. | **HIGH** — the public quickstart cannot work |

Accessibility/responsiveness: nothing structurally broken found; not redesigned, per brief.

---

## 4. Frontend fixes applied (each verified in-browser)

| Fix | File | Verification |
|---|---|---|
| Missing `+` that broke the whole dashboard script (`…'2px');transform:` → `…'2px')+';transform:`) | `frontend/dashboard.html:592` | `node --check` on the extracted script passes; in-browser all 16 handlers now `typeof === 'function'`; clicking "Deploy an Agent" advances to "Set Up Your Agent" |
| Repointed leaderboard at the real Arc testnet registry/marketplace | `frontend/js/leaderboard.js` | checksum error gone |
| Corrected `agents(uint256)` ABI to the deployed 6-field shape | `frontend/js/leaderboard.js` | `BAD_DATA` gone; page renders real data — 50 agents, 913 loans, top score 950 |
| Bounded the agent scan (most recent 50) + truthful "showing #N–#M of T" note; registry total no longer misreported as the window size | `frontend/js/leaderboard.js`, `frontend/leaderboard.html` | completes instead of spinning |
| `batchMaxCount: 1` + `staticNetwork` on the status provider | `frontend/status.html` | Base panel returns all 8 values (was 6/6 failures) |
| `Promise.allSettled` + a 12 s per-call deadline; missing values render `n/a` | `frontend/status.html` | panel degrades gracefully instead of blanking or hanging forever |
| Added the **Arc Mainnet** panel | `frontend/status.html` | renders live: V6.2 `0xCb23f2fb…5071be`, LIVE, migration finalized, 1 agent / 1 pool / 1 loan, faucet 19 USDC |
| basis-points → percent in both rate renderers; `10000n` annualiser | `frontend/js/pages/borrow.js`, `pool-detail.js` | `calculateInterestRate()` returns `1500` on every live V3/V4 deployment checked (Base, Base Sepolia, Arc testnet, Arc mainnet); now renders `15.00% APR` |

`frontend/src/App.jsx` was checked and is **not** affected — it already divides by 100 at `setInterestRate`.

Deliberately **not** changed: adding Arc mainnet to `GetStarted.jsx`. That component sends transactions, and wiring a mainnet write path is an owner decision, not a test-pass fix. Flagged in §8 instead.

---

## 5. x402 — end-to-end flow and every failure path

Harness: `x402-e2e-harness.js` → `x402-e2e-results.json`. Boots the real `CreditAssessmentServer` twice (shipped defaults → Arc testnet V3; explicitly pointed at V7 → Arc mainnet V4, read-only), drives the real `x402Client` and hand-built `X-PAYMENT` headers.

**Final: 32 PASS / 0 FAIL / 6 NOTE.**

| # | Path | Result |
|---|---|---|
| 1 | `GET /health` | 200 |
| 2 | unpaid request | **402** with `accepts[0]`, `X-402-Version: 1`, correct amount/payTo/asset |
| 3 | malformed header — not base64, base64-of-non-JSON, empty, JSON array | all **402** |
| 4 | wrong scheme (`exact`) | 402 "Unsupported scheme" |
| 5 | wrong network (`base` vs `arc-testnet`) | 402 "Wrong network" |
| 6 | missing EIP-3009 fields | 402 |
| 7 | payment to an attacker address | 402 "must go to fee recipient" |
| 8 | underpaid (0.999999 of 1 USDC) | 402 "Insufficient payment" |
| 9 | zero-value payment | 402 |
| 10 | expired (`validBefore` in the past) | 402 "expired" |
| 11 | not yet valid (`validAfter` in the future) | 402 "not yet valid" |
| 12 | value tampered after signing | 402 "signature invalid" |
| 13 | garbage `r` | 402 |
| 14 | signed by a different wallet than `from` | 402 |
| 15 | signed against the wrong token (`verifyingContract`) | 402 |
| 16 | signed against the wrong `chainId` | 402 |
| 17 | **valid payment** | **200**, assessment returned |
| 18 | replay same nonce | 402 "already used (replay)" |
| 19 | replay **after a server restart** | 402 — file-backed nonce store holds |
| 20 | `x402Client.get()` full 402 → sign → retry → 200 | works |
| 21 | invalid agent address | **400** (was 404 — fixed, §7) |
| 22 | unknown route | 404 |

**NOTEs (behaviour worth knowing, not fixed):**

- **Overpay is accepted.** The server only checks `value >= feeAmount`; a 50 USDC authorization for a 1 USDC quote is honoured. The buyer-side cap is the real protection.
- **The payload's `validBefore` is not bound to the quote.** The 402 advertises `maxTimeoutSeconds: 300`, but a client can sign a one-year window and the server accepts it.
- **Signature-only mode serves an unfunded payer.** With no settlement signer the server proves *authorization*, not *collectability* — a wallet holding 0 USDC gets the resource. Correct for dev; dangerous if ever run that way in production. (Now partly mitigated — see §7.)

---

## 6. Re-verification of the 2026-07 SDK/x402 fixes

`npx mocha test/sdk/*.test.js --timeout 15000` → **76 passing, 0 failing**. (At the suite's default 2 s timeout, 3 `SpecularQuickstart` polling tests time out; unrelated to anything here — they pass with a realistic budget.) x402 subset: **21/21**.

| 2026-07 finding | Still holds? | Evidence |
|---|---|---|
| **F1 — default 10 USDC per-payment cap** | **YES** | live: server quoting 11 USDC → client refuses, `payment 11 USDC exceeds maxPayment 10 USDC`. Plus 12/12 unit tests. |
| **F1 — `verifyingContract` pin (token substitution)** | **YES** | live: server quoting an unknown token → `refusing to sign — verifyingContract … is not the known USDC for arc-testnet`. Also blocked via `asset` and via a server-supplied `eip712Domain`. |
| **F1 — `maxTotalSpend`, one authorization per request** | **YES** | unit tests pass; a server that keeps returning 402 gets exactly one signed authorization. |
| **F4 — stub mode requires opt-in** | **YES** | `SpecularX402Server` refuses `mode:'stub'` without `{allowStub:true}` or `SPECULAR_X402_ALLOW_STUB=1`. 3/3 tests. |
| **F5 — resource derived from configured `baseUrl`, not the client `Host`** | **YES** | 2/2 tests. |
| **F6 — `/__specular_x402/stats` gated** | **YES** | loopback-only without a token; with `SPECULAR_X402_STATS_TOKEN` requires the Bearer and ignores IP. 3/3 tests. |
| **flush re-entrancy (`while`, not `if`)** | **YES** | `while (this._flushInFlight)` present; race test collapses N concurrent flushes to one supply. |
| **M2 — no `MaxUint256` approvals** | **YES** | no `MaxUint256` anywhere in the SDK approval paths; exact just-in-time approvals + `revokeApproval()`. |
| **M1 — config resolved from `__dirname`, not CWD** | **NO — incomplete** | `SpecularQuickstart` has `REPO_ROOT`. **`SpecularX402Server` did not.** See below. |

### M1 regression — proven, then fixed

`SpecularX402Server` loaded `'./src/config/base-addresses.json'` **relative to the process CWD**. Demonstrated by running it from a scratch directory containing a poisoned `./src/config/base-addresses.json`:

```
CWD  = …/hostile
addresses loaded by the server: {"usdc":"0xAAAA…0003","agentLiquidityMarketplace":"0xAAAA…0004", …}
M1 REGRESSION: hostile CWD config was used
```

This matters more here than in `Quickstart`: this server **holds a hot key** (`SELLER_KEY`, falling back to **`PRIVATE_KEY`** — the production deployer key) and **auto-supplies real USDC**, with `network` defaulting to **Base mainnet**. Fixed with `REPO_ROOT = path.resolve(__dirname, '..','..','..')`; re-run of the same exploit now loads the real Circle USDC address and ignores the hostile CWD.

---

## 7. x402 against the V7 / 2026-09 changes

### 7.1 Does it read the chain or stale constants?

**It reads the chain.** Against Arc mainnet `ReputationManagerV4`, the assessment matched direct `eth_call` reads **exactly**:

```
chain truth  score=0 limit=100 USDC coll=100% rate=15%
x402 body    score=0 limit=100 USDC coll=100% rate=15.00% APR
```

`creditLimitRaw` `100000000` == chain, `interestRateBps` `1500` == chain, `collateralRequired` `100%` == chain. The bps→percent conversion in x402 is **correct** (`/100`) — it is the *frontend* that had this wrong.

**The 50,000 hardcode at `CreditAssessmentServer.js:382` reported by the cross-generation round has been fixed** — it is now `cfg.autoApproveMaxUsdc`, env-overridable via `CREDIT_AUTO_APPROVE_MAX_USDC`, and carries a comment saying the tier table is on-chain and owner-settable. Two caveats remain (both NOTEd, not fixed): the **default is still 50,000**, which is 5× V7's immutable `MAX_TIER_LIMIT` of 10,000, so `autoApproveEligible` is effectively always true; and `loanTerms.minDurationDays: 7` / `maxDurationDays: 365` are still hardcoded.

The tier *labels* (`PRIME`/`STANDARD`/`SUBPRIME`/`HIGH_RISK`/`UNRATED`) use 800/600/400/200 buckets. V7's on-chain `TIER_MIN_SCORE` is `0/200/400/500/600/800` — there is no 500 bucket in the x402 taxonomy, so a score-500 agent (75 % collateral on V7) is labelled `SUBPRIME`, same as a score-400 agent (100 % collateral). This is the service's own risk language rather than a copy of the protocol's table, so it is a labelling drift, not a wrong number.

### 7.2 New bug found: the paywall cannot actually collect

`_paymentRequirements` quoted a **hardcoded** EIP-712 domain of `{ name: 'USD Coin', version: '1' }`. That matches **no real USDC deployment**:

| Token | Real `name` / `version` | Quoted domain separator vs on-chain |
|---|---|---|
| Base USDC `0x833589fC…` | `"USD Coin"` / **`"2"`** | **MISMATCH** |
| Arc mainnet USDC `0x36000000…` | **`"USDC"`** / **`"2"`** | **MISMATCH** |

Consequence: every authorization a client signs against the quoted domain is **unsettleable** — `transferWithAuthorization` reverts on an invalid signature. And the server never noticed, because when settlement failed it fell back to **local signature verification using the same wrong domain**, which passes. Net effect on any real network: **the paywall serves the resource and collects nothing**, silently, forever.

Two fixes applied:

1. **`_tokenDomain()`** reads `name()`/`version()` off the token, caches them, and where the token exposes `DOMAIN_SEPARATOR()` verifies the reconstruction against it (loud `console.error` on mismatch). Used by both the 402 quote and signature verification. Overridable via `X402_TOKEN_NAME` / `X402_TOKEN_VERSION`.
   *Verified live:* against Arc mainnet USDC the server now quotes `{"name":"USDC","version":"2"}` and `hashDomain` == on-chain `0x940506929bba…` exactly.
2. **Failed settlement is now fatal** when a settlement signer is configured — it returns `402 "Payment could not be settled on-chain"` instead of serving for free. The legacy behaviour is available behind `allowSigOnlyFallback` / `X402_ALLOW_SIG_ONLY_FALLBACK=1` for tokens with no EIP-3009.

Also fixed in the same pass:
- `/credit/<malformed>` returned **404** (the route regex only matched a well-formed address, so the `ethers.isAddress` guard was dead code) → now **400**.
- The 402 `description` hardcoded `"(1 USDC)"` regardless of the configured fee → now interpolates it.
- `protocol: 'Specular Protocol v3'` / `dataSource: 'on-chain (ReputationManagerV3)'` were **factually wrong** when pointed at V4 → now report the actual reputation-manager address plus `network`, claiming no generation they cannot know.

Regression test added: **`test/sdk/x402-credit-server-domain.test.js`, 8 tests, all passing** — covers the resolved domain, acceptance of a correctly-signed payment, **rejection of one signed against the old `USD Coin`/`1` domain**, fail-closed settlement, the explicit opt-out, the 400, the fee description, and the absence of the stale "ReputationManagerV3" string.

### 7.3 x402 cannot operate on Arc mainnet at all

- `x402Client.KNOWN_USDC` has entries for `base`, `arc-testnet`, `base-sepolia` — **no `arc-mainnet`**. The client fails closed ("no known USDC to pin `verifyingContract` against"), which is the right default but means it is unusable on the live production network.
- `SpecularX402Server.NETWORKS` has `base`, `arc`, `arc-staging` — **no `arc-mainnet`** entry either.

So the payment layer has simply not been migrated to the network that went live on 2026-09-19. Left unchanged deliberately: adding Arc mainnet here enables real-money signing on mainnet and is an owner decision.

---

## 8. Real-money exposure in x402

| Component | Holds keys | Grants allowances | Moves USDC | Network |
|---|---|---|---|---|
| `CreditAssessmentServer` | `SERVER_PRIVATE_KEY` (optional) | no | **yes** — broadcasts `transferWithAuthorization` to pull the fee | whatever `chainId`/`usdcAddress` is configured; **defaults to Arc testnet** |
| `x402Client` | caller's wallet | **no** — EIP-3009, never `approve()` | signs transfer authorizations, **default cap 10 USDC per payment**, optional lifetime cap, token pinned | per `KNOWN_USDC` |
| `SpecularX402Server` | `SELLER_KEY` **or `PRIVATE_KEY`** | via `SpecularQuickstart.supply()` (exact approvals since 2026-07) | **yes** — auto-supplies accumulated revenue into a Specular pool | **defaults to `base` = Base mainnet** |
| `SpecularX402Client` | caller's wallet | via x402/viem | yes, `maxPayment` default 10 USDC | base / base-sepolia |

Three things worth the owner's attention:

1. **`SpecularX402Server` defaults to Base mainnet and falls back to `process.env.PRIVATE_KEY`.** Constructed with no `network` and no `privateKey`, it will use the production deployer key on Base mainnet. That combination should require an explicit opt-in, not be the default.
2. Until the §6 fix, that same component resolved its address config from the process CWD — attacker-controllable in an untrusted workspace.
3. `.x402-nonces.json` (used EIP-3009 nonces) **is tracked in git** and not gitignored. Not a vulnerability, but deployment state does not belong in the repo, and a fresh clone ships with a pre-seeded nonce set.

---

## 9. Prioritised list of what is wrong

### P0 — public site shows incorrect information (owner action; source is outside this repo)
1. Base `LiquidityMarketplace` on `specular.financial` → change `0xd7b4dEE7…b1C8f` (paused v4) to `0x0a4e3C74…815F9a`.
2. Replace the invented credit model ($50k / 2.9–10.9 % / 150 % collateral / score 500) with the on-chain V7 table, or label it unambiguously as illustrative. Today it reads as product fact.
3. Remove or fix the `api.specular.network` section — the host does not resolve.
4. Publish `@specular/sdk` to npm or rewrite `/get-started`; the advertised quickstart cannot run, and it imports a symbol (`Specular`) the SDK does not export.
5. Add Arc mainnet; it is the live production network and the site does not mention it.

### P1 — fixed in this pass, needs review + deploy
6. `dashboard.html` syntax error — whole page was dead. **Fixed.**
7. `leaderboard.html` — phantom/bad-checksum registry + wrong `agents()` ABI. **Fixed**, now renders real data.
8. `status.html` — Base panel failed on every load (RPC batching). **Fixed**, plus resilience and an Arc mainnet panel.
9. Basis-points rendered as percent → "1500% APR", and interest overstated 100×. **Fixed** in `borrow.js` / `pool-detail.js`.
10. x402 quoted an EIP-712 domain matching no real USDC — **the paywall could not collect on any real network**. **Fixed** + 8 regression tests.
11. x402 settlement failure silently served the resource for free. **Fixed** (fail-closed by default).
12. M1 CWD config poisoning in `SpecularX402Server`. **Fixed**, exploit re-run confirms.

### P2 — known, not fixed (owner decisions)
13. `SpecularX402Server` defaults: Base mainnet + `PRIVATE_KEY` fallback. Make both explicit.
14. x402 has no `arc-mainnet` entry in either `KNOWN_USDC` or `NETWORKS` — unusable on the live network.
15. `CREDIT_AUTO_APPROVE_MAX_USDC` default 50,000 is 5× V7's `MAX_TIER_LIMIT`; x402 tier buckets omit V7's 500 tier; `loanTerms` durations hardcoded.
16. Overpay accepted without an upper bound; payload `validBefore` not bound to the quoted `maxTimeoutSeconds`.
17. `dashboard.html` Docs panel lists four **fabricated** contracts (`SpecularIdentity`/`SpecularPool`/`SpecularLending`/`SpecularCollateral`). Whole page is a mockup with no chain access — label it or wire it up.
18. `frontend/js/` is a complete SPA with **no entry HTML** and an API client pointed at `localhost:3001`. Delete it or give it a page.
19. Two live sites disagree (`specular.financial` static/marketing vs `specular.vercel.app` Base Sepolia React). Pick one.
20. `CLAUDE.md` is stale: names `public/app.html` and a root `index.html` that do not exist, and carries the pre-V7 tier table.
21. `.x402-nonces.json` tracked in git.
22. Base's public RPC (`mainnet.base.org`) throttles hard enough that even unbatched reads time out — a dedicated RPC endpoint is the real fix for `status.html`.

---

## 10. Artefacts

| File | What |
|---|---|
| `verify-frontend-addresses.js` | read-only on-chain verification of every user-visible address across Base / Arbitrum / Arc mainnet / Arc testnet |
| `read-v7-tiers.js` | dumps the live V7 tier table from Arc mainnet `ReputationManagerV4` |
| `verify-vercel-app-addresses.js` | Base Sepolia addresses used by `specular.vercel.app` |
| `x402-e2e-harness.js` | full x402 flow + failure-path harness (2 server configs, 38 checks) |
| `x402-e2e-results.json` | machine-readable results — 32 PASS / 0 FAIL / 6 NOTE |
| `test/sdk/x402-credit-server-domain.test.js` | 8 regression tests for the 2026-09-25 x402 fixes |

Files changed: `frontend/dashboard.html`, `frontend/js/leaderboard.js`, `frontend/leaderboard.html`, `frontend/status.html`, `frontend/js/pages/borrow.js`, `frontend/js/pages/pool-detail.js`, `src/x402/CreditAssessmentServer.js`, `src/sdk/x402/SpecularX402Server.js`. No `contracts/` changes. No transactions sent on any network.
