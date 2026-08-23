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
- **93/93 tests passing** — run with `npm test`
- Deploy locally: `npm run node` (terminal 1) then `npm run deploy:local` (terminal 2)

### Production Contracts (deployed)

- `AgentLiquidityMarketplace.sol` — v4, the active canonical marketplace
- `AgentLiquidityMarketplaceV6.sol` — V6, surgical patch with §B1/§S1/§S5 fixes (NEW, deployed Arc only)
- Arc Testnet addresses: `src/config/arc-testnet-addresses.json`
- Base Mainnet addresses: `src/config/base-addresses.json`
- **Arc Testnet V6-STAGING (2026-08 self-audit fixes)**: `src/config/arc-testnet-v6-addresses.json` — the FIXED stack (H-1..H-3, A1, D1–D5, D11/D12 + all levers) deployed to Arc testnet as a mainnet rehearsal. Marketplace `0xDbDf60AE5CB46D23aA44c062a4943655a6820f31`, RegistryV2 `0x4712A978A0EADe68f0b485b981112Ae66aA622d9`, ReputationV3 `0x085D581FB56d4aD428d9852466557286099dD46c`, Faucet `0x11D3e3A358D0Ef572260E33DAC66D0276EB97c57`, MockUSDC `0x9F3C10985998D1354D1465c5135Aa924775bd11D`. Owner = secure wallet. Launch levers ON (M-1, M-2=1d, F-C=1 USDC, D1 rate-limit 20/day, 1% fee, faucet cohort 100). On-chain smoke test 19/19 (`scripts/smoke-test-arc-testnet-v6.js`). Deploy: `scripts/deploy-arc-testnet-v6.js`. NOTE: this is the fixed code on TESTNET; the older Arc-testnet V6 `0x7a05…` below predates these fixes.

| Network | v4 (canonical) | V6 (with fixes) | Owner | Paused |
|---------|---------------|------------------|-------|--------|
| Arc Testnet | `0x048363A325A5B188b7FF157d725C5e329f0171D3` | `0x7a0560551b2370ee87458186c0b1eFCc38c7c57a` (post-WORLDCLASS audit, deployed 2026-05-17 — predates 2026-08 self-audit fixes) | `0x800e305A...F72C` (secure) | **No** |
| Arc Testnet **V6-staging (fixed)** | — | `0xDbDf60AE5CB46D23aA44c062a4943655a6820f31` (2026-08 self-audit fixes + levers, fresh MockUSDC) | `0x800e305A...F72C` (secure) | **No** |
| Base Mainnet | `0x0a4e3C745aB95aceb45B05C28D89fe4Db8815F9a` (CANONICAL 2026-05-17 — V6, post-WORLDCLASS audit) | (v4 archived: `0xd7b4dEE74C61844DFA75aEbe224e4635463b1C8f`, paused) | `0x800e305A...F72C` (secure) | **No** |

- Base stale marketplace: `0x77F8D49cdE6Ae7481BeA38C8a70b5A893bD4d9AF` (60.5 USDC residual, different owner — ignore)
- Arc compromised wallet: `0x656086A21073272533c8A3f56A94c1f3D8BCFcE2` (key published; agentId 43, 777+ loans, USDC swept to secure wallet 2026-05-08)
- Base v4 deployed bytecode was compiled from a stash revision with MAX_LENDERS=50 (matches V6); committed v4 source has MAX_LENDERS=200

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

## Security Findings (audited, fixed in V6, awaiting external audit)

| § | Severity | Mechanism on v4 | Fix in V6 | Status |
|---|----------|----------------|-----------|--------|
| §B1 | Critical | `withdrawLiquidity` doesn't remove the lender from `poolLenders[]`. Re-supply pushes a duplicate entry. `_distributeInterest` double-counts → `Panic(0x11)`. | `isInPoolLenders` flag gates the push. `compactPoolLenders` admin for migration. | **Fixed in V6**, verified live on Arc V6 |
| §S1 | Critical | `claimInterest` transfers USDC out without decrementing `pool.availableLiquidity`. Phantom liquidity grows. | `claimInterest` decrements `availableLiquidity` by claimed amount. | **Fixed in V6**, verified live on Arc V6 |
| §S5 | Medium | `_countActiveLoans` walks `agentLoans[]` array. ~5,140 loans = block-gas DoS. | `activeLoanCount` counter (O(1)). | **Fixed in V6**, verified at 100 sequential loans (gas FLAT, ratio 0.937) |

### Live impact still extant on v4

- **Base mainnet loans #2/#3/#4 — RESOLVED** (verified on-chain 2026-07). The liquidation cron ran on schedule; all three are now `DEFAULTED` (state 3) and the v4 marketplace USDC balance is 0. v4 is `paused: true`, owner = secure wallet. (Historical: they were the 0.10-USDC self-borrows whose `repayLoan` reverted `Panic(0x11)`; `liquidateLoan` avoids the buggy interest path and succeeded.)
- Base canonical V6 verified clean 2026-07: unpaused, owner = secure wallet, 13 loans all `REPAID`, no phantom liquidity (§S1 holds).
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
- `forensics/monitor/v6-invariants.js` + launchd `com.specular.v6-invariants` (every 30 min)

### Earlier audit context
- `AUDIT_BUNDLE.md` — original severity table + all findings on v4
- `DISCLOSURE.md` — formal security disclosure
- `MASTER_COMPREHENSIVE_SECURITY_REPORT.md` — full 14-phase analysis on v4
- `LIQUIDATION_GUIDE.md` — emergency recovery for Base loans (superseded by runbook above)
- `comprehensive-tests/` — phases 1–14 test suites (legacy)
- `forensics/monitor/invariant-monitor.js` — v4 multi-network monitoring daemon

## Reputation & Loan Model

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

## Brand

- Primary color: `#FF6A00` (orange)
- Background: void black
- Fonts: Outfit (headings), Inter (body)
- Logo: overlapping circles motif

## npm Scripts

```
npm test                  # all tests (93/93)
npm run compile           # compile contracts
npm run node              # start local Hardhat node
npm run deploy:local      # deploy to localhost
npm run deploy:sepolia    # deploy to Sepolia testnet
npm run coverage          # coverage report
```
