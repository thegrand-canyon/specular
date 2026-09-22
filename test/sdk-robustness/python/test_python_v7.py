"""Python SDK: V7 (V6.2 / ReputationManagerV4) parity suite.

Mirrors test/sdk-v7/01-capability-matrix.test.js against
python/specular/client.py. The Python client must give a third-party agent the
SAME guarantees as the JS one — the 2026-09 robustness round found it materially
weaker, and every behavioural difference here is a finding, not a nuance.

Covered:
  * three-way capability detection (V6 / V6.1 / V6.2) + reputation V3 / V4,
    including the "claims V6.2 but the selector does not answer" case;
  * required_self_stake / self_stake, and the clean UnsupportedOnDeployment
    error on a V6 / V6.1 deployment (never a fabricated zero);
  * the borrow pre-check raising InsufficientSelfStake BEFORE any transaction,
    carrying the exact shortfall, and failing OPEN when the probe itself fails;
  * the withdraw pre-check raising SelfStakeLocked only for the pool CREATOR;
  * tier_table() reading the table FROM THE CHAIN on V4 and labelling the V3
    compiled-in constants honestly;
  * credit_info() carrying the ladder / lockout explanation and the self-stake.

Run:  venv/bin/python -m unittest discover -s test/sdk-robustness/python -v
"""

import os
import sys
import unittest
from unittest.mock import MagicMock

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
sys.path.insert(0, os.path.join(REPO_ROOT, "python"))

from specular.client import (  # noqa: E402
    InsufficientSelfStake,
    SelfStakeLocked,
    SpecularClient,
    UnsupportedOnDeployment,
)


USDC = lambda n: int(n * 1_000_000)  # noqa: E731

V7_TIER_LIMITS = [USDC(1000), USDC(5000), USDC(10000), USDC(10000), USDC(2500), USDC(5000)]
V7_TIER_COLLATERAL = [100, 100, 100, 75, 0, 0]
V7_TIER_MIN_SCORE = [0, 200, 400, 500, 600, 800]
V7_TIER_RATES = [1500, 1500, 1000, 1000, 700, 500]
MAX_TIER_LIMIT = USDC(10000)

TRANSIENT = RuntimeError("server response 503 (transient RPC failure)")

MP_SELECTORS = ["VERSION()", "previewRepayment(uint256)", "canTopUp(uint256,address)",
                "getActiveLoanIds(uint256)"]
V62_SELECTORS = MP_SELECTORS + ["requiredSelfStake(uint256,uint256)", "selfStake(uint256)"]


class Fn:
    """A web3 contract function whose .call() is scripted."""

    def __init__(self, result=None, raises=None, counter=None, name=""):
        self.result, self.raises, self.counter, self.name = result, raises, counter, name
        self.args = []

    def __call__(self, *a, **k):
        self.args.append(a)
        return self

    def call(self, *a, **k):
        if self.counter is not None:
            self.counter[self.name] = self.counter.get(self.name, 0) + 1
        if self.raises is not None:
            raise self.raises() if callable(self.raises) else self.raises
        return self.result(*self.args[-1]) if callable(self.result) else self.result


class Fns:
    def __init__(self, **fns):
        for name, fn in fns.items():
            fn.name = fn.name or name
        self._fns = fns

    def __getattr__(self, name):
        if name in self._fns:
            return self._fns[name]
        raise AttributeError(name)


def code_with(signatures):
    return b"".join(SpecularClient._selector(s) for s in signatures) + b"\x60\x01"


AGENT = "0x" + "11" * 20
CREATOR = AGENT
OTHER = "0x" + "99" * 20


