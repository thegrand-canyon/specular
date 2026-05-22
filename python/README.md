# Specular Python SDK

Plug Specular Protocol credit into any Python AI agent. Wraps the on-chain
contracts with a minimum-friction surface: onboard + borrow + repay in three
lines.

## Install

```bash
cd python && pip install -e .
# For LangChain integration:
pip install -e ".[langchain]"
```

## Quickstart

```python
from web3 import Web3
from eth_account import Account
from specular import SpecularClient

w3 = Web3(Web3.HTTPProvider("https://mainnet.base.org"))
account = Account.from_key(os.environ["AGENT_KEY"])
sdk = SpecularClient(w3, account, network="base")

# One call: register + create pool + approve USDC (all idempotent)
sdk.onboard()

# Borrow 100 USDC for 30 days
result = sdk.borrow(amount=100, duration_days=30)
loan_id = result["loanId"]
print(f"Loan {loan_id} ready: {result['explorerUrl']}")

# ... agent does work, earns USDC ...

# Repay
sdk.repay(loan_id)

# Check standing — reputation went up
info = sdk.credit_info()
print(f"Score: {info.score}, credit: {info.credit_limit_usdc} USDC, APR: {info.interest_rate_apr}%")
```

## LangChain

```python
from specular.langchain_tools import specular_tools
from langchain.agents import AgentExecutor, create_tool_calling_agent
from langchain_anthropic import ChatAnthropic

tools = specular_tools(sdk)  # 9 tools: credit_info, onboard, borrow, repay, etc.

llm = ChatAnthropic(model="claude-3-5-sonnet-20241022")
agent = create_tool_calling_agent(llm, tools, prompt)
executor = AgentExecutor(agent=agent, tools=tools)

# The LLM decides what to do
executor.invoke({"input": "I need 50 USDC to pay an API. Borrow what I need and repay later."})
```

Tools available to the LLM:
- `specular_credit_info` — score, limit, rate
- `specular_onboard` — register + pool + approve
- `specular_borrow` — borrow USDC
- `specular_repay` — repay loan
- `specular_loans` — list active/historical loans
- `specular_supply` — supply liquidity (lender)
- `specular_withdraw` — withdraw lender position
- `specular_claim_interest` — claim earned interest
- `specular_claim_initial_credit` — claim faucet grant (if active)

## Networks

| Network | V6 address | Use |
|---------|-----------|-----|
| `base` | `0x0a4e3C745aB95aceb45B05C28D89fe4Db8815F9a` | Production (real USDC) |
| `arc` | `0x7a0560551b2370ee87458186c0b1eFCc38c7c57a` | Testnet (mock USDC) |

## Examples

- `examples/borrow_to_pay_demo.py` — working LLM agent that decides whether to
  use own funds vs. borrow vs. mix, then completes a paid task and repays.
