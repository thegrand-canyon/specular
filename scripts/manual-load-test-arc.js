/**
 * Manual 30-Minute Load Test for Arc Testnet
 * Direct contract interactions with heavy rate limit handling
 */

const { ethers } = require('hardhat');
const fs = require('fs');
const path = require('path');

const TEST_DURATION_MS = 30 * 60 * 1000;
const startTime = Date.now();

function timeRemaining() {
    const elapsed = Date.now() - startTime;
    const remaining = TEST_DURATION_MS - elapsed;
    return Math.max(0, Math.floor(remaining / 60000)); // minutes
}

function shouldContinue() {
    return Date.now() - startTime < TEST_DURATION_MS;
}

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function log(message) {
    const timestamp = new Date().toLocaleTimeString();
    const remaining = timeRemaining();
    console.log(`[${timestamp}] [${remaining}m left] ${message}`);
}

async function withRetry(fn, maxRetries = 10, baseDelay = 5000) {
    for (let i = 0; i < maxRetries; i++) {
        try {
            return await fn();
        } catch (error) {
            if (error.message.includes('Too Many Requests') && i < maxRetries - 1) {
                const delay = baseDelay * Math.pow(1.5, i);
                log(`   ⚠️  Rate limited, waiting ${Math.floor(delay/1000)}s...`);
                await sleep(delay);
            } else {
                throw error;
            }
        }
    }
}

