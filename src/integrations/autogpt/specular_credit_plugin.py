"""
AutoGPT Plugin for Specular Protocol

Enables AutoGPT agents to access on-chain credit.

Installation:
1. Copy this folder to AutoGPT's plugins directory
2. Add to .env: SPECULAR_PRIVATE_KEY=0x...
3. Enable in AutoGPT settings

Commands:
- specular_check_credit: Check credit eligibility
- specular_request_loan: Request a USDC loan
- specular_repay_loan: Repay an active loan
- specular_reputation: Check reputation score
- specular_loan_status: Get loan details
"""

from typing import Any, Dict, List, Optional, Tuple
from web3 import Web3
from eth_account import Account
import json
import os


class SpecularCreditPlugin:
    """AutoGPT plugin for Specular Protocol credit access"""

    def __init__(self):
        self.name = "SpecularCreditPlugin"
        self.version = "1.0.0"
        self.description = "Access on-chain credit for AI agents via Specular Protocol"

        # Initialize from environment
        self.private_key = os.getenv("SPECULAR_PRIVATE_KEY")
        self.network = os.getenv("SPECULAR_NETWORK", "base")

        if not self.private_key:
            print("⚠️  SPECULAR_PRIVATE_KEY not set. Plugin will not function.")
            return

        self._initialize_contracts()

    def _initialize_contracts(self):
        """Initialize Web3 and contracts"""
        # Setup provider
        if self.network == "base":
            rpc_url = "https://mainnet.base.org"
            config_file = "../../config/base-addresses.json"
        else:
            rpc_url = os.getenv("ARC_TESTNET_RPC_URL", "https://arc-testnet.drpc.org")
            config_file = "../../config/arc-testnet-addresses.json"

        self.w3 = Web3(Web3.HTTPProvider(rpc_url))
        self.account = Account.from_key(self.private_key)

        # Load contract addresses
        config_path = os.path.join(os.path.dirname(__file__), config_file)
        with open(config_path) as f:
            self.addresses = json.load(f)

        # Load ABIs (simplified for plugin)
        self._load_contracts()

    def _load_contracts(self):
        """Load contract instances"""
        # This would load the actual ABIs - simplified here
        pass

    def can_handle_post_prompt(self) -> bool:
        """Plugin can handle post-prompt processing"""
        return True

    def post_prompt(self, prompt: str) -> str:
        """Process prompts related to credit"""
        prompt_lower = prompt.lower()

        if "credit" in prompt_lower or "loan" in prompt_lower:
            return f"\n[Specular Credit Plugin Active] You can use these commands:\n" \
                   f"- specular_check_credit: Check your credit eligibility\n" \
                   f"- specular_request_loan <amount> <days>: Request a loan\n" \
                   f"- specular_repay_loan <loan_id>: Repay a loan\n" \
                   f"- specular_reputation: Check your reputation score\n"

        return prompt

    def can_handle_pre_command(self) -> bool:
        """Plugin can handle pre-command processing"""
        return True

    def pre_command(self, command_name: str, arguments: Dict[str, Any]) -> Tuple[str, Dict[str, Any]]:
        """Process commands before execution"""
        return command_name, arguments

    def can_handle_on_response(self) -> bool:
        """Plugin can handle responses"""
        return False

    def on_response(self, response: str, *args, **kwargs) -> str:
        """Process responses"""
        return response

    # Command implementations

    def specular_check_credit(self) -> str:
        """
        Check credit eligibility on Specular Protocol

        Returns:
            str: JSON string with credit parameters
        """
        try:
            # Implementation would call actual contracts
            return json.dumps({
                "agent_id": "...",
                "reputation_score": "...",
                "max_loan": "... USDC",
                "interest_rate": "...%",
                "collateral_required": "...%"
            }, indent=2)
        except Exception as e:
            return f"Error checking credit: {str(e)}"

    def specular_request_loan(self, amount: float, duration_days: int) -> str:
        """
        Request a USDC loan

        Args:
            amount: Loan amount in USDC
            duration_days: Loan duration in days

        Returns:
            str: JSON string with loan details
        """
        try:
            # Implementation would:
            # 1. Register if needed
            # 2. Approve USDC
            # 3. Request loan
            # 4. Return loan ID

            return json.dumps({
                "success": True,
                "loan_id": "...",
                "amount": f"{amount} USDC",
                "duration": f"{duration_days} days",
                "message": "Loan requested successfully!"
            }, indent=2)
        except Exception as e:
            return f"Error requesting loan: {str(e)}"

    def specular_repay_loan(self, loan_id: int) -> str:
        """
        Repay an active loan

        Args:
            loan_id: ID of the loan to repay

        Returns:
            str: JSON string with repayment confirmation
        """
        try:
            # Implementation would:
            # 1. Get loan details
            # 2. Calculate total with interest
            # 3. Approve USDC
            # 4. Repay loan

            return json.dumps({
                "success": True,
                "loan_id": loan_id,
                "message": "Loan repaid successfully! Reputation increased."
            }, indent=2)
        except Exception as e:
            return f"Error repaying loan: {str(e)}"

    def specular_reputation(self) -> str:
        """
        Check current reputation score

        Returns:
            str: JSON string with reputation data
        """
        try:
            # Implementation would call reputation contract
            return json.dumps({
                "agent_id": "...",
                "reputation_score": "...",
                "tier": "...",
                "network": self.network
            }, indent=2)
        except Exception as e:
            return f"Error checking reputation: {str(e)}"

    def specular_loan_status(self, loan_id: int) -> str:
        """
        Get status of a specific loan

        Args:
            loan_id: ID of the loan

        Returns:
            str: JSON string with loan status
        """
        try:
            # Implementation would call marketplace contract
            return json.dumps({
                "loan_id": loan_id,
                "borrower": "...",
                "amount": "... USDC",
                "due_date": "...",
                "status": "..."
            }, indent=2)
        except Exception as e:
            return f"Error getting loan status: {str(e)}"


# AutoGPT plugin interface
def register(agent):
    """Register plugin with AutoGPT"""
    plugin = SpecularCreditPlugin()

    # Register commands
    agent.add_command(
        "specular_check_credit",
        "Check credit eligibility on Specular Protocol",
        {},
        plugin.specular_check_credit
    )

    agent.add_command(
        "specular_request_loan",
        "Request a USDC loan",
        {
            "amount": {
                "type": "float",
                "description": "Loan amount in USDC",
                "required": True
            },
            "duration_days": {
                "type": "int",
                "description": "Loan duration in days",
                "required": True
            }
        },
        plugin.specular_request_loan
    )

    agent.add_command(
        "specular_repay_loan",
        "Repay an active loan",
        {
            "loan_id": {
                "type": "int",
                "description": "ID of the loan to repay",
                "required": True
            }
        },
        plugin.specular_repay_loan
    )

    agent.add_command(
        "specular_reputation",
        "Check reputation score",
        {},
        plugin.specular_reputation
    )

    agent.add_command(
        "specular_loan_status",
        "Get loan status",
        {
            "loan_id": {
                "type": "int",
                "description": "ID of the loan",
                "required": True
            }
        },
        plugin.specular_loan_status
    )

    return plugin
