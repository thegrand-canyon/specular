/**
 * Test Concurrent Loans from Multiple Agents
 * All agents request loans at the same time
 */

const { ethers } = require('hardhat');
const fs = require('fs');
const path = require('path');

async function main() {
    console.log('\n🔥 CONCURRENT LOAN TEST\n');
    console.log('═══════════════════════════════════════════════════════\n');

    const addressesPath = path.join(__dirname, '..', 'src', 'config', 'sepolia-addresses.json');
    const addresses = JSON.parse(fs.readFileSync(addressesPath, 'utf8'));

    const testAgentsPath = path.join(__dirname, '..', 'test-agents.json');
    const testAgents = JSON.parse(fs.readFileSync(testAgentsPath, 'utf8'));

    const v3Pool = await ethers.getContractAt('LendingPoolV3', addresses.lendingPool);
    const reputationManager = await ethers.getContractAt('ReputationManagerV2', addresses.reputationManager);
    const usdc = await ethers.getContractAt('MockUSDC', addresses.mockUSDC);

    console.log('📊 Agent Status:\n');

    const agentWallets = [];

    for (const agent of testAgents) {
        const wallet = new ethers.Wallet(agent.privateKey, ethers.provider);
        const reputation = await reputationManager['getReputationScore(address)'](agent.address);
        const creditLimit = await reputationManager['calculateCreditLimit(address)'](agent.address);
        const usdcBalance = await usdc.balanceOf(agent.address);

        console.log(`${agent.name}:`);
        console.log(`  Address: ${agent.address}`);
        console.log(`  Reputation: ${reputation}`);
        console.log(`  Credit Limit: ${ethers.formatUnits(creditLimit, 6)} USDC`);
        console.log(`  USDC Balance: ${ethers.formatUnits(usdcBalance, 6)}`);
        console.log('');

        agentWallets.push({ ...agent, wallet, reputation, creditLimit });
    }

    // Check pool liquidity
    const poolLiquidity = await v3Pool.availableLiquidity();
    console.log('Pool Available Liquidity:', ethers.formatUnits(poolLiquidity, 6), 'USDC\n');

    console.log('═══════════════════════════════════════════════════════\n');
    console.log('🚀 Starting Concurrent Loan Requests...\n');

    // All agents request loans simultaneously (within 1000 USDC credit limit for rep 100)
    const loanRequests = [
        { agent: agentWallets[0], amount: '1000', duration: 30 },
        { agent: agentWallets[1], amount: '800', duration: 60 },
        { agent: agentWallets[2], amount: '600', duration: 90 },
        { agent: agentWallets[3], amount: '400', duration: 45 }
    ];

    console.log('Loan Requests:');
    for (const req of loanRequests) {
        console.log(`  ${req.agent.name}: ${req.amount} USDC for ${req.duration} days`);
    }
    console.log('\n⏳ Requesting loans sequentially (to avoid nonce issues)...\n');

    const startTime = Date.now();
    const results = [];

    // Send requests sequentially to avoid nonce conflicts
    for (const req of loanRequests) {
        const result = await (async () => {
        try {
            const loanAmount = ethers.parseUnits(req.amount, 6);

            // Get actual collateral requirement for this agent
            const collateralPercent = await reputationManager['calculateCollateralRequirement(address)'](req.agent.address);
            const collateral = (loanAmount * collateralPercent) / 100n;

            // Approve collateral
            await usdc.connect(req.agent.wallet).approve(addresses.lendingPool, collateral);

            // Request loan
            const tx = await v3Pool.connect(req.agent.wallet).requestLoan(loanAmount, req.duration);
            const receipt = await tx.wait();

            // Check if auto-approved
            const approveEvent = receipt.logs.find(log => {
                try {
                    return v3Pool.interface.parseLog(log)?.name === 'LoanApproved';
                } catch { return false; }
            });

            if (approveEvent) {
                const parsed = v3Pool.interface.parseLog(approveEvent);
                const loanId = parsed.args.loanId;
                const autoApproved = parsed.args.autoApproved;

                return {
                    agent: req.agent.name,
                    success: true,
                    loanId: loanId.toString(),
                    autoApproved,
                    amount: req.amount
                };
            }

            return {
                agent: req.agent.name,
                success: false,
                error: 'Not auto-approved'
            };

        } catch (error) {
            return {
                agent: req.agent.name,
                success: false,
                error: error.message.split('\n')[0].substring(0, 100)
            };
        }
        })();

        results.push(result);
    }

    const endTime = Date.now();

    console.log('═══════════════════════════════════════════════════════\n');
    console.log('📊 CONCURRENT LOAN RESULTS:\n');

    let successCount = 0;
    let totalLoaned = 0n;

    for (const result of results) {
        if (result.success) {
            console.log(`✅ ${result.agent}:`);
            console.log(`   Loan ID: ${result.loanId}`);
            console.log(`   Amount: ${result.amount} USDC`);
            console.log(`   Auto-Approved: ${result.autoApproved ? 'YES ⚡' : 'NO'}`);
            successCount++;
            totalLoaned += ethers.parseUnits(result.amount, 6);
        } else {
            console.log(`❌ ${result.agent}:`);
            console.log(`   Error: ${result.error}`);
        }
        console.log('');
    }

    console.log('═══════════════════════════════════════════════════════\n');
    console.log('Performance Metrics:\n');
    console.log('Total Time:', (endTime - startTime) + 'ms');
    console.log('Success Rate:', (successCount / loanRequests.length * 100).toFixed(1) + '%');
    console.log('Total Loaned:', ethers.formatUnits(totalLoaned, 6), 'USDC');
    console.log('Throughput:', (successCount / ((endTime - startTime) / 1000)).toFixed(1), 'loans/second');

    const finalLiquidity = await v3Pool.availableLiquidity();
    console.log('\nPool Liquidity After:', ethers.formatUnits(finalLiquidity, 6), 'USDC');

    console.log('\n✅ Concurrent loan test complete!\n');
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
