"""OpenAI Functions / Assistants API tool definitions for Specular.

Drop the output of `specular_functions()` directly into chat.completions.create
or the Assistants API as `tools=...`. Dispatch with `execute_specular_function()`.

Usage:
    from openai import OpenAI
    from specular import SpecularClient
    from specular.openai_tools import specular_functions, execute_specular_function

    client = OpenAI()
    sdk = SpecularClient(w3, account, network='base')

    resp = client.chat.completions.create(
        model='gpt-4o',
        messages=[{'role': 'user', 'content': 'Borrow 50 USDC for 14 days.'}],
        tools=specular_functions(),
    )
    for call in resp.choices[0].message.tool_calls or []:
        result = execute_specular_function(sdk, call.function.name, json.loads(call.function.arguments))
        # Feed back to model
"""

from __future__ import annotations

import json
from dataclasses import asdict
from typing import Any
from .client import SpecularClient


def specular_functions() -> list[dict[str, Any]]:
    """Return the OpenAI tools schema for Specular operations."""
    return [
        {
            "type": "function",
            "function": {
                "name": "specular_credit_info",
                "description": "Get the agent's Specular credit info: reputation score, credit limit (USDC), collateral percentage, interest rate APR. Call BEFORE borrowing.",
                "parameters": {"type": "object", "properties": {}, "required": []},
            },
        },
        {
            "type": "function",
            "function": {
                "name": "specular_onboard",
                "description": "Register the agent + create lending pool. Idempotent. Usually unnecessary — specular_borrow handles it.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "ipfs_hash": {"type": "string", "description": "Optional metadata URI"}
                    },
                    "required": [],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "specular_borrow",
                "description": "Borrow USDC against the agent's reputation. Auto-onboards if needed.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "amount": {"type": "number", "description": "USDC amount"},
                        "duration_days": {"type": "integer", "description": "7-365"},
                    },
                    "required": ["amount", "duration_days"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "specular_repay",
                "description": "Repay an active loan. Principal + interest pulled from the agent's USDC balance.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "loan_id": {"type": "integer", "description": "Loan ID from specular_borrow"}
                    },
                    "required": ["loan_id"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "specular_loans",
                "description": "List the agent's loans (active + historical).",
                "parameters": {"type": "object", "properties": {}, "required": []},
            },
        },
        {
            "type": "function",
            "function": {
                "name": "specular_claim_initial_credit",
                "description": "If a faucet is active on this network, claim the one-time 10 USDC initial credit grant.",
                "parameters": {"type": "object", "properties": {}, "required": []},
            },
        },
    ]


def execute_specular_function(sdk: SpecularClient, name: str, args: dict[str, Any] | None = None) -> str:
    """Execute a function call against an SDK instance. Returns JSON string
    suitable for `tool_result` content in the next message."""
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
        return json.dumps({"error": f"Unknown function: {name}"})
    except Exception as e:
        return json.dumps({"error": str(e)})