async function main() {
    console.log('\n🧪 MANUAL 30-MINUTE LOAD TEST\n');
    console.log('═══════════════════════════════════════════════════════\n');
    console.log(`Start Time: ${new Date().toLocaleString()}`);
    console.log(`Duration: 30 minutes\n`);

    // Load Arc addresses
    const addressesPath = path.join(__dirname, '..', 'src', 'config', 'arc-testnet-addresses.json');
    const addresses = JSON.parse(fs.readFileSync(addressesPath, 'utf8'));

    log('Loading contracts...');
    await sleep(3000);

    const [deployer] = await ethers.getSigners();
    log(`Deployer: ${deployer.address}`);

    // Load contracts with retry
    const registry = await withRetry(() =>
        ethers.getContractAt('AgentRegistryV2', addresses.agentRegistryV2)
    );
    await sleep(3000);

    const reputation = await withRetry(() =>
        ethers.getContractAt('ReputationManagerV3', addresses.reputationManagerV3)
    );
    await sleep(3000);

    const marketplace = await withRetry(() =>
        ethers.getContractAt('AgentLiquidityMarketplace', addresses.agentLiquidityMarketplace)
    );
    await sleep(3000);

    const usdc = await withRetry(() =>
        ethers.getContractAt('MockUSDC', addresses.mockUSDC)
    );
    await sleep(3000);

    log('✅ Contracts loaded');

    const testResults = {
        agentsCreated: 0,
        loansRequested: 0,
        loansRepaid: 0,
        liquiditySupplied: 0,
        errors: []
    };

    console.log('\n═══════════════════════════════════════════════════════\n');
    log('🚀 Starting 30-minute stress test...\n');

    let actionCounter = 0;

    while (shouldContinue()) {
        actionCounter++;
        const action = actionCounter % 5; // Cycle through different actions

        try {
            if (action === 0) {
                // Create new agent
                log(`📝 Action ${actionCounter}: Creating new agent...`);

                const agentWallet = ethers.Wallet.createRandom().connect(ethers.provider);

                // Fund with gas
                await withRetry(async () => {
                    const tx = await deployer.sendTransaction({
                        to: agentWallet.address,
                        value: ethers.parseEther('0.1')
                    });
                    await tx.wait();
                });
                await sleep(5000);

                // Fund with USDC
                await withRetry(async () => {
                    const tx = await usdc.mint(agentWallet.address, ethers.parseUnits('20000', 6));
                    await tx.wait();
                });
                await sleep(5000);

                // Register agent
                const agentRegistry = registry.connect(agentWallet);
                await withRetry(async () => {
                    const tx = await agentRegistry.registerAgent('Test Agent');
                    await tx.wait();
                });
                await sleep(5000);

                // Get agent ID
                const agentId = await withRetry(() =>
                    registry.totalAgents()
                );
                await sleep(3000);

                // Initialize reputation
                const repManager = reputation.connect(agentWallet);
                await withRetry(async () => {
                    const tx = await repManager.initializeReputation(agentId);
                    await tx.wait();
                });
                await sleep(5000);

                // Create pool
                const market = marketplace.connect(agentWallet);
                const usdcContract = usdc.connect(agentWallet);

                await withRetry(async () => {
                    const tx = await usdcContract.approve(addresses.agentLiquidityMarketplace, ethers.parseUnits('10000', 6));
                    await tx.wait();
                });
                await sleep(5000);

                await withRetry(async () => {
                    const tx = await market.createPool(agentId, ethers.parseUnits('10000', 6));
                    await tx.wait();
                });
                await sleep(5000);

                testResults.agentsCreated++;
                log(`   ✅ Agent ${agentId} created with pool`);

            } else if (action === 1) {
                // Supply liquidity to random agent
                log(`📝 Action ${actionCounter}: Supplying liquidity...`);

                const lenderWallet = ethers.Wallet.createRandom().connect(ethers.provider);

                // Fund lender
                await withRetry(async () => {
                    const tx = await deployer.sendTransaction({
                        to: lenderWallet.address,
                        value: ethers.parseEther('0.1')
                    });
                    await tx.wait();
                });
                await sleep(5000);

                await withRetry(async () => {
                    const tx = await usdc.mint(lenderWallet.address, ethers.parseUnits('15000', 6));
                    await tx.wait();
                });
                await sleep(5000);

                // Get random agent
                const totalAgents = await withRetry(() => registry.totalAgents());
                const randomAgentId = Math.floor(Math.random() * Number(totalAgents)) + 1;
                await sleep(3000);

                // Supply liquidity
                const market = marketplace.connect(lenderWallet);
                const usdcContract = usdc.connect(lenderWallet);

                await withRetry(async () => {
                    const tx = await usdcContract.approve(addresses.agentLiquidityMarketplace, ethers.parseUnits('15000', 6));
                    await tx.wait();
                });
                await sleep(5000);

                await withRetry(async () => {
                    const tx = await market.supplyLiquidity(randomAgentId, ethers.parseUnits('15000', 6));
                    await tx.wait();
                });
                await sleep(5000);

                testResults.liquiditySupplied++;
                log(`   ✅ Supplied 15,000 USDC to Agent ${randomAgentId}`);

            } else {
                // Just wait and monitor
                log(`📊 Status: ${testResults.agentsCreated} agents, ${testResults.liquiditySupplied} liquidity ops`);
                await sleep(30000); // 30 second pause
            }

        } catch (error) {
            log(`   ❌ Error: ${error.message.substring(0, 100)}`);
            testResults.errors.push(error.message);
            await sleep(15000); // Wait longer after error
        }

        // Status update every 5 minutes
        if (actionCounter % 10 === 0) {
            log('\n📈 PROGRESS REPORT:');
            log(`   Agents Created:      ${testResults.agentsCreated}`);
            log(`   Liquidity Supplied:  ${testResults.liquiditySupplied}`);
            log(`   Errors:              ${testResults.errors.length}`);
            log(`   Time Remaining:      ${timeRemaining()} minutes\n`);
        }

        // Minimum 45 seconds between actions
        await sleep(45000);
    }

    // Final report
    log('\n═══════════════════════════════════════════════════════');
    log('📊 30-MINUTE LOAD TEST COMPLETE\n');

    const report = {
        testDuration: '30 minutes',
        timestamp: new Date().toISOString(),
        network: 'Arc Testnet',
        results: testResults
    };

    const reportPath = path.join(__dirname, '..', 'load-test-results.json');
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

    console.log('📈 FINAL STATISTICS:');
    console.log(`   Actions Performed:   ${actionCounter}`);
    console.log(`   Agents Created:      ${testResults.agentsCreated}`);
    console.log(`   Liquidity Supplied:  ${testResults.liquiditySupplied}`);
    console.log(`   Errors:              ${testResults.errors.length}\n`);

    console.log('💾 Report saved to: load-test-results.json\n');
    console.log('═══════════════════════════════════════════════════════\n');
}

main().catch(error => {
    console.error('Load test failed:', error);
    process.exit(1);
});
