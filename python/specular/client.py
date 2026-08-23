"""SpecularClient — Python SDK for Specular Protocol.

Mirrors the JavaScript SpecularQuickstart SDK. Uses web3.py for chain
interaction. Designed to plug into Python agent frameworks (LangChain,
OpenAI Functions, Anthropic Tools, etc.).
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from decimal import Decimal
from pathlib import Path
from typing import Any


def _usdc_units(amount: float | str | int) -> int:
    """Convert a USDC display amount to 6-decimal base units WITHOUT float
    truncation. int(19.99 * 1e6) == 19989999 (one unit short) because 19.99 is
    not exactly representable in binary float; Decimal(str(amount)) avoids that.
    Truncates toward zero for sub-unit precision (never over-spends)."""
    return int(Decimal(str(amount)) * 1_000_000)

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
        # Arc testnet V6-STAGING — the 2026-08 self-audited/fixed stack (levers ON).
        "arc-staging": {
            "addresses_path": REPO_ROOT / "src" / "config" / "arc-testnet-v6-addresses.json",
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
        # arc/arc-staging expose V6 at the _v6 key; Base's canonical V6 is at
        # agentLiquidityMarketplace. Prefer _v6 when present.
        self.marketplace_addr = addr.get("agentLiquidityMarketplace_v6") or addr["agentLiquidityMarketplace"]
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
            # 'pending' (not the default 'latest') so rapid sequential sends
            # don't reuse a nonce and hit "nonce too low".
            "nonce": self.w3.eth.get_transaction_count(self.account.address, "pending"),
        })
        # Estimate gas
        tx["gas"] = self.w3.eth.estimate_gas(tx)
        signed = self.account.sign_transaction(tx)
        tx_hash = self.w3.eth.send_raw_transaction(signed.raw_transaction)
        receipt = self.w3.eth.wait_for_transaction_receipt(tx_hash)
        # A mined receipt is not a successful one: status 0 means the EVM
        # reverted. Without this check a reverted repay/supply/withdraw returns
        # its hash as "success" and the calling agent (or LLM tool wrapper)
        # treats the loan as repaid — later defaulting for real.
        if receipt["status"] != 1:
            raise RuntimeError(f"transaction {tx_hash.hex()} reverted (status 0)")
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

        # No blanket approval: each USDC-pulling op (borrow collateral, repay,
        # supply) approves EXACTLY what it needs just-in-time. approveTx stays in
        # the return shape (always None) for backward compatibility.
        return out

    def _approve_exact(self, amount: int) -> str | None:
        """Approve exactly `amount` (base units) to the marketplace if the current
        allowance doesn't already cover it. Bounds a single marketplace bug to
        the amount in flight rather than the wallet's whole USDC balance."""
        if amount <= 0:
            return None
        current = self.usdc.functions.allowance(self.account.address, self.marketplace_addr).call()
        if current >= amount:
            return None
        return self._send(self.usdc.functions.approve(self.marketplace_addr, amount))

    def revoke_approval(self) -> str | None:
        """Set the marketplace USDC allowance to 0. Returns tx hash or None."""
        current = self.usdc.functions.allowance(self.account.address, self.marketplace_addr).call()
        if current == 0:
            return None
        return self._send(self.usdc.functions.approve(self.marketplace_addr, 0))

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
        if duration_days < 7 or duration_days > 365:
            raise ValueError("duration_days must be 7-365")
        self.onboard()  # idempotent
        amt_units = _usdc_units(amount)
        # Low-reputation agents must post collateral, pulled by requestLoan.
        # required = amount * collateralPercent / 100 (matches the contract).
        coll_pct = self.reputation.functions.calculateCollateralRequirement(self.account.address).call()
        self._approve_exact(amt_units * coll_pct // 100)
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
        # Approve exactly the total owed (principal + interest). Interest is
        # computed from loan.duration (fixed full term), not elapsed time, so the
        # client figure matches the contract to the base unit.
        # loan tuple: (loanId, borrower, agentId, amount, collateralAmount,
        #              interestRate, startTime, endTime, duration, state)
        loan = self.marketplace.functions.loans(loan_id).call()
        interest = self.marketplace.functions.calculateInterest(loan[3], loan[5], loan[8]).call()
        self._approve_exact(loan[3] + interest)
        return self._send(self.marketplace.functions.repayLoan(loan_id))

    def supply(self, agent_id: int, amount: float) -> str:
        amt = _usdc_units(amount)
        self._approve_exact(amt)
        return self._send(self.marketplace.functions.supplyLiquidity(agent_id, amt))

    def withdraw(self, agent_id: int, amount: float) -> str:
        amt = _usdc_units(amount)
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
