"""Python SDK robustness / JS-parity suite.

Mirrors test/sdk-robustness/*.test.js against python/specular/client.py. Every
behavioural difference from the JS SpecularQuickstart is a finding: a
third-party agent picking the Python client must not get weaker guarantees.

Run:  venv/bin/python -m unittest discover -s test/sdk-robustness/python -v
"""

import os
import sys
import threading
import time
import unittest
from decimal import Decimal
from unittest.mock import MagicMock

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
sys.path.insert(0, os.path.join(REPO_ROOT, "python"))

from specular.client import SpecularClient, _usdc_units  # noqa: E402


# ----------------------------------------------------------------- fixtures

class FakeFn:
    """A web3 contract function whose .call() is scripted."""

    def __init__(self, result=None, raises=None, log=None, name=""):
        self.result, self.raises, self.log, self.name = result, raises, log, name
        self.calls = 0

    def __call__(self, *a, **k):
        return self

    def call(self, *a, **k):
        self.calls += 1
        if self.log is not None:
            self.log.append(self.name)
        if self.raises is not None:
            exc = self.raises() if callable(self.raises) else self.raises
            raise exc
        return self.result


class FakeFunctions:
    def __init__(self, **fns):
        self._fns = fns

    def __getattr__(self, name):
        if name in self._fns:
            return self._fns[name]
        raise AttributeError(name)


def bare_client(**kw):
    """A SpecularClient with no chain, no config, no __init__."""
    c = object.__new__(SpecularClient)
    c.account = MagicMock()
    c.account.address = "0x" + "11" * 20
    c.marketplace_addr = "0x" + "22" * 20
    c.w3 = MagicMock()
    c.sent = []
    c._send = lambda fn: (c.sent.append(getattr(fn, "name", "tx")) or "0xhash")
    for k, v in kw.items():
        setattr(c, k, v)
    return c


TRANSIENT = RuntimeError("server response 503 (transient RPC failure)")


# ------------------------------------------------------------------- tests

class TestNetworkParity(unittest.TestCase):
    def test_arc_mainnet_is_reachable_from_python(self):
        """[F-R19] The JS SDK ships arc-mainnet; Python must too, or the live
        deployment is simply unusable from Python agents."""
        self.assertIn(
            "arc-mainnet", SpecularClient.NETWORK_CONFIGS,
            "python client cannot target Arc mainnet — the network the protocol actually launched on")


class TestNetworkFiles(unittest.TestCase):
    def test_every_network_config_points_at_a_real_file(self):
        for net, cfg in SpecularClient.NETWORK_CONFIGS.items():
            self.assertTrue(cfg["addresses_path"].exists(), f"{net}: {cfg['addresses_path']} missing")


class TestCapabilityDetection(unittest.TestCase):
    """Parity with JS F-R1/F-R2: a transient RPC error must never be read as
    'this deployment is V6'."""

    def _client(self, version_raises=None, code=b"", selector_present=True):
        c = bare_client()
        sel_ver = SpecularClient._selector("VERSION()")
        code_hex = "0x" + (sel_ver.hex() if selector_present else "") + "600160015260206000f3"
        c.w3.eth.get_code = MagicMock(return_value=bytes.fromhex(code_hex[2:]))
        c.marketplace = MagicMock()
        c.marketplace.functions = FakeFunctions(
            VERSION=FakeFn(result="V6.1", raises=version_raises))
        c.marketplace.address = c.marketplace_addr
        return c

    def test_transient_failure_does_not_downgrade_to_v6(self):
        c = self._client(version_raises=lambda: TRANSIENT, selector_present=True)
        try:
            v = c.marketplace_version()
        except Exception as e:  # failing closed is acceptable
            self.assertRegex(str(e), r"(?i)version|rpc|stale")
            return
        self.assertEqual(v, "V6.1", "a transient RPC error was cached as 'V6' — late repays will under-approve")

    def test_genuinely_absent_selector_is_detected_as_v6(self):
        c = self._client(version_raises=lambda: RuntimeError("execution reverted"), selector_present=False)
        self.assertEqual(c.marketplace_version(), "V6")

    def test_version_is_cached_after_a_successful_read(self):
        c = self._client()
        self.assertEqual(c.marketplace_version(), "V6.1")
        self.assertEqual(c.marketplace_version(), "V6.1")
        self.assertEqual(c.w3.eth.get_code.call_count, 1)


