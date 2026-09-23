# Specular Protocol - AI Agent Framework Integrations

Make your AI agent financially autonomous in 10 lines of code.

## 🚀 Quick Start

### LangChain
```javascript
const { SpecularCreditTool } = require('@specular/langchain');

const creditTool = new SpecularCreditTool({
    wallet: myEthersWallet,
    network: 'base'
});

// Add to your LangChain agent's tools
const agent = new OpenAIAgent({
    tools: [creditTool]
});

// Agent can now autonomously access credit
await agent.invoke("Check my credit and request a $100 loan for 30 days");
```

### CrewAI
```python
from specular_credit_tool import SpecularCreditTool

credit_tool = SpecularCreditTool(
    private_key="0x...",
    network="base"
)

financial_agent = Agent(
    role='Financial Manager',
    goal='Optimize capital efficiency',
    tools=[credit_tool]
)

# Agent can now manage liquidity autonomously
```

### AutoGPT
```bash
# 1. Install plugin
cp -r src/integrations/autogpt ~/.autogpt/plugins/specular_credit

# 2. Configure
echo "SPECULAR_PRIVATE_KEY=0x..." >> .env
echo "SPECULAR_NETWORK=base" >> .env

# 3. Enable in AutoGPT settings
# Agent now has credit commands available
```

---

## 📦 Available Integrations

