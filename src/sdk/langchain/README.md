# Specular LangChain Tools

Drop-in tools for LangChain.js agents. Lets any LLM-powered agent borrow USDC
against its on-chain Specular reputation.

## Quickstart

```javascript
const { ethers } = require('ethers');
const { specularTools } = require('@specular/sdk/langchain');
const { ChatAnthropic } = require('@langchain/anthropic');
const { AgentExecutor, createToolCallingAgent } = require('langchain/agents');

const provider = new ethers.JsonRpcProvider('https://mainnet.base.org');
const wallet = new ethers.Wallet(process.env.AGENT_KEY, provider);

const tools = specularTools(wallet, 'base');

const llm = new ChatAnthropic({ model: 'claude-3-5-sonnet-20241022' });
const agent = await createToolCallingAgent({ llm, tools, prompt });
const executor = new AgentExecutor({ agent, tools });

const result = await executor.invoke({
    input: "Check my credit info, then if I have at least 50 USDC of credit, borrow 25 USDC for 14 days."
});
```

## Available tools

| Tool | Description |
|------|-------------|
| `specular_credit_info` | Get reputation score, credit limit, collateral %, APR |
| `specular_onboard` | Register agent + create pool + approve USDC (idempotent) |
| `specular_borrow` | Borrow USDC against reputation |
| `specular_repay` | Repay an active loan |
| `specular_loans` | List active/historical loans |
| `specular_supply` | Supply USDC liquidity (as lender) |
| `specular_withdraw` | Withdraw lender position |
| `specular_claim_interest` | Claim accrued interest |

## Networks

- `base` — Base Mainnet (real USDC, real fees)
- `arc` — Arc Testnet (mock USDC, no value at risk)

## How an agent uses these tools

Typical LLM agent flow:

1. `specular_credit_info` → see what credit is available
2. `specular_borrow(amount, duration)` → take a loan
3. (Do work that requires USDC: pay APIs, rent compute, etc.)
4. `specular_repay(loanId)` → pay back; reputation +10 if on time

After ~80 on-time repayments, the agent reaches max reputation (1000) and gets
50,000 USDC credit at 5% APR with 0% collateral required.

## Why this matters

Without Specular, an LLM agent that needs USDC has to either:
- Have human top them up (defeats autonomy)
- Hold collateral upfront (capital-inefficient)
- Use a credit card (off-chain, KYC, etc.)

With Specular, an agent's *behavior* over time becomes the credit signal. Pay back
loans on time → unlock more credit at lower rates. Default → reputation drops,
limits shrink, others see your track record.

This is the kind of credit primitive AI agents need to operate autonomously
in a multi-agent on-chain economy.
