#!/usr/bin/env python3
"""S9 — Python client read-side parity against arc-staging.

Reads credit info, pool details, previewRepayment/loan data and V6.1 views for the
S1 agent A (and any ACTIVE loan) through python/specular SpecularClient and writes them to
forensics/output/testing-2026-09-20/results/S9-python.json. The companion
`node scripts/e2e/s9-python-parity.js` reads the same values through the JS SDK and
compares field by field.

Usage: python3 scripts/e2e/s9-python-parity.py  (needs web3 + eth-account; see python/requirements.txt)
"""
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "python"))
OUT = ROOT / "forensics" / "output" / "testing-2026-09-20"

from web3 import Web3
from eth_account import Account
from specular import SpecularClient

RPC = os.environ.get("E2E_ARC_RPC_URL", "https://rpc.testnet.arc.network")


def main() -> None:
    wallets = json.load(open(OUT / "e2e-wallets.json"))
    role = os.environ.get("S9_ROLE", "A")
    acct = Account.from_key(wallets["roles"][role]["privateKey"])
    w3 = Web3(Web3.HTTPProvider(RPC))
    assert w3.eth.chain_id == 5042002, f"refusing: chainId {w3.eth.chain_id}"
    sdk = SpecularClient(w3, acct, network="arc-staging")  # read-only use below; no tx is sent

    agent_id = sdk.registry.functions.addressToAgentId(acct.address).call()
    ci = sdk.credit_info()
    # NOTE: agentPools() (the public struct getter) returns
    #   (agentId, agentAddress, totalLiquidity, availableLiquidity, totalLoaned, totalEarned, isActive).
    # getAgentPool() is a DIFFERENT 7-tuple (agentAddress, totalLiquidity, availableLiquidity,
    # totalLoaned, totalEarned, utilizationRate, lenderCount) — do not index it with the struct order.
    pool = sdk.marketplace.functions.agentPools(agent_id).call()
    active = sdk.active_loan_ids(agent_id)
    loans = sdk.loans()
    lender_addr = Web3.to_checksum_address(wallets["roles"]["L1"]["address"])
    pos = sdk.marketplace.functions.getLenderPosition(agent_id, lender_addr).call()
    out = {
        "source": "python",
        "rpc": RPC,
        "address": acct.address,
        "agentId": int(agent_id),
        "marketplaceVersion": sdk.marketplace_version(),
        "creditInfo": {"score": ci.score, "creditLimitUsdc": ci.credit_limit_usdc, "collateralPct": ci.collateral_pct, "interestRateApr": ci.interest_rate_apr},
        "pool": {"agentId": int(pool[0]), "agentAddress": pool[1], "totalLiquidity": int(pool[2]), "availableLiquidity": int(pool[3]), "totalLoaned": int(pool[4]), "totalEarned": int(pool[5]), "isActive": bool(pool[6])},
        "activeLoanIds": active,
        "loanCount": len(loans),
        "loans": [{"loanId": l.loan_id, "amountUsdc": l.amount_usdc, "interestRateBps": l.interest_rate_bps, "state": l.state, "endTime": l.end_time} for l in loans],
        "lenderPositionL1": {"amount": int(pos[0]), "earnedInterest": int(pos[1]), "depositTimestamp": int(pos[2])},
        "canTopUpL1": sdk.can_top_up(agent_id, lender_addr),
        "previewRepayment": None,
        "previewRepaymentInactiveError": None,
    }
    if active:
        pv = sdk.preview_repayment(active[0])
        out["previewRepayment"] = {"loanId": active[0], **{k: (int(v) if isinstance(v, int) else v) for k, v in pv.items()}}
    # inactive loan must surface the contract revert (not fall back silently)
    if loans:
        repaid = [l for l in loans if l.state == "REPAID"]
        if repaid:
            try:
                sdk.preview_repayment(repaid[-1].loan_id)
                out["previewRepaymentInactiveError"] = "NO ERROR (unexpected)"
            except Exception as e:  # noqa: BLE001
                out["previewRepaymentInactiveError"] = str(e)[:120]
            # the nominal figure for a REPAID loan, for cross-checking against JS
            lid = repaid[-1].loan_id
            loan = sdk.marketplace.functions.loans(lid).call()
            out["nominalInterestRepaidLoan"] = {"loanId": lid, "interest": int(sdk.marketplace.functions.calculateInterest(loan[3], loan[5], loan[8]).call()), "mirror": sdk.interest_for_seconds(loan[3], loan[5], loan[8])}
    (OUT / "results").mkdir(parents=True, exist_ok=True)
    json.dump(out, open(OUT / "results" / "S9-python.json", "w"), indent=2, default=str)
    print(json.dumps(out, indent=2, default=str))


if __name__ == "__main__":
    main()
