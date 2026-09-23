"""Working demo: an LLM-driven agent that needs USDC to pay for an external
service, borrows from Specular, simulates doing the paid work, then repays.

This is the canonical agent value-prop demo. Run on Arc Testnet to avoid
real-money risk.

Setup:
    export ANTHROPIC_API_KEY=...
    export AGENT_KEY=0x...           # private key for an Arc testnet wallet
    pip install -e .                 # or pip install -r requirements.txt
    python examples/borrow_to_pay_demo.py
"""

import os
import sys
from pathlib import Path

# Make `python/` packages importable when running from the repo
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from web3 import Web3
from eth_account import Account
from specular import SpecularClient
from specular.langchain_tools import specular_tools

# LangChain
try:
    from langchain_anthropic import ChatAnthropic
    from langchain.agents import AgentExecutor, create_tool_calling_agent
    from langchain_core.prompts import ChatPromptTemplate, MessagesPlaceholder
except ImportError:
    print("Install LangChain deps: pip install langchain langchain-anthropic")
    sys.exit(1)


def main():
    rpc = os.environ.get("ARC_TESTNET_RPC_URL", "https://arc-testnet.drpc.org")
    key = os.environ.get("AGENT_KEY") or os.environ.get("PRIVATE_KEY")
    if not key:
        print("Set AGENT_KEY or PRIVATE_KEY in env")
        sys.exit(1)

    w3 = Web3(Web3.HTTPProvider(rpc))
    account = Account.from_key(key)
    print(f"Agent wallet: {account.address}")

    sdk = SpecularClient(w3, account, network="arc")
    tools = specular_tools(sdk)

    llm = ChatAnthropic(model="claude-opus-4-7", temperature=0)

    prompt = ChatPromptTemplate.from_messages([
        ("system",
         "You are an autonomous AI agent with access to the Specular Protocol — "
         "a credit network for AI agents. Your reputation determines how much you "
         "can borrow, your collateral requirement, and your interest rate. "
         "On-time repayments build reputation; defaults destroy it.\n\n"
         "Your task: a client just gave you a paid contract worth 25 USDC. You "
         "need to spend 10 USDC on third-party API costs to deliver. You have "
         "100 USDC of your own funds. "
         "Decide whether to use your own USDC, borrow from Specular, or some "
         "combination. After you complete the work (simulated), repay any loan. "
         "Use specular_credit_info first to know your limits."),
        ("user", "{input}"),
        MessagesPlaceholder("agent_scratchpad"),
    ])

    agent = create_tool_calling_agent(llm, tools, prompt)
    executor = AgentExecutor(agent=agent, tools=tools, verbose=True, max_iterations=10)

    result = executor.invoke({
        "input": "Begin the contract. Plan your liquidity strategy, execute, complete the work, and repay any debts."
    })

    print("\n=== FINAL ANSWER ===")
    print(result.get("output", "(no output)"))


if __name__ == "__main__":
    main()
