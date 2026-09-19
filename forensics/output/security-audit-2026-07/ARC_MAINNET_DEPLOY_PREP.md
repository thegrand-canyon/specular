# Arc Mainnet Deploy Prep — Specular V6 (fixed)

Pre-flight checklist + gates for deploying the **2026-07-audited, fixed** stack
to **Arc Mainnet** (a new network for Specular; currently only Arc Testnet +
Base Mainnet exist). Deploys the fixed `AgentLiquidityMarketplaceV6`
(H-1/H-2/H-3/M-3 + M-1/M-2 levers) + RegistryV2 + ReputationV3 + faucet.

Deploy tooling (built 2026-08): `scripts/deploy-arc-mainnet.js` (guarded, dry-run
by default), `arcMainnet` hardhat network, `chains.json` arc-mainnet entry.

---

## TL;DR status

| Gate | State |
|------|-------|
| Fixed contracts compile clean | ✅ 50 files, paris |
| Full unit suite | ✅ 484 passing (+ H-1/H-2/H-3/M-3/lever regression tests) |
| Slither run + triaged | ✅ register() reentrancy fixed; remaining High/Med are OZ false-positives / accepted (see below) |
| Deploy script + guards | ✅ `scripts/deploy-arc-mainnet.js` (dry-run default, refuses mock USDC / chain mismatch / non-6-dec token) |
| **Arc mainnet exists** | ✅ **LIVE since 2026-09-16** (chainId 5042, `https://rpc.mainnet.arc.io`, USDC ERC-20 `0x3600…0000` 6-dec). Verified against docs.arc.io + live RPC 2026-09-19; `.env`, `chains.json`, hardhat `arcMainnet` filled. Dry run passes chain/USDC guards. |
| **External audit of fixed V6** | ❌ **REQUIRED before mainnet money** (owner decision, 2026-08) — 6 fixes since WORLDCLASS |
| Launch config | ✅ decided: M-1 on, M-2 on (≈1 day), faucet on |
| Deployer funded on Arc (USDC = gas) | ❌ **BLOCKER** — secure wallet holds 0 USDC on Arc mainnet (2026-09-19). Full stack + wiring ≈ 9.2M gas ≈ 0.18 USDC @ 20 gwei; fund ≥ 1 USDC. |

**Gating blockers as of 2026-09-19:** (1) ~~Arc mainnet must launch~~ DONE 2026-09-16, (2) an
external re-audit of the 6 post-WORLDCLASS fixes must pass (owner decision), (3) fund the
secure wallet with USDC on Arc mainnet (gas). The repo side is
ready: fixed contracts, deploy script + guards, network scaffolding, this runbook.

---

## Gate 0 — Arc Mainnet network params (✅ CLEARED 2026-09-19 — mainnet live)

**Verified 2026-08 against Circle's official docs (docs.arc.io, circlefin/skills):
Arc MAINNET HAS NOT LAUNCHED. "Mainnet addresses are not yet available … Arc is
testnet only."** So this deploy cannot happen until Circle ships Arc mainnet.
Everything else here is staged and ready for that moment.

Confirmed Arc facts (testnet today; confirm the mainnet equivalents at launch):
- **Chain ID (testnet):** `5042002` (`0x4CEF52`). Mainnet id: TBD.
- **RPC (testnet):** `https://rpc.testnet.arc.network` (official) — note the repo
  currently uses `https://arc-testnet.drpc.org`, a valid third-party endpoint.
- **USDC is a DUAL-MODEL asset** (same funds, two views):
  - Native gas token — **18 decimals** — used for `msg.value` / fees.
  - **ERC-20 interface — 6 decimals — testnet address `0x3600000000000000000000000000000000000000`.**
    This is the view the marketplace uses (`safeTransferFrom`/`approve`).
  - 1 USDC = 1e6 ERC-20 base units = 1e18 native. **Never mix the two.**
- **Gas is paid in USDC (native view).** The deployer just needs USDC — no
  separate gas token. `deploy-arc-mainnet.js`'s native-balance check ≈ USDC
  (0.01 "native" ≈ 0.01 USDC).

**Implication for the contracts:** NO changes needed. The marketplace's ERC-20
`safeTransferFrom`/`approve` path binds to the 6-decimal USDC ERC-20 view; the
deploy script's "must be 6 decimals" guard already selects that view and would
reject the 18-decimal native handle. The Arc TESTNET config in this repo uses a
deployed MockUSDC (`0xf2807…`) rather than the canonical `0x3600…0000` ERC-20 —
for mainnet, use Arc's real USDC ERC-20 address.

