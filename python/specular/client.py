"""SpecularClient — Python SDK for Specular Protocol.

Mirrors the JavaScript SpecularQuickstart SDK. Uses web3.py for chain
interaction. Designed to plug into Python agent frameworks (LangChain,
OpenAI Functions, Anthropic Tools, etc.).
"""

from __future__ import annotations

import json
import os
import re
import threading
import time
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
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
from eth_utils import keccak


REPO_ROOT = Path(__file__).resolve().parents[2]

_ARTIFACTS = REPO_ROOT / "artifacts" / "contracts" / "core"


def _read_abi(name: str) -> list[dict]:
    with open(_ARTIFACTS / f"{name}.sol" / f"{name}.json") as f:
        return json.load(f)["abi"]


def _frag_key(frag: dict) -> tuple:
    return (frag.get("type"), frag.get("name"), tuple(i.get("type") for i in frag.get("inputs") or ()))


def _union_abi(first: list[dict], second: list[dict]) -> list[dict]:
    """Union two ABIs, keeping the first occurrence of each signature."""
    seen: set[tuple] = set()
    out: list[dict] = []
    for frag in [*first, *second]:
        k = _frag_key(frag)
        if k in seen:
            continue
        seen.add(k)
        out.append(frag)
    return out


_MP_ABI: list[dict] | None = None
_REP_ABI: list[dict] | None = None


def _marketplace_abi() -> list[dict]:
    """Marketplace ABI covering V6, V6.1 and V6.2.

    `AgentLiquidityMarketplaceV62` is a STRICT superset of
    `AgentLiquidityMarketplaceV6` (it adds only `requiredSelfStake` and
    `selfStake`), so every V6/V6.1 call still encodes byte-identically."""
    global _MP_ABI
    if _MP_ABI is None:
        try:
            _MP_ABI = _read_abi("AgentLiquidityMarketplaceV62")
        except FileNotFoundError:
            _MP_ABI = _read_abi("AgentLiquidityMarketplaceV6")
    return _MP_ABI


def _reputation_abi() -> list[dict]:
    """Reputation ABI covering V3 and V4.

    V4 is NOT a superset: it replaces the three `record*` write signatures with
    loanId-carrying ones. Those are `onlyAuthorizedPool` and no client calls
    them, but they are kept so operator tooling sharing this loader still works,
    hence a union rather than a swap."""
    global _REP_ABI
    if _REP_ABI is None:
        v3 = _read_abi("ReputationManagerV3")
        try:
            v4 = _read_abi("ReputationManagerV4")
        except FileNotFoundError:
            v4 = []
        _REP_ABI = _union_abi(v3, v4)
    return _REP_ABI


@dataclass
class CreditInfo:
    """Snapshot of an agent's credit standing.

    Every figure is read from the chain — this client carries no tier table.
    The optional fields are populated only on the deployments that expose them
    (ReputationManagerV4 for the ladder/lockout, AgentLiquidityMarketplaceV62
    for the self-stake) and stay ``None`` elsewhere rather than being faked."""
    score: int
    credit_limit_usdc: float
    collateral_pct: int
    interest_rate_apr: float
    # --- capability ------------------------------------------------------
    marketplace_version: str | None = None
    reputation_version: str | None = None
    # --- ReputationManagerV4 only ----------------------------------------
    agent_id: int | None = None
    tier: int | None = None
    tier_limit_usdc: float | None = None
    ladder_limit_usdc: float | None = None
    max_repaid_principal_usdc: float | None = None
    max_tier_limit_usdc: float | None = None
    locked_out: bool | None = None
    locked_until: int | None = None
    limit_explanation: str | None = None
    # --- AgentLiquidityMarketplaceV62 only -------------------------------
    self_stake: "SelfStakeInfo | None" = None


@dataclass
class SelfStakeInfo:
    """[V6.2] The pool creator's own first-loss position in its own pool.

    ``amount``/``required``/``shortfall`` are USDC base units (6 decimals);
    the ``*_usdc`` fields are the display-unit equivalents."""
    amount: int
    amount_usdc: float
    locked: bool
    required: int
    required_usdc: float
    shortfall: int
    shortfall_usdc: float


@dataclass
class CreditTier:
    """One row of the credit tier table."""
    index: int
    min_score: int
    limit: int
    limit_usdc: float
    collateral_pct: int
    interest_rate_bps: int
    unsecured_exposure: int


class UnsupportedOnDeployment(RuntimeError):
    """A V6.2-only feature was requested on a V6 / V6.1 deployment."""


class LoanEnumerationFailed(RuntimeError):
    """[X-4] The ``agentLoans[]`` walk hit a transient RPC failure.

    Raised instead of returning a silently truncated loan list, which reads as
    "this agent has no outstanding debt"."""


class InsufficientSelfStake(RuntimeError):
    """[V6.2 / M2-c] The borrow would revert "Insufficient self-stake".

    Carries ``agent_id``, ``required``, ``current`` and ``shortfall`` (base units)."""

    def __init__(self, message: str, *, agent_id: int, required: int, current: int, shortfall: int):
        super().__init__(message)
        self.agent_id = agent_id
        self.required = required
        self.current = current
        self.shortfall = shortfall


