/**
 * Test Deployment Script
 *
 * Tests deployed V2 contracts on Sepolia to ensure everything works correctly.
 *
 * Usage:
 *   npx hardhat run scripts/test-deployment.js --network sepolia
 */

const { ethers } = require('hardhat');
const fs = require('fs');
const path = require('path');

async function main() {
    console.log('\n🧪 Testing Specular V2 deployment on Sepolia...\n');

    // Load deployed addresses
    const addressesPath = path.join(__dirname, '..', 'src', 'config', 'sepolia-addresses.json');

    if (!fs.existsSync(addressesPath)) {
        console.error('❌ Error: Sepolia addresses file not found!');
        console.error('Please deploy contracts first.');
        process.exit(1);
    }

    const addresses = JSON.parse(fs.readFileSync(addressesPath, 'utf8'));
    const [deployer] = await ethers.getSigners();

    console.log(`Testing with account: ${deployer.address}\n`);

    // Get contract instances
    const agentRegistry = await ethers.getContractAt('AgentRegistryV2', addresses.agentRegistry);
    const reputationManager = await ethers.getContractAt('ReputationManagerV2', addresses.reputationManager);
    const lendingPool = await ethers.getContractAt('LendingPoolV2', addresses.lendingPool);
    const usdc = await ethers.getContractAt('MockUSDC', addresses.mockUSDC);

    try {
        // Test 1: Check if contracts are accessible
        console.log('✓ Test 1: Contract Accessibility');
        const totalAgents = await agentRegistry.totalAgents();
        console.log(`  Current agents registered: ${totalAgents}`);

        // Test 2: Register a test agent
        console.log('\n✓ Test 2: Agent Registration');
        const isRegistered = await agentRegistry.isRegistered(deployer.address);

        if (!isRegistered) {
            const tx = await agentRegistry.register('ipfs://test-agent', [
                { key: 'name', value: ethers.toUtf8Bytes('Test Agent') },
                { key: 'version', value: ethers.toUtf8Bytes('1.0.0') }
            ]);
            await tx.wait();
            console.log('  Agent registered successfully');

            const agentId = await agentRegistry.addressToAgentId(deployer.address);
            console.log(`  Agent ID: ${agentId}`);
        } else {
            console.log('  Agent already registered');
        }

        // Test 3: Initialize reputation
        console.log('\n✓ Test 3: Reputation Initialization');
        try {
            const initTx = await reputationManager['initializeReputation(address)'](deployer.address);
            await initTx.wait();
            console.log('  Reputation initialized');
        } catch (error) {
            if (error.message.includes('already initialized')) {
                console.log('  Reputation already initialized');
            } else {
                throw error;
            }
        }

        const score = await reputationManager['getReputationScore(address)'](deployer.address);
        console.log(`  Reputation score: ${score}/1000`);

        // Test 4: Check credit limit
        console.log('\n✓ Test 4: Credit Limit Calculation');
        const creditLimit = await reputationManager['calculateCreditLimit(address)'](deployer.address);
        console.log(`  Credit limit: ${ethers.formatUnits(creditLimit, 6)} USDC`);

        // Test 5: Check pool liquidity
        console.log('\n✓ Test 5: Lending Pool Status');
        const availableLiquidity = await lendingPool.availableLiquidity();
        const totalLent = await lendingPool.totalLent();
        console.log(`  Available liquidity: ${ethers.formatUnits(availableLiquidity, 6)} USDC`);
        console.log(`  Total lent: ${ethers.formatUnits(totalLent, 6)} USDC`);

        // Test 6: Small loan request (if there's liquidity)
        if (availableLiquidity > 0) {
            console.log('\n✓ Test 6: Loan Request');

            const loanAmount = ethers.parseUnits('100', 6); // 100 USDC
            const collateralReq = await reputationManager['calculateCollateralRequirement(address)'](deployer.address);
            const collateralAmount = (loanAmount * BigInt(collateralReq)) / 100n;

            if (collateralAmount > 0) {
                // Check USDC balance
                const balance = await usdc.balanceOf(deployer.address);
                console.log(`  Your USDC balance: ${ethers.formatUnits(balance, 6)} USDC`);

                if (balance >= collateralAmount) {
                    console.log(`  Collateral required: ${ethers.formatUnits(collateralAmount, 6)} USDC`);

                    // Approve collateral
                    const approveTx = await usdc.approve(addresses.lendingPool, collateralAmount);
                    await approveTx.wait();
                    console.log('  Collateral approved');

                    // Request loan
                    const loanTx = await lendingPool.requestLoan(loanAmount, 30);
                    const loanReceipt = await loanTx.wait();
                    console.log(`  Loan requested: ${loanReceipt.hash}`);
                    console.log('  Note: Loan needs manual approval by owner');
                } else {
                    console.log('  ⚠️  Insufficient USDC for collateral');
                    console.log(`  Need: ${ethers.formatUnits(collateralAmount, 6)} USDC`);
                    console.log(`  You can mint USDC with the MockUSDC contract`);
                }
            } else {
                console.log('  No collateral required for your reputation level');

                // Request loan without collateral
                const loanTx = await lendingPool.requestLoan(loanAmount, 30);
                const loanReceipt = await loanTx.wait();
                console.log(`  Loan requested: ${loanReceipt.hash}`);
                console.log('  Note: Loan needs manual approval by owner');
            }
        } else {
            console.log('\n⚠️  Test 6: Skipped (no liquidity in pool)');
            console.log('  Run setup-pool-v2.js to add liquidity');
        }

        console.log('\n✅ All tests passed successfully!\n');
        console.log('Contract Addresses:');
        console.log(`- AgentRegistry: https://sepolia.etherscan.io/address/${addresses.agentRegistry}`);
        console.log(`- ReputationManager: https://sepolia.etherscan.io/address/${addresses.reputationManager}`);
        console.log(`- LendingPool: https://sepolia.etherscan.io/address/${addresses.lendingPool}`);
        console.log('');

    } catch (error) {
        console.error('\n❌ Test failed:', error.message);
        throw error;
    }
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
