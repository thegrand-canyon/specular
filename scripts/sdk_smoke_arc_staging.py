"""Exercise the Python SDK against the FIXED V6 staging stack on Arc testnet.
Confirms client construction (arc-staging), credit_info, borrow, repay, loans
work against the 2026-08-fixed contracts. Uses the deployer account (already
onboarded + funded with staging MockUSDC via the JS smoke)."""
import os
import sys
import warnings

warnings.filterwarnings("ignore")
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "python"))

from web3 import Web3
from eth_account import Account
from specular.client import SpecularClient

RPC = os.environ.get("ARC_TESTNET_RPC_URL", "https://arc-testnet.drpc.org")

PASS = 0
FAIL = 0


def ok(label, cond, detail=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  PASS {label} {detail}")
    else:
        FAIL += 1
        print(f"  FAIL {label} {detail}")


def main():
    pk = os.environ.get("PRIVATE_KEY")
    if not pk:
        print("PRIVATE_KEY not set")
        sys.exit(1)
    w3 = Web3(Web3.HTTPProvider(RPC))
    acct = Account.from_key(pk)
    client = SpecularClient(w3, acct, network="arc-staging")
    ok("client targets fixed staging marketplace",
       client.marketplace_addr.lower() == "0xdbdf60ae5cb46d23aa44c062a4943655a6820f31")

    # Already onboarded by the JS smoke; onboard() is idempotent.
    client.onboard()

    info = client.credit_info()
    print(f"     score={info.score} limit={info.credit_limit_usdc} "
          f"collateral={info.collateral_pct}% rate={info.interest_rate_apr}%")
    ok("credit_info returns a score", isinstance(info.score, int))

    # Small collateralized borrow/repay cycle (fresh-tier agent posts collateral).
    res = client.borrow(2, 7)
    ok("borrow returns loanId", res.get("loanId") is not None, f"(loanId {res.get('loanId')})")
    tx = client.repay(res["loanId"])
    ok("repay returns tx hash", isinstance(tx, str) and len(tx) > 0)

    loans = client.loans()
    this = next((l for l in loans if l.loan_id == res["loanId"]), None)
    ok("loan shows REPAID", this is not None and this.state == "REPAID")

    print(f"\n=== Python SDK-vs-staging: {PASS} passed, {FAIL} failed ===")
    sys.exit(1 if FAIL else 0)


if __name__ == "__main__":
    main()
