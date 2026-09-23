"""
Example: Using Specular Credit in a CrewAI Crew

This example shows how to add credit access to CrewAI agents.
"""

import os
from dotenv import load_dotenv
from crewai import Agent, Task, Crew
from specular_credit_tool import SpecularCreditTool

load_dotenv()


def main():
    print("═══════════════════════════════════════")
    print("  CrewAI + Specular Credit Example")
    print("═══════════════════════════════════════\n")

    # Initialize Specular Credit Tool
    credit_tool = SpecularCreditTool(
        private_key=os.getenv("PRIVATE_KEY"),
        network="arc"  # or "base" for mainnet
    )

    print("✅ Credit tool initialized\n")

    # Create a Financial Manager Agent
    financial_manager = Agent(
        role='Financial Manager',
        goal='Optimize capital efficiency and manage liquidity for the organization',
        backstory="""You are an expert financial manager for an AI-powered organization.
        Your job is to ensure optimal capital allocation, manage working capital needs,
        and build strong credit reputation on-chain.""",
        tools=[credit_tool],
        verbose=True
    )

    # Create a Treasury Analyst Agent
    treasury_analyst = Agent(
        role='Treasury Analyst',
        goal='Monitor cash positions and recommend financing decisions',
        backstory="""You are a meticulous treasury analyst who tracks all financial
        positions and provides recommendations on when to borrow or lend capital.""",
        tools=[credit_tool],
        verbose=True
    )

    # Task 1: Check Credit Eligibility
    check_eligibility_task = Task(
        description="""Check our current credit eligibility on Specular Protocol.
        Report on our reputation score, maximum loan amount, interest rate, and
        collateral requirements.""",
        agent=treasury_analyst,
        expected_output="A detailed report on credit eligibility"
    )

    # Task 2: Request Working Capital Loan
    request_loan_task = Task(
        description="""Based on the credit check, request a $50 USDC loan for 30 days
        to cover short-term working capital needs. Ensure the terms are favorable.""",
        agent=financial_manager,
        expected_output="Confirmation of loan request with loan ID and terms"
    )

    # Task 3: Monitor Loan Status
    monitor_loan_task = Task(
        description="""After requesting the loan, monitor its status and prepare
        a repayment plan to ensure on-time payment and reputation building.""",
        agent=treasury_analyst,
        expected_output="Loan status report and repayment plan"
    )

    # Create the Crew
    financial_crew = Crew(
        agents=[financial_manager, treasury_analyst],
        tasks=[check_eligibility_task, request_loan_task, monitor_loan_task],
        verbose=True
    )

    print("\n🚀 Starting Financial Crew...\n")

    # Execute the crew
    result = financial_crew.kickoff()

    print("\n═══════════════════════════════════════")
    print("  Crew Execution Complete!")
    print("═══════════════════════════════════════\n")
    print(result)


def simple_example():
    """Simpler example without full CrewAI"""
    print("Simple Example: Direct Tool Usage\n")

    credit_tool = SpecularCreditTool(
        private_key=os.getenv("PRIVATE_KEY"),
        network="arc"
    )

    # Check eligibility
    print("1. Checking eligibility...")
    result = credit_tool._run('{"action": "check_eligibility"}')
    print(result, "\n")

    # Check reputation
    print("2. Checking reputation...")
    result = credit_tool._run('{"action": "check_reputation"}')
    print(result, "\n")

    # Request loan
    print("3. Requesting loan...")
    result = credit_tool._run('{"action": "request_loan", "amount": 10, "duration_days": 7}')
    print(result, "\n")


if __name__ == "__main__":
    # Run simple example (uncomment for full CrewAI example)
    simple_example()
    # main()
