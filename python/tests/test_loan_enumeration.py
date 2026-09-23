"""[X-4/X-5, 2026-09-23 cross-generation regression round] — Python parity.

Mirrors test/sdk/quickstart-loan-enumeration.test.js:

  X-4  the ``agentLoans[]`` walk must end only at a genuine out-of-bounds revert.
       ``except Exception: break`` could not tell "past the end" from "the RPC
       failed while I asked", so a rate limit silently truncated the loan list —
       and an empty list reads as "this agent has no outstanding debt".
  X-5  ``_code_has_selector`` missed any selector whose first byte is 0x00,
       because solc emits the dispatcher constant as a PUSH3.

Pure unit tests: no chain, no network.
"""
import sys
import types
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from specular.client import LoanEnumerationFailed, SpecularClient  # noqa: E402

ADDR = "0x1111111111111111111111111111111111111111"


class Web3RPCErrorStub(Exception):
    """Shaped like web3's Web3RPCError: carries the upstream JSON-RPC response."""

    def __init__(self, code, message):
        super().__init__({"code": code, "message": message})
        self.rpc_response = {"error": {"code": code, "message": message}}


def rate_limited():
    return Web3RPCErrorStub(-32005, "rate limit exceeded")


def reverted_no_data():
    return Web3RPCErrorStub(3, "execution reverted")


def client_with_loans(loan_ids, fail_at=None, fail_with=rate_limited):
    c = object.__new__(SpecularClient)
    c.account = types.SimpleNamespace(address=ADDR)
    c.network = "test"
    c._mp_version = "V6"

    def agent_loans(_addr, idx):
        if fail_at is not None and idx == fail_at:
            raise fail_with()
        if idx >= len(loan_ids):
            raise reverted_no_data()
        return types.SimpleNamespace(call=lambda: loan_ids[idx])

    def loans(_lid):
        # (loanId, borrower, agentId, amount, collateral, rate, start, end, duration, state)
        return types.SimpleNamespace(call=lambda: (0, ADDR, 1, 1_000000, 0, 1500, 0, 0, 0, 1))

    def can_top_up(_a, _l):
        return types.SimpleNamespace(call=lambda: (_ for _ in ()).throw(fail_with()))

    def agent_pools(_a):
        return types.SimpleNamespace(call=lambda: (1, ADDR, 0, 0, 0, 0, True))

    c.marketplace = types.SimpleNamespace(functions=types.SimpleNamespace(
        agentLoans=lambda a, i: agent_loans(a, i),
        loans=loans,
        canTopUp=can_top_up,
        agentPools=agent_pools,
    ))
    return c


class TestTransientClassification(unittest.TestCase):
    def test_rate_limit_is_transient(self):
        self.assertTrue(SpecularClient._is_transient_rpc_failure(rate_limited()))

    def test_plain_revert_is_not_transient(self):
        self.assertFalse(SpecularClient._is_transient_rpc_failure(reverted_no_data()))

    def test_revert_with_a_reason_is_not_transient(self):
        self.assertFalse(SpecularClient._is_transient_rpc_failure(
            Exception('execution reverted: Loan not active')))


class TestLoanEnumeration(unittest.TestCase):
    def test_control_complete_list(self):
        c = client_with_loans([7, 8, 9])
        self.assertEqual([l.loan_id for l in c.loans()], [7, 8, 9])
        self.assertEqual(c.active_loan_ids(1), [7, 8, 9])

    def test_loans_raises_on_rate_limit(self):
        c = client_with_loans([7, 8, 9], fail_at=1)
        with self.assertRaises(LoanEnumerationFailed):
            c.loans()

    def test_active_loan_ids_raises_on_rate_limit(self):
        c = client_with_loans([7, 8, 9], fail_at=2)
        with self.assertRaises(LoanEnumerationFailed):
            c.active_loan_ids(1)

    def test_can_top_up_does_not_answer_true_on_a_rate_limit(self):
        c = client_with_loans([], fail_with=rate_limited)
        c._mp_version = "V6.1"
        with self.assertRaises(Exception):
            c.can_top_up(1)

    def test_can_top_up_still_degrades_to_true_when_absent(self):
        c = client_with_loans([], fail_with=reverted_no_data)
        c._mp_version = "V6.1"
        self.assertTrue(c.can_top_up(1))


class TestAllowanceShortfall(unittest.TestCase):
    """[X-9] "exceeds" in a revert string does not mean "allowance".

    `Exceeds credit limit` used to be read as an allowance shortfall, so the
    borrow path re-approved collateral + principal — a transient 2x
    over-approval for a borrow that could never succeed."""

    def test_credit_limit_is_not_an_allowance_shortfall(self):
        self.assertFalse(SpecularClient._is_allowance_shortfall(
            Exception('execution reverted: Exceeds credit limit')))

    def test_pool_liquidity_is_not_an_allowance_shortfall(self):
        self.assertFalse(SpecularClient._is_allowance_shortfall(
            Exception('execution reverted: Exceeds pool liquidity')))

    def test_legacy_allowance_revert_still_recognised(self):
        self.assertTrue(SpecularClient._is_allowance_shortfall(
            Exception('ERC20: transfer amount exceeds allowance')))

    def test_openzeppelin_v5_custom_error_still_recognised(self):
        self.assertTrue(SpecularClient._is_allowance_shortfall(
            Exception('execution reverted 0xfb8f41b2' + '00' * 96)))


class TestSelectorScan(unittest.TestCase):
    def test_leading_zero_selector_found_as_push3(self):
        sel = SpecularClient._selector("minHoldForReputationReward()")
        self.assertEqual(sel.hex(), "004d9045")
        code = bytes.fromhex("6080604052") + b"\x62" + sel[1:] + bytes.fromhex("8114610020")
        self.assertTrue(SpecularClient._code_contains_selector(code, sel))

    def test_absent_selector_still_absent(self):
        sel = SpecularClient._selector("minHoldForReputationReward()")
        code = bytes.fromhex("608060405263123456788114610020806387654321146100305780")
        self.assertFalse(SpecularClient._code_contains_selector(code, sel))


if __name__ == "__main__":
    unittest.main()
