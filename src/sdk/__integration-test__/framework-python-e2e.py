"""Python framework integrations e2e — invoke each Python tool with real wallet.

Tests:
  - specular.SpecularClient (the base SDK)
  - specular.openai_tools (specular_functions, execute_specular_function)
  - specular.anthropic_tools (specular_anthropic_tools, execute_specular_anthropic_tool)
  - specular.langchain_tools (specular_tools)  [requires langchain installed]
"""

import json
import os
import sys
import warnings

# Suppress urllib3 LibreSSL warning on macOS system python3.9
warnings.filterwarnings("ignore")

# Add python/ to sys.path so we can import specular
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "../../../python"))

from specular.client import SpecularClient
from web3 import Web3
from eth_account import Account
from specular.openai_tools import specular_functions, execute_specular_function
from specular.anthropic_tools import specular_anthropic_tools, execute_specular_anthropic_tool

PASS = 0
FAIL = 0


def log(name, ok, detail=""):
    global PASS, FAIL
    if ok:
        PASS += 1
        print(f"  PASS {name}: {detail}")
    else:
        FAIL += 1
        print(f"  FAIL {name}: {detail}")


def try_run(label, fn):
    try:
        r = fn()
        log(label, True, json.dumps(r) if not isinstance(r, str) else r[:160])
        return r
    except Exception as e:
        log(label, False, f"{type(e).__name__}: {str(e)[:200]}")
        return None


def main():
    pk = os.environ.get("PRIVATE_KEY")
    if not pk:
        print("PRIVATE_KEY not set")
        sys.exit(2)

    rpc = os.environ.get("ARC_TESTNET_RPC_URL", "https://arc-testnet.drpc.org")
    w3 = Web3(Web3.HTTPProvider(rpc))
    account = Account.from_key(pk)
    sdk = SpecularClient(w3, account, network="arc")
    print(f"Agent: {sdk.account.address}")
    print(f"RPC:   {rpc}\n")

    # === BASE SDK ===
    print("=== Python SpecularClient ===")
    try_run("creditInfo", lambda: sdk.credit_info().__dict__)
    try_run("loans", lambda: [l.__dict__ for l in sdk.loans()][:3])

    # === OPENAI ===
    print("\n=== OpenAI Functions ===")
    fns = specular_functions()
    log("returns list", isinstance(fns, list), f"{len(fns)} functions")
    by_name = {f["function"]["name"]: f for f in fns}
    expected = ["specular_credit_info", "specular_onboard", "specular_borrow",
                "specular_repay", "specular_loans"]
    for n in expected:
        log(f"function {n}", n in by_name, f"params: {','.join(by_name[n]['function']['parameters'].get('properties', {}).keys()) or '(none)'}" if n in by_name else "missing")
    try_run("openai credit_info", lambda: execute_specular_function(sdk, "specular_credit_info", {}))
    try_run("openai loans", lambda: execute_specular_function(sdk, "specular_loans", {}))
    borrow_result = try_run("openai borrow(0.5, 7d)",
        lambda: execute_specular_function(sdk, "specular_borrow", {"amount": 0.5, "duration_days": 7}))
    if borrow_result:
        try:
            parsed = json.loads(borrow_result) if isinstance(borrow_result, str) else borrow_result
            loan_id = parsed.get("loanId") or parsed.get("loan_id")
            if loan_id is not None:
                try_run(f"openai repay({loan_id})",
                    lambda: execute_specular_function(sdk, "specular_repay", {"loan_id": loan_id}))
            else:
                log("openai borrow returned loanId", False, str(parsed)[:200])
        except Exception as e:
            log("openai parse loanId", False, str(e))

    # === ANTHROPIC ===
    print("\n=== Anthropic Tool Use ===")
    tools = specular_anthropic_tools()
    log("returns list", isinstance(tools, list), f"{len(tools)} tools")
    by_name = {t["name"]: t for t in tools}
    for n in expected:
        log(f"tool {n}", n in by_name, f"schema={by_name[n]['input_schema']['type']}" if n in by_name else "missing")
    try_run("anthropic credit_info", lambda: execute_specular_anthropic_tool(sdk, "specular_credit_info", {}))
    try_run("anthropic loans", lambda: execute_specular_anthropic_tool(sdk, "specular_loans", {}))
    borrow_result = try_run("anthropic borrow(0.5, 7d)",
        lambda: execute_specular_anthropic_tool(sdk, "specular_borrow", {"amount": 0.5, "duration_days": 7}))
    if borrow_result:
        try:
            parsed = json.loads(borrow_result) if isinstance(borrow_result, str) else borrow_result
            loan_id = parsed.get("loanId") or parsed.get("loan_id")
            if loan_id is not None:
                try_run(f"anthropic repay({loan_id})",
                    lambda: execute_specular_anthropic_tool(sdk, "specular_repay", {"loan_id": loan_id}))
        except Exception as e:
            log("anthropic parse loanId", False, str(e))

    # === LANGCHAIN ===
    # Optional — skip if langchain not installed
    print("\n=== LangChain (optional) ===")
    try:
        from specular.langchain_tools import specular_tools
        lc_tools = specular_tools(sdk)
        log("langchain tools list", isinstance(lc_tools, list), f"{len(lc_tools)} tools")
        by_name = {t.name: t for t in lc_tools}
        for n in ["specular_credit_info", "specular_loans", "specular_borrow", "specular_repay"]:
            log(f"tool {n}", n in by_name, "present" if n in by_name else "missing")
        if "specular_credit_info" in by_name:
            try_run("langchain credit_info", lambda: by_name["specular_credit_info"].invoke({}))
    except ImportError as e:
        log("langchain import", False, f"langchain not installed: {e}")
    except Exception as e:
        log("langchain unexpected error", False, f"{type(e).__name__}: {e}")

    print(f"\n=== TOTAL: {PASS} pass, {FAIL} fail ===")
    sys.exit(0 if FAIL == 0 else 1)


if __name__ == "__main__":
    main()
