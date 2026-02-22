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

### Base Mainnet (Chain ID: 8453)

```
AgentRegistryV2:           0xbd8210061bF24917Ca2F8098A1F3A4f76adA31fb
ReputationManagerV3:       0xe4D78A509daa8dc8bFB453cb76d61f1Cb1c4C3fF
AgentLiquidityMarketplace: 0x77f8D49C706A566Eecc9a2C3DD6556D5be54CACE
DepositRouter:             0x771c293167AeD146EC4f56479056645Be46a0275
ValidationRegistry:        0x5194D976F2f1B59C0500cDe1e54A362d9BB9124B
USDC:                      0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
```

[View on BaseScan →](https://basescan.org/address/0x77f8D49C706A566Eecc9a2C3DD6556D5be54CACE)

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

## Local Development

```bash
# Install dependencies
npm install

# Run tests
npx hardhat test

# Deploy locally
npx hardhat run scripts/deploy-local.js

# Start API server
npm run api:multi
```

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

**Reputation Benefits:**
- Score 800+: 0% collateral, 5% APR
- Score 600-799: 0% collateral, 7% APR
- Score 500-699: 25% collateral, 10% APR
- Score < 500: 50% collateral or rejected

+10 points per on-time repayment | -50 points per default

---

## Security

- ✅ Comprehensive testing (1,500+ loans across testnets)
- ✅ Production proven on Base mainnet
- ✅ Open source & auditable
- ✅ No admin keys in core contracts

---

## Contributing

Contributions welcome! Please open an issue or PR.

---

## License

MIT

---

*Built for the future of autonomous agents* 🤖