At launch, fill from Circle's official mainnet docs and set in `.env`:
- [x] `ARC_MAINNET_CHAIN_ID=5042` (live RPC returns 5042)
- [x] `ARC_MAINNET_RPC_URL=https://rpc.mainnet.arc.io` (Circle official; Alchemy/Blockdaemon/dRPC/QuickNode also listed)
- [x] `ARC_MAINNET_USDC=0x3600000000000000000000000000000000000000` — live `symbol()=USDC`, `decimals()=6`
- [x] Explorer `https://explorer.arc.io` (Cloudflare-fronted; `/api` verification endpoint assumed Blockscout-style, NOT yet exercised)

The deploy script hard-refuses: the testnet mock USDC, a chainId that doesn't
match the RPC, and any USDC handle without 6 decimals (blocks the native view).

## Gate 1 — External audit of the fixed V6 (REQUIRED)

An **internal self-audit (2026-08)** ran first — 4 adversarial review lenses +
an exact-solvency fuzz + slither — and fixed 1 HIGH (liquidation-underflow) + 4
MEDIUM. See `SELF_AUDIT_2026-08.md`. It also surfaced **D1 (reputation-minting
economics)** as a CRITICAL design risk no lever fixes — the external audit's #1
item. The self-audit does NOT replace the external audit.

Contract changes since the WORLDCLASS audit (2026-07/08), all with regression
tests but **not externally re-audited**:
- [ ] H-1 phantom-liquidity fix (`_distributeInterest` decrements availableLiquidity on fee routing)
- [ ] H-2 lender-slot reclaim (`_removePoolLender` on full withdrawal)
- [ ] H-3 aggregate credit limit (`outstandingPrincipal`)
- [ ] M-3 faucet per-address dedup
- [ ] M-1/M-2 owner levers (default off)
- [ ] register() CEI reentrancy fix (AgentRegistryV2)
- [ ] Re-run slither/mythril on the final source; confirm no new High/Medium.

### Slither triage (2026-08, `slither 0.11.4`)
- register() reentrancy-no-eth — **FIXED** (CEI, _safeMint last).
- incorrect-exp (High) — OpenZeppelin `Math.mulDiv` `^`; known OZ false positive.
- divide-before-multiply (Med) — `calculateInterest`; pre-existing accepted
  rounding the SDK's exact-approval logic is matched to. Bounded to a few base units.
- incorrect-equality (Med) — ValidationRegistry existence check; intended.
- unused-return (Med) — `calculateCreditLimit` destructures `getSummary`; intended.

## Gate 2 — Tests + dry run

- [x] `npm test` → 484 passing
- [x] Dry run 2026-09-19: chain + USDC guards pass; halts at the balance check (0 USDC). Re-run after funding.
      Independent estimate: Registry 2.64M + Reputation 1.68M + Marketplace 3.39M + Faucet 0.79M + wiring ≈ 9.2M gas ≈ 0.18 USDC @ 20 gwei.

## Gate 3 — Launch config decisions (CONFIRMED 2026-08)

Owner decisions for the Arc mainnet launch (all three protections ON):

- [x] **M-1 lever ON** → `SPECULAR_BIND_BORROW=1`. Borrowing restricted to a
      pool's creator; a transferred agent NFT can't borrow against lenders.
- [x] **M-2 lever ON** → `SPECULAR_MIN_HOLD_SECONDS=<value>`. On-time repayments
      earn reputation only if the loan was held long enough. **Recommended
      starting value: `86400` (1 day)** — barely affects legitimate agents (who
      hold for their term) while forcing ~50 days to farm to the 0-collateral
      tier. Tunable later via `setMinHoldForReputationReward`. **→ confirm the
      exact seconds value before deploy.**
- [x] **F-C squat lever** → `SPECULAR_MIN_SUPPLY=<base units>`. Minimum to open a
      new lender slot; forces a squatter to lock `minSupply × 50` per pool.
      **Recommended: `1000000` (1 USDC)**. Default 0 = off. **→ set at launch.**
- [x] **Faucet ENABLED**. Still to set at/after deploy:
      - `FAUCET_MAX_ELIGIBLE_AGENT_ID=<N>` — initial eligible cohort size (start
        small, raise as needed). 0 = off, so this MUST be set > 0 to activate.
      - `setClaimAmount(<amount>)` — grant per agent (default 10 USDC, max 100).
      - **Fund the faucet** with USDC (`maxEligible × claimAmount` headroom).
- [ ] **Owner**: deploy from, or transfer all 4 contracts to, the secure wallet
      `0x800e305A0caDdE6289dFDFEDF38218f45C06F72C`.

Deploy invocation with the confirmed config (once Gate 0/1 clear):
```bash
DEPLOY_CONFIRM=YES \
SPECULAR_BIND_BORROW=1 \
SPECULAR_MIN_HOLD_SECONDS=86400 \
SPECULAR_MIN_SUPPLY=1000000 \
FAUCET_MAX_ELIGIBLE_AGENT_ID=<N> \
node scripts/deploy-arc-mainnet.js
```

