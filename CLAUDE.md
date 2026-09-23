# Specular Protocol

Credit infrastructure protocol for AI agents. Agents register, build reputation, and borrow USDC against tokenized collateral.

Website: specular.financial | GitHub: thegrand-canyon/specular | Deploy: specular.vercel.app (Vite + Railway API)

## Environment

- macOS, Homebrew at /opt/homebrew
- **Node 22 LTS required**: always prefix commands with `export PATH="/opt/homebrew/opt/node@22/bin:$PATH"`
- Hardhat 2.x with solc 0.8.20, optimizer on (200 runs, viaIR)
- Project root: ~/Specular

## Architecture

### Local Development Contracts (contracts/core/)

- `AgentRegistry.sol` — agent registration + metadata
- `ReputationManager.sol` — credit scoring 0–1000, affects interest rates and loan limits
- `LendingPool.sol` — loan lifecycle (request → approve → repay/default), interest calculation, collateral
- `MockUSDC.sol` — test token with 6 decimals (matches real USDC)
- **872 passing, 5 pending** — run with `npm test` (executed 2026-09-24, ~2 min; the long-standing "93/93" in this file predated the V6/V6.1/V6.2 suites)
- Deploy locally: `npm run node` (terminal 1) then `npm run deploy:local` (terminal 2)

### Production Contracts (deployed)

- `AgentLiquidityMarketplace.sol` — v4, the active canonical marketplace
- `AgentLiquidityMarketplaceV6.sol` — V6, surgical patch with §B1/§S1/§S5 fixes (NEW, deployed Arc only)
- Arc Testnet addresses: `src/config/arc-testnet-addresses.json`
- Base Mainnet addresses: `src/config/base-addresses.json`
- **Arc Testnet STAGING**: `src/config/arc-testnet-v6-addresses.json`. **Canonical today (read on-chain 2026-09-24): Marketplace V6.2 `0x7E4D144AbEB3C695Ec2DdF00Fc710aABC04bDd18` + ReputationManagerV4 `0xD7906fDFBf69BA89a4c2FE148797e24f386fE3d2`** (deployed 2026-09-22). RegistryV2 `0x4712A978A0EADe68f0b485b981112Ae66aA622d9`, Faucet `0x11D3e3A358D0Ef572260E33DAC66D0276EB97c57`, MockUSDC `0x9F3C10985998D1354D1465c5135Aa924775bd11D`. Owner = secure wallet on all of them, unpaused, `migrationFinalized=true`. **Live levers are the same as mainnet's: M-1 on, M-2=86400s, minSupply=10 USDC, rate limit 5/day, 1% fee, faucet cohort 100** — the old "F-C=1 USDC / rate-limit 20/day" figures are two generations stale. Read-only config check: `node scripts/smoke-test-arc-testnet-v6.js --read-only` (9 assertions, sends nothing). Superseded and still live: V6.0 `0xDbDf60AE…` (849.16 test USDC), V6.1 `0xB2d88bbF…` (482.24), V6.2-pre-scale-fix `0xa736EE7B…` (3,487.69) — see `supersededDeployments[]`; **none is monitored**. `ReputationV3 0x085D581FB…` belongs to the retired V6.0 generation. The older Arc-testnet V6 `0x7a05…` below predates all of this.

| Network | v4 (canonical) | V6 (with fixes) | Owner | Paused |
|---------|---------------|------------------|-------|--------|
| Arc Testnet | `0x048363A325A5B188b7FF157d725C5e329f0171D3` | `0x7a0560551b2370ee87458186c0b1eFCc38c7c57a` (post-WORLDCLASS audit, deployed 2026-05-17 — predates 2026-08 self-audit fixes) | `0x800e305A...F72C` (secure) | **No** |
| Arc Testnet **staging** | — | **`0x7E4D144AbEB3C695Ec2DdF00Fc710aABC04bDd18` (V6.2 CANONICAL + ReputationManagerV4 `0xD7906fDF…`, 2026-09-22)**; superseded & still live: `0xDbDf60AE…` (V6.0), `0xB2d88bbF…` (V6.1), `0xa736EE7B…` (V6.2 pre-scale-fix) | `0x800e305A...F72C` (secure) | **No** |
| Base Mainnet | `0x0a4e3C745aB95aceb45B05C28D89fe4Db8815F9a` (CANONICAL 2026-05-17 — V6, post-WORLDCLASS audit; **unmonitored**) | (v4 archived: `0xd7b4dEE74C61844DFA75aEbe224e4635463b1C8f`, paused) | `0x800e305A...F72C` (secure) | **No** |
| **Arc Mainnet** (chainId 5042) | — | **`0xCb23f2fb03Bfd4775Cc0e76E28f64c1e545071be` (V6.2 CANONICAL, V7 credit model, 2026-09-23)** with **ReputationManagerV4 `0x12953e732e5D1aFdA640554125367d1CEC2ac4FB`**; superseded: V6.1 `0x358c5E69…` (left running, monitored), V6.0 `0xb9996de0…` (retired) | `0x800e305A...F72C` (secure) | **No** |

