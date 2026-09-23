# @specular/langchain

Add on-chain credit to your LangChain agents in 3 lines of code.

[![npm version](https://badge.fury.io/js/%40specular%2Flangchain.svg)](https://www.npmjs.com/package/@specular/langchain)

## 🚀 Quick Start

```javascript
const { SpecularCreditTool } = require('@specular/langchain');

const creditTool = new SpecularCreditTool({
    wallet: myEthersWallet,
    network: 'base'
});

// Add to your LangChain agent
const agent = new OpenAIAgent({
    tools: [creditTool]
});

// Agent can now access credit autonomously
await agent.invoke("Check my credit and request a $100 loan for 30 days");
```

## 📦 Installation

```bash
npm install @specular/langchain ethers
```

## 💡 What This Does

Your LangChain agents can:
- ✅ Access working capital (borrow USDC)
- ✅ Build credit history (on-chain reputation)
- ✅ Reduce collateral over time (100% → 0%)
- ✅ Operate autonomously (no human approval needed)

## 🔧 Usage

### Basic Setup

```javascript
const { ethers } = require('ethers');
const { SpecularCreditTool } = require('@specular/langchain');

// 1. Setup wallet
const provider = new ethers.JsonRpcProvider('https://mainnet.base.org');
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

// 2. Initialize credit tool
const creditTool = new SpecularCreditTool({
    wallet: wallet,
    network: 'base' // or 'arc' for testnet
});

// 3. Use with LangChain (if using full framework)
// Or call directly:
const result = await creditTool._call(JSON.stringify({
    action: 'check_eligibility'
}));
```

### Available Actions

```javascript
// Check credit eligibility
await creditTool._call('{"action": "check_eligibility"}');
// Returns: { eligible, reputationScore, maxLoanAmount, interestRate, collateralRequired }

// Request a loan
await creditTool._call('{"action": "request_loan", "amount": 100, "durationDays": 30}');
// Returns: { success, loanId, amount, duration, txHash }

// Repay a loan
await creditTool._call('{"action": "repay_loan", "loanId": 1}');
// Returns: { success, principal, interest, totalRepaid, txHash }

// Check reputation score
await creditTool._call('{"action": "check_reputation"}');
// Returns: { agentId, reputationScore, tier }

// Get loan status
await creditTool._call('{"action": "loan_status", "loanId": 1}');
// Returns: { loanId, borrower, amount, dueDate, status }
```

## 🌐 Networks

### Base Mainnet (Production)
```javascript
network: 'base'
```
- **RPC:** https://mainnet.base.org
- **USDC:** Native USDC (6 decimals)
- **Liquidity:** Check current at [basescan](https://basescan.org/address/0x2f24Ca82Cac2a0034eEA2E128328BAdA94A5E4B6)

### Arc Testnet (Testing)
```javascript
network: 'arc'
```
- **RPC:** https://arc-testnet.drpc.org
- **USDC:** MockUSDC for testing
- **Get test USDC:** Contact Specular team

## 📊 How Reputation Works

| Reputation | Collateral | Interest Rate |
|------------|-----------|---------------|
| 800-1000 | 0% | 5% APR |
| 600-799 | 0% | 7% APR |
| 400-599 | 25% | 10% APR |
| 200-399 | 50% | 12% APR |
| 0-199 | 100% | 15% APR |

**Build Reputation:**
- Start: 100 points
- On-time repayment: +10 points
- Default: -50 points (scaled by loan size)

## 💼 Use Cases

### Trading Agent
```javascript
// Agent needs capital for arbitrage
const loan = await creditTool._call(JSON.stringify({
    action: 'request_loan',
    amount: 500,
    durationDays: 7
}));

// Execute trades
// ...

// Repay with profits
await creditTool._call(JSON.stringify({
    action: 'repay_loan',
    loanId: JSON.parse(loan).loanId
}));
```

### Service Provider Agent
```javascript
// Agent provides services, needs working capital
await creditTool._call('{"action": "request_loan", "amount": 100, "durationDays": 30}');

// Provide services, earn USDC
// ...

// Repay on time, build reputation
await creditTool._call('{"action": "repay_loan", "loanId": 1}');

// Next loan: Higher limit, lower rate
```

## 🔐 Security

**Best Practices:**
1. Use dedicated wallet for agent operations
2. Store private keys in environment variables
3. Start small on testnet
4. Monitor agent's credit usage

```javascript
// ✅ Good
require('dotenv').config();
const wallet = new ethers.Wallet(process.env.AGENT_PRIVATE_KEY, provider);

// ❌ Bad
const wallet = new ethers.Wallet("0x1234...", provider);
```

## 🆘 Troubleshooting

### "Wallet is required"
Make sure you're passing an ethers.Wallet instance:
```javascript
const wallet = new ethers.Wallet(privateKey, provider);
const creditTool = new SpecularCreditTool({ wallet, network: 'base' });
```

### "Not registered"
Auto-registration happens on first loan request. Or check eligibility first:
```javascript
await creditTool._call('{"action": "check_eligibility"}');
```

### "Insufficient collateral"
Check your reputation and required collateral:
```javascript
const eligibility = await creditTool._call('{"action": "check_eligibility"}');
console.log(JSON.parse(eligibility).collateralRequired);
```

## 📚 Documentation

- [Full Integration Guide](https://github.com/specular-protocol/specular/tree/main/src/integrations)
- [Protocol Docs](https://docs.specular.network)
- [API Reference](https://api.specular.network)

## 🤝 Support

- **Issues:** [GitHub Issues](https://github.com/specular-protocol/specular/issues)
- **Discussions:** [Moltbook m/specular](https://www.moltbook.com/m/specular)

## 📄 License

MIT

---

**Built by Specular Protocol** | [Website](https://specular.network) | [GitHub](https://github.com/specular-protocol)
