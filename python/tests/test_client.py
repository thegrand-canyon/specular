"""First offline unit suite for the Python SDK (python/specular/client.py).

Previously the Python client was only live-tested (Arc e2e). These tests cover
the pure/mockable logic with no chain: _usdc_units precision (L4), the
receipt-status check (M3), _approve_exact skip + staleness poll, borrow input
validation ordering, and revoke_approval.

Run:  /usr/bin/python3 -m unittest discover -s python/tests -v
"""
import os
import sys
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
    return c


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

    def test_skips_when_covered(self):
        c = self._client([10_000_000])
        self.assertIsNone(c._approve_exact(5_000_000))
        c._send.assert_not_called()

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


if __name__ == "__main__":
    unittest.main()