class TestPreviewFallback(unittest.TestCase):
    """Parity with JS F-R2."""

    def _client(self, preview_raises):
        c = bare_client()
        c._mp_version = "V6.1"
        sel_prev = SpecularClient._selector("previewRepayment(uint256)")
        c.w3.eth.get_code = MagicMock(return_value=sel_prev + b"\x60\x01")
        c.marketplace = MagicMock()
        c.marketplace.address = c.marketplace_addr
        loan = [0, "0x0", 1, 1_000_000_000, 0, 1500, 0, 0, 7 * 86400, 1]
        c.marketplace.functions = FakeFunctions(
            loans=FakeFn(result=loan),
            previewRepayment=FakeFn(raises=preview_raises),
            calculateInterest=FakeFn(result=2_876_712),
        )
        return c

    def test_transient_error_does_not_fall_back_to_the_nominal_figure(self):
        c = self._client(lambda: TRANSIENT)
        try:
            pv = c.preview_repayment(1)
        except Exception:
            return  # failing closed is acceptable
        self.assertEqual(
            pv["source"], "previewRepayment",
            "a transient RPC failure silently produced the V6 nominal amount — a late repay would under-approve")

    def test_a_real_revert_still_surfaces(self):
        c = self._client(lambda: RuntimeError("execution reverted: Loan not active"))
        with self.assertRaises(Exception):
            c.preview_repayment(1)


class TestAllowanceShortfall(unittest.TestCase):
    """Parity with JS F-R3: OZ v5 custom errors must be recognised."""

    def test_recognises_the_legacy_string_revert(self):
        self.assertTrue(SpecularClient._is_allowance_shortfall(
            RuntimeError("ERC20: transfer amount exceeds allowance")))

    def test_recognises_the_openzeppelin_v5_custom_error(self):
        self.assertTrue(SpecularClient._is_allowance_shortfall(
            RuntimeError("execution reverted: 0xfb8f41b2000000000000000000000000dead")))
        self.assertTrue(SpecularClient._is_allowance_shortfall(
            RuntimeError("ERC20InsufficientAllowance")))

    def test_does_not_misfire_on_an_unrelated_revert(self):
        self.assertFalse(SpecularClient._is_allowance_shortfall(RuntimeError("Loan not active")))


class TestExactApproval(unittest.TestCase):
    def _client(self, current_allowance, approve_log):
        c = bare_client()
        c.usdc = MagicMock()
        c.usdc.functions = FakeFunctions(
            allowance=FakeFn(result=current_allowance),
            approve=FakeFn(result=True, name="approve"),
        )
        approve_fn = c.usdc.functions.approve

        def approve(spender, amount):
            approve_log.append(amount)
            return approve_fn

        c.usdc.functions._fns["approve"] = approve
        return c

    def test_skips_when_the_allowance_is_already_exact(self):
        log = []
        c = self._client(100, log)
        self.assertIsNone(c._approve_exact(100))
        self.assertEqual(log, [])

    def test_approves_the_exact_amount_when_short(self):
        log = []
        c = self._client(0, log)
        c._approve_exact(250)
        self.assertEqual(log, [250])

    def test_tightens_an_over_large_pre_existing_allowance(self):
        """[F-R15 parity] A leftover unlimited allowance must not be carried forward."""
        log = []
        c = self._client(2 ** 256 - 1, log)
        c._approve_exact(250)
        self.assertEqual(log, [250], "an unlimited allowance was accepted as 'already covered'")

    def test_never_approves_an_unbounded_amount(self):
        log = []
        c = self._client(0, log)
        c._approve_exact(250)
        for a in log:
            self.assertNotEqual(a, 2 ** 256 - 1)


