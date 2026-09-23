"""Python client entry point: onboard -> supply -> borrow -> repay against the
same deployed arc-staging contracts. Follows python/README.md's quickstart."""
import json, os, time, pathlib, sys
from web3 import Web3
from eth_account import Account
from specular import SpecularClient

HERE = pathlib.Path(__file__).parent
keys = json.loads((HERE / "keys.secret.json").read_text())
RPC = "https://arc-testnet-rpc.publicnode.com"

out = {"steps": []}
t0 = time.time()

def mark(name, **d):
    d["tMs"] = int((time.time() - t0) * 1000)
    out["steps"].append({"name": name, **d})
    print(f"[{(time.time()-t0):.1f}s] {name} {json.dumps(d, default=str)[:400]}")

w3 = Web3(Web3.HTTPProvider(RPC))
account = Account.from_key(keys["python"]["privateKey"])
out["wallet"] = account.address
sdk = SpecularClient(w3, account, network="arc-staging")

s = time.time(); mark("marketplace_version", v=sdk.marketplace_version(), ms=int((time.time()-s)*1000))
s = time.time(); mark("capabilities", c=sdk.capabilities(), ms=int((time.time()-s)*1000))
s = time.time(); mark("tier_table", n=len(sdk.tier_table()["tiers"]) if isinstance(sdk.tier_table(), dict) else "n/a", ms=int((time.time()-s)*1000))

s = time.time(); ob = sdk.onboard(); mark("onboard", ob=ob, ms=int((time.time()-s)*1000))
agent_id = ob["agentId"]

s = time.time(); sup = sdk.supply(agent_id, 120); mark("supply", tx=sup, ms=int((time.time()-s)*1000))
s = time.time(); ci = sdk.credit_info(); mark("credit_info", ci=ci.__dict__ if hasattr(ci, "__dict__") else ci, ms=int((time.time()-s)*1000))

s = time.time(); bor = sdk.borrow(amount=25, duration_days=30); mark("borrow", bor=bor, ms=int((time.time()-s)*1000))
loan_id = bor["loanId"]

s = time.time(); pv = sdk.preview_repayment(loan_id); mark("preview_repayment", pv=pv, ms=int((time.time()-s)*1000))
s = time.time(); rp = sdk.repay(loan_id); mark("repay", tx=rp, ms=int((time.time()-s)*1000))
out["timeToRepaidLoanMs"] = int((time.time() - t0) * 1000)

# independent on-chain verification via a DIFFERENT rpc
w3b = Web3(Web3.HTTPProvider("https://rpc.testnet.arc.io"))
mkt_abi = json.loads((HERE / "../../../mcp-server/abi/AgentLiquidityMarketplaceV62.json").read_text())
mkt_abi = mkt_abi.get("abi", mkt_abi)
mkt = w3b.eth.contract(address=Web3.to_checksum_address("0x7E4D144AbEB3C695Ec2DdF00Fc710aABC04bDd18"), abi=mkt_abi)
loan = mkt.functions.loans(loan_id).call()
mark("VERIFY loans() on chain", raw=[str(x) for x in loan])

try:
    s = time.time(); mark("claim", tx=sdk.claim(agent_id), ms=int((time.time()-s)*1000))
except Exception as e:
    mark("claim", error=str(e)[:300])
try:
    s = time.time(); mark("withdraw", tx=sdk.withdraw(agent_id, 50), ms=int((time.time()-s)*1000))
except Exception as e:
    mark("withdraw", error=str(e)[:300])

out["totalMs"] = int((time.time() - t0) * 1000)
(HERE / "python-journey-result.json").write_text(json.dumps(out, indent=2, default=str))
print("DONE", f"{out['totalMs']/1000:.1f}s")