---

## Deploy sequence

```bash
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"

# 0. Final gate: tests + fresh compile
npm test && npx hardhat compile

# 1. Set Gate-0 env in .env (ARC_MAINNET_RPC_URL / _CHAIN_ID / _USDC), then dry run
node scripts/deploy-arc-mainnet.js
#    → confirm: chainId matches, USDC symbol/decimals correct, deployer funded, gas est sane

# 2. Broadcast (IRREVERSIBLE). Add lever/faucet env here if enabling at deploy.
DEPLOY_CONFIRM=YES node scripts/deploy-arc-mainnet.js
#    → writes src/config/arc-mainnet-addresses.json

# 3. Verify on the Arc explorer (after adding the customChain to hardhat etherscan config)
npx hardhat verify --network arcMainnet <REGISTRY_ADDR>
npx hardhat verify --network arcMainnet <REPUTATION_ADDR> <REGISTRY_ADDR>
npx hardhat verify --network arcMainnet <MARKETPLACE_ADDR> <REGISTRY_ADDR> <REPUTATION_ADDR> <USDC>
npx hardhat verify --network arcMainnet <FAUCET_ADDR> <REGISTRY_ADDR> <USDC>
```

## Post-deploy

**2026-09-19 (later): internal audit → V6.1 → marketplace REDEPLOYED on mainnet.**
New canonical marketplace `0x358c5E69f712A4b3558333090a45A054bAeEb282` (V6.1, Sourcify exact_match, migration
finalized at deploy → F-08 closed). Old V6.0 `0xb9996de0…9Aaa` retired: fees withdrawn, paused, revokePool.
Rehearsed first on Arc testnet staging (`0xB2d88bbF…6878`). Smoke 22/22 on new; invariants OK; monitor
follows the config file so the launchd job now watches the new address. Redeploy log:
`forensics/output/arc-mainnet-2026-09-19/redeploy-v6.1.log`. See `../audit-2026-09/` for the audit + fix notes.

**DEPLOYED 2026-09-19** (owner chose to launch ahead of Gate 1). Addresses in
`src/config/arc-mainnet-addresses.json`: RegistryV2 `0x6F1EbF50290f6D4A9947E9EB77f98a683684fBF5`,
ReputationV3 `0x1577Eb9985CcA859F25ED2EDaeD16A464ADFaE5e`, MarketplaceV6
`0xb9996de05fD514A0cB2B81fa25448EECD4559Aaa`, Faucet `0xD854F80031A8d0CB166587AafA0969Da8C3757bF`.
Levers: M-1 on, M-2 86400, F-C 1 USDC, D1 20/day, fee 100 bps, faucet cohort 100 (unfunded).
Deploy log: /tmp/arc-mainnet-deploy.log (copy into forensics if needed).

- [x] Ownership of all 4 contracts = secure wallet (deployed from it; read back on-chain).
- [x] `reputation.authorizePool(marketplace)` confirmed on-chain.
- [x] Smoke test `scripts/smoke-test-arc-mainnet.js`: agentId 1, loans #1/#2 REPAID, interest claimed,
      full withdraw, §S1 holds, marketplace balance == accumulatedFees (0.001452 USDC protocol fees).
      Note: a lender top-up AFTER a loan opens forfeits that loan's interest to fees (by design).
- [ ] Add arc-mainnet to the SDK config loaders (SpecularQuickstart, python client)
      and `chains.json` (fill the real values, flip status → production).
- [x] Monitoring: `V6_MONITOR_NETWORK=arc-mainnet node forensics/monitor/v6-invariants.js` — launchd `com.specular.v6-invariants-arc-mainnet` (every 30 min, log `forensics/monitor/v6-invariants-arc-mainnet.log`), installed 2026-09-19 alongside the testnet job.
- [x] CLAUDE.md network table updated.
- [x] Source verification: all 4 contracts **exact_match (creation + runtime) on Sourcify** 2026-09-19
      (https://repo.sourcify.dev/5042/<addr>). explorer.arc.io's /api is Cloudflare-challenged so
      `hardhat verify` fails there; hardhat-verify 2.1.3 also uses Sourcify's retired v1 API. Submit
      via Sourcify v2 (`POST /server/v2/verify/5042/<addr>` with hardhat build-info) if re-verifying.
- [ ] Fund the faucet (cohort 100 × 10 USDC claimAmount = 1,000 USDC headroom) if grants are wanted at launch.
- [ ] Rotate/transfer: nothing — deployer == secure wallet.

## Cost

Native-gas cost depends on Arc's gas pricing (unknown until Gate 0). The dry run
prints a live marketplace-deploy gas estimate; full stack ≈ 2–3× that. Ensure the
deployer holds ≥ `ARC_MAINNET_MIN_GAS` (default 0.01 native).
