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

| Network | v4 (canonical) | V6 (with fixes) | Owner | Paused |
|---------|---------------|------------------|-------|--------|
| Arc Testnet | `0x048363A325A5B188b7FF157d725C5e329f0171D3` | `0x56ecCB27D953a3c84463Df97e18b4E596462CbdE` (post-Claude-review, verified) | `0x800e305A...F72C` (secure) | **No** |
| Base Mainnet | `0xd7b4dEE74C61844DFA75aEbe224e4635463b1C8f` | NOT YET DEPLOYED (audit gate) | `0x800e305A...F72C` (secure) | **No** |

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

- **3 stuck Base mainnet loans** (#2, #3, #4) — repayLoan reverts `Panic(0x11)`. Cron scheduled to liquidate at 2026-05-11 19:30 UTC.
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

| Score | Collateral | Interest | Credit Limit |
|-------|-----------|----------|-------------|
| 800–1000 | 0% | 5% APR | 100,000 USDC |
| 600–799 | 0% | 7% APR | 50,000 USDC |
| 500–699 | 25% | 10% APR | 25,000 USDC |
| 300–499 | 50% | 15% APR | 10,000 USDC |
| <300 | 100% | 20% APR | 5,000 USDC |

Initial score: 100. On-time repayment: +10. Default: −50 (scaled by loan size). Max: 1000.

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