| Framework | Language | Status | Documentation |
|-----------|----------|--------|---------------|
| **LangChain** | JavaScript | ✅ Ready | [docs](#langchain-integration) |
| **CrewAI** | Python | ✅ Ready | [docs](#crewai-integration) |
| **AutoGPT** | Python | ✅ Ready | [docs](#autogpt-integration) |
| **LlamaIndex** | Python | 🚧 Coming Soon | - |
| **Semantic Kernel** | C# | 🚧 Coming Soon | - |

---

## 🎯 What This Enables

Your AI agents can:
- ✅ **Access working capital** - Borrow USDC when needed
- ✅ **Build credit history** - On-chain reputation that compounds
- ✅ **Earn passive income** - Lend to other agents
- ✅ **Reduce collateral** - Start at 100%, work down to 0%
- ✅ **Operate autonomously** - No human intervention required

---

## 🔧 LangChain Integration

### Installation
```bash
npm install @specular/langchain ethers
```

### Usage
```javascript
const { ethers } = require('ethers');
const { SpecularCreditTool } = require('@specular/langchain');

// Setup wallet
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

// Initialize credit tool
const creditTool = new SpecularCreditTool({
    wallet: wallet,
    network: 'base' // or 'arc' for testnet
});

// Use with LangChain agent
import { ChatOpenAI } from "@langchain/openai";
import { createOpenAIFunctionsAgent, AgentExecutor } from "langchain/agents";

const llm = new ChatOpenAI({ modelName: "gpt-4" });
const agent = await createOpenAIFunctionsAgent({
    llm,
    tools: [creditTool],
    prompt: "You are a financial AI agent with access to on-chain credit."
});

const executor = new AgentExecutor({ agent, tools: [creditTool] });

// Agent can now autonomously manage credit
const result = await executor.invoke({
    input: "Check my credit eligibility and request a $100 loan for 30 days if favorable"
});
```

### Available Actions
- `check_eligibility` - View credit limit, rate, collateral requirements
- `request_loan` - Borrow USDC (auto-registers if needed)
- `repay_loan` - Repay to build reputation
- `check_reputation` - View current score and tier
- `loan_status` - Get loan details

### Example
```javascript
// Direct tool usage (without LangChain agent)
const result = await creditTool._call(JSON.stringify({
    action: 'request_loan',
    amount: 100,
    durationDays: 30
}));

console.log(result);
// {
//   "success": true,
//   "loanId": "42",
//   "amount": "100 USDC",
//   "duration": "30 days",
//   "txHash": "0x..."
// }
```

**Full example:** [langchain/example-usage.js](./langchain/example-usage.js)

---

## 🐍 CrewAI Integration

### Installation
```bash
pip install crewai web3 python-dotenv
```

### Usage
```python
from crewai import Agent, Task, Crew
from specular_credit_tool import SpecularCreditTool

# Initialize credit tool
credit_tool = SpecularCreditTool(
    private_key=os.getenv("PRIVATE_KEY"),
    network="base"
)

# Create financial agent
financial_manager = Agent(
    role='Financial Manager',
    goal='Optimize capital efficiency and manage liquidity',
    backstory="""You are an expert financial manager who ensures
    optimal capital allocation and builds strong credit reputation.""",
    tools=[credit_tool],
    verbose=True
)

# Create task
manage_liquidity = Task(
    description="""Check our credit eligibility. If we have capacity,
    request a $100 loan for 30 days to cover working capital needs.""",
    agent=financial_manager,
    expected_output="Loan confirmation with terms"
)

# Execute
crew = Crew(
    agents=[financial_manager],
    tasks=[manage_liquidity]
)

result = crew.kickoff()
```

### Available Actions
Same as LangChain (JSON input format):
```python
result = credit_tool._run('{"action": "check_eligibility"}')
result = credit_tool._run('{"action": "request_loan", "amount": 100, "duration_days": 30}')
result = credit_tool._run('{"action": "repay_loan", "loan_id": 1}')
result = credit_tool._run('{"action": "check_reputation"}')
result = credit_tool._run('{"action": "loan_status", "loan_id": 1}')
```

**Full example:** [crewai/example_usage.py](./crewai/example_usage.py)

---

## 🤖 AutoGPT Integration

### Installation
```bash
# 1. Copy plugin to AutoGPT plugins directory
cp -r src/integrations/autogpt ~/.autogpt/plugins/specular_credit

# 2. Install dependencies
cd ~/.autogpt/plugins/specular_credit
pip install web3 eth-account

# 3. Configure environment
echo "SPECULAR_PRIVATE_KEY=0x..." >> ~/.autogpt/.env
echo "SPECULAR_NETWORK=base" >> ~/.autogpt/.env

# 4. Enable plugin in AutoGPT settings
```

### Available Commands
Once installed, AutoGPT gains these commands:

- `specular_check_credit` - Check credit eligibility
- `specular_request_loan <amount> <days>` - Request a loan
- `specular_repay_loan <loan_id>` - Repay a loan
- `specular_reputation` - Check reputation score
- `specular_loan_status <loan_id>` - Get loan details

### Example AutoGPT Session
```
User: Check my credit and request a loan if I'm eligible

AutoGPT: Executing specular_check_credit...
Result: {
  "reputation_score": 150,
  "max_loan": "75 USDC",
  "interest_rate": "8%",
  "collateral_required": "50%"
}

AutoGPT: You're eligible for up to $75. Executing specular_request_loan 50 30...
Result: {
  "success": true,
  "loan_id": "23",
  "amount": "50 USDC",
  "message": "Loan approved! USDC in your wallet."
}

AutoGPT: Successfully borrowed $50 USDC for 30 days at 8% interest.
Repayment due: $54 USDC. I'll remind you before the due date.
```

---

## 🌐 Networks

### Base Mainnet (Production)
```javascript
network: 'base'
```
- **Chain ID:** 8453
- **RPC:** https://mainnet.base.org
- **Liquidity:** $285 USDC
- **Registry:** 0xb9996de05fD514A0cB2B81fa25448EECD4559Aaa
- **Marketplace:** 0x2f24Ca82Cac2a0034eEA2E128328BAdA94A5E4B6
- **USDC:** 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913

### Arc Testnet (Testing)
```javascript
network: 'arc'
```
- **Chain ID:** 5042002
- **RPC:** https://arc-testnet.drpc.org
- **Liquidity:** $32K USDC
- **Registry:** 0x741C03c0d95d2c15E479CE1c7E69B3196d86faD7
- **Marketplace:** 0x048363A325A5B188b7FF157d725C5e329f0171D3
- **MockUSDC:** 0xf2807051e292e945751A25616705a9aadfb39895

---

## 💡 How It Works

### 1. Register (One-Time)
Agent registers on-chain with a unique ID and metadata.

### 2. Build Reputation
- **Start:** 100 reputation, 100% collateral, $50 limit
- **On-time repayment:** +10 reputation
- **Default:** -50 reputation (scaled by loan size)

### 3. Unlock Better Terms
| Reputation | Collateral | Max Loan | Interest |
|------------|-----------|----------|----------|
| 800-1000 | 0% | High | 5% APR |
| 600-799 | 0% | Medium | 7% APR |
| 400-599 | 25% | Medium | 10% APR |
| 200-399 | 50% | Low | 12% APR |
| 0-199 | 100% | Very Low | 15% APR |

### 4. Access Credit
Borrow USDC instantly based on reputation. No credit checks, no KYC.

---

## 🔐 Security

### Best Practices
1. **Separate Wallets** - Use dedicated wallet for agent operations
2. **Environment Variables** - Never hardcode private keys
3. **Start Small** - Test on Arc Testnet first
4. **Monitor** - Track agent's credit usage
5. **Repay On Time** - Build reputation, unlock better terms

### Example Security Setup
```javascript
// ❌ DON'T DO THIS
const wallet = new ethers.Wallet("0x1234..."); // Hardcoded key

// ✅ DO THIS
require('dotenv').config();
const wallet = new ethers.Wallet(process.env.AGENT_PRIVATE_KEY);
```

---

## 📊 Real-World Examples

### Example 1: Trading Agent
```javascript
// Agent needs capital to arbitrage opportunity
const creditTool = new SpecularCreditTool({ wallet, network: 'base' });

// Check if we can borrow
const eligibility = await creditTool._call('{"action": "check_eligibility"}');

// Borrow $500 for 7 days
const loan = await creditTool._call(JSON.stringify({
    action: 'request_loan',
    amount: 500,
    durationDays: 7
}));

// Execute trades with borrowed capital
// ...

// Repay with profits
const repayment = await creditTool._call(JSON.stringify({
    action: 'repay_loan',
    loanId: loan.loanId
}));
```

### Example 2: Service Provider Agent
```python
# Agent provides services, gets paid in USDC, builds credit
credit_tool = SpecularCreditTool(private_key=key, network="base")

# Start with small loan
credit_tool._run('{"action": "request_loan", "amount": 50, "duration_days": 14}')

# Provide services, earn USDC
# ...

# Repay on time
credit_tool._run('{"action": "repay_loan", "loan_id": 1}')

# Reputation increases, can borrow more next time
```

---

## 🆘 Troubleshooting

### "Wallet is required for SpecularCreditTool"
Make sure you're passing an ethers.Wallet instance:
```javascript
const wallet = new ethers.Wallet(privateKey, provider);
const creditTool = new SpecularCreditTool({ wallet, network: 'base' });
```

### "Not registered"
Auto-registration happens on first loan request. Or manually register:
```javascript
await creditTool._call('{"action": "request_loan", "amount": 10, "durationDays": 7}');
```

### "Insufficient collateral"
Check your reputation and required collateral:
```javascript
const eligibility = await creditTool._call('{"action": "check_eligibility"}');
console.log(eligibility);
```

### RPC Timeout Errors
Switch to a different RPC or add retry logic:
```javascript
const provider = new ethers.JsonRpcProvider(
    'https://mainnet.base.org',
    8453,
    { batchMaxCount: 1 } // Prevents batching issues
);
```

---

## 🤝 Contributing

Want to add support for more frameworks?

1. **LlamaIndex** - Python tool wrapper
2. **Semantic Kernel** - C# plugin
3. **Haystack** - Python component
4. **Rasa** - Custom action
5. **Botpress** - Integration module

**Template structure:**
```
src/integrations/<framework>/
├── specular_credit_tool.<ext>   # Main integration
├── example_usage.<ext>           # Usage examples
└── README.md                     # Framework-specific docs
```

---

## 📚 Resources

- **Documentation:** https://docs.specular.network
- **API Reference:** https://api.specular.network/docs
- **Examples:** [examples/](../../examples/)
- **Support:** https://discord.gg/specular
- **Moltbook:** m/specular

---

## 📄 License

MIT License - see [LICENSE](../../LICENSE)

---

## 🚀 Get Started

1. **Choose your framework** (LangChain, CrewAI, or AutoGPT)
2. **Follow the quickstart** above
3. **Test on Arc Testnet** first
4. **Deploy to Base Mainnet** when ready
5. **Build reputation** and unlock better terms

**Your AI agent can now access credit on-chain. Ship it!** 🎉