def client(
    version="V6.2",
    rep_version="V4",
    self_stake=USDC(2500),
    required=USDC(2500),
    outstanding=0,
    creator=CREATOR,
    score=800,
    credit_limit=USDC(5000),
    locked_out=False,
    locked_until=0,
    self_stake_view_raises=None,
    code_selectors=None,
    counter=None,
):
    """A SpecularClient with no chain, no config, no __init__."""
    c = object.__new__(SpecularClient)
    c.account = MagicMock()
    c.account.address = AGENT
    c.network = "test"
    c.marketplace_addr = "0x" + "22" * 20
    c.reputation_addr = "0x" + "33" * 20
    c.sent = []
    c._send = lambda fn: (c.sent.append(getattr(fn, "name", "tx")) or "0xhash")

    if code_selectors is None:
        code_selectors = {"V6": [], "V6.1": MP_SELECTORS, "V6.2": V62_SELECTORS}[version]
    mp_code = code_with(code_selectors)
    rep_code = code_with(["VERSION()"] if rep_version != "V3" else [])

    c.w3 = MagicMock()
    c.w3.eth.get_code = MagicMock(
        side_effect=lambda addr: mp_code if str(addr).lower() == c.marketplace_addr.lower() else rep_code)

    coll = V7_TIER_COLLATERAL[_tier_of(score)]
    c.marketplace = MagicMock()
    c.marketplace.functions = Fns(
        VERSION=Fn(result=version, raises=None if version != "V6" else RuntimeError("reverted")),
        requiredSelfStake=Fn(result=lambda _id, extra: required if not extra else
                             ((outstanding + extra) * (100 - coll) // 100) // 2,
                             raises=self_stake_view_raises, counter=counter),
        selfStake=Fn(result=(self_stake, outstanding > 0), raises=self_stake_view_raises, counter=counter),
        outstandingPrincipal=Fn(result=outstanding),
        agentPools=Fn(result=(1, creator, USDC(10000), USDC(10000), 0, 0, True)),
        withdrawLiquidity=Fn(result=None),
    )
    c.reputation = MagicMock()
    c.reputation.functions = Fns(
        VERSION=Fn(result=rep_version, raises=None if rep_version != "V3" else RuntimeError("reverted")),
        getReputationScore=Fn(result=score),
        calculateCreditLimit=Fn(result=0 if locked_out else credit_limit),
        calculateCollateralRequirement=Fn(result=coll),
        calculateInterestRate=Fn(result=V7_TIER_RATES[_tier_of(score)]),
        tierOf=Fn(result=lambda s: _tier_of(s)),
        tierLimit=Fn(result=lambda s: V7_TIER_LIMITS[_tier_of(s)]),
        tierLimits=Fn(result=lambda i: V7_TIER_LIMITS[i], counter=counter),
        tierMinScore=Fn(result=lambda i: V7_TIER_MIN_SCORE[i]),
        tierCollateralPct=Fn(result=lambda i: V7_TIER_COLLATERAL[i]),
        tierInterestBps=Fn(result=lambda i: V7_TIER_RATES[i]),
        unsecuredTierExposure=Fn(result=lambda i: V7_TIER_LIMITS[i] * (100 - V7_TIER_COLLATERAL[i]) // 100),
        MAX_TIER_LIMIT=Fn(result=MAX_TIER_LIMIT),
        ladderLimit=Fn(result=USDC(5100)),
        maxRepaidPrincipal=Fn(result=USDC(2500)),
        isLockedOut=Fn(result=locked_out),
        lockedUntil=Fn(result=locked_until),
    )
    c.registry = MagicMock()
    c.registry.functions = Fns(addressToAgentId=Fn(result=1))
    return c


def _tier_of(score):
    for i in range(5, -1, -1):
        if score >= V7_TIER_MIN_SCORE[i]:
            return i
    return 0


# --------------------------------------------------------- capability detection

class TestVersionOrdinal(unittest.TestCase):
    def test_orders_generations_and_fails_safe(self):
        self.assertEqual(SpecularClient.version_ordinal("V6"), 6.0)
        self.assertEqual(SpecularClient.version_ordinal("V6.1"), 6.1)
        self.assertEqual(SpecularClient.version_ordinal("V6.2"), 6.2)
        self.assertEqual(SpecularClient.version_ordinal("V7"), 7.0)
        for junk in ("", None, "nonsense", "6.2"):
            self.assertEqual(SpecularClient.version_ordinal(junk), 6.0,
                             "an unidentifiable version must sort as the most conservative generation")
        self.assertGreater(SpecularClient.version_ordinal("V6.2"), SpecularClient.version_ordinal("V6.1"))


class TestCapabilityMatrix(unittest.TestCase):
    def test_v6(self):
        caps = client(version="V6", rep_version="V3").capabilities()
        self.assertEqual(caps["version"], "V6")
        self.assertFalse(caps["v61"])
        self.assertFalse(caps["v62"])
        self.assertFalse(caps["reputation_v4"])

    def test_v61_is_not_v62(self):
        """Base mainnet and Arc mainnet are here today: they must never be
        treated as having the self-stake gate."""
        caps = client(version="V6.1", rep_version="V3").capabilities()
        self.assertTrue(caps["v61"])
        self.assertFalse(caps["v62"])
        self.assertEqual(caps["reputation_version"], "V3")

    def test_v62_with_v4_reputation(self):
        caps = client(version="V6.2", rep_version="V4").capabilities()
        self.assertEqual(caps["version"], "V6.2")
        self.assertEqual(caps["ordinal"], 6.2)
        self.assertTrue(caps["v61"], "V6.2 keeps every V6.1 view")
        self.assertTrue(caps["v62"])
        self.assertTrue(caps["reputation_v4"])

    def test_claims_v62_without_the_selector_is_not_v62(self):
        c = client(version="V6.2", code_selectors=MP_SELECTORS)  # no requiredSelfStake in bytecode
        caps = c.capabilities()
        self.assertEqual(caps["version"], "V6.2")
        self.assertFalse(caps["v62"], "the version string alone must not enable the gate")

    def test_reputation_version_transient_failure_is_surfaced_not_guessed(self):
        c = client(rep_version="V4")
        c.w3.eth.get_code = MagicMock(side_effect=TRANSIENT)
        with self.assertRaises(RuntimeError) as cm:
            c.reputation_version()
        self.assertRegex(str(cm.exception), r"(?i)could not determine|refusing to guess")

    def test_capabilities_are_cached(self):
        c = client()
        self.assertIs(c.capabilities(), c.capabilities())


# ------------------------------------------------------------------ self-stake

class TestSelfStakeViews(unittest.TestCase):
    def test_required_self_stake_and_self_stake_on_v62(self):
        c = client(self_stake=USDC(1000), required=USDC(2500), outstanding=USDC(5000))
        self.assertEqual(c.required_self_stake(1), USDC(2500))
        st = c.self_stake(1)
        self.assertEqual(st.amount, USDC(1000))
        self.assertEqual(st.required, USDC(2500))
        self.assertEqual(st.shortfall, USDC(1500))
        self.assertEqual(st.shortfall_usdc, 1500.0)
        self.assertTrue(st.locked, "outstanding principal locks the position")

    def test_unlocked_when_nothing_outstanding(self):
        st = client(outstanding=0).self_stake(1)
        self.assertFalse(st.locked)

    def test_unsupported_on_v6_and_v61_rather_than_a_fabricated_zero(self):
        for version in ("V6", "V6.1"):
            c = client(version=version, rep_version="V3")
            for fn in (lambda: c.required_self_stake(1, 100), lambda: c.self_stake(1)):
                with self.assertRaises(UnsupportedOnDeployment) as cm:
                    fn()
                self.assertRegex(str(cm.exception), r"not supported on this deployment")
                self.assertRegex(str(cm.exception), r"requires V6\.2")

    def test_agent_id_is_validated_before_any_chain_work(self):
        c = client()
        for bad in (-1, 1.5, "one", None, True):
            with self.assertRaises(ValueError):
                c.required_self_stake(bad)


# ----------------------------------------------------------- the borrow gate

class TestBorrowSelfStakeGate(unittest.TestCase):
    def test_raises_with_the_exact_shortfall_before_any_transaction(self):
        c = client(self_stake=USDC(100), required=USDC(2500), score=800)
        with self.assertRaises(InsufficientSelfStake) as cm:
            c._assert_self_stake_sufficient(USDC(5000), 0)
        e = cm.exception
        self.assertEqual(e.agent_id, 1)
        self.assertEqual(e.required, USDC(2500))
        self.assertEqual(e.current, USDC(100))
        self.assertEqual(e.shortfall, USDC(2400))
        self.assertRegex(str(e), r"Insufficient self-stake")
        self.assertRegex(str(e), r"2400\.0 USDC short")
        self.assertRegex(str(e), r"client\.supply\(1, 2400\.0\)")
        self.assertEqual(c.sent, [], "nothing may be sent by a refused borrow")

    def test_passes_when_the_stake_already_covers_the_exposure(self):
        c = client(self_stake=USDC(2500), required=USDC(2500))
        c._assert_self_stake_sufficient(USDC(5000), 0)  # must not raise

    def test_no_gate_at_a_100_percent_collateral_tier(self):
        counter = {}
        c = client(self_stake=0, required=USDC(2500), counter=counter)
        c._assert_self_stake_sufficient(USDC(5000), 100)
        self.assertEqual(counter, {}, "nothing unsecured => nothing to stake => no read")

    def test_no_gate_on_a_v61_deployment(self):
        c = client(version="V6.1", rep_version="V3", self_stake=0)
        c._assert_self_stake_sufficient(USDC(5000), 0)  # must not raise

    def test_fails_open_when_the_probe_itself_fails(self):
        """The gate is enforced on chain regardless; a probe failure must cost
        the caller an explanation, never the ability to borrow."""
        c = client(self_stake=0, required=USDC(2500))
        c.w3.eth.get_code = MagicMock(side_effect=TRANSIENT)
        c._assert_self_stake_sufficient(USDC(5000), 0)  # must not raise

        c2 = client(self_stake=0, required=USDC(2500), self_stake_view_raises=TRANSIENT)
        c2._assert_self_stake_sufficient(USDC(5000), 0)  # must not raise


# --------------------------------------------------------- the withdraw lock

class TestWithdrawLock(unittest.TestCase):
    def test_creator_with_outstanding_principal_is_refused_locally(self):
        c = client(creator=AGENT, outstanding=USDC(5000))
        with self.assertRaises(SelfStakeLocked) as cm:
            c._assert_withdraw_not_locked(1)
        e = cm.exception
        self.assertEqual(e.outstanding_principal, USDC(5000))
        self.assertRegex(str(e), r"FIRST-LOSS SELF-STAKE")
        self.assertRegex(str(e), r"Self-stake locked while borrowing")
        self.assertRegex(str(e), r"Ordinary lenders in this pool are not")
        self.assertEqual(c.sent, [])

    def test_creator_with_nothing_outstanding_is_allowed(self):
        client(creator=AGENT, outstanding=0)._assert_withdraw_not_locked(1)

    def test_ordinary_lender_is_never_locked(self):
        client(creator=OTHER, outstanding=USDC(5000))._assert_withdraw_not_locked(1)

    def test_no_lock_on_a_v61_deployment(self):
        client(version="V6.1", rep_version="V3", creator=AGENT,
               outstanding=USDC(5000))._assert_withdraw_not_locked(1)

    def test_withdraw_runs_the_check_before_sending(self):
        c = client(creator=AGENT, outstanding=USDC(5000))
        with self.assertRaises(SelfStakeLocked):
            c.withdraw(1, 10)
        self.assertEqual(c.sent, [], "withdraw must not send a doomed transaction")


# ------------------------------------------------------------- the tier table

class TestTierTable(unittest.TestCase):
    def test_read_from_chain_on_v4(self):
        counter = {}
        t = client(rep_version="V4", counter=counter).tier_table()
        self.assertEqual(t["source"], "chain")
        self.assertEqual(len(t["tiers"]), 6)
        self.assertGreaterEqual(counter.get("tierLimits", 0), 6,
                                "every tier limit must come from a contract read")
        self.assertEqual([x.limit for x in t["tiers"]], V7_TIER_LIMITS)
        self.assertEqual([x.collateral_pct for x in t["tiers"]], V7_TIER_COLLATERAL)
        self.assertEqual(t["max_tier_limit"], MAX_TIER_LIMIT)
        # The V3 numbers this client used to imply must not appear.
        self.assertNotIn(USDC(25000), [x.limit for x in t["tiers"]])
        self.assertNotIn(USDC(50000), [x.limit for x in t["tiers"]])
        for tier in t["tiers"]:
            self.assertLessEqual(tier.limit, t["max_tier_limit"])

    def test_follows_an_owner_set_change(self):
        raised = list(V7_TIER_LIMITS)
        raised[5] = USDC(9000)
        c = client(rep_version="V4")
        c.reputation.functions._fns["tierLimits"] = Fn(result=lambda i: raised[i], name="tierLimits")
        self.assertEqual(c.tier_table()["tiers"][5].limit, USDC(9000))

    def test_v3_constants_are_labelled_honestly(self):
        t = client(version="V6.1", rep_version="V3").tier_table()
        self.assertEqual(t["source"], "v3-constant")
        self.assertIsNone(t["max_tier_limit"], "V3 has no ceiling to report")
        self.assertEqual(t["tiers"][4].limit, USDC(25000))
        self.assertEqual(t["tiers"][5].limit, USDC(50000))


# ------------------------------------------------------------- credit_info

class TestCreditInfo(unittest.TestCase):
    def test_v7_fields_present(self):
        info = client(score=800, credit_limit=USDC(5000), self_stake=USDC(2500),
                      outstanding=USDC(1000), required=USDC(500)).credit_info()
        self.assertEqual(info.marketplace_version, "V6.2")
        self.assertEqual(info.reputation_version, "V4")
        self.assertEqual(info.tier, 5)
        self.assertEqual(info.tier_limit_usdc, 5000.0)
        self.assertEqual(info.ladder_limit_usdc, 5100.0)
        self.assertEqual(info.max_tier_limit_usdc, 10000.0)
        self.assertFalse(info.locked_out)
        self.assertRegex(info.limit_explanation, r"min\(tier limit")
        self.assertIsNotNone(info.self_stake)
        self.assertTrue(info.self_stake.locked)

    def test_lockout_is_explained_not_left_as_a_bare_zero(self):
        info = client(locked_out=True, locked_until=1_800_000_000, credit_limit=0).credit_info()
        self.assertEqual(info.credit_limit_usdc, 0.0)
        self.assertTrue(info.locked_out)
        self.assertRegex(info.limit_explanation, r"LOCKED OUT after a default")
        self.assertRegex(info.limit_explanation, r"reset to 0")

    def test_v3_deployment_reports_no_v7_fields_rather_than_faking_them(self):
        info = client(version="V6.1", rep_version="V3", score=800).credit_info()
        self.assertEqual(info.reputation_version, "V3")
        self.assertIsNone(info.tier)
        self.assertIsNone(info.limit_explanation)
        self.assertIsNone(info.self_stake)

    def test_capability_probe_failure_still_returns_the_base_answer(self):
        c = client()
        c.w3.eth.get_code = MagicMock(side_effect=TRANSIENT)
        info = c.credit_info()
        self.assertEqual(info.credit_limit_usdc, 5000.0)
        self.assertIsNone(info.marketplace_version)


# ------------------------------------------------------------- config parity

class TestConfigParity(unittest.TestCase):
    def test_v7_address_keys_are_preferred(self):
        """A V7 deployment publishes agentLiquidityMarketplace_v62 /
        reputationManagerV4 as FRESH deploys. The client must prefer them, or a
        Python agent silently keeps talking to the retired V6.1 stack."""
        import json
        from pathlib import Path
        cfg = json.loads((Path(REPO_ROOT) / "src" / "config" / "arc-testnet-v6-addresses.json").read_text())
        if "agentLiquidityMarketplace_v62" not in cfg:
            self.skipTest("arc-staging config carries no V7 keys yet")
        chosen_mp = (cfg.get("agentLiquidityMarketplace_v62")
                     or cfg.get("agentLiquidityMarketplace_v6")
                     or cfg["agentLiquidityMarketplace"])
        chosen_rep = cfg.get("reputationManagerV4") or cfg["reputationManagerV3"]
        self.assertEqual(chosen_mp, cfg["agentLiquidityMarketplace_v62"])
        self.assertEqual(chosen_rep, cfg["reputationManagerV4"])


if __name__ == "__main__":
    unittest.main()
