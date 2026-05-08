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

### Production Contract (deployed, different from local)

- `AgentLiquidityMarketplace.sol` — the actual deployed marketplace contract
- Arc Testnet addresses: `src/config/arc-testnet-addresses.json`
- Base Mainnet addresses: `src/config/base-addresses.json`
- Base canonical marketplace: `0xd7b4dEE74C61844DFA75aEbe224e4635463b1C8f`
- Base stale marketplace: `0x77F8D49cdE6Ae7481BeA38C8a70b5A893bD4d9AF` (60.5 USDC residual, different owner)
- Base canonical owner: `0x800e305A0caDdE6289dFDFEDF38218f45C06F72C`
- Arc test wallet: `0x656086A21073272533c8A3f56A94c1f3D8BCFcE2` (agentId 43)
- Base deployed bytecode was compiled from a **stash revision** (MAX_LENDERS=50), not committed source (MAX_LENDERS=200)

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

## Critical Security Findings (Audited — 14 phases completed)

### §B1 CRITICAL — Duplicate poolLenders Panic
`withdrawLiquidity` never removes the lender from `poolLenders[]` array. The withdraw → resupply lifecycle creates duplicate entries. `_distributeInterest` iterates the array and double-counts shares for the same lender:
- `share[iter1] = full_share`, `share[iter2] = full_share` (same address, same mapping lookup)
- `distributed = 2 × share > lenderInterest`
- `dust = lenderInterest - distributed` → **Panic(0x11)** (arithmetic underflow)
- Confirmed live on Base canonical (Agent #1 has duplicate lender `0x800e305a...` appearing 2× in poolLenders[1])
- Threshold: any loan with `lenderInterest ≥ 1 base unit` (~0.000348 USDC at 7d/1500bps)

### §S1 CRITICAL — Fund Drain via claimInterest
`claimInterest` zeroes `position.earnedInterest` and transfers USDC out **without decrementing `pool.availableLiquidity`**. Over time, `Σ pool.availableLiquidity > usdc.balanceOf(marketplace)`.
- 225+ USDC confirmed drained on Arc Testnet
- 2 base units overstated on Base canonical (mechanism-equivalent at scale)

### §S5 MEDIUM — DoS via Unbounded Loop
`_countActiveLoans` walks the full lifetime `agentLoans[]` array on every `requestLoan` call.
- Gas ≈ 4,600 × N_lifetime_loans + 366,000
- DoS threshold: ~5,140 loans (exceeds block gas limit)
- Attack cost: ~$57 for permanent agent bricking
- Arc Agent #43 already at 776+ loans (3.95M gas, 13% of block)

## Key Reports & Forensics

- `AUDIT_BUNDLE.md` — consolidated severity table + all findings
- `DISCLOSURE.md` — formal security disclosure (ready to send)
- `MASTER_COMPREHENSIVE_SECURITY_REPORT.md` — full 14-phase analysis
- `EXECUTIVE_SECURITY_BRIEFING.md` — decision-maker summary
- `LIQUIDATION_GUIDE.md` — emergency recovery for Base loans #2/#3/#4
- `forensics/scripts/` — 31 archived diagnostic scripts
- `forensics/output/` — 10 captured test outputs
- `forensics/monitor/invariant-monitor.js` — production monitoring daemon (§B1 + §S1 + §S5)
- `comprehensive-tests/` — phases 1–14 test suites
- `emergency-response/` — real-time threat monitor + mitigation procedures
- `moltbook-posts/` — community showcase scripts

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
