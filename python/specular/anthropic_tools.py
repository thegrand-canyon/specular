"""Anthropic Tool Use tool definitions for Specular Protocol.

Direct Claude Messages API integration (no LangChain dependency).

Usage:
    import anthropic
    from specular import SpecularClient
    from specular.anthropic_tools import specular_anthropic_tools, execute_specular_anthropic_tool

    client = anthropic.Anthropic()
    sdk = SpecularClient(w3, account, network='base')

    resp = client.messages.create(
        model='claude-3-5-sonnet-20241022',
        max_tokens=1024,
        tools=specular_anthropic_tools(),
        messages=[{'role': 'user', 'content': 'Check my credit, then borrow 50 USDC for 14 days.'}],
    )
    for block in resp.content:
        if block.type == 'tool_use':
            result = execute_specular_anthropic_tool(sdk, block.name, block.input)
            # Feed result back to Claude in the next turn
"""

from __future__ import annotations

import json
from dataclasses import asdict
from typing import Any
from .client import SpecularClient


def specular_anthropic_tools() -> list[dict[str, Any]]:
    return [
        {
            "name": "specular_credit_info",
            "description": "Get the agent's Specular Protocol credit info: reputation score, credit limit (USDC), collateral percentage required, interest rate APR. Call BEFORE borrowing.",
            "input_schema": {"type": "object", "properties": {}, "required": []},
        },
        {
            "name": "specular_onboard",
            "description": "Register the agent on Specular + create lending pool. Idempotent. Usually unnecessary — specular_borrow handles it.",
            "input_schema": {
                "type": "object",
                "properties": {"ipfs_hash": {"type": "string"}},
                "required": [],
            },
        },
        {
            "name": "specular_borrow",
            "description": "Borrow USDC against the agent's reputation. Auto-onboards if needed.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "amount": {"type": "number"},
                    "duration_days": {"type": "integer"},
                },
                "required": ["amount", "duration_days"],
            },
        },
        {
            "name": "specular_repay",
            "description": "Repay an active loan. Pulls principal + interest from agent's USDC.",
            "input_schema": {
                "type": "object",
                "properties": {"loan_id": {"type": "integer"}},
                "required": ["loan_id"],
            },
        },
        {
            "name": "specular_loans",
            "description": "List the agent's loans (active + historical).",
            "input_schema": {"type": "object", "properties": {}, "required": []},
        },
        {
            "name": "specular_claim_initial_credit",
            "description": "Claim one-time initial-credit grant from the Specular faucet (if active).",
            "input_schema": {"type": "object", "properties": {}, "required": []},
        },
    ]


def execute_specular_anthropic_tool(sdk: SpecularClient, name: str, args: dict[str, Any] | None = None) -> str:
    args = args or {}
    try:
        if name == "specular_credit_info":
            return json.dumps(asdict(sdk.credit_info()))
        if name == "specular_onboard":
            return json.dumps(sdk.onboard(args.get("ipfs_hash", "ipfs://agent")))
        if name == "specular_borrow":
            return json.dumps(sdk.borrow(args["amount"], args["duration_days"]))
        if name == "specular_repay":
            return json.dumps({"txHash": sdk.repay(args["loan_id"])})
        if name == "specular_loans":
            return json.dumps([asdict(l) for l in sdk.loans()])
        if name == "specular_claim_initial_credit":
            tx = sdk.claim_initial_credit()
            return json.dumps({"txHash": tx, "claimed": tx is not None})
        return json.dumps({"error": f"Unknown tool: {name}"})
    except Exception as e:
        return json.dumps({"error": str(e)})
