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
        tx = self._send(self.usdc.functions.approve(self.marketplace_addr, amount))
        # [RPC-staleness fix] Public RPCs load-balance across nodes; the just-mined
        # approve may not be visible from the replica the next call hits, which
        # reverts "exceeds allowance". Poll until the new allowance is visible.
        import time as _time
        for _ in range(15):
            if self.usdc.functions.allowance(self.account.address, self.marketplace_addr).call() >= amount:
                break
            _time.sleep(1)
        return tx

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

    # ------------------------------------------------------------- V6.1 views
    # V6.1 (2026-09 audit fixes) added VERSION(), previewRepayment, canTopUp and
    # getActiveLoanIds, and repayLoan now charges interest on max(duration,
    # elapsed) capped at duration + LATE_INTEREST_CAP. Pre-V6.1 deployments have
    # none of those selectors, so every new call is version-gated with a fallback.

    #: Seconds of extra accrual covered between preview and mined repay on a LATE
    #: loan (clamped at the contract cap; leftover allowance is revoked after).
    LATE_REPAY_HEADROOM_SECONDS = 600

    def marketplace_version(self) -> str:
        """Marketplace VERSION(); 'V6' when the deployment predates VERSION()."""
        cached = getattr(self, "_mp_version", None)
        if cached is None:
            try:
                cached = str(self.marketplace.functions.VERSION().call())
            except Exception:
                cached = "V6"
            self._mp_version = cached
        return cached

    def _has_v61_views(self) -> bool:
        return self.marketplace_version() != "V6"

    @staticmethod
    def interest_for_seconds(principal: int, rate_bps: int, seconds: int) -> int:
        """Mirrors calculateInterest() exactly (divide-before-multiply)."""
        annual = (int(principal) * int(rate_bps)) // 10_000
        return (annual * int(seconds)) // (365 * 86_400)

    def preview_repayment(self, loan_id: int) -> dict[str, Any]:
        """Exact amount repayLoan(loan_id) would pull now (base units).

        V6.1: previewRepayment(loanId). V6: nominal fixed-term interest, which is
        what V6 actually charges. Keys: principal, interest, total,
        chargeable_seconds, late_seconds, duration_seconds, interest_rate_bps,
        source ('previewRepayment' | 'calculateInterest')."""
        # loan tuple: (loanId, borrower, agentId, amount, collateralAmount,
        #              interestRate, startTime, endTime, duration, state)
        loan = self.marketplace.functions.loans(loan_id).call()
        principal, rate_bps, duration = loan[3], loan[5], loan[8]
        if self._has_v61_views():
            try:
                interest, total, chargeable, late = self.marketplace.functions.previewRepayment(loan_id).call()
                return {
                    "principal": principal, "interest": interest, "total": total,
                    "chargeable_seconds": chargeable, "late_seconds": late,
                    "duration_seconds": duration, "interest_rate_bps": rate_bps,
                    "source": "previewRepayment",
                }
            except Exception as e:  # a real revert must surface; a missing selector falls back
                if "Loan not active" in str(e):
                    raise
        interest = self.marketplace.functions.calculateInterest(principal, rate_bps, duration).call()
        return {
            "principal": principal, "interest": interest, "total": principal + interest,
            "chargeable_seconds": duration, "late_seconds": 0,
            "duration_seconds": duration, "interest_rate_bps": rate_bps,
            "source": "calculateInterest",
        }

    def _repay_approval(self, loan_id: int) -> tuple[int, dict[str, Any], int]:
        """(amount_to_approve, preview, headroom). Exactly preview['total'] except
        for a loan that is late AND under the interest cap, where the interest
        that can accrue during LATE_REPAY_HEADROOM_SECONDS is added (clamped at
        duration + LATE_INTEREST_CAP, so never more than the contract could pull)."""
        pv = self.preview_repayment(loan_id)
        headroom = 0
        if pv["source"] == "previewRepayment" and pv["late_seconds"] > 0:
            try:
                cap = int(self.marketplace.functions.LATE_INTEREST_CAP().call())
            except Exception:
                cap = 30 * 86_400
            target = min(pv["chargeable_seconds"] + self.LATE_REPAY_HEADROOM_SECONDS, pv["duration_seconds"] + cap)
            with_headroom = self.interest_for_seconds(pv["principal"], pv["interest_rate_bps"], target)
            headroom = max(0, with_headroom - pv["interest"])
        return pv["total"] + headroom, pv, headroom

    def repay(self, loan_id: int) -> str:
        # Approve exactly what the contract will pull: previewRepayment().total on
        # V6.1 (late loans pay for elapsed time, capped at duration + 30 days),
        # principal + nominal interest on V6. Never an unlimited approval.
        approve, _pv, headroom = self._repay_approval(loan_id)
        self._approve_exact(approve)
        tx = self._send(self.marketplace.functions.repayLoan(loan_id))
        if headroom > 0:
            # Late-loan headroom may leave a few base units of allowance; clear it.
            try:
                self.revoke_approval()
            except Exception:
                pass
        return tx

    def can_top_up(self, agent_id: int, lender: str | None = None) -> bool:
        """V6.1: whether `lender` (default: this account) can top up the pool now
        without supplyLiquidity reverting "Top-up would forfeit in-flight
        interest". Always True on V6 and for a lender with no position."""
        if not self._has_v61_views():
            return True
        try:
            return bool(self.marketplace.functions.canTopUp(
                agent_id, Web3.to_checksum_address(lender or self.account.address)).call())
        except Exception:
            return True

    def active_loan_ids(self, agent_id: int) -> list[int]:
        """IDs of the agent's ACTIVE loans (V6.1 getActiveLoanIds; bounded walk on V6)."""
        if self._has_v61_views():
            try:
                return [int(x) for x in self.marketplace.functions.getActiveLoanIds(agent_id).call()]
            except Exception:
                pass
        # pool tuple: (agentId, agentAddress, totalLiquidity, availableLiquidity, totalLoaned, totalEarned, isActive)
        pool = self.marketplace.functions.agentPools(agent_id).call()
        addr = pool[1]
        if not addr or int(addr, 16) == 0:
            return []
        out: list[int] = []
        for idx in range(200):
            try:
                lid = self.marketplace.functions.agentLoans(addr, idx).call()
            except Exception:
                break
            if self.marketplace.functions.loans(lid).call()[9] == 1:
                out.append(int(lid))
        return out

    def supply(self, agent_id: int, amount: float) -> str:
        amt = _usdc_units(amount)
        if self._has_v61_views():
            pos = self.marketplace.functions.getLenderPosition(agent_id, self.account.address).call()
            if pos[0] > 0 and not self.can_top_up(agent_id):
                raise RuntimeError(
                    f"topping up pool #{agent_id} now would forfeit in-flight interest and the contract "
                    "would revert (\"Top-up would forfeit in-flight interest\"). Wait for the pool's older "
                    "active loans to close (check can_top_up(agent_id) first), or open a fresh position "
                    "from another address."
                )
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