class SelfStakeLocked(RuntimeError):
    """[V6.2 / M2-a] The withdrawal would revert "Self-stake locked while borrowing"."""

    def __init__(self, message: str, *, agent_id: int, outstanding_principal: int):
        super().__init__(message)
        self.agent_id = agent_id
        self.outstanding_principal = outstanding_principal


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
        # [ROBUSTNESS F-R19] Arc MAINNET (chainId 5042) — the network the protocol
        # actually launched on. The JS SDK has shipped this since 2026-09-19; its
        # absence here meant a Python agent simply could not reach the live
        # deployment (and, worse, would fall back to 'base' by default).
        "arc-mainnet": {
            "addresses_path": REPO_ROOT / "src" / "config" / "arc-mainnet-addresses.json",
            "explorer_tx": "https://explorer.arc.io/tx/",
            "default_rpc": "https://rpc.mainnet.arc.io",
        },
    }

    # ------------------------------------------------------------ robustness
    # Mirrors the JS SpecularQuickstart hardening (2026-09 robustness pass) so a
    # Python agent gets the same guarantees as a JS one.

    #: Wall-clock lag (seconds) beyond which the RPC head is considered stale.
    MAX_BLOCK_LAG_SECONDS = 600
    #: Largest metadata URI written to the registry.
    MAX_METADATA_URI_BYTES = 2048
    #: OpenZeppelin v5 `ERC20InsufficientAllowance(address,uint256,uint256)`.
    ERC20_INSUFFICIENT_ALLOWANCE = "fb8f41b2"

    @staticmethod
    def _selector(signature: str) -> bytes:
        return keccak(text=signature)[:4]

    @staticmethod
    def _to_base_units(amount: Any, ctx: str) -> int:
        """[F-R9 parity] Authoritative amount parsing. Rejects bools, NaN/inf,
        non-positive values and anything Decimal cannot represent, instead of
        letting a negative or NaN reach ABI encoding with an opaque error."""
        if isinstance(amount, bool) or amount is None or isinstance(amount, (dict, list, tuple)):
            raise ValueError(f"{ctx}: amount must be a positive number, got {amount!r}")
        try:
            units = _usdc_units(amount)
        except (InvalidOperation, ValueError, ArithmeticError, TypeError) as e:
            raise ValueError(f"{ctx}: amount {amount!r} is not a representable USDC value ({e})") from e
        if units <= 0:
            raise ValueError(f"{ctx}: amount must be a positive number, got {amount!r}")
        return units

    @staticmethod
    def _to_agent_id(agent_id: Any, ctx: str) -> int:
        """[F-R16 parity] agentId must be a non-negative integer."""
        if isinstance(agent_id, bool) or not isinstance(agent_id, int):
            raise ValueError(f"{ctx}: agentId must be a non-negative integer, got {agent_id!r}")
        if agent_id < 0:
            raise ValueError(f"{ctx}: agentId must be a non-negative integer, got {agent_id!r}")
        return int(agent_id)

    @staticmethod
    def _assert_duration_days(days: Any, ctx: str) -> int:
        """[F-R18] `days < 7 or days > 365` lets float('nan') through — BOTH
        comparisons are False for NaN — and accepts bools and floats."""
        if isinstance(days, bool) or not isinstance(days, int):
            raise ValueError(f"{ctx}: durationDays must be an integer, got {days!r}")
        if days > 365:
            hint = (f" (looks like {days // 86400} days expressed in seconds — pass days instead)"
                    if days % 86400 == 0 else "")
            raise ValueError(f"{ctx}: durationDays={days} exceeds max 365{hint}")
        if days < 7:
            raise ValueError(f"{ctx}: durationDays={days} is below min 7")
        return days

    @staticmethod
    def _assert_metadata_uri(uri: Any, ctx: str = "SpecularClient.onboard") -> str:
        """[F-R17 parity] Bound the metadata URI written to the registry."""
        if not isinstance(uri, str):
            raise ValueError(f"{ctx}: metadata URI must be a string, got {type(uri).__name__}")
        if not uri:
            raise ValueError(f"{ctx}: metadata URI must not be empty")
        n = len(uri.encode("utf-8"))
        if n > SpecularClient.MAX_METADATA_URI_BYTES:
            raise ValueError(
                f"{ctx}: metadata URI is {n} bytes, over the {SpecularClient.MAX_METADATA_URI_BYTES}-byte limit "
                "— store the document off chain and register its URI instead.")
        if re.search(r"[\x00-\x1f]|\s", uri):
            raise ValueError(f"{ctx}: metadata URI must not contain whitespace or control characters")
        return uri

    @staticmethod
    def _is_allowance_shortfall(e: BaseException) -> bool:
        """[F-R3 parity] "the marketplace tried to pull more than I approved".

        The string test alone only matches legacy reverts like Base USDC's
        "ERC20: transfer amount exceeds allowance"; OpenZeppelin v5 tokens raise
        the custom error `ERC20InsufficientAllowance` (selector 0xfb8f41b2),
        whose message carries no words at all.

        [X-9 parity] Marketplace reverts that contain "exceeds" but are not about
        an allowance are excluded first: `Exceeds credit limit` used to be read as
        an allowance shortfall, so the borrow path re-approved
        `collateral + principal` — a transient 2x over-approval for a borrow that
        could never succeed, plus two wasted transactions."""
        msg = str(e)
        if re.search(r"(?i)exceeds (credit limit|pool liquidity|available liquidity|maximum|max )", msg):
            return False
        if re.search(r"(?i)allowance|exceeds|transfer amount", msg):
            return True
        return SpecularClient.ERC20_INSUFFICIENT_ALLOWANCE in msg.lower()

    #: [X-4 parity] JSON-RPC error codes that mean "ask again later", not "the
    #: contract answered". web3 surfaces the upstream code on
    #: ``Web3RPCError.rpc_response``; ethers/web3 both turn a rate limit AND a
    #: data-less revert into an indistinguishable "call failed", and the code is
    #: the only discriminator. Measured on the live Arc endpoints 2026-09-23:
    #: rate limit -> -32005, genuine revert -> 3.
    TRANSIENT_RPC_CODES = frozenset({-32005, -32016, -32002, -32029, -32603, 429})

    @staticmethod
    def _rpc_error_code(e: BaseException) -> int | None:
        for attr in ("rpc_response", "response"):
            resp = getattr(e, attr, None)
            if isinstance(resp, dict):
                code = (resp.get("error") or {}).get("code")
                if isinstance(code, int):
                    return code
        args = getattr(e, "args", ())
        for a in args:
            if isinstance(a, dict) and isinstance(a.get("code"), int):
                return a["code"]
        m = re.search(r"'code':\s*(-?\d+)", str(e))
        return int(m.group(1)) if m else None

    @staticmethod
    def _is_transient_rpc_failure(e: BaseException) -> bool:
        """[X-4 parity] The failure was transport/capacity shaped, so the chain
        never actually answered. Such an error must NEVER be read as "the
        agentLoans array ends here" or "this deployment is an older one"."""
        if e is None:
            return False
        # a revert that carries a reason string is a definite contract answer
        if re.search(r"(?i)execution reverted:\s*\S", str(e)):
            return False
        code = SpecularClient._rpc_error_code(e)
        if code is not None:
            if code in SpecularClient.TRANSIENT_RPC_CODES:
                return True
            if code == 3:
                return False  # "execution reverted" — definite
        if re.search(r"(?i)rate limit|too many requests|throttl|capacity|overloaded|try again|timed? ?out|"
                     r"connection|ECONN|EAI_AGAIN|network|\b(429|500|502|503|504)\b", str(e)):
            return True
        return isinstance(e, (TimeoutError, ConnectionError, OSError))

    def _loan_id_at(self, address: str, index: int, ctx: str) -> int | None:
        """[X-4 parity] One step of the ``agentLoans[]`` walk.

        ``None`` at the genuine end of the array; raises on anything else. The
        walk used to be ``except Exception: break``, which cannot tell "past the
        end" from "the RPC failed while I asked" — and a truncated (often empty)
        loan list is a wrong answer about outstanding debt."""
        try:
            return int(self.marketplace.functions.agentLoans(address, index).call())
        except BaseException as e:  # noqa: BLE001
            if not SpecularClient._is_transient_rpc_failure(e):
                return None  # genuine end of array
            raise LoanEnumerationFailed(
                f"{ctx}: the RPC failed at index {index} of the agentLoans walk for {address} ({e}). "
                "Refusing to report a truncated loan list as complete — an empty or short list here "
                "reads as \"no outstanding debt\". Retry against a healthy RPC.") from e

    @property
    def _write_lock(self) -> threading.RLock:
        """[F-R10 parity] Serialize this key's writes. Every op is multi-tx
        (approve -> act -> revoke) and the nonce is read at send time, so two
        concurrent ops hand the same nonce to two transactions."""
        lock = getattr(self, "_write_lock_obj", None)
        if lock is None:
            lock = threading.RLock()
            self._write_lock_obj = lock
        return lock

    def _note_block(self, n: Any) -> None:
        try:
            b = int(n)
        except (TypeError, ValueError):
            return
        cur = getattr(self, "_max_seen_block", None)
        if cur is None or b > cur:
            self._max_seen_block = b

    def _assert_chain_not_behind(self, ctx: str = "SpecularClient") -> int | None:
        """[F-R5 parity] Refuse to size money from a lagging replica or across a
        reorg: the head must never be below one we already observed, and (on a
        real chain) must not trail wall clock by more than MAX_BLOCK_LAG_SECONDS."""
        if getattr(self, "staleness_check", True) is False:
            return None
        try:
            head = int(self.w3.eth.block_number)
        except Exception:
            return None
        seen = getattr(self, "_max_seen_block", None)
        if seen is not None and head < seen:
            self._max_seen_block = head
            raise RuntimeError(
                f"{ctx}: the RPC is serving state BEHIND what this session already observed "
                f"(head {head} < block {seen} seen earlier). Either it load-balanced onto a lagging replica "
                "or the chain reorged. Refusing to act on stale state — retry, or set "
                "`client.staleness_check = False` to override.")
        self._note_block(head)
        max_lag = getattr(self, "max_block_lag_seconds", SpecularClient.MAX_BLOCK_LAG_SECONDS)
        if max_lag:
            try:
                blk = self.w3.eth.get_block(head)
                lag = int(time.time()) - int(blk["timestamp"])
            except Exception:
                return head
            if lag > max_lag:
                raise RuntimeError(
                    f"{ctx}: RPC head block {head} is {lag}s behind wall clock (max {max_lag}s) — this endpoint "
                    "is serving stale state. Refusing to size an approval or a loan from it.")
        return head

    def _with_approval_cleanup(self, fn):
        """[F-R4 parity] A failure between approve and the pull must not leave a
        standing allowance; the exact-approval resting state is zero."""
        self._approved_this_op = False
        try:
            return fn()
        except BaseException:
            if getattr(self, "_approved_this_op", False):
                try:
                    self._revoke_approval_inner()
                except Exception:
                    pass
            raise
        finally:
            self._approved_this_op = False

    def _code_has_selector(self, signature: str, which: str = "marketplace") -> bool:
        """[F-R1 parity] Capability detection from DEPLOYED BYTECODE, not from
        whether an `eth_call` happened to fail. A 429/500/timeout during a call
        is indistinguishable from a missing selector at the client layer, so the
        old `try: VERSION() except: 'V6'` read one RPC hiccup as "old
        deployment" — and then under-approved every late repayment.

        `which` selects the contract: "marketplace" (default) or "reputation"."""
        attr = "_rep_code" if which == "reputation" else "_mp_code"
        addr = self.reputation_addr if which == "reputation" else self.marketplace_addr
        code = getattr(self, attr, None)
        if code is None:
            code = bytes(self.w3.eth.get_code(Web3.to_checksum_address(addr)))
            if not code:
                raise RuntimeError(
                    f"SpecularClient: no contract code at {which} {addr} "
                    "(wrong address, wrong network, or an RPC serving an empty view).")
            setattr(self, attr, code)
        return SpecularClient._code_contains_selector(code, SpecularClient._selector(signature))

    @staticmethod
    def _code_contains_selector(code: bytes, selector: bytes) -> bool:
        """[X-5 parity] Does `code` dispatch `selector`?

        A plain substring scan misses ~1 function in 256: solc emits the
        dispatcher constant with the minimum number of PUSH bytes, so a selector
        whose first byte is 0x00 appears as a PUSH3 of its low three bytes
        (``PUSH4 0x004d9045`` == ``PUSH3 0x4d9045`` numerically) and the four
        bytes never occur contiguously. Verified on the live Arc mainnet V6.2 at
        0xCb23f2fb03Bfd4775Cc0e76E28f64c1e545071be, whose
        ``minHoldForReputationReward()`` (0x004d9045) returns 86400 while the
        bytes 004d9045 are absent from its code. A false negative here makes the
        client declare a deployed function missing and silently fall back."""
        s = selector
        if s in code:
            return True
        while len(s) > 1 and s[0] == 0:
            s = s[1:]
            if s in code:
                return True
        return False

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
        # agentLiquidityMarketplace. A V7 (V6.2) deployment publishes
        # agentLiquidityMarketplace_v62. Prefer the newest key present.
        self.marketplace_addr = (addr.get("agentLiquidityMarketplace_v62")
                                 or addr.get("agentLiquidityMarketplace_v6")
                                 or addr["agentLiquidityMarketplace"])
        self.registry_addr = addr["agentRegistryV2"]
        # [V7] ReputationManagerV4 is a fresh deploy, not an upgrade: a V7 config
        # names it reputationManagerV4. Older configs keep reputationManagerV3.
        self.reputation_addr = addr.get("reputationManagerV4") or addr["reputationManagerV3"]
        self.usdc_addr = addr["usdc"]
        self.faucet_addr = addr.get("agentCreditFaucet")
        self.explorer = cfg["explorer_tx"]

        # [V7] ABIs are SUPERSETS covering every deployment generation this client
        # can meet (marketplace V6/V6.1/V6.2, reputation V3/V4). Nothing is called
        # on a deployment whose bytecode lacks the selector — see
        # `_code_has_selector` / `capabilities`.
        self.marketplace = self.w3.eth.contract(
            address=Web3.to_checksum_address(self.marketplace_addr),
            abi=_marketplace_abi(),
        )
        self.registry = self._load_contract(
            self.registry_addr,
            REPO_ROOT / "artifacts" / "contracts" / "core" /
            "AgentRegistryV2.sol" / "AgentRegistryV2.json",
        )
        self.reputation = self.w3.eth.contract(
            address=Web3.to_checksum_address(self.reputation_addr),
            abi=_reputation_abi(),
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
        self._assert_metadata_uri(ipfs_hash)
        with self._write_lock:
            return self._onboard_inner(ipfs_hash)

    def _onboard_inner(self, ipfs_hash: str = "ipfs://agent") -> dict[str, Any]:
        out: dict[str, Any] = {"agentId": None, "registerTx": None, "poolTx": None, "approveTx": None}
        agent_id = self.registry.functions.addressToAgentId(self.account.address).call()
        if agent_id == 0:
            out["registerTx"] = self._send(self.registry.functions.register(ipfs_hash, []))
            # [parity with JS] Public-RPC propagation: the registry write may not
            # be visible from every node yet. Poll until it is, so createAgentPool
            # doesn't revert "Not a registered agent" — and so we never proceed
            # with agentId 0, which the old code silently did.
            for _ in range(20):
                agent_id = self.registry.functions.addressToAgentId(self.account.address).call()
                if agent_id != 0:
                    break
                time.sleep(1)
            if agent_id == 0:
                raise RuntimeError("register() confirmed but addressToAgentId still 0 after 20s")
        out["agentId"] = agent_id

        pool = self.marketplace.functions.agentPools(agent_id).call()
        # pool[6] is isActive
        if not pool[6]:
            # [parity with JS] Retry on load-balanced replica staleness: some
            # public RPCs return inconsistent views for a few seconds after a
            # registry write.
            for attempt in range(5):
                try:
                    out["poolTx"] = self._send(self.marketplace.functions.createAgentPool())
                    break
                except Exception as e:
                    if attempt == 4 or "Not a registered agent" not in str(e):
                        raise
                    time.sleep(2)

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
        # [F-R15 parity] EXACT in both directions: a larger pre-existing allowance
        # (a crashed session, or an older SDK's MaxUint256) must be tightened down,
        # not accepted as "already covered" and carried forward forever.
        if current == amount:
            return None
        if current > amount:
            self._approved_this_op = True
            return self._send(self.usdc.functions.approve(self.marketplace_addr, amount))
        self._approved_this_op = True
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
        with self._write_lock:
            return self._revoke_approval_inner()

    def _revoke_approval_inner(self) -> str | None:
        """Unlocked revoke — used from inside an op that already holds the lock."""
        current = self.usdc.functions.allowance(self.account.address, self.marketplace_addr).call()
        if current == 0:
            return None
        return self._send(self.usdc.functions.approve(self.marketplace_addr, 0))

    def credit_info(self) -> CreditInfo:
        """Current credit standing, every figure read from the chain.

        On a V4 reputation manager the result also carries the ladder and lockout
        state that EXPLAIN the limit, and on a V6.2 marketplace the agent's
        first-loss self-stake. Those fields stay None on older deployments."""
        score = self.reputation.functions.getReputationScore(self.account.address).call()
        credit_limit = self.reputation.functions.calculateCreditLimit(self.account.address).call()
        coll = self.reputation.functions.calculateCollateralRequirement(self.account.address).call()
        rate = self.reputation.functions.calculateInterestRate(self.account.address).call()
        info = CreditInfo(
            score=score,
            credit_limit_usdc=credit_limit / 1e6,
            collateral_pct=coll,
            interest_rate_apr=rate / 100,
        )
        try:
            caps = self.capabilities()
        except Exception:
            return info  # capability probe failed: return the V3-shaped answer
        info.marketplace_version = caps["version"]
        info.reputation_version = caps["reputation_version"]
        if not caps["reputation_v4"]:
            return info

        f = self.reputation.functions
        agent_id = self._agent_id()
        info.agent_id = agent_id
        info.tier = int(f.tierOf(score).call())
        info.tier_limit_usdc = int(f.tierLimit(score).call()) / 1e6
        info.ladder_limit_usdc = int(f.ladderLimit(agent_id).call()) / 1e6
        info.max_repaid_principal_usdc = int(f.maxRepaidPrincipal(agent_id).call()) / 1e6
        info.max_tier_limit_usdc = int(f.MAX_TIER_LIMIT().call()) / 1e6
        info.locked_out = bool(f.isLockedOut(agent_id).call())
        info.locked_until = int(f.lockedUntil(agent_id).call())
        # A post-default agent reads credit_limit_usdc == 0, which without this
        # explanation looks like a bug rather than the 180-day lockout it is.
        info.limit_explanation = (
            f"Credit limit is 0 because agent #{agent_id} is LOCKED OUT after a default until "
            f"unix {info.locked_until}. Capacity (maxRepaidPrincipal) was also reset to 0."
            if info.locked_out else
            f"Credit limit = min(tier limit {info.tier_limit_usdc}, ladder limit {info.ladder_limit_usdc}) USDC, "
            f"where the ladder is creditMultiple x your largest on-time-repaid loan "
            f"({info.max_repaid_principal_usdc} USDC) + growthStep. No tier may ever exceed "
            f"{info.max_tier_limit_usdc} USDC (MAX_TIER_LIMIT, an immutable constant).")
        if caps["v62"] and agent_id:
            try:
                info.self_stake = self.self_stake(agent_id)
            except Exception:
                pass  # pool may not exist yet
        return info

    def borrow(self, amount: float, duration_days: int) -> dict[str, Any]:
        """Borrow USDC. Returns dict with loanId, tx hash, explorer URL."""
        # [F-R18] `duration_days < 7 or duration_days > 365` is False for NaN in
        # BOTH directions, so the old check passed NaN straight to the chain.
        self._assert_duration_days(duration_days, "SpecularClient.borrow")
        amt_units = self._to_base_units(amount, "SpecularClient.borrow")
        with self._write_lock:
            self._onboard_inner()  # idempotent
            return self._with_approval_cleanup(lambda: self._borrow_inner(amt_units, duration_days))

    def _borrow_inner(self, amt_units: int, duration_days: int) -> dict[str, Any]:
        # [F-R5 parity] Never size collateral (or pick a tier) from a lagging replica.
        self._assert_chain_not_behind("SpecularClient.borrow")
        # Low-reputation agents must post collateral, pulled by requestLoan.
        # required = amount * collateralPercent / 100 (matches the contract).
        coll_pct = self.reputation.functions.calculateCollateralRequirement(self.account.address).call()
        # [V7 / M2-c] On a V6.2 deployment any exposure the collateral does not
        # cover must already be backed by the agent's OWN first-loss stake.
        # requestLoan reverts "Insufficient self-stake" otherwise — and it does so
        # AFTER the collateral approve, so the check belongs here, before any tx.
        self._assert_self_stake_sufficient(amt_units, coll_pct)
        self._approve_exact(amt_units * coll_pct // 100)
        try:
            tx_hash = self._send(self.marketplace.functions.requestLoan(amt_units, duration_days))
        except Exception as e:
            # [F-R3 parity] The contract may pull marginally more collateral than
            # amount*pct/100. Approve a BOUNDED buffer once (collateral +
            # principal, to the trusted marketplace) and retry; the cleanup
            # revokes whatever is left.
            if not self._is_allowance_shortfall(e):
                raise
            self._approve_exact(amt_units * coll_pct // 100 + amt_units)
            tx_hash = self._send(self.marketplace.functions.requestLoan(amt_units, duration_days))
            self._approved_this_op = True
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
        """Marketplace VERSION(); 'V6' when the deployment predates VERSION().

        [F-R1 parity] Decided by deployed bytecode. A transient RPC failure is
        SURFACED, never silently cached as 'V6' — guessing 'V6' on a V6.1 chain
        under-approves a late repayment and the repay reverts."""
        cached = getattr(self, "_mp_version", None)
        if cached is not None:
            return cached
        try:
            present = self._code_has_selector("VERSION()")
        except Exception as e:
            raise RuntimeError(
                f"SpecularClient: could not determine the marketplace version at {self.marketplace_addr} ({e}). "
                "Refusing to guess — guessing 'V6' would under-approve a late repayment on a V6.1 deployment. "
                "Retry against a healthy RPC.") from e
        if not present:
            self._mp_version = "V6"
            return self._mp_version
        self._mp_version = str(self.marketplace.functions.VERSION().call())
        return self._mp_version

    @staticmethod
    def version_ordinal(v: Any) -> float:
        """Numeric ordering for a VERSION string, so capability gates are `>=`
        comparisons rather than string equality: 'V6' -> 6.0, 'V6.1' -> 6.1,
        'V6.2' -> 6.2. An unrecognised string sorts as 6.0 (most conservative)."""
        m = re.match(r"^V(\d+)(?:\.(\d+))?$", str(v or "").strip())
        if not m:
            return 6.0
        return float(m.group(1)) + (float(m.group(2)) / 10 if m.group(2) else 0.0)

    def reputation_version(self) -> str:
        """Reputation manager VERSION(); 'V3' when the selector is absent.

        [F-R1 parity] Decided by deployed bytecode; a transient RPC failure is
        SURFACED, never silently cached — guessing 'V3' would present a stale
        hardcoded tier table instead of the on-chain one."""
        cached = getattr(self, "_rep_version", None)
        if cached is not None:
            return cached
        try:
            present = self._code_has_selector("VERSION()", "reputation")
        except Exception as e:
            raise RuntimeError(
                f"SpecularClient: could not determine the reputation manager version at "
                f"{self.reputation_addr} ({e}). Refusing to guess. Retry against a healthy RPC.") from e
        if not present:
            self._rep_version = "V3"
            return self._rep_version
        self._rep_version = str(self.reputation.functions.VERSION().call())
        return self._rep_version

    def capabilities(self) -> dict[str, Any]:
        """[V7] Three-way capability matrix for this deployment.

        ============  ==========  =====  =====  ==========================================
        generation    VERSION()   v61    v62    adds
        ============  ==========  =====  =====  ==========================================
        V6            (absent)    no     no     baseline
        V6.1          "V6.1"      yes    no     previewRepayment/canTopUp/getActiveLoanIds
        V6.2 (V7)     "V6.2"      yes    yes    requiredSelfStake/selfStake, first-loss lock
        ============  ==========  =====  =====  ==========================================

        Base mainnet and the current Arc deployments are V6.1 or V6, so every
        V6.2 path must be gated — never assumed."""
        cached = getattr(self, "_caps", None)
        if cached is not None:
            return cached
        version = self.marketplace_version()
        ordinal = self.version_ordinal(version)
        v62 = ordinal >= 6.2
        if v62:
            # Belt and braces: confirm against the deployed bytecode so a
            # mislabelled contract cannot make the client skip the pre-checks.
            try:
                v62 = self._code_has_selector("requiredSelfStake(uint256,uint256)")
            except Exception:
                pass
        rep_version = self.reputation_version()
        self._caps = {
            "version": version,
            "ordinal": ordinal,
            "v61": ordinal >= 6.1,
            "v62": v62,
            "reputation_version": rep_version,
            "reputation_v4": rep_version != "V3",
        }
        return self._caps

    def _has_v61_views(self) -> bool:
        return self.marketplace_version() != "V6"

    def _has_v62(self) -> bool:
        """True when the deployment is V6.2 (the V7 credit model)."""
        return bool(self.capabilities()["v62"])

    def _unsupported(self, what: str) -> UnsupportedOnDeployment:
        return UnsupportedOnDeployment(
            f"SpecularClient.{what}: not supported on this deployment — the {self.network} marketplace "
            f"{self.marketplace_addr} reports version {getattr(self, '_mp_version', 'V6')} (requires V6.2 or later). "
            "Base mainnet and the current Arc deployments predate the V7 credit model.")

    # --------------------------------------------------- V6.2 / V7 self-stake

    def _agent_id(self) -> int:
        return int(self.registry.functions.addressToAgentId(self.account.address).call())

    def required_self_stake(self, agent_id: int, additional_amount: float | int = 0) -> int:
        """[V6.2] First-loss self-stake the agent must already hold in its OWN
        pool before it could borrow `additional_amount` more (display units).
        Returns base units. Pass 0 to price the exposure already outstanding."""
        agent_id = self._to_agent_id(agent_id, "SpecularClient.required_self_stake")
        extra = 0 if not additional_amount else self._to_base_units(
            additional_amount, "SpecularClient.required_self_stake")
        if not self._has_v62():
            raise self._unsupported("required_self_stake")
        return int(self.marketplace.functions.requiredSelfStake(agent_id, extra).call())

    def self_stake(self, agent_id: int) -> SelfStakeInfo:
        """[V6.2] The pool creator's own position — the agent's first-loss
        capital — and whether it is LOCKED (the agent carries outstanding
        principal). A locked position cannot be withdrawn and is seized before
        any third-party lender's on a default."""
        agent_id = self._to_agent_id(agent_id, "SpecularClient.self_stake")
        if not self._has_v62():
            raise self._unsupported("self_stake")
        amount, locked = self.marketplace.functions.selfStake(agent_id).call()
        required = int(self.marketplace.functions.requiredSelfStake(agent_id, 0).call())
        shortfall = max(0, required - int(amount))
        return SelfStakeInfo(
            amount=int(amount), amount_usdc=int(amount) / 1e6, locked=bool(locked),
            required=required, required_usdc=required / 1e6,
            shortfall=shortfall, shortfall_usdc=shortfall / 1e6)

    def _assert_self_stake_sufficient(self, amt_units: int, coll_pct: int) -> None:
        """[V6.2 / M2-c] Refuse a borrow the self-stake gate would revert, saying
        exactly how much more first-loss capital to supply. No-op on V6/V6.1 and
        at the 100%-collateral tiers.

        Unlike repayment sizing (F-R1), a failed probe here is not money-critical:
        the gate is enforced on chain regardless, so a probe failure fails OPEN
        and the caller merely gets the raw revert instead of an explanation."""
        if int(coll_pct) >= 100:
            return
        try:
            if not self._has_v62():
                return
        except Exception:
            return
        agent_id = self._agent_id()
        if not agent_id:
            return
        try:
            required = int(self.marketplace.functions.requiredSelfStake(agent_id, amt_units).call())
            have = int(self.marketplace.functions.selfStake(agent_id).call()[0])
        except Exception:
            return
        if have >= required:
            return
        short = required - have
        raise InsufficientSelfStake(
            f"SpecularClient.borrow: insufficient self-stake. This deployment (V6.2, the V7 credit model) "
            f"requires agent #{agent_id} to hold {required / 1e6} USDC of its OWN first-loss capital in its own "
            f"pool to carry this exposure, but the position holds {have / 1e6} USDC — {short / 1e6} USDC short. "
            f'requestLoan would revert "Insufficient self-stake". Supply the difference first '
            f"(client.supply({agent_id}, {short / 1e6})), then borrow. That stake is LOCKED while any principal "
            "is outstanding and is seized before any third-party lender on a default.",
            agent_id=agent_id, required=required, current=have, shortfall=short)

    def _assert_withdraw_not_locked(self, agent_id: int) -> None:
        """[V6.2 / M2-a] Refuse a withdrawal the first-loss lock would revert.
        Only ever fires for the POOL CREATOR's own position while
        `outstandingPrincipal > 0`; ordinary lenders are never locked."""
        try:
            if not self._has_v62():
                return
        except Exception:
            return
        try:
            pool = self.marketplace.functions.agentPools(agent_id).call()
            creator = str(pool[1])
            if creator.lower() != str(self.account.address).lower():
                return
            outstanding = int(self.marketplace.functions.outstandingPrincipal(agent_id).call())
        except Exception:
            return  # advisory only — never block a withdraw on a failed pre-check
        if outstanding == 0:
            return
        raise SelfStakeLocked(
            f"SpecularClient.withdraw: your position in pool #{agent_id} is the agent's FIRST-LOSS SELF-STAKE and "
            f"is locked while it borrows. Agent #{agent_id} still owes {outstanding / 1e6} USDC of principal, so "
            'withdrawLiquidity would revert "Self-stake locked while borrowing". Repay the outstanding loans first '
            "(client.active_loan_ids(agent_id) lists them), then withdraw. Ordinary lenders in this pool are not "
            "locked — only the pool creator.",
            agent_id=agent_id, outstanding_principal=outstanding)

    def tier_table(self) -> dict[str, Any]:
        """The credit tier table, READ FROM THE CHAIN.

        On ReputationManagerV4 the table is on-chain state and owner-settable
        (bounded by the immutable `MAX_TIER_LIMIT`), so no client may carry a
        hardcoded copy. On V3 there is no view to read, so the historical
        compiled-in constants are returned, flagged ``source='v3-constant'``."""
        caps = self.capabilities()
        if not caps["reputation_v4"]:
            v3 = [(0, 0, 1_000_000000, 100, 1500), (1, 200, 5_000_000000, 100, 1500),
                  (2, 400, 10_000_000000, 100, 1000), (3, 500, 10_000_000000, 25, 1000),
                  (4, 600, 25_000_000000, 0, 700), (5, 800, 50_000_000000, 0, 500)]
            return {
                "source": "v3-constant",
                "max_tier_limit": None,
                "tiers": [CreditTier(index=i, min_score=ms, limit=lim, limit_usdc=lim / 1e6,
                                     collateral_pct=cp, interest_rate_bps=bps,
                                     unsecured_exposure=lim * (100 - cp) // 100)
                          for (i, ms, lim, cp, bps) in v3],
            }
        f = self.reputation.functions
        tiers = []
        for i in range(6):
            lim = int(f.tierLimits(i).call())
            tiers.append(CreditTier(
                index=i,
                min_score=int(f.tierMinScore(i).call()),
                limit=lim,
                limit_usdc=lim / 1e6,
                collateral_pct=int(f.tierCollateralPct(i).call()),
                interest_rate_bps=int(f.tierInterestBps(i).call()),
                unsecured_exposure=int(f.unsecuredTierExposure(i).call()),
            ))
        return {"source": "chain", "max_tier_limit": int(f.MAX_TIER_LIMIT().call()), "tiers": tiers}

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
            except Exception as e:
                # [F-R2 parity] Fall back to the nominal figure ONLY when the
                # selector is genuinely absent from the deployed bytecode. A real
                # revert and any transient RPC failure must surface: silently
                # returning the V6 nominal amount for a LATE V6.1 loan
                # under-approves the repay, which then reverts.
                try:
                    deployed = self._code_has_selector("previewRepayment(uint256)")
                except Exception:
                    deployed = True
                if deployed:
                    raise e
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
        # [F-R5 parity] A stale replica makes a LATE loan read as on-time and
        # cheap, so the approval would be sized below what the chain will pull.
        self._assert_chain_not_behind("SpecularClient.repay")
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
        with self._write_lock:
            return self._with_approval_cleanup(lambda: self._repay_inner(loan_id))

    def _repay_inner(self, loan_id: int) -> str:
        # Approve exactly what the contract will pull: previewRepayment().total on
        # V6.1 (late loans pay for elapsed time, capped at duration + 30 days),
        # principal + nominal interest on V6. Never an unlimited approval.
        approve, pv, headroom = self._repay_approval(loan_id)
        self._approve_exact(approve)
        bumped = False
        try:
            tx = self._send(self.marketplace.functions.repayLoan(loan_id))
        except Exception as e:
            # [F-R3 parity] The contract may pull more than previewed (a repay
            # delayed past the late headroom). Re-price from the chain — still
            # clamped by the contract's own cap inside _repay_approval — and retry.
            if not self._is_allowance_shortfall(e):
                raise
            bumped = True
            try:
                fresh, _pv2, _h2 = self._repay_approval(loan_id)
                bump_to = max(fresh, approve + max(pv["interest"], 1))
            except Exception:
                bump_to = approve + max(pv["interest"], 1)
            self._approve_exact(bump_to)
            tx = self._send(self.marketplace.functions.repayLoan(loan_id))
        if headroom > 0 or bumped:
            # Late-loan headroom may leave a few base units of allowance; clear it.
            try:
                self._revoke_approval_inner()
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
        except BaseException as e:  # noqa: BLE001
            # [X-4] True is the PERMISSIVE answer — it lets supply() go ahead and
            # forfeit in-flight interest. Only a deployment that genuinely lacks
            # the selector may be answered that way.
            if SpecularClient._is_transient_rpc_failure(e):
                raise
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
            lid = self._loan_id_at(addr, idx, "SpecularClient.active_loan_ids")
            if lid is None:
                break
            if self.marketplace.functions.loans(lid).call()[9] == 1:
                out.append(int(lid))
        return out

    def supply(self, agent_id: int, amount: float) -> str:
        agent_id = self._to_agent_id(agent_id, "SpecularClient.supply")
        amt = self._to_base_units(amount, "SpecularClient.supply")
        with self._write_lock:
            return self._with_approval_cleanup(lambda: self._supply_inner(agent_id, amt))

    def _supply_inner(self, agent_id: int, amt: int) -> str:
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
        """Withdraw supplied principal from a pool.

        [V6.2 / M2-a] A pool CREATOR's own position is first-loss capital and is
        locked while the agent carries outstanding principal; that is pre-checked
        so the caller gets an explanation instead of the raw revert."""
        agent_id = self._to_agent_id(agent_id, "SpecularClient.withdraw")
        amt = self._to_base_units(amount, "SpecularClient.withdraw")
        with self._write_lock:
            self._assert_withdraw_not_locked(agent_id)
            return self._send(self.marketplace.functions.withdrawLiquidity(agent_id, amt))

    def claim_interest(self, agent_id: int) -> str:
        agent_id = self._to_agent_id(agent_id, "SpecularClient.claim_interest")
        with self._write_lock:
            return self._send(self.marketplace.functions.claimInterest(agent_id))

    def loans(self) -> list[LoanInfo]:
        """Return all of this agent's loans (active + historical)."""
        out = []
        idx = 0
        while True:
            # [X-4] ends the walk ONLY at a genuine out-of-bounds revert; a
            # transient RPC failure raises rather than truncating the list.
            lid = self._loan_id_at(self.account.address, idx, "SpecularClient.loans")
            if lid is None:
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
