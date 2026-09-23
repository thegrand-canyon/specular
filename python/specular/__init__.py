"""Specular — credit infrastructure for AI agents.

Quickstart:
    from web3 import Web3
    from eth_account import Account
    from specular import SpecularClient

    w3 = Web3(Web3.HTTPProvider("https://mainnet.base.org"))
    account = Account.from_key(YOUR_PRIVATE_KEY)
    sdk = SpecularClient(w3, account, network="base")

    sdk.onboard()
    loan_id = sdk.borrow(amount=100, duration_days=30)
    # ... agent does work with the USDC ...
    sdk.repay(loan_id)
"""

from .client import (
    CreditInfo,
    CreditTier,
    InsufficientSelfStake,
    LoanInfo,
    SelfStakeInfo,
    SelfStakeLocked,
    SpecularClient,
    UnsupportedOnDeployment,
)

__all__ = [
    "SpecularClient",
    "CreditInfo",
    "CreditTier",
    "LoanInfo",
    "SelfStakeInfo",
    # V7 (V6.2) errors an integrator must handle
    "InsufficientSelfStake",
    "SelfStakeLocked",
    "UnsupportedOnDeployment",
]