class TestInputValidation(unittest.TestCase):
    """Parity with JS L2/L3 + F-R9/F-R16/F-R17."""

    def setUp(self):
        self.c = bare_client()
        self.c.onboard = lambda: {"agentId": 1}
        self.c.reputation = MagicMock()
        self.c.marketplace = MagicMock()

    def test_borrow_rejects_nan_duration(self):
        """float('nan') < 7 and float('nan') > 365 are BOTH False, so a plain
        range check lets NaN straight through to the chain."""
        with self.assertRaises(Exception):
            self.c.borrow(100, float("nan"))

    def test_borrow_rejects_non_integer_and_bool_durations(self):
        for bad in (7.5, True, "30", None, float("inf")):
            with self.assertRaises(Exception, msg=f"duration {bad!r} was accepted"):
                self.c.borrow(100, bad)

    def test_borrow_rejects_malformed_amounts(self):
        for bad in (0, -5, float("nan"), float("inf"), None, "abc", {}):
            with self.assertRaises(Exception, msg=f"amount {bad!r} was accepted"):
                self.c.borrow(bad, 30)

    def test_supply_and_withdraw_reject_malformed_amounts(self):
        for bad in (0, -5, float("nan"), None, "abc"):
            with self.assertRaises(Exception, msg=f"supply amount {bad!r} was accepted"):
                self.c.supply(1, bad)
            with self.assertRaises(Exception, msg=f"withdraw amount {bad!r} was accepted"):
                self.c.withdraw(1, bad)

    def test_agent_id_is_validated(self):
        for bad in (-1, 1.5, "abc", None, float("nan")):
            with self.assertRaises(Exception, msg=f"agentId {bad!r} was accepted"):
                self.c.supply(bad, 10)
            with self.assertRaises(Exception, msg=f"agentId {bad!r} was accepted"):
                self.c.claim_interest(bad)

    def test_metadata_uri_is_bounded_and_clean(self):
        with self.assertRaises(Exception):
            SpecularClient._assert_metadata_uri("x" * 100000)
        with self.assertRaises(Exception):
            SpecularClient._assert_metadata_uri("")
        with self.assertRaises(Exception):
            SpecularClient._assert_metadata_uri("ipfs://a b")
        SpecularClient._assert_metadata_uri("ipfs://Qm-agent-café-🤖")

    def test_usdc_units_precision_is_unchanged(self):
        self.assertEqual(_usdc_units(19.99), 19_990_000)
        self.assertEqual(_usdc_units("0.000001"), 1)
        self.assertEqual(_usdc_units(Decimal("1.5")), 1_500_000)


class TestStaleness(unittest.TestCase):
    """Parity with JS F-R5: refuse to size money from a lagging replica."""

    def test_detects_a_head_that_went_backwards(self):
        c = bare_client()
        c.w3.eth.block_number = 500
        c._note_block(500)
        c.w3.eth.block_number = 480
        with self.assertRaises(Exception) as ctx:
            c._assert_chain_not_behind("test")
        self.assertRegex(str(ctx.exception), r"(?i)behind|stale|reorg")

    def test_accepts_a_forward_moving_head(self):
        c = bare_client()
        c.w3.eth.block_number = 500
        c._note_block(500)
        c.w3.eth.block_number = 501
        c.w3.eth.get_block = MagicMock(return_value={"timestamp": int(time.time())})
        c._assert_chain_not_behind("test")

    def test_detects_a_head_block_far_behind_wall_clock(self):
        c = bare_client()
        c.w3.eth.block_number = 500
        c.w3.eth.get_block = MagicMock(return_value={"timestamp": int(time.time()) - 7200})
        with self.assertRaises(Exception) as ctx:
            c._assert_chain_not_behind("test")
        self.assertRegex(str(ctx.exception), r"(?i)behind|stale")


class TestWriteSerialization(unittest.TestCase):
    """Parity with JS F-R10: concurrent writes from one key must not race on
    the nonce."""

    def test_concurrent_writes_are_serialized(self):
        c = bare_client()
        active = {"n": 0, "max": 0}
        lock = threading.Lock()

        def op():
            with c._write_lock:
                with lock:
                    active["n"] += 1
                    active["max"] = max(active["max"], active["n"])
                time.sleep(0.02)
                with lock:
                    active["n"] -= 1

        threads = [threading.Thread(target=op) for _ in range(5)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertEqual(active["max"], 1, "SDK write operations ran concurrently on one key")


class TestApprovalCleanup(unittest.TestCase):
    """Parity with JS F-R4: a failed op must not leave a standing allowance."""

    def test_failure_after_approving_triggers_a_revoke(self):
        c = bare_client()
        revoked = []
        c.revoke_approval = lambda: revoked.append(True)
        c._revoke_approval_inner = c.revoke_approval

        def boom():
            c._approved_this_op = True
            raise RuntimeError("503 from the RPC after the approve landed")

        with self.assertRaises(RuntimeError):
            c._with_approval_cleanup(boom)
        self.assertEqual(revoked, [True], "a failed operation left the allowance standing")

    def test_success_does_not_trigger_a_revoke(self):
        c = bare_client()
        revoked = []
        c._revoke_approval_inner = lambda: revoked.append(True)
        c._with_approval_cleanup(lambda: "ok")
        self.assertEqual(revoked, [])


if __name__ == "__main__":
    unittest.main()
