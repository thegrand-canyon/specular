# Specular Protocol

**AI-native credit protocol with on-chain reputation.**

🌐 **Live on Base Mainnet** | 📊 **1,500+ loans tested** | ✅ **Production-ready**

---

## What is Specular?

Specular is the first unsecured credit protocol designed for AI agents. Build reputation through on-time repayments to unlock better loan terms and higher credit limits.

### Key Features

- ✅ **Unsecured loans** - No collateral at high reputation
- ✅ **On-chain reputation** - Portable credit history
- ✅ **Programmable terms** - Flexible via smart contracts
- ✅ **Multi-chain** - Base, Arbitrum, Optimism, Polygon support
- ✅ **No KYC** - Pure on-chain identity

---

## For AI Agents

**→ See [FOR_AI_AGENTS.md](FOR_AI_AGENTS.md) for complete integration guide**

Quick example:
```javascript
const agent = new SpecularAgent(wallet, contracts);
await agent.register({ name: "MyBot" });
const loan = await agent.requestLoan(100, 30); // 100 USDC, 30 days
await agent.repayLoan(loan.id);
// +10 reputation points!
```

---

## Contract Addresses

`src/config/*.json` is the single source of truth for every deployment — the SDK,
the agent server and the monitors all read those files. The addresses below are a
convenience copy of them; if the two ever disagree, the JSON wins.

### Base Mainnet (Chain ID: 8453) — `src/config/base-addresses.json`

```
AgentRegistryV2:           0xb9996de05fD514A0cB2B81fa25448EECD4559Aaa
ReputationManagerV3:       0xf19b1780A84668C8dfB6b4E84C08e457dB3B0527
AgentLiquidityMarketplace: 0x0a4e3C745aB95aceb45B05C28D89fe4Db8815F9a   (V6, canonical since 2026-05-17)
AgentCreditFaucet:         0x990f7495528bFC2ebcb8CbD6EeBd2Bc32B450164
USDC:                      0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
```

[View on BaseScan →](https://basescan.org/address/0x0a4e3C745aB95aceb45B05C28D89fe4Db8815F9a)

### Arc Mainnet (Chain ID: 5042) — `src/config/arc-mainnet-addresses.json`

```
AgentRegistryV2:               0x6F1EbF50290f6D4A9947E9EB77f98a683684fBF5
ReputationManagerV4:           0x12953e732e5D1aFdA640554125367d1CEC2ac4FB
AgentLiquidityMarketplace V6.2: 0xCb23f2fb03Bfd4775Cc0e76E28f64c1e545071be
AgentCreditFaucet:             0xD854F80031A8d0CB166587AafA0969Da8C3757bF
USDC:                          0x3600000000000000000000000000000000000000
```

---

## Production Stats

**Base Mainnet Testing:**
- ✅ 13/13 successful loans (100% protocol success)
- ✅ Reputation system validated (10 → 130 points)
- ✅ Gas cost: ~$0.002 per loan cycle
- ✅ Total tested: $36 borrowed, $0.44 interest paid

**Status:** Ready for production use

---

## Quick Links

- 📖 [Agent Integration Guide](FOR_AI_AGENTS.md)
- 🚀 [Deployment Guide](DEPLOYMENT_GUIDE.md)
- 📊 [Stress Test Results](BASE_STRESS_TEST_ANALYSIS.md)
- 🤖 [Discovery Ready Checklist](AGENT_DISCOVERY_READY.md)

---

## Prerequisites

| Tool | Version | Needed for |
|------|---------|-----------|
| Node.js | 22 LTS | everything (`npm`, hardhat, the SDK, the agent server) |
| Foundry (`forge`) | any recent | the Solidity invariant/gas/soak suites under `test/foundry/` — optional |
| Python | ≥ 3.10 | the Python SDK under `python/` — optional |

Nothing else is required. `lib/forge-std` is a git submodule but `forge` installs it
on first run, so a plain `git clone` is enough. **Run `npm install` at the repo root
before `forge test`** — `foundry.toml` remaps `@openzeppelin/` into `node_modules/`,
so forge cannot compile without it.

## Local Development

```bash
# 1. Install dependencies (repo root)
npm install

# 2. Compile the contracts
npx hardhat compile

# 3. Run the JS/TS test suite (~2 min)
npm test

# 4. Optional: the Solidity suites (needs Foundry; run step 1 first)
forge test

# 5. Deploy the local dev stack
npx hardhat node                                          # terminal 1
npm run deploy:local                                      # terminal 2

# 6. Start the API server
npm run api:multi
```

### Agent integration server (`mcp-server/`)

Builds and tests independently of the contracts — the ABIs it needs are committed
under `mcp-server/abi/`, so no `hardhat compile` is required:

```bash
cd mcp-server && npm install && npm run build && npm test
```

### Python SDK (`python/`)

```bash
cd python && pip install -r requirements.txt && pip install pytest && pytest tests/
```

### Environment

Copy `.env.example` to `.env` and fill in what you need. The read-only monitors
(`forensics/monitor/*.js`) run with no `.env` at all — they fall back to public RPC
endpoints. Deploy scripts require `PRIVATE_KEY`; they are dry-run by default and only
broadcast with `DEPLOY_CONFIRM=YES`, so an unfunded throwaway key is enough to
rehearse a deployment.

---

## Deploy the API

See [DEPLOYMENT_GUIDE.md](DEPLOYMENT_GUIDE.md) for Railway/Vercel/Render deployment.

**1-Click Railway Deploy:**
1. Push this repo to GitHub
2. Connect to Railway
3. Set env vars: `ARC_TESTNET_RPC_URL`, `DEFAULT_NETWORK=base`
4. Deploy!

---

## How It Works

```
AI Agent → Register → Request Loan → Repay → Build Reputation → Better Terms
```

**Reputation Benefits:** the live tier table is on-chain and owner-settable
(`ReputationManagerV4.tierLimits`); read it with the monitor or
`getCreditLimit()` rather than trusting a copy in a README.

---

## Security

- ✅ Comprehensive testing (1,500+ loans across testnets)
- ✅ Production proven on Base mainnet
- ✅ Open source & auditable
- ⚠️  The contracts are **not** admin-key-free: the owner can pause, retune the
  tier table and the economic levers, and sweep accumulated fees. See
  `AUDIT_BUNDLE.md` and `forensics/output/` for the audit history.

---

## Contributing

Contributions welcome! Please open an issue or PR.

---

## License

MIT

---

*Built for the future of autonomous agents* 🤖
