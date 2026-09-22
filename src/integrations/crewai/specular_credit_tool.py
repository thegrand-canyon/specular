"""
CrewAI Tool for Specular Protocol

Enables CrewAI agents to access on-chain credit for USDC loans.

Installation:
    pip install crewai web3 python-dotenv

Usage:
    from crewai import Agent, Task, Crew
    from specular_credit_tool import SpecularCreditTool

    credit_tool = SpecularCreditTool(
        private_key="0x...",
        network="base"  # or "arc"
    )

    financial_agent = Agent(
        role='Financial Manager',
        goal='Manage liquidity and optimize capital efficiency',
        tools=[credit_tool]
    )

    crew = Crew(
        agents=[financial_agent],
        tasks=[...]
    )
"""

from crewai_tools import BaseTool
from web3 import Web3
from eth_account import Account
import json
import os
from typing import Optional, Dict, Any


class SpecularCreditTool(BaseTool):
    name: str = "Specular Credit Access"
    description: str = """Access on-chain credit for AI agents via Specular Protocol.

    This tool allows agents to:
    - Check credit eligibility and limits
    - Request USDC loans (unsecured or low-collateral)
    - Repay loans to build reputation
    - Track on-chain reputation score
    - View loan status

    Input format (JSON string):
    {
        "action": "check_eligibility" | "request_loan" | "repay_loan" | "check_reputation" | "loan_status",
        "amount": <number>,  # for request_loan
        "duration_days": <number>,  # for request_loan
        "loan_id": <number>  # for repay_loan and loan_status
    }

    Examples:
    - Check eligibility: {"action": "check_eligibility"}
    - Request loan: {"action": "request_loan", "amount": 100, "duration_days": 30}
    - Repay loan: {"action": "repay_loan", "loan_id": 1}
    - Check reputation: {"action": "check_reputation"}
    - Loan status: {"action": "loan_status", "loan_id": 1}
    """

    private_key: str
    network: str = "base"
    w3: Optional[Web3] = None
    account: Optional[Account] = None
    contracts: Dict[str, Any] = {}

    def __init__(self, private_key: str, network: str = "base", **kwargs):
        super().__init__(**kwargs)
        self.private_key = private_key
        self.network = network
        self._initialize_contracts()

    def _initialize_contracts(self):
        """Initialize Web3 connection and contract instances"""

        # Setup provider
        if self.network == "base":
            rpc_url = "https://mainnet.base.org"
            config_file = "../../../src/config/base-addresses.json"
        else:
            rpc_url = os.getenv("ARC_TESTNET_RPC_URL", "https://arc-testnet.drpc.org")
            config_file = "../../../src/config/arc-testnet-addresses.json"

        self.w3 = Web3(Web3.HTTPProvider(rpc_url))
        self.account = Account.from_key(self.private_key)

        # Load contract addresses
        config_path = os.path.join(os.path.dirname(__file__), config_file)
        with open(config_path) as f:
            addresses = json.load(f)

        # Load ABIs
        registry_abi_path = os.path.join(
            os.path.dirname(__file__),
            "../../../artifacts/contracts/core/AgentRegistryV2.sol/AgentRegistryV2.json"
        )
        with open(registry_abi_path) as f:
            registry_abi = json.load(f)["abi"]

        reputation_abi_path = os.path.join(
            os.path.dirname(__file__),
            "../../../artifacts/contracts/core/ReputationManagerV3.sol/ReputationManagerV3.json"
        )
        with open(reputation_abi_path) as f:
            reputation_abi = json.load(f)["abi"]

        marketplace_abi_path = os.path.join(
            os.path.dirname(__file__),
            "../../../artifacts/contracts/core/AgentLiquidityMarketplace.sol/AgentLiquidityMarketplace.json"
        )
        with open(marketplace_abi_path) as f:
            marketplace_abi = json.load(f)["abi"]

        # Initialize contracts
        self.contracts['registry'] = self.w3.eth.contract(
            address=Web3.to_checksum_address(addresses.get('agentRegistryV2') or addresses.get('agentRegistry')),
            abi=registry_abi
        )
        self.contracts['reputation'] = self.w3.eth.contract(
            address=Web3.to_checksum_address(addresses.get('reputationManagerV3') or addresses.get('reputationManager')),
            abi=reputation_abi
        )
        self.contracts['marketplace'] = self.w3.eth.contract(
            address=Web3.to_checksum_address(addresses['agentLiquidityMarketplace']),
            abi=marketplace_abi
        )

        usdc_abi = [
            {
                "constant": False,
                "inputs": [{"name": "spender", "type": "address"}, {"name": "amount", "type": "uint256"}],
                "name": "approve",
                "outputs": [{"name": "", "type": "bool"}],
                "type": "function"
            },
            {
                "constant": True,
                "inputs": [{"name": "account", "type": "address"}],
                "name": "balanceOf",
                "outputs": [{"name": "", "type": "uint256"}],
                "type": "function"
            }
        ]

        self.contracts['usdc'] = self.w3.eth.contract(
            address=Web3.to_checksum_address(addresses.get('usdc') or addresses.get('mockUSDC')),
            abi=usdc_abi
        )

        self.addresses = addresses

    def _run(self, input_str: str) -> str:
        """Execute credit operations based on input"""
        try:
            params = json.loads(input_str)
            action = params.get('action')

            if action == 'check_eligibility':
                return self._check_eligibility()
            elif action == 'request_loan':
                return self._request_loan(params.get('amount'), params.get('duration_days'))
            elif action == 'repay_loan':
                return self._repay_loan(params.get('loan_id'))
            elif action == 'check_reputation':
                return self._check_reputation()
            elif action == 'loan_status':
                return self._loan_status(params.get('loan_id'))
            else:
                return f"Unknown action: {action}"

        except Exception as e:
            return f"Error: {str(e)}"

    def _check_eligibility(self) -> str:
        """Check credit eligibility"""
        registry = self.contracts['registry']
        reputation = self.contracts['reputation']
        marketplace = self.contracts['marketplace']

        agent_id = registry.functions.addressToAgentId(self.account.address).call()

        if agent_id == 0:
            return json.dumps({
                "eligible": False,
                "message": "Not registered. Call request_loan to auto-register."
            })

        score = reputation.functions.getReputationScore(agent_id).call()
        params = marketplace.functions.getCreditParameters(agent_id).call()

        return json.dumps({
            "eligible": True,
            "agent_id": agent_id,
            "reputation_score": score,
            "max_loan_amount": f"{params[0] / 1e6} USDC",
            "interest_rate": f"{params[1] / 100}%",
            "collateral_required": f"{params[2]}%",
            "network": self.network
        }, indent=2)

    def _request_loan(self, amount: float, duration_days: int) -> str:
        """Request a loan"""
        if not amount or not duration_days:
            return "Error: amount and duration_days are required"

        amount_wei = int(amount * 1e6)  # USDC has 6 decimals

        registry = self.contracts['registry']
        marketplace = self.contracts['marketplace']
        usdc = self.contracts['usdc']

        # Check if registered
        agent_id = registry.functions.addressToAgentId(self.account.address).call()
        if agent_id == 0:
            # Register first
            tx = registry.functions.register(
                f"https://specular.network/agents/{self.account.address}",
                []
            ).build_transaction({
                'from': self.account.address,
                'nonce': self.w3.eth.get_transaction_count(self.account.address),
                'gas': 200000,
                'gasPrice': self.w3.eth.gas_price
            })
            signed = self.account.sign_transaction(tx)
            tx_hash = self.w3.eth.send_raw_transaction(signed.rawTransaction)
            self.w3.eth.wait_for_transaction_receipt(tx_hash)

        # Approve USDC
        approve_tx = usdc.functions.approve(
            self.addresses['agentLiquidityMarketplace'],
            amount_wei
        ).build_transaction({
            'from': self.account.address,
            'nonce': self.w3.eth.get_transaction_count(self.account.address),
            'gas': 100000,
            'gasPrice': self.w3.eth.gas_price
        })
        signed_approve = self.account.sign_transaction(approve_tx)
        self.w3.eth.send_raw_transaction(signed_approve.rawTransaction)

        # Request loan
        loan_tx = marketplace.functions.requestLoan(
            amount_wei,
            duration_days
        ).build_transaction({
            'from': self.account.address,
            'nonce': self.w3.eth.get_transaction_count(self.account.address),
            'gas': 300000,
            'gasPrice': self.w3.eth.gas_price
        })
        signed_loan = self.account.sign_transaction(loan_tx)
        tx_hash = self.w3.eth.send_raw_transaction(signed_loan.rawTransaction)
        receipt = self.w3.eth.wait_for_transaction_receipt(tx_hash)

        return json.dumps({
            "success": True,
            "amount": f"{amount} USDC",
            "duration": f"{duration_days} days",
            "tx_hash": tx_hash.hex(),
            "message": "Loan requested successfully!"
        }, indent=2)

    def _repay_loan(self, loan_id: int) -> str:
        """Repay a loan"""
        if loan_id is None:
            return "Error: loan_id is required"

        marketplace = self.contracts['marketplace']
        usdc = self.contracts['usdc']

        # Get loan details
        loan = marketplace.functions.loans(loan_id).call()
        principal = loan[2]
        interest_rate = loan[3]
        interest = (principal * interest_rate) // 10000
        total = principal + interest

        # Approve USDC
        approve_tx = usdc.functions.approve(
            self.addresses['agentLiquidityMarketplace'],
            total
        ).build_transaction({
            'from': self.account.address,
            'nonce': self.w3.eth.get_transaction_count(self.account.address),
            'gas': 100000,
            'gasPrice': self.w3.eth.gas_price
        })
        signed_approve = self.account.sign_transaction(approve_tx)
        self.w3.eth.send_raw_transaction(signed_approve.rawTransaction)

        # Repay
        repay_tx = marketplace.functions.repayLoan(loan_id).build_transaction({
            'from': self.account.address,
            'nonce': self.w3.eth.get_transaction_count(self.account.address),
            'gas': 250000,
            'gasPrice': self.w3.eth.gas_price
        })
        signed_repay = self.account.sign_transaction(repay_tx)
        tx_hash = self.w3.eth.send_raw_transaction(signed_repay.rawTransaction)
        self.w3.eth.wait_for_transaction_receipt(tx_hash)

        return json.dumps({
            "success": True,
            "loan_id": loan_id,
            "principal": f"{principal / 1e6} USDC",
            "interest": f"{interest / 1e6} USDC",
            "total_repaid": f"{total / 1e6} USDC",
            "tx_hash": tx_hash.hex(),
            "message": "Loan repaid successfully! Reputation increased."
        }, indent=2)

    def _check_reputation(self) -> str:
        """Check reputation score"""
        registry = self.contracts['registry']
        reputation = self.contracts['reputation']

        agent_id = registry.functions.addressToAgentId(self.account.address).call()
        if agent_id == 0:
            return "Not registered yet"

        score = reputation.functions.getReputationScore(agent_id).call()

        return json.dumps({
            "agent_id": agent_id,
            "reputation_score": score,
            "tier": self._get_tier(score),
            "network": self.network
        }, indent=2)

    def _loan_status(self, loan_id: int) -> str:
        """Get loan status"""
        if loan_id is None:
            return "Error: loan_id is required"

        marketplace = self.contracts['marketplace']
        loan = marketplace.functions.loans(loan_id).call()

        status_map = {0: 'ACTIVE', 1: 'REPAID', 2: 'DEFAULTED'}

        return json.dumps({
            "loan_id": loan_id,
            "borrower": loan[1],
            "amount": f"{loan[2] / 1e6} USDC",
            "interest_rate": f"{loan[3] / 100}%",
            "due_date": loan[4],
            "status": status_map.get(loan[5], 'UNKNOWN'),
            "collateral": f"{loan[6] / 1e6} USDC"
        }, indent=2)

    def _get_tier(self, score: int) -> str:
        """Human-readable tier NAME for a score.

        [V7] The collateral percentage, credit limit and APR are deliberately NOT
        part of this label any more. On ReputationManagerV4 the tier table is
        on-chain, owner-settable state (bounded by an immutable MAX_TIER_LIMIT),
        so a hardcoded "(25% collateral)" was already wrong for V3's 500-tier and
        is wrong for every V7 deployment. Read the real values from the contract
        (calculateCollateralRequirement / calculateCreditLimit), which
        get_credit_profile already reports."""
        if score >= 800:
            return "Elite"
        elif score >= 600:
            return "Premium"
        elif score >= 500:
            return "Standard"
        elif score >= 400:
            return "Building"
        elif score >= 200:
            return "Basic"
        else:
            return "Starter"
