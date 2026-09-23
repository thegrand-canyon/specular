"""First offline unit suite for the Python SDK (python/specular/client.py).

Previously the Python client was only live-tested (Arc e2e). These tests cover
the pure/mockable logic with no chain: _usdc_units precision (L4), the
receipt-status check (M3), _approve_exact skip + staleness poll, borrow input
validation ordering, and revoke_approval.

Run:  /usr/bin/python3 -m unittest discover -s python/tests -v
"""
import os
import sys
import time
import unittest
from unittest.mock import MagicMock, patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from specular.client import SpecularClient, _usdc_units  # noqa: E402


def bare_client():
    """Construct a SpecularClient without running __init__ (no chain/config)."""
    c = object.__new__(SpecularClient)
    c.account = MagicMock()
    c.account.address = "0x" + "11" * 20
    c.marketplace_addr = "0x" + "22" * 20
    # Capability detection now probes the DEPLOYED BYTECODE (robustness F-R1), so
    # a bare client needs a w3 whose get_code answers. Default: a V6.1 deployment.
    c.w3 = MagicMock()
    c.w3.eth.get_code = MagicMock(return_value=_code_with(V61_SELECTORS))
    # A plausible, fresh chain head — the staleness guard (robustness F-R5) reads it.
    c.w3.eth.block_number = 1000
    c.w3.eth.get_block = MagicMock(return_value={"timestamp": int(time.time())})
    return c


V61_SELECTORS = ["VERSION()", "previewRepayment(uint256)", "canTopUp(uint256,address)",
                 "getActiveLoanIds(uint256)"]


def _code_with(signatures):
    """Fake runtime bytecode containing the given function selectors."""
    out = b"\x60\x80\x60\x40"
    for sig in signatures:
        out += SpecularClient._selector(sig)
    return out + b"\x00"


class TestUsdcUnits(unittest.TestCase):
    def test_exact_representation(self):
        # int(19.99 * 1e6) == 19989999 — the bug L4 fixed. Decimal is exact.
        self.assertEqual(_usdc_units(19.99), 19_990_000)

    def test_full_precision(self):
        self.assertEqual(_usdc_units(1.234567), 1_234_567)

    def test_whole_numbers_and_strings(self):
        self.assertEqual(_usdc_units(100), 100_000_000)
        self.assertEqual(_usdc_units("0.000001"), 1)

    def test_truncates_toward_zero(self):
        # Sub-base-unit precision floors (never over-spends).
        self.assertEqual(_usdc_units("1.9999999"), 1_999_999)

    def test_rejects_nan_inf(self):
        for bad in ("nan", "inf"):
            with self.assertRaises(Exception):
                _usdc_units(bad)


class TestSendReceiptStatus(unittest.TestCase):
    """M3: a mined-but-reverted tx (status 0) must raise, not return success."""

    def _client_with_receipt(self, status):
        c = bare_client()
        c.w3 = MagicMock()
        c.w3.eth.get_transaction_count.return_value = 7
        c.w3.eth.estimate_gas.return_value = 100_000
        tx_hash = MagicMock()
        tx_hash.hex.return_value = "deadbeef"
        c.w3.eth.send_raw_transaction.return_value = tx_hash
        c.w3.eth.wait_for_transaction_receipt.return_value = {"status": status}
        return c

    def test_reverted_raises(self):
        c = self._client_with_receipt(0)
        with self.assertRaises(RuntimeError):
            c._send(MagicMock())

    def test_success_returns_hash(self):
        c = self._client_with_receipt(1)
        self.assertEqual(c._send(MagicMock()), "deadbeef")

    def test_nonce_uses_pending(self):
        # L5: nonce must come from the 'pending' view, not 'latest'.
        c = self._client_with_receipt(1)
        c._send(MagicMock())
        args, _ = c.w3.eth.get_transaction_count.call_args
        self.assertIn("pending", args)


class TestApproveExact(unittest.TestCase):
    def _client(self, allowance_seq):
        c = bare_client()
        c.usdc = MagicMock()
        it = iter(allowance_seq)
        c.usdc.functions.allowance.return_value.call.side_effect = lambda: next(it)
        c._send = MagicMock(return_value="0xhash")
        return c

    def test_skips_when_allowance_is_already_exact(self):
        c = self._client([5_000_000])
        self.assertIsNone(c._approve_exact(5_000_000))
        c._send.assert_not_called()

    def test_tightens_an_over_large_allowance(self):
        # [robustness F-R15] EXACT in both directions: a leftover larger
        # allowance is reduced, never carried forward.
        c = self._client([10_000_000])
        self.assertEqual(c._approve_exact(5_000_000), "0xhash")
        c.usdc.functions.approve.assert_called_with(c.marketplace_addr, 5_000_000)

    def test_zero_amount_is_noop(self):
        c = self._client([])
        self.assertIsNone(c._approve_exact(0))
        c._send.assert_not_called()

    @patch("time.sleep", lambda s: None)
    def test_polls_past_stale_replica(self):
        # Pre-check sees 0; after approve, two stale reads (0) then fresh.
        c = self._client([0, 0, 0, 5_000_000])
        self.assertEqual(c._approve_exact(5_000_000), "0xhash")
        c._send.assert_called_once()
        # 1 pre-check + 3 poll reads consumed → the poll waited out the staleness.
        self.assertEqual(c.usdc.functions.allowance.return_value.call.call_count, 4)


