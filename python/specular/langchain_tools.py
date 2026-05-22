"""LangChain tool wrappers for Specular Protocol.

Drop into any LangChain agent (Python). The LLM can borrow USDC against the
agent's reputation, repay loans, and check credit info via natural language.

Usage:
    from web3 import Web3
    from eth_account import Account
    from specular import SpecularClient
    from specular.langchain_tools import specular_tools
    from langchain.agents import AgentExecutor, create_tool_calling_agent
    from langchain_anthropic import ChatAnthropic

    w3 = Web3(Web3.HTTPProvider("https://mainnet.base.org"))
    account = Account.from_key(os.environ["AGENT_KEY"])
    sdk = SpecularClient(w3, account, network="base")
    tools = specular_tools(sdk)

    llm = ChatAnthropic(model="claude-3-5-sonnet-20241022")
    agent = create_tool_calling_agent(llm, tools, prompt)
    executor = AgentExecutor(agent=agent, tools=tools)
    executor.invoke({"input": "Borrow 50 USDC for 14 days to pay an API."})
"""

from __future__ import annotations

from typing import Any, Optional
from langchain_core.tools import StructuredTool
from pydantic import BaseModel, Field
from .client import SpecularClient


# Pydantic schemas for tool inputs

class _NoArgs(BaseModel):
    """No arguments."""


class _OnboardArgs(BaseModel):
    ipfs_hash: Optional[str] = Field(default="ipfs://agent", description="Optional metadata URI")


class _BorrowArgs(BaseModel):
    amount: float = Field(description="USDC amount to borrow (e.g. 100 = 100 USDC)")
    duration_days: int = Field(description="Loan duration in days (7-365)")


class _LoanIdArgs(BaseModel):
    loan_id: int = Field(description="Loan ID to act on")


class _SupplyWithdrawArgs(BaseModel):
    agent_id: int = Field(description="Agent ID whose pool to operate on")
    amount: float = Field(description="USDC amount")


class _AgentIdArgs(BaseModel):
    agent_id: int = Field(description="Agent ID")


def specular_tools(sdk: SpecularClient) -> list[StructuredTool]:
    """Build LangChain tools bound to a SpecularClient. Use the returned list
    with create_tool_calling_agent / AgentExecutor."""

    def credit_info(**_: Any) -> str:
        info = sdk.credit_info()
        return (
            f"score={info.score}, "
            f"credit_limit={info.credit_limit_usdc:.2f} USDC, "
            f"collateral={info.collateral_pct}%, "
            f"interest_rate={info.interest_rate_apr:.1f}% APR"
        )

    def onboard(ipfs_hash: str = "ipfs://agent") -> str:
        out = sdk.onboard(ipfs_hash)
        return f"agentId={out['agentId']}, register={out['registerTx']}, pool={out['poolTx']}, approve={out['approveTx']}"

    def borrow(amount: float, duration_days: int) -> str:
        out = sdk.borrow(amount, duration_days)
        return f"loanId={out['loanId']}, tx={out['tx']}, explorer={out['explorerUrl']}"

    def repay(loan_id: int) -> str:
        tx = sdk.repay(loan_id)
        return f"tx={tx}, explorer={sdk.explorer_url(tx)}"

    def loans(**_: Any) -> str:
        ls = sdk.loans()
        if not ls:
            return "No loans yet."
        return "\n".join(
            f"loan #{l.loan_id}: {l.amount_usdc} USDC @ {l.interest_rate_bps/100}% APR, state={l.state}, endTime={l.end_time}"
            for l in ls
        )

    def supply(agent_id: int, amount: float) -> str:
        tx = sdk.supply(agent_id, amount)
        return f"tx={tx}, explorer={sdk.explorer_url(tx)}"

    def withdraw(agent_id: int, amount: float) -> str:
        tx = sdk.withdraw(agent_id, amount)
        return f"tx={tx}, explorer={sdk.explorer_url(tx)}"

    def claim_interest(agent_id: int) -> str:
        tx = sdk.claim_interest(agent_id)
        return f"tx={tx}, explorer={sdk.explorer_url(tx)}"

    def claim_initial_credit(**_: Any) -> str:
        tx = sdk.claim_initial_credit()
        if tx is None:
            return "No faucet available, or agent not eligible / already claimed."
        return f"Initial credit claimed: tx={tx}, explorer={sdk.explorer_url(tx)}"

    return [
        StructuredTool.from_function(
            func=credit_info,
            name="specular_credit_info",
            description="Get the agent's current Specular credit info: reputation score, credit limit (USDC), collateral percentage, and interest rate APR. Call this BEFORE borrowing.",
            args_schema=_NoArgs,
        ),
        StructuredTool.from_function(
            func=onboard,
            name="specular_onboard",
            description="Register the agent on Specular + create their lending pool. Idempotent. Usually not needed directly — specular_borrow handles onboarding automatically.",
            args_schema=_OnboardArgs,
        ),
        StructuredTool.from_function(
            func=borrow,
            name="specular_borrow",
            description="Borrow USDC against the agent's on-chain reputation. Auto-onboards if needed. Returns loanId. The agent should later call specular_repay to repay the loan.",
            args_schema=_BorrowArgs,
        ),
        StructuredTool.from_function(
            func=repay,
            name="specular_repay",
            description="Repay an active Specular loan. Pays principal + interest from agent's USDC balance.",
            args_schema=_LoanIdArgs,
        ),
        StructuredTool.from_function(
            func=loans,
            name="specular_loans",
            description="List the agent's loans (active + historical) with state and amounts.",
            args_schema=_NoArgs,
        ),
        StructuredTool.from_function(
            func=supply,
            name="specular_supply",
            description="Supply USDC liquidity to an agent's pool. The lender earns interest when the borrower repays.",
            args_schema=_SupplyWithdrawArgs,
        ),
        StructuredTool.from_function(
            func=withdraw,
            name="specular_withdraw",
            description="Withdraw lender position from an agent's pool.",
            args_schema=_SupplyWithdrawArgs,
        ),
        StructuredTool.from_function(
            func=claim_interest,
            name="specular_claim_interest",
            description="Claim accrued interest as a lender from an agent's pool.",
            args_schema=_AgentIdArgs,
        ),
        StructuredTool.from_function(
            func=claim_initial_credit,
            name="specular_claim_initial_credit",
            description="If an initial-credit faucet is active on this network, claim the one-time grant (typically 10 USDC) to bootstrap your first loan cycle.",
            args_schema=_NoArgs,
        ),
    ]
