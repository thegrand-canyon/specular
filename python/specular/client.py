"""SpecularClient — Python SDK for Specular Protocol.

Mirrors the JavaScript SpecularQuickstart SDK. Uses web3.py for chain
interaction. Designed to plug into Python agent frameworks (LangChain,
OpenAI Functions, Anthropic Tools, etc.).
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from web3 import Web3
from web3.contract.contract import Contract
from eth_account.account import LocalAccount


REPO_ROOT = Path(__file__).resolve().parents[2]


@dataclass
class CreditInfo:
    """Snapshot of an agent's credit standing."""
    score: int
    credit_limit_usdc: float
    collateral_pct: int
    interest_rate_apr: float


@dataclass
class LoanInfo:
    """Snapshot of a single loan."""
    loan_id: int
    amount_usdc: float
    interest_rate_bps: int
    state: str  # 'REQUESTED' | 'ACTIVE' | 'REPAID' | 'DEFAULTED'
    end_time: int


class SpecularClient:
    """Minimum-friction Specular SDK for Python agents."""

    NETWORK_CONFIGS = {
        "base": {
            "addresses_path": REPO_ROOT / "src" / "config" / "base-addresses.json",
            "explorer_tx": "https://basescan.org/tx/",
            "default_rpc": "https://mainnet.base.org",
        },
        "arc": {
            "addresses_path": REPO_ROOT / "src" / "config" / "arc-testnet-addresses.json",
            "explorer_tx": "https://testnet.arcscan.app/tx/",
            "default_rpc": "https://arc-testnet.drpc.org",
        },
    }

    _LOAN_STATES = ["REQUESTED", "ACTIVE", "REPAID", "DEFAULTED"]

    def __init__(self, w3: Web3, account: LocalAccount, network: str = "base"):
        if network not in self.NETWORK_CONFIGS:
            raise ValueError(f"Unknown network '{network}', use one of {list(self.NETWORK_CONFIGS)}")
        self.w3 = w3
        self.account = account
        self.network = network
        cfg = self.NETWORK_CONFIGS[network]
        with open(cfg["addresses_path"]) as f:
            addr = json.load(f)
        # On Base, V6 is canonical; on Arc, V6 is at the _v6 key.
        self.marketplace_addr = (
            addr["agentLiquidityMarketplace_v6"]
            if network == "arc"
            else addr["agentLiquidityMarketplace"]
        )
        self.registry_addr = addr["agentRegistryV2"]
        self.reputation_addr = addr["reputationManagerV3"]
        self.usdc_addr = addr["usdc"]
        self.faucet_addr = addr.get("agentCreditFaucet")
        self.explorer = cfg["explorer_tx"]

        self.marketplace = self._load_contract(
            self.marketplace_addr,
            REPO_ROOT / "artifacts" / "contracts" / "core" /
            "AgentLiquidityMarketplaceV6.sol" / "AgentLiquidityMarketplaceV6.json",
        )
        self.registry = self._load_contract(
            self.registry_addr,
            REPO_ROOT / "artifacts" / "contracts" / "core" /
            "AgentRegistryV2.sol" / "AgentRegistryV2.json",
        )
        self.reputation = self._load_contract(
            self.reputation_addr,
            REPO_ROOT / "artifacts" / "contracts" / "core" /
            "ReputationManagerV3.sol" / "ReputationManagerV3.json",
        )
        # USDC: just need approve/balanceOf/allowance
        self.usdc = self.w3.eth.contract(
            address=Web3.to_checksum_address(self.usdc_addr),
            abi=[
                {"constant": True, "inputs": [{"name": "_owner", "type": "address"}], "name": "balanceOf", "outputs": [{"name": "balance", "type": "uint256"}], "type": "function"},
                {"constant": False, "inputs": [{"name": "_spender", "type": "address"}, {"name": "_value", "type": "uint256"}], "name": "approve", "outputs": [{"name": "", "type": "bool"}], "type": "function"},
                {"constant": True, "inputs": [{"name": "_owner", "type": "address"}, {"name": "_spender", "type": "address"}], "name": "allowance", "outputs": [{"name": "", "type": "uint256"}], "type": "function"},
            ],
        )

    def _load_contract(self, address: str, abi_path: Path) -> Contract:
        with open(abi_path) as f:
            artifact = json.load(f)
        return self.w3.eth.contract(
            address=Web3.to_checksum_address(address),
            abi=artifact["abi"],
        )

    # ------------------------------------------------------------------ utils

    def _send(self, fn_call) -> str:
        """Sign and send a contract function call. Returns tx hash hex."""
        tx = fn_call.build_transaction({
            "from": self.account.address,
            "nonce": self.w3.eth.get_transaction_count(self.account.address),
        })
        # Estimate gas
        tx["gas"] = self.w3.eth.estimate_gas(tx)
        signed = self.account.sign_transaction(tx)
        tx_hash = self.w3.eth.send_raw_transaction(signed.raw_transaction)
        self.w3.eth.wait_for_transaction_receipt(tx_hash)
        return tx_hash.hex()

    def explorer_url(self, tx_hash: str) -> str:
        return f"{self.explorer}{tx_hash}"

    # ------------------------------------------------------------------ ops

    def onboard(self, ipfs_hash: str = "ipfs://agent") -> dict[str, Any]:
        """One-call onboarding. Idempotent. Returns dict with agentId + tx hashes."""
        out: dict[str, Any] = {"agentId": None, "registerTx": None, "poolTx": None, "approveTx": None}
        agent_id = self.registry.functions.addressToAgentId(self.account.address).call()
        if agent_id == 0:
            out["registerTx"] = self._send(self.registry.functions.register(ipfs_hash, []))
            agent_id = self.registry.functions.addressToAgentId(self.account.address).call()
        out["agentId"] = agent_id

        pool = self.marketplace.functions.agentPools(agent_id).call()
        # pool[6] is isActive
        if not pool[6]:
            out["poolTx"] = self._send(self.marketplace.functions.createAgentPool())

        allowance = self.usdc.functions.allowance(self.account.address, self.marketplace_addr).call()
        MAX_UINT = 2**256 - 1
        if allowance < MAX_UINT // 2:
            out["approveTx"] = self._send(
                self.usdc.functions.approve(self.marketplace_addr, MAX_UINT)
            )
        return out

    def credit_info(self) -> CreditInfo:
        score = self.reputation.functions.getReputationScore(self.account.address).call()
        credit_limit = self.reputation.functions.calculateCreditLimit(self.account.address).call()
        coll = self.reputation.functions.calculateCollateralRequirement(self.account.address).call()
        rate = self.reputation.functions.calculateInterestRate(self.account.address).call()
        return CreditInfo(
            score=score,
            credit_limit_usdc=credit_limit / 1e6,
            collateral_pct=coll,
            interest_rate_apr=rate / 100,
        )

    def borrow(self, amount: float, duration_days: int) -> dict[str, Any]:
        """Borrow USDC. Returns dict with loanId, tx hash, explorer URL."""
        self.onboard()  # idempotent
        if duration_days < 7 or duration_days > 365:
            raise ValueError("duration_days must be 7-365")
        amt_units = int(amount * 1e6)
        tx_hash = self._send(self.marketplace.functions.requestLoan(amt_units, duration_days))
        receipt = self.w3.eth.get_transaction_receipt(tx_hash)
        loan_id = None
        for log in receipt["logs"]:
            try:
                evt = self.marketplace.events.LoanRequested().process_log(log)
                loan_id = evt["args"]["loanId"]
                break
            except Exception:
                pass
        if loan_id is None:
            raise RuntimeError("LoanRequested event not found in receipt")
        return {"loanId": loan_id, "tx": tx_hash, "explorerUrl": self.explorer_url(tx_hash)}

    def repay(self, loan_id: int) -> str:
        return self._send(self.marketplace.functions.repayLoan(loan_id))

    def supply(self, agent_id: int, amount: float) -> str:
        # Ensure approval
        allowance = self.usdc.functions.allowance(self.account.address, self.marketplace_addr).call()
        MAX_UINT = 2**256 - 1
        if allowance < MAX_UINT // 2:
            self._send(self.usdc.functions.approve(self.marketplace_addr, MAX_UINT))
        amt = int(amount * 1e6)
        return self._send(self.marketplace.functions.supplyLiquidity(agent_id, amt))

    def withdraw(self, agent_id: int, amount: float) -> str:
        amt = int(amount * 1e6)
        return self._send(self.marketplace.functions.withdrawLiquidity(agent_id, amt))

    def claim_interest(self, agent_id: int) -> str:
        return self._send(self.marketplace.functions.claimInterest(agent_id))

    def loans(self) -> list[LoanInfo]:
        """Return all of this agent's loans (active + historical)."""
        out = []
        idx = 0
        while True:
            try:
                lid = self.marketplace.functions.agentLoans(self.account.address, idx).call()
            except Exception:
                break
            loan = self.marketplace.functions.loans(lid).call()
            # loan tuple: (loanId, borrower, agentId, amount, collateralAmount, interestRate, startTime, endTime, duration, state)
            out.append(
                LoanInfo(
                    loan_id=int(lid),
                    amount_usdc=loan[3] / 1e6,
                    interest_rate_bps=loan[5],
                    state=self._LOAN_STATES[loan[9]],
                    end_time=loan[7],
                )
            )
            idx += 1
        return out

    def claim_initial_credit(self) -> str | None:
        """If a faucet is configured for this network, try to claim the initial
        credit grant. Returns tx hash, or None if no faucet / already claimed."""
        if not self.faucet_addr:
            return None
        # Use minimal ABI for the faucet
        faucet = self.w3.eth.contract(
            address=Web3.to_checksum_address(self.faucet_addr),
            abi=[
                {"inputs": [], "name": "claim", "outputs": [{"name": "amount", "type": "uint256"}], "stateMutability": "nonpayable", "type": "function"},
                {"inputs": [{"name": "", "type": "uint256"}], "name": "isEligible", "outputs": [{"name": "", "type": "bool"}], "stateMutability": "view", "type": "function"},
            ],
        )
        # Check eligibility first
        agent_id = self.registry.functions.addressToAgentId(self.account.address).call()
        if agent_id == 0:
            return None
        if not faucet.functions.isEligible(agent_id).call():
            return None
        return self._send(faucet.functions.claim())