class TestBorrowValidation(unittest.TestCase):
    def test_duration_validated_before_onboard(self):
        # Invalid duration must fail fast — BEFORE spending gas on onboarding.
        c = bare_client()
        c.onboard = MagicMock()
        with self.assertRaises(ValueError):
            c.borrow(100, 5)   # below 7-day minimum
        with self.assertRaises(ValueError):
            c.borrow(100, 400) # above 365-day maximum
        c.onboard.assert_not_called()


class TestRevokeApproval(unittest.TestCase):
    def test_noop_when_zero(self):
        c = bare_client()
        c.usdc = MagicMock()
        c.usdc.functions.allowance.return_value.call.return_value = 0
        c._send = MagicMock()
        self.assertIsNone(c.revoke_approval())
        c._send.assert_not_called()

    def test_revokes_nonzero(self):
        c = bare_client()
        c.usdc = MagicMock()
        c.usdc.functions.allowance.return_value.call.return_value = 123
        c._send = MagicMock(return_value="0xr")
        self.assertEqual(c.revoke_approval(), "0xr")
        c.usdc.functions.approve.assert_called_with(c.marketplace_addr, 0)


class TestV61Repay(unittest.TestCase):
    """V6.1: repay approves previewRepayment().total (plus bounded late headroom);
    V6 (no VERSION()) falls back to the nominal fixed-term figure."""

    P, RATE, DUR = 1_000_000_000, 1500, 7 * 86_400  # 1000 USDC @ 15% for 7 days
    LOAN = (1, "0x" + "11" * 20, 1, P, 0, RATE, 0, DUR, DUR, 1)

    def _client(self, version, preview=None):
        c = bare_client()
        c.marketplace = MagicMock()
        if version is None:
            # A genuine V6.0 deployment: the selectors are absent from the bytecode.
            c.w3.eth.get_code = MagicMock(return_value=_code_with([]))
            c.marketplace.functions.VERSION.return_value.call.side_effect = Exception("execution reverted")
        else:
            c.marketplace.functions.VERSION.return_value.call.return_value = version
        c.marketplace.functions.loans.return_value.call.return_value = self.LOAN
        nominal = SpecularClient.interest_for_seconds(self.P, self.RATE, self.DUR)
        c.marketplace.functions.calculateInterest.return_value.call.return_value = nominal
        c.marketplace.functions.LATE_INTEREST_CAP.return_value.call.return_value = 30 * 86_400
        if preview is not None:
            c.marketplace.functions.previewRepayment.return_value.call.return_value = preview
        c._approve_exact = MagicMock(return_value=None)
        c._send = MagicMock(return_value="0xrepay")
        c.revoke_approval = MagicMock(return_value=None)
        c._revoke_approval_inner = c.revoke_approval
        return c, nominal

    def test_v6_fallback_uses_nominal(self):
        c, nominal = self._client(None)
        self.assertEqual(c.marketplace_version(), "V6")
        pv = c.preview_repayment(1)
        self.assertEqual(pv["source"], "calculateInterest")
        self.assertEqual(pv["total"], self.P + nominal)
        c.repay(1)
        c._approve_exact.assert_called_once_with(self.P + nominal)
        c.marketplace.functions.previewRepayment.assert_not_called()
        c.revoke_approval.assert_not_called()

    def test_v61_on_time_is_exact(self):
        nominal = SpecularClient.interest_for_seconds(self.P, self.RATE, self.DUR)
        c, _ = self._client("V6.1", preview=(nominal, self.P + nominal, self.DUR, 0))
        c.repay(1)
        c._approve_exact.assert_called_once_with(self.P + nominal)
        c.revoke_approval.assert_not_called()

    def test_v61_late_adds_bounded_headroom_then_revokes(self):
        chargeable = 17 * 86_400
        late_i = SpecularClient.interest_for_seconds(self.P, self.RATE, chargeable)
        c, _ = self._client("V6.1", preview=(late_i, self.P + late_i, chargeable, 10 * 86_400))
        c.repay(1)
        approved = c._approve_exact.call_args[0][0]
        expected_headroom = SpecularClient.interest_for_seconds(
            self.P, self.RATE, chargeable + SpecularClient.LATE_REPAY_HEADROOM_SECONDS) - late_i
        self.assertGreater(expected_headroom, 0)
        self.assertEqual(approved, self.P + late_i + expected_headroom)
        # bounded: never beyond the contract cap (duration + 30d)
        cap_total = self.P + SpecularClient.interest_for_seconds(self.P, self.RATE, self.DUR + 30 * 86_400)
        self.assertLessEqual(approved, cap_total)
        c.revoke_approval.assert_called_once()

    def test_v61_late_at_cap_is_exact(self):
        chargeable = self.DUR + 30 * 86_400
        capped = SpecularClient.interest_for_seconds(self.P, self.RATE, chargeable)
        c, _ = self._client("V6.1", preview=(capped, self.P + capped, chargeable, 300 * 86_400))
        c.repay(1)
        c._approve_exact.assert_called_once_with(self.P + capped)
        c.revoke_approval.assert_not_called()

    def test_can_top_up_true_on_v6(self):
        c, _ = self._client(None)
        self.assertTrue(c.can_top_up(1))
        c.marketplace.functions.canTopUp.assert_not_called()

    def test_supply_refused_when_top_up_would_forfeit(self):
        c, _ = self._client("V6.1")
        c.marketplace.functions.getLenderPosition.return_value.call.return_value = (5_000_000, 0, 0, 0)
        c.marketplace.functions.canTopUp.return_value.call.return_value = False
        with self.assertRaisesRegex(RuntimeError, "forfeit in-flight interest"):
            c.supply(1, 1)
        c._approve_exact.assert_not_called()


if __name__ == "__main__":
    unittest.main()