- **Arc Mainnet (deployed 2026-09-19, migrated to V7 2026-09-23)**: `src/config/arc-mainnet-addresses.json`. RegistryV2 `0x6F1EbF50290f6D4A9947E9EB77f98a683684fBF5`, **ReputationManagerV4 `0x12953e732e5D1aFdA640554125367d1CEC2ac4FB`**, **Marketplace V6.2 `0xCb23f2fb03Bfd4775Cc0e76E28f64c1e545071be`** (CANONICAL, V7 credit model). Superseded but deliberately still live, unpaused and separately monitored: ReputationV3 `0x1577Eb9985CcA859F25ED2EDaeD16A464ADFaE5e` + Marketplace V6.1 `0x358c5E69f712A4b3558333090a45A054bAeEb282` — verified 2026-09-23 as holding nothing beyond its own 0.000014 USDC `accumulatedFees`, zero lender positions, zero active loans, so it already meets the §6 retirement preconditions (do NOT retire it before the hosted API is redeployed off it). Fully retired: V6.0 `0xb9996de05fD514A0cB2B81fa25448EECD4559Aaa` (paused, revoked, 0 balance). Faucet `0xD854F80031A8d0CB166587AafA0969Da8C3757bF` — **unaffected by the V7 migration** (it references only the registry, which was reused); claim path re-verified live 2026-09-23 by state-override `eth_call`. USDC = Arc native ERC-20 `0x3600000000000000000000000000000000000000` (6 dec; gas is the same USDC in its 18-dec native view). RPC `https://rpc.mainnet.arc.io`, explorer `https://explorer.arc.io`. Levers (tightened 2026-09-19 post-audit): M-1 on, M-2=86400s, **F-C minSupply=10 USDC, D1 rate-limit 5 pts/day**, 1% fee, faucet cohort 100, **claimAmount=1 USDC, faucet funded 20 USDC** (claim verified live; agent #1 = secure wallet already claimed). Smoke test: `scripts/smoke-test-arc-mainnet.js` (real USDC, tiny amounts). Deployed ahead of the runbook's Gate 1 external re-audit (owner decision 2026-09-19). **Internal audit 2026-09-19** (`forensics/output/audit-2026-09/INTERNAL_AUDIT_2026-09-19.md`) found F-01 HIGH (NFT transfer freezes loan) + F-04 HIGH (D1 economics) + 3 MEDIUM + 3 LOW; F-01/02/03/05/07 fixed in **V6.1** (source in repo, `VERSION()=="V6.1"`, pre-fix mainnet source at git tag `arc-mainnet-v6-deployed-2026-09-19`). **Mainnet redeployed to V6.1 on 2026-09-19** via `scripts/redeploy-marketplace-v6.1.js` (marketplace-only; old retired, migration finalized = F-08 closed). Sourcify exact_match; smoke 22/22; invariants OK. **Superseded by the V7 stack on 2026-09-23**; all levers above were re-applied and re-verified on the V6.2/V4 contracts (2026-09-23): `platformFeeRate=100`, `minSupplyAmount=10 USDC`, `bindBorrowToPoolCreator=true`, `minHoldForReputationReward=86400`, `maxReputationGainPerWindow=5` / `reputationGainWindow=86400`, `migrationFinalized=true`. The late-repay reputation penalty **now exists** in V4 (`latePenaltyBase=10`, `perDay=5`, `max=100`) and F-04 was answered by the M1+M2 model change — but **F-04 is priced, not closed** (residual attacker EV ~24 %/yr), so keep third-party lender exposure modest.

- Base stale marketplace: `0x77F8D49cdE6Ae7481BeA38C8a70b5A893bD4d9AF` — different owner, ignore. **Its USDC balance is 0.0, not the 60.5 recorded earlier** (read on Base mainnet 2026-09-24); it also does not answer the V6 ABI at all, so it is a different contract shape. Nothing to recover there.
- **⚠️ Base mainnet is NOT monitored.** `forensics/monitor/v6-invariants.js` has no `base` network (`arc-testnet | arc-staging | arc-mainnet | local` only) and no launchd job watches Base. The canonical Base V6 `0x0a4e3C74…` held **1.506031 USDC** across 4 pools with `accumulatedFees` 0.000054 on 2026-09-24 — small, but unwatched. `forensics/monitor/invariant-monitor.js` (the old multi-network daemon that did cover Base) is not running and is v4-era.
- Arc compromised wallet: `0x656086A21073272533c8A3f56A94c1f3D8BCFcE2` (key published; agentId 43, 777+ loans, USDC swept to secure wallet 2026-05-08)
- Base v4 deployed bytecode was compiled from a stash revision with MAX_LENDERS=50 (matches V6); committed v4 source has MAX_LENDERS=200

### Hosted agent surface (mcp-server/) — LIVE 2026-09-19

- **URL:** `https://specular-agent-api-production.up.railway.app` (Railway project `resplendent-determination`, service `specular-agent-api`, built from `mcp-server/Dockerfile` via `RAILWAY_DOCKERFILE_PATH`; the older `specular` service is the legacy Express API).
- MCP Streamable HTTP at `/mcp`, REST under `/v1/{network}/…`, `/openapi.json`, `/health`. Networks enabled: `arc-mainnet` (real USDC) + `arc-staging`. **Requires a bearer token** since 2026-09-22 (`fe94781`) — `SPECULAR_MCP_TOKEN` in `.env`; `/health` and `/openapi.json` stay open without one, `/mcp` and `/v1/…` return 401. Per-IP rate-limited.
- **✅ Deploy is current (re-checked live 2026-09-24).** The stale-container problem flagged on 2026-09-23 is resolved: `/v1/arc-mainnet/status` now reports `marketplace: 0xCb23f2fb…`, `capabilities.v62: true`, `reputationV4: true`, `creditTiers.source: "chain"`, `maxTierLimitUsdc: 10000`, `minSupplyUsdc: 10.0`, version `2.1.0`. Bearer auth confirmed live: `/health` 200 without a token, `/v1/arc-mainnet/status` **401** without one and 200 with `SPECULAR_MCP_TOKEN`. RPC failover is live (3 upstreams on arc-mainnet, 2 on arc-staging; `/rpc-health` is open and unauthenticated by design). **After any future redeploy of the contracts, re-check this endpoint** — a stale image silently overstates credit limits 10×.
- **Non-custodial:** reads run server-side; `prepare_*` return unsigned txs for the agent's own wallet; `broadcast_signed_transaction` relays only to Specular contracts. Server refuses to boot if `SPECULAR_PRIVATE_KEY` is set.
- Deploy: `RAILWAY_TOKEN` (project token, in `.env`) then `railway up --service specular-agent-api --ci` from repo root. Docs: `docs/integrations/{REMOTE_MCP,GROK_BOT,MUSE_CONNECTOR}.md`.

### SDK (src/)

- `SpecularAgent.js` — main agent interface (`new SpecularAgent(wallet, contracts)`)
- `ContractManager.js` — contract interaction layer, ABI loading
- `StateManager.js` — caching and state sync with TTL
- `EventListener.js` — WebSocket event monitoring
- Example: `examples/basic-agent.js`

### Frontend

- Dashboard: `public/app.html` — self-contained HTML file
- Homepage: `index.html` — V2 multi-asset collateral model with agent swarm animation
- Simple/Advanced mode toggle with separate UIs per mode
- Color system: orange (#FF6A00) for brand/primary, green for money, red for danger

### Owner key: single signer, accepted by the owner (2026-09-23)

Specular's contracts are controlled by one EOA, `0x800e305A0caDdE6289dFDFEDF38218f45C06F72C`.
**The owner has stated he is the signer of the contracts and is holding it that way** — this is
a recorded decision, not an oversight. What it means operationally, from the 2026-09-23 incident
drill (`forensics/output/testing-2026-09-23/INCIDENT_DRILL_REPORT.md`):

- Of 34 enumerated owner actions on V6.2 + V4, **29 succeed and only 6 are visible to
  monitoring**; a full hostile chain extracted 5,561 USDC in 35 txs while monitoring showed a
  single WARN up to 30 minutes later.
- `AgentLiquidityMarketplaceV62` and `ReputationManagerV4` override `renounceOwnership` to
  revert. **`AgentRegistryV2` and `AgentCreditFaucet` do not** — they are plain `Ownable`.
  The registry holds `deactivateAgent`, the per-agent kill switch the incident runbook
  recommends over `pause()`.
- The registry is deliberately never redeployed (it holds every agent NFT), so unlike F-04 this
  **cannot be fixed by shipping new contracts**. One `renounceOwnership()` on the registry —
  hostile or accidental — permanently destroys the kill switch with no recovery path.

Containment with a single key is a 6-tx ownership rotation, and only while the key is still
held. Hard bounds that survive a compromised key: `MAX_TIER_LIMIT` (10,000 USDC) is immutable,
and `migrationFinalized` is latched, so the seed/drain path is permanently closed.

## ⚠️ Current risk posture (2026-09-22) — READ BEFORE ENABLING LENDING

**Do NOT solicit third-party lender liquidity on any network, and do not hand the hosted
agent endpoint to an external platform, until the V7 credit model (M1+M2) ships.**

Why: F-04 is proven, on-chain and in simulation, to be unfixable by owner levers. Reputation
is gated by time, not cost. Across **all 40 viable lever configurations** the attacker's cost
stays pinned at `platformFeeRate/10000` of an honest agent's cost, capped at 5 % by the
contract's own 500 bps fee ceiling. Measured worst case: **25,000 USDC of lender money for
0.125 USDC** (200,642:1), and lenders **cannot withdraw** once a pool is drawn down. Confirmed
live on Arc staging: 59 loans took one agent from score 20 → 610 (0 % collateral, 25,000 limit)
for **0.149 USDC** of fees. The 2026-09-19 lever tightening bought 4× time and **zero** cost;
`minSupplyAmount` is a complete no-op against this attack, and M-1 does not (and structurally
cannot) stop Sybil fan-out — it only blocks a transferred agent NFT from borrowing.

Today's real exposure is **zero** (no third-party lenders, no TVL, faucet 19 USDC), which is
exactly why this is the cheapest moment to fix it. Fix = `ReputationManagerV4` + marketplace
changes; the tier limits are hardcoded and `reputationManager` is `immutable`, so it is a
fresh deploy of both (the registry and agent NFTs persist). See
`forensics/output/testing-2026-09-20/ECONOMIC_ATTACK_SIMULATION.md` §8.2/§8.3 and
`forensics/output/v7-model/`.

Honest framing from that analysis: an unsecured line to a pseudonymous agent can only be made
EV-negative by backing it with something the protocol can seize. Pick the parameters to
**price** the residual risk; do not claim it is zero.

### V7 credit model (the F-04 fix) — LIVE ON ARC MAINNET since 2026-09-23

`contracts/core/ReputationManagerV4.sol` + `contracts/core/AgentLiquidityMarketplaceV62.sol`
(`VERSION()=="V6.2"`). M1 = credit limit tracks demonstrated repaid volume
(`min(tierLimit, max(bootstrap, k·maxRepaidPrincipal + growthStep))`, k=2, growthStep 100 USDC,
setter reverts on 0 because k=1 provably deadlocks the ladder); M2 = the pool creator's own
stake is **locked while borrowing and is the first-loss tranche**. Tier limits are now
**on-chain and owner-settable** under an immutable `MAX_TIER_LIMIT` — read them from the
contract, never hardcode 25k/50k.

Measured vs V3: attacker capital as a share of the prize **0.8 % → 229.2 %**, steady-state
extraction **2,500 → 13.9 USDC/day**, lender loss per incident **49,982 → 2,431**.
**Residual attacker EV is still positive (~24 %/yr) — F-04 is PRICED, NOT CLOSED.** Honest
agents are slightly *slower and dearer*, not faster (an earlier claim to the contrary compared
two strategies rather than two models and was refuted on re-measurement).

- **Arc MAINNET (canonical, 2026-09-23):** ReputationManagerV4 `0x12953e732e5D1aFdA640554125367d1CEC2ac4FB`,
  MarketplaceV6.2 `0xCb23f2fb03Bfd4775Cc0e76E28f64c1e545071be`. Both Sourcify `exact_match`; smoke 21/21.
- **Arc staging (rehearsal, scale-fixed, 2026-09-22):** ReputationManagerV4 `0xD7906fDFBf69BA89a4c2FE148797e24f386fE3d2`,
  MarketplaceV6.2 `0x7E4D144AbEB3C695Ec2DdF00Fc710aABC04bDd18`. E2E 237/237. Live levers
  re-read 2026-09-24 and identical to mainnet's: minSupply 10 USDC, fee 100 bps, minHold 86400,
  M-1 on, rate limit 5/86400, migrationFinalized true.
- **Superseded stacks: `supersededDeployments[]` is the authority on BOTH networks.** Do not
  look for a `*_legacy` key — the only such key anywhere is staging's
  `agentLiquidityMarketplace_v6_0_legacy_still_live`, which names the **V6.0** contract, not the
  V6.1 one. `agentLiquidityMarketplacePrevious` / `reputationManagerPrevious` name the most
  recent superseded pair. A monitor must be pointed at a superseded stack **by address**
  (`V6_MONITOR_MARKETPLACE=0x…`); `V6_MONITOR_MARKETPLACE_KEY` naming a key that does not exist
  makes the monitor `exit(2)` and alert every cycle while watching nothing.
  - Arc mainnet: one superseded marketplace, `0x358c5E69…`, and it **is** monitored.
  - Arc staging: **three**, all unpaused and unmonitored, holding real test USDC (read
    2026-09-24): `0xDbDf60AE…` 849.16, `0xB2d88bbF…` 482.24, `0xa736EE7B…` 3,487.69.
- **Deploy:** `scripts/deploy-v7.js --network <arc-staging|arc-mainnet>` (dry run by default).
- **Migration plan:** `forensics/output/v7-model/V7_MAINNET_MIGRATION_RUNBOOK.md`.
- **⚠️ Reputation does NOT migrate** — V4 ships no seed helper on purpose (that is the F-08
  owner-drain shape). Every agent restarts at bootstrap. Mainnet holds 1 pool / 1 agent /
  0 third-party lenders today, so the migration is ~0.2 USDC and one test score. It only gets
  more expensive from here.
- **⚠️ Monitoring:** repointing the canonical key makes the monitor follow V7 and **stop
  watching the superseded marketplace**. A second job must watch it **by address** — there is no
  config key to resolve it by on mainnet, and `V6_MONITOR_MARKETPLACE_KEY=…_legacy` would resolve
  to `undefined` and `exit(2)` every run (`v6-invariants.js:106-107`), i.e. a permanently
  alerting job monitoring nothing:
  ```
  V6_MONITOR_NETWORK=arc-mainnet V6_MONITOR_MARKETPLACE=0x358c5E69f712A4b3558333090a45A054bAeEb282 \
    node forensics/monitor/v6-invariants.js
  ```
  This is live as launchd `com.specular.v6-invariants-arc-mainnet-legacy` (verified 2026-09-23).
- **⚠️ FIXED 2026-09-24 — the two mainnet jobs were cancelling `CP-CHANGED`.** Both used
  `V6_MONITOR_NETWORK=arc-mainnet` and therefore shared `state-arc-mainnet.json`. The legacy
  marketplace points at ReputationManagerV3, which has no on-chain tier table, so its run wrote
  `creditPolicy: null` — and it runs ~30 s **before** the canonical job on every cycle
  (confirmed in the log). The canonical run therefore never had a previous policy to compare
  against and **`CP-CHANGED` could never fire** — the single signal a hostile owner key reliably
  produces. Setting `V6_MONITOR_MARKETPLACE` now gives a run its own instance namespace
  (`state-<net>-<addr8>.json`, own log, own heartbeat), which also makes the legacy job's
  liveness independently observable in `alert.js --status`. **Re-check this after every future
  supersession.**
- **✅ Alert storm (closed):** `heartbeat-arc-testnet.json` has been deleted; `alert.js --status`
  shows only live jobs and no `MONITOR_DOWN` fires. Rule: **retiring a job means deleting its
  heartbeat file**, or the dead-man's switch alerts about it for ever.
- **⚠️ Every alert channel is local to this Mac.** `SPECULAR_ALERT_WEBHOOK` is unset and
  `forensics/monitor/monitor.env` does not exist, so alerts are a latch file, `~/SPECULAR-ALERT.txt`,
  a macOS banner and a spoken line. Verified end to end 2026-09-24 by forcing a real failure.

## Testing round 2026-09-20/21 (6 tracks) — `forensics/output/testing-2026-09-20/`

| Track | Headline |
|---|---|
| Contracts V6.1 | branch coverage 86.3→91.0 %, Foundry 6/6 over 768k calls, **mutation 17/17 killed**, `npm test` 698 passing |
| E2E on Arc staging | **186 assertions green**; F-01/F-02/F-07/F-08/M-1/M-2/D1/F-C all confirmed on a live chain |
| Economics | F-04 unfixable by levers (above); M1+M2 model change specified and simulated |
| Hosted server | 15 findings (4 High: relay bypass, unbounded upstream, **rate limiter keyed on the edge not the caller**, `ws` CVE) — all fixed, redeployed 2026-09-21 |
| Monitoring | old monitor caught **3 of 19** engineered violations; the §S5 check had been a **silent no-op since deploy** (keyed by wallet; V6.1 keys by agentId). Rewritten → 19/19, alerting, rotation. **15 check families defined today** (V6.2-SELFSTAKE and V7-CREDIT-POLICY were added after that round); a clean Arc-mainnet run emits **14** — observed 2026-09-24 |
| SDK | 20 findings (2 High: a transient RPC error poisoned V6.1 capability detection → late repay under-approves → **agent cannot close its loan and defaults**). Exact-approval verified across all 14 USDC-pulling paths; Python brought to parity |

Known-environmental: `test/api/tx-builder*` can fail when the Arc testnet public RPC
rate-limits this host (dRPC 429s us). Use `https://rpc.testnet.arc.io` or
`https://arc-testnet-rpc.publicnode.com`. Note `.env` still sets
`ARC_TESTNET_RPC_URL=https://arc-testnet.drpc.org`, so a shell that loads `.env` gets dRPC even
though every script now DEFAULTS to `rpc.testnet.arc.io`; the launchd staging job pins the good
endpoint in its plist. (Full suite ran clean on 2026-09-24: 872 passing, 0 failing.)

Operational: the three invariant monitors run `forensics/monitor/run-with-alert.sh` (alerts on
ANY non-zero exit incl. crash/watchdog). Incident runbook: `forensics/monitor/INCIDENT_RUNBOOK.md`.
**`pause()` freezes lender exits AND repayment AND your own `liquidateLoan`** — **9 of 35**
measured operations on V6.2 (the older "6 of 18" was the coarser V6.1 probe set; nothing in V6.2
made pause safer). `registry.deactivateAgent` breaks exactly **1** operation and is reversible —
it is the better per-agent kill switch.

### launchd jobs installed on this machine (audited 2026-09-24)

`launchctl list | grep specular` — five jobs, every plist pointing at a file that exists:

| label | script | interval | notes |
|---|---|---|---|
| `com.specular.v6-invariants-arc-mainnet` | `run-with-alert.sh arc-mainnet` | 1800 s | canonical V6.2 + V4 |
| `com.specular.v6-invariants-arc-mainnet-legacy` | `run-with-alert.sh arc-mainnet` + `V6_MONITOR_MARKETPLACE=0x358c5E69…` | 1800 s | superseded V6.1 |
| `com.specular.v6-invariants-arc-staging` | `run-with-alert.sh arc-staging` | 1800 s | `ARC_TESTNET_RPC_URL=https://rpc.testnet.arc.io` |
| `com.specular.overdue-loans-arc-mainnet` | `run-overdue-check.sh arc-mainnet` | 3600 s | stamps **no heartbeat** |
| `com.specular.rpc-health-sample` | `rpc-health-sample.sh` | 900 s | stamps **no heartbeat** |

`com.specular.v6-invariants.plist.disabled` is the retired arc-testnet job — do not reload it.
All five plists are now committed under `forensics/monitor/`; before 2026-09-24 four of them
existed **only** in `~/Library/LaunchAgents` and in no git history.

## Security Findings (audited, fixed in V6, awaiting external audit)

| § | Severity | Mechanism on v4 | Fix in V6 | Status |
|---|----------|----------------|-----------|--------|
| §B1 | Critical | `withdrawLiquidity` doesn't remove the lender from `poolLenders[]`. Re-supply pushes a duplicate entry. `_distributeInterest` double-counts → `Panic(0x11)`. | `isInPoolLenders` flag gates the push. `compactPoolLenders` admin for migration. | **Fixed in V6**, verified live on Arc V6 |
| §S1 | Critical | `claimInterest` transfers USDC out without decrementing `pool.availableLiquidity`. Phantom liquidity grows. | `claimInterest` decrements `availableLiquidity` by claimed amount. | **Fixed in V6**, verified live on Arc V6 |
| §S5 | Medium | `_countActiveLoans` walks `agentLoans[]` array. ~5,140 loans = block-gas DoS. | `activeLoanCount` counter (O(1)). | **Fixed in V6**, verified at 100 sequential loans (gas FLAT, ratio 0.937) |

### Live impact still extant on v4

- **Base mainnet loans #2/#3/#4 — RESOLVED** (verified on-chain 2026-07). The liquidation cron ran on schedule; all three are now `DEFAULTED` (state 3) and the v4 marketplace USDC balance is 0. v4 is `paused: true`, owner = secure wallet. (Historical: they were the 0.10-USDC self-borrows whose `repayLoan` reverted `Panic(0x11)`; `liquidateLoan` avoids the buggy interest path and succeeded.)
- Base canonical V6 re-read 2026-09-24: unpaused, owner = secure wallet, **14** loans all `REPAID` (state 2), 4 pools, `accumulatedFees` 0.000054, USDC balance 1.506031 (lender positions, not phantom). No `VERSION()` — it is the V6.0 generation.
- **Arc v4 §S1 leak**: ~74.87 USDC of phantom availableLiquidity across 40 lenders (cumulative)
- **Arc v4 agent #43**: 777+ lifetime loans, 3.94M gas per requestLoan, ~5,665 loans from full DoS

### Live verification of V6 fixes (Arc Testnet)

| Test | Outcome |
|------|---------|
| Multi-lender repay (4 distinct lenders, interest distributed) | NO PANIC — proportional shares exact to base unit |
| 50-lender boundary (cap test) | All 4 cap-rejection cases reverted "Pool lender capacity reached" |
| 50-lender repay (interest across all 50) | NO PANIC, 1.4M gas (well under block limit) |
| 100 sequential loans on agent #49 | gas FLAT, ratio 0.937 (decreasing over time) |
| 25 sustained supply/loan/repay/claim cycles | §S1 invariant holds at every snapshot |
| 200 random ops × 3 agents × 4 lenders (property fuzz) | 0 invariant violations |
| 5 reentrancy attack scenarios | All blocked by `nonReentrant` |

## Key Reports & Forensics

### SDK & off-chain security audit (2026-07)
- `forensics/output/security-audit-2026-07/SDK_SECURITY_AUDIT_2026-07.md` — 3 HIGH + 4 MEDIUM + 6 LOW off-chain findings, all fixed with regression tests under `test/sdk/`. Covers the SDKs, x402 layer, secrets, and config integrity (contracts NOT re-audited — unchanged since WORLDCLASS 2026-05-17).
- New security env flags introduced by these fixes are documented in `.env.example`: `SPECULAR_ALLOW_KEY_PERSIST`, `SPECULAR_KEYSTORE_PASSWORD`, `SPECULAR_X402_ALLOW_STUB`, `SPECULAR_X402_STATS_TOKEN`, `SPECULAR_X402_BASE_URL`. Behavior changes: SDK approvals are now exact (no MaxUint256); x402 client has a default 10 USDC per-payment cap (`maxPayment`); x402 stub mode requires opt-in.
- **Open action (owner):** rotate `MOLTBOOK_API_KEY` — it is in public git history (`a8efbf8`); the code fallback was removed but that does not revoke it.

### Audit + V6 (current, 2026-05-07/08)
- `forensics/output/regression-2026-05-07/EXECUTIVE_SUMMARY.md` — non-technical stakeholder one-pager
- `forensics/output/regression-2026-05-07/audit-package/` — auditor handoff (also `audit-package.tar.gz`, 58K)
- `forensics/output/regression-2026-05-07/V6_MIGRATION_RUNBOOK.md` — post-deploy migration steps
- `forensics/output/regression-2026-05-07/BASE_DEPLOY_PREP.md` — Base deployment checklist
- `forensics/output/regression-2026-05-07/LIQUIDATION_RUNBOOK_2026-05-11.md` — Base #2/#3/#4 cron-scheduled liquidation
- `forensics/monitor/v6-invariants.js` + the launchd jobs listed above (every 30 min). **Not** `com.specular.v6-invariants` — that label is the retired arc-testnet job and is installed only as `.disabled`.

### Earlier audit context
- `AUDIT_BUNDLE.md` — original severity table + all findings on v4
- `DISCLOSURE.md` — formal security disclosure
- `MASTER_COMPREHENSIVE_SECURITY_REPORT.md` — full 14-phase analysis on v4
- `LIQUIDATION_GUIDE.md` — emergency recovery for Base loans (superseded by runbook above)
- `comprehensive-tests/` — phases 1–14 test suites (legacy)
- `forensics/monitor/invariant-monitor.js` — v4 multi-network monitoring daemon

## Reputation & Loan Model

**The tier table is NOT a constant any more — read it from the chain.** On `ReputationManagerV4` (the V7 model)
it is owner-settable on-chain state bounded by the immutable `MAX_TIER_LIMIT` (10,000 USDC). Every client reads it:
`sdk.tierTable()` (JS), `client.tier_table()` (Python), `get_protocol_status.creditTiers` (MCP/REST), or
`tierLimits(i)` / `tierCollateralPct(i)` / `tierInterestBps(i)` / `unsecuredTierExposure(i)` directly. An agent's
actual limit is always `calculateCreditLimit(address)`. The numbers below are the SHIPPED DEFAULTS of each
generation, for orientation only — never hardcode them.

### V7 defaults (`ReputationManagerV4` — Arc staging since 2026-09-22, **Arc mainnet since 2026-09-23**; table re-read from both chains 2026-09-24)

| Score | Collateral | Interest | Tier limit | Unsecured exposure |
|-------|-----------|----------|-----------|--------------------|
| 800–1000 | 0% | 5% APR | 5,000 USDC | 5,000 |
| 600–799 | 0% | 7% APR | 2,500 USDC | 2,500 |
| 500–599 | 75% | 10% APR | 10,000 USDC | 2,500 |
| 400–499 | 100% | 10% APR | 10,000 USDC | 0 |
| 200–399 | 100% | 15% APR | 5,000 USDC | 0 |
| 0–199 | 100% | 15% APR | 1,000 USDC | 0 |

The effective limit is `min(tier limit, ladder limit)` where `ladderLimit = creditMultiple × maxRepaidPrincipal +
growthStep` (floored at `bootstrapLimit`), and it is exactly **0** during a 180-day post-default lockout.
A loan at a tier below 100% collateral also requires the agent's own **first-loss self-stake**:
`selfStake >= unsecuredExposure / creditMultiple`, locked while any principal is outstanding.
On-time repayment scales by principal AND hold time; default costs up to 500 pts plus a capacity reset.
See `forensics/output/v7-model/V7_DESIGN_AND_VALIDATION.md`.

### V3 defaults (`ReputationManagerV3` — **Base mainnet only**)

> **Not Arc mainnet.** Arc mainnet has run `ReputationManagerV4` (the V7 model above) since
> 2026-09-23; its live tier limits are `[1000, 5000, 10000, 10000, 2500, 5000]` USDC under an
> immutable `MAX_TIER_LIMIT` of 10,000 — the 25k/50k figures below are **10× too high** for Arc
> and must never be applied there. Read tiers from the contract. The 0 %-collateral tiers on Arc
> are 2,500 (score ≥ 600) and 5,000 (score ≥ 800).

Verified live on Arc V6 — 95-cycle progression mapped score 0 → 950 (see `forensics/output/regression-2026-05-07/64-reputation-tiers.json`):

| Score | Collateral | Interest | Credit Limit |
|-------|-----------|----------|-------------|
| 800–999 | 0% | 5% APR | 50,000 USDC |
| 600–799 | 0% | 7% APR | 25,000 USDC |
| 500–599 | 25% | 10% APR | 10,000 USDC |
| 400–499 | 100% | 10% APR | 10,000 USDC |
| 200–399 | 100% | 15% APR | 5,000 USDC |
| 1–199 | 100% | 15% APR | 1,000 USDC |
| 0 | 100% | 15% APR | 1,000 USDC |

Initial score: 0 (uninitialized agent). On-time repayment: +10. Default: −50 (scaled by loan size). Max: 1000 (score-1000 tier not yet observed live — borrower ran out of gas at score 950).

**Reputation does NOT migrate across a V7 deploy.** `ReputationManagerV4` starts empty by design (no `seedReputation`);
every agent must call `initializeReputation()` again and re-climb. Agent NFTs/ids survive (the registry is not
redeployed). Clients must never assume a prior score exists on a V7 deployment.

## Disaster recovery — what lives ONLY on this machine (audited 2026-09-24)

`origin/main` == local `HEAD` (`503b4d2`, github.com/thegrand-canyon/specular), so all
**1,280 tracked files** — contracts, SDK, scripts, monitor, runbooks — are recoverable from
GitHub. What is not:

| Only here | Recoverable? | If the machine is lost |
|---|---|---|
| **`.env` — `PRIVATE_KEY` of `0x800e305A…F72C`** | **NO** | **Total, permanent loss of control.** That one EOA owns the marketplace, reputation manager, registry and faucet on Arc mainnet, Arc staging and Base. There is no multisig, no timelock, no guardian, no recovery path, and `renounceOwnership` reverting on the marketplace/reputation manager does not help you — the contracts simply become unadministrable: no `pause`, no `liquidateLoan`, no `deactivateAgent`, no lever changes, for ever. **Back this key up offline. It is the single highest-value item in the whole system.** |
| `.env` — `SPECULAR_MCP_TOKEN`, `RAILWAY_TOKEN`, `MOLTBOOK_API_KEY`, RPC URLs | partly | MCP token: rotate and redistribute to agents. Railway token: reissue from the Railway dashboard. RPC URLs are public. |
| launchd plists | **now yes** | All five are committed under `forensics/monitor/` and reinstalled with `./forensics/monitor/install-v6-monitor.sh`. Before 2026-09-24 four of the five existed only in `~/Library/LaunchAgents` — a rebuild would have silently come back with monitoring gone. |
| Monitor state: `state-*.json`, `heartbeat-*.json`, `alerts.log`, `v6-invariants-*.log`, `rpc-health.jsonl`, `overdue-*.log` | NO (gitignored) | Only history is lost. Everything is re-derived from chain on the next run — except the `CP-CHANGED` baseline and the `FRESH-STUCK`/lateness comparisons, which are **blind for exactly one cycle** after a rebuild. Expect no alert on a policy change made during that window. |
| `monitor.env` (webhook) | n/a | Does not exist. Nothing to lose; nothing remote to notify. |
| **~142 untracked root `*.md` reports** (252 on disk, 110 tracked) | **NO** | Session summaries, test reports and campaign docs from 2026-02 onward. Not load-bearing for operations, but gone for good. `git add` them or accept the loss. |
| `artifacts/`, `node_modules/`, `cache/` | yes | `npm ci && npx hardhat compile`. |

**Rebuild, in order:** clone the repo → restore `.env` from offline backup → `npm ci` →
`npx hardhat compile` → edit the plist paths if the repo is not at `~/Specular` →
`./forensics/monitor/install-v6-monitor.sh` → `node forensics/monitor/alert.js --self-test`
→ `node forensics/monitor/alert.js --status` (one fresh heartbeat per invariant job) →
`node scripts/incident-drill/verify-runbook-levers.js` (exit 0) →
`node scripts/smoke-test-arc-mainnet.js --read-only` (11/11).

## Brand

- Primary color: `#FF6A00` (orange)
- Background: void black
- Fonts: Outfit (headings), Inter (body)
- Logo: overlapping circles motif

## npm Scripts

```
npm test                  # all tests (872 passing, 5 pending — verified 2026-09-24)
npm run compile           # compile contracts
npm run node              # start local Hardhat node
npm run deploy:local      # deploy to localhost
npm run deploy:sepolia    # deploy to Sepolia testnet
npm run coverage          # coverage report
```
