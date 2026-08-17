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
| **Arc mainnet network params** | ❌ **BLOCKER — chainId / RPC / real USDC address must be confirmed** |
| **External audit of fixed V6** | ❌ **RECOMMENDED before mainnet money** (6 fixes since WORLDCLASS) |
| Deployer funded on Arc (native gas) | ❌ pending |

---

## Gate 0 — Confirm Arc Mainnet network params (BLOCKER)

Fill these from **Circle's official Arc documentation** (do not guess — a wrong
value on mainnet is catastrophic), then set in `.env`:

- [ ] `ARC_MAINNET_CHAIN_ID` — Arc mainnet chain id
- [ ] `ARC_MAINNET_RPC_URL` — official/production RPC
- [ ] `ARC_MAINNET_USDC` — **real** USDC token address on Arc (6 decimals). On
      Arc, USDC is the native/canonical asset — confirm the exact contract.
- [ ] Explorer URL + verification API (for `chains.json` + `hardhat verify`)
- [ ] Native gas token + how to fund the deployer

The deploy script hard-refuses: the testnet mock USDC, a chainId that doesn't
match the RPC, and any USDC without 6 decimals.

## Gate 1 — External audit of the fixed V6 (RECOMMENDED)

Six contract changes since the WORLDCLASS audit (2026-07/08), all with regression
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
- [ ] Dry run: `node scripts/deploy-arc-mainnet.js` (with Gate-0 env set) — validates
      chain/USDC/balance and prints a gas estimate. No broadcast.

## Gate 3 — Launch config decisions

- [ ] **M-1 lever** (`SPECULAR_BIND_BORROW=1`)? Restricts borrowing to a pool's
      creator (a transferred agent NFT can't borrow against lenders). Default off.
- [ ] **M-2 lever** (`SPECULAR_MIN_HOLD_SECONDS=N`)? Min loan hold before an
      on-time repay earns reputation (blunts farming). Default off (0).
- [ ] **Faucet** (`FAUCET_MAX_ELIGIBLE_AGENT_ID=N`, `setClaimAmount`)? Default
      grants disabled (max=0). Fund the faucet with USDC if enabling.
- [ ] **Owner**: deploy from, or transfer all 4 contracts to, the secure wallet
      `0x800e305A0caDdE6289dFDFEDF38218f45C06F72C`.

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

- [ ] Ownership of all 4 contracts = secure wallet.
- [ ] `reputation.authorizePool(marketplace)` confirmed (script does this).
- [ ] Smoke test: register an agent, supply, borrow small, repay, claim — on mainnet
      with tiny amounts (mirror the Arc-testnet e2e).
- [ ] Add arc-mainnet to the SDK config loaders (SpecularQuickstart, python client)
      and `chains.json` (fill the real values, flip status → production).
- [ ] Monitoring: point the v6-invariants monitor at the Arc mainnet marketplace.
- [ ] Update CLAUDE.md network table with the Arc mainnet addresses.

## Cost

Native-gas cost depends on Arc's gas pricing (unknown until Gate 0). The dry run
prints a live marketplace-deploy gas estimate; full stack ≈ 2–3× that. Ensure the
deployer holds ≥ `ARC_MAINNET_MIN_GAS` (default 0.01 native).
