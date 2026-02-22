/**
 * Build Reputation for Test Agents
 * Uses V2 to build reputation (V2 can update ReputationManager)
 */

const { ethers } = require('hardhat');
const fs = require('fs');
const path = require('path');

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
    console.log('\n📈 BUILDING AGENT REPUTATION\n');
    console.log('═══════════════════════════════════════════════════════\n');

    const [deployer] = await ethers.getSigners();

    // Load addresses and test agents
    const addressesPath = path.join(__dirname, '..', 'src', 'config', 'sepolia-addresses.json');
    const addresses = JSON.parse(fs.readFileSync(addressesPath, 'utf8'));

    const testAgentsPath = path.join(__dirname, '..', 'test-agents.json');
    const testAgents = JSON.parse(fs.readFileSync(testAgentsPath, 'utf8'));

    const v2Pool = await ethers.getContractAt('LendingPoolV2', addresses.lendingPoolV2);
    const reputationManager = await ethers.getContractAt('ReputationManagerV2', addresses.reputationManager);
    const usdc = await ethers.getContractAt('MockUSDC', addresses.mockUSDC);

    // Each agent will take multiple loans to build reputation
    const repBuildingPlan = [
        { name: 'Alice', loans: 90 },  // 90 loans * 10 rep = 900 rep + 100 start = 1000
        { name: 'Bob', loans: 60 },    // 60 loans * 10 = 600 + 100 = 700
        { name: 'Carol', loans: 40 },  // 40 loans * 10 = 400 + 100 = 500
        { name: 'Dave', loans: 0 }     // Stay at 100
    ];

    for (const plan of repBuildingPlan) {
        const agent = testAgents.find(a => a.name === plan.name);
        if (!agent) continue;

        console.log(`🎯 ${agent.name} (Target: ${agent.targetRep} rep, Need: ${plan.loans} loans)`);
        console.log('───────────────────────────────────────────────────────');

        if (plan.loans === 0) {
            console.log('  Keeping at initial reputation (100)');
            console.log('  ✅ Done\n');
            continue;
        }

        const wallet = new ethers.Wallet(agent.privateKey, ethers.provider);

        for (let i = 0; i < plan.loans; i++) {
            try {
                const loanAmount = ethers.parseUnits('100', 6); // Small loans to build rep quickly
                const collateral = loanAmount; // 100% collateral at rep 100-500

                // Approve collateral
                const approveCollateral = await usdc.connect(wallet).approve(addresses.lendingPoolV2, collateral);
                await approveCollateral.wait();

                // Request loan
                const requestTx = await v2Pool.connect(wallet).requestLoan(loanAmount, 30);
                await requestTx.wait();

                // Owner approves
                const nextLoanId = await v2Pool.nextLoanId();
                const loanId = nextLoanId - 1n;
                const approveTx = await v2Pool.connect(deployer).approveLoan(loanId);
                await approveTx.wait();

                // Repay immediately
                const loan = await v2Pool.loans(loanId);
                const principal = loan.amount;
                const rate = loan.interestRate;
                const duration = loan.durationDays;
                const interest = (principal * rate * duration) / (10000n * 365n);
                const totalRepayment = principal + interest;

                const approveRepayment = await usdc.connect(wallet).approve(addresses.lendingPoolV2, totalRepayment);
                await approveRepayment.wait();

                const repayTx = await v2Pool.connect(wallet).repayLoan(loanId);
                await repayTx.wait();

                if ((i + 1) % 10 === 0) {
                    const currentRep = await reputationManager['getReputationScore(address)'](agent.address);
                    console.log(`  Progress: ${i + 1}/${plan.loans} loans - Rep: ${currentRep}`);
                }

                await sleep(1000); // Small delay to avoid nonce issues

            } catch (error) {
                console.log(`  Error on loan ${i + 1}:`, error.message.split('\n')[0]);
            }
        }

        const finalRep = await reputationManager['getReputationScore(address)'](agent.address);
        console.log(`  ✅ Final Reputation: ${finalRep}`);
        console.log('');
    }

    console.log('═══════════════════════════════════════════════════════\n');
    console.log('📊 Final Reputation Summary:\n');

    for (const agent of testAgents) {
        const reputation = await reputationManager['getReputationScore(address)'](agent.address);
        const creditLimit = await reputationManager['calculateCreditLimit(address)'](agent.address);

        console.log(`${agent.name}:`);
        console.log(`  Reputation: ${reputation}`);
        console.log(`  Credit Limit: ${ethers.formatUnits(creditLimit, 6)} USDC`);
        console.log('');
    }

    console.log('✅ Reputation building complete!\n');
    console.log('🎯 Next: Test concurrent loans');
    console.log('   npx hardhat run scripts/test-concurrent-loans.js --network sepolia\n');
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
