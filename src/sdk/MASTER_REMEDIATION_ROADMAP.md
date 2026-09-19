# Master Remediation Roadmap

**Purpose**: Single prioritized action list synthesizing every audit doc in
`src/sdk/`. One row = one concrete fix. Sort key is impact × probability,
not severity label.

**Scope**: Issues identified across 11 audit documents covering live
network probes, smart contract source, backend API, frontend, SDK,
documentation, and integration surfaces.

**Convention**: Tracks reference the source audit document and finding ID
(e.g., `S1` = `CONTRACT_SOURCE_AUDIT.md` §S1, `N6` =
`CROSS_NETWORK_AUDIT.md` §N6, `B3` = `BACKEND_AUDIT.md` §B3).

---

## §M0 — Tier-1 (block release / ship immediately)

| #   | Source | Component                           | Fix description                                                                              |
| --- | ------ | ----------------------------------- | -------------------------------------------------------------------------------------------- |
| 1   | S1     | `AgentLiquidityMarketplace.claimInterest` | Decrement `pool.availableLiquidity` by `interest` before token transfer.                |
| 2   | S2     | `AgentRegistryV2._update`           | In ERC-721 transfer hook, require `addressToAgentId[to] == 0` or wipe `agents[oldId].owner`. |
| 3   | B1     | `SyncWorker.fetchPool`              | Replace synthesized `totalLoaned` with `pool.totalLoaned` field directly.                    |
| 4   | B3     | `RequestLimiter.processRequest`     | Decrement counter via `res.on('finish'/'close')` instead of `res.end` override.              |
| 5   | N6+B5  | RPC provider config                 | Add fallback RPC URL list per network; consider re-enabling batching with try/fallback.      |

These five together close every HIGH-severity correctness bug found in
this audit pass. Items 1–2 require contract redeploy + ownership migration
(non-trivial); items 3–5 are pure backend changes deployable to Railway.

---

## §M1 — Tier-2 (next release; user-visible quality)

| #   | Source | Component                           | Fix                                                                                  |
| --- | ------ | ----------------------------------- | ------------------------------------------------------------------------------------ |
| 6   | B2     | `MultiNetworkAPI` manifest          | Either implement or remove `/loans`, `/leaderboard`, `/credit/*`, `/tx/*`, `/virtuals/*` from `/.well-known/specular.json`. |
| 7   | B4     | `SyncWorker.fetchAgent`             | Replace per-agent pool scan with single `getAgentPool(agentId)` call. ~12× RPC reduction. |
| 8   | B6     | `SyncWorker.syncNetwork` error path | Add exponential backoff + serve stale-but-flagged cache when 429 limits the sync.   |
| 9   | S3     | `repayLoan` `whenNotPaused`         | Remove `whenNotPaused` from `repayLoan` (and `claimInterest`); lock-up under owner pause is grief vector. |
| 10  | S4     | `requestLoan` credit check          | Replace per-loan credit check with cumulative active-loan exposure check.            |
| 11  | S5     | `requestLoan` activeness            | Verify `agentRegistry.agents(agentId).isActive` before disbursing.                   |
| 12  | S6     | `validationRegistry` external call  | Wrap in try/catch; if validationRegistry reverts, fall back to `score = 0`, not DOS. |
| 13  | B7     | API route limiter coverage          | Apply `requestLimiter` globally with allowlist exemptions for `/dashboard`, `/build`, `/`. |
| 14  | B9     | `backend/routes/virtuals.js`        | Delete the file (5 contract-ABI mismatches; never wired in).                         |
| 15  | DRIFT  | Arc bytecode `[H-01 FIX]` missing   | Decision: redeploy Arc with current source, or document the 600-wei dust as known.   |

---

## §M2 — Tier-3 (polish / observability)

| #   | Source | Component                           | Fix                                                                                  |
| --- | ------ | ----------------------------------- | ------------------------------------------------------------------------------------ |
| 16  | S7     | `calculateCreditLimit` score-0 default | Document or change: score 0 → 1 k USDC default may be permissive for new agents.  |
| 17  | S8     | `getActiveAgents()` always reverts  | Remove the function or implement it; it's dead weight in the ABI.                    |
| 18  | S9     | Owner-tunable scoring params        | Add 24-h timelock or remove the setters.                                             |
| 19  | S12    | `calculateCollateralRequirement`    | Fix score-band table: remove duplicate `>= 600 return 0` (shadowed); fill 400-499 gap. |
| 20  | B10    | `DEFAULT_NETWORK` ordering          | Hoist declaration above `validateNetwork` for readability.                           |
| 21  | B8     | `validateNetwork` mounting          | Switch to `app.param('network', ...)` for consistency.                               |
| 22  | B12    | `/stats` histograms                 | Add per-route p50/p95/p99 latency histograms; per-network sync-duration distribution. |
| 23  | B11    | Unused deps                         | Remove `helmet`, `express-rate-limit` from `package.json` — or actually use them.    |
| 24  | B13    | Read-only architecture docs         | Add an "API is read-only; clients sign their own tx" note to `README` and `/`.       |
| 25  | DOC    | `DOC_FABRICATION_AUDIT` items       | Strip every README claim of features that don't exist (Arbitrum support, etc.).      |

---

## §M3 — Documentation cleanup

Outside the issue tables above, several audit documents identified
documentation-vs-reality mismatches that should be resolved before any
external integration partner reads the repo:

- **`README.md`** — claims Arbitrum One support; per
  `arbitrum-addresses.json`, no contracts deployed (per `N11`).
- **`MOLTBOOK_INTEGRATION.md`** (if present) — verify every endpoint URL
  against §B2's table.
- **`SCHEMA.md` / `SCHEMA_VERIFICATION.md`** — re-verify after §M1 #6
  is resolved (manifest cleanup).
- **`VIRTUALS_SDK_AUDIT.md`** — mark `backend/routes/virtuals.js` as
  deleted (§M1 #14).

---

## §M4 — Decision points (require human judgment)

The following findings have multiple viable fixes; pick before
implementing:

1. **§M0 #1 (`claimInterest` leak) — Fix on which contract?**
   Arc v4 `0x0483...71D3` is owned and live; Arc v5_WITH_FIX
   `0x9EF0...7A2B` is deployed but unauthorized. Options: (a) deploy v6
   to both networks, (b) authorize the existing v5_WITH_FIX (assumes it
   already has the §S1 fix — verify), (c) accept the latent bug since
   `claimedSoFar = 0` today.

2. **§M0 #2 (NFT transfer orphan) — Block transfers entirely?**
   Easiest fix is to make `_update` revert if `to` already has an agent.
   But this prevents legit recovery scenarios. Alternative: allow
   transfer, wipe `addressToAgentId[to]` zero state pre-overwrite, emit
   an event so the receiver knows.

3. **§M0 #5 (RPC fallback) — Which provider list?**
   Need at least 2 providers per network. Candidates for Base: `mainnet.base.org`,
   `base.llamarpc.com`, Alchemy, QuickNode. For Arc: drpc + ?? (very few
   public RPCs). Decision: which providers, in what order, and is
   batching enabled or disabled per provider?

4. **§M1 #6 (manifest cleanup) — Implement or remove?**
   `/loans` and `/leaderboard` are reasonable to implement (cache layer
   already has the data). `/credit/:address` is computable from
   reputation contract. `/tx/*` requires either a signing service
   (security risk) or stays unimplemented (manifest must reflect this).

5. **§M1 #15 (Arc bytecode drift) — Redeploy?**
   600 wei of permanent dust on a single pool is below operational
   significance. Redeploy cost = ownership-migration ceremony +
   integration partner notification. Recommendation: document, don't
   redeploy, until other Tier-1 contract changes batch in.

---

## §M5 — Estimated impact summary

| Tier   | # items | Lines of code (estimate) | Risk if unaddressed                                  |
| ------ | ------- | ------------------------ | ---------------------------------------------------- |
| M0     | 5       | ~80 LOC + 1 redeploy     | Insolvency (S1) and grief (S2) latent today.         |
| M1     | 10      | ~200 LOC + 1 redeploy    | Degraded UX, unaddressable manifest claims.          |
| M2     | 10      | ~150 LOC                 | Polish; reduced ops visibility.                      |
| M3     | doc-only| ~0 LOC                   | External partner confusion; reputation risk.         |
| M4     | n/a     | n/a                      | Decisions needed before M0-M2 can ship.              |

---

## §M6 — Cross-reference to source audit docs

| Doc                            | What it covers                                                |
| ------------------------------ | ------------------------------------------------------------- |
| `CONTRACT_SOURCE_AUDIT.md`     | Solidity source review (3 contracts, S1-S13, 2 HIGH bugs)     |
| `CROSS_NETWORK_AUDIT.md`       | Live-probe findings, pool 43 deep-dive (N1-N13)               |
| `BACKEND_AUDIT.md`             | API server, cache, middleware (B1-B13, 3 HIGH bugs)           |
| `API_AUDIT.md`                 | Earlier API audit — superseded by `BACKEND_AUDIT.md`          |
| `FRONTEND_AUDIT.md`            | Frontend code quality                                         |
| `DRIFT_AUDIT.md`               | Source-vs-deployed bytecode drift (Arc H-01 missing)          |
| `DOC_FABRICATION_AUDIT.md`     | README/docs claims that don't match reality                   |
| `VIRTUALS_SDK_AUDIT.md`        | Virtuals integration assessment                               |
| `BORROWER_ALLOWANCE.md`        | USDC approval UX surface                                      |
| `OPTION2_FEASIBILITY.md`       | Integration architecture choice                               |
| `HYGIENE_NOTES.md`             | Minor cleanups                                                |
| `RECEIPT.md`                   | Proof-of-work artifact / signed audit summary                 |
| `SCHEMA.md` / `SCHEMA_VERIFICATION.md` | API response schemas                                  |

---

## §M7 — Method

This roadmap was assembled by:

1. Reviewing every `src/sdk/*AUDIT*.md` and related summary doc
2. Extracting each finding's severity scoreboard
3. Re-scoring against:
   - **Live impact today** (is anyone hitting the bug right now?)
   - **Probability of trip** (latent vs active)
   - **Blast radius** (one user vs whole protocol)
   - **Fix cost** (LOC, redeploy, ownership migration)
4. Stack-ranking and grouping into M0/M1/M2 tiers
5. Pulling forward the decision points in §M4 that gate implementation

The output is intentionally short. Detailed analysis stays in the source
audit docs; this file is the single navigable index.

---

**Recommended next step**: Resolve §M4 decisions, then implement §M0
items in order. §M1 can ship in parallel once §M0 contract changes are
scheduled.
