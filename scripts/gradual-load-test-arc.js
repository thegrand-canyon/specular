/**
 * Gradual 30-Minute Load Test for Arc Testnet
 * Slowly adds agents and lenders to avoid rate limits
 * Tests different scenarios sequentially
 */

const { ethers } = require('hardhat');
const fs = require('fs');
const path = require('path');
const { AutonomousAgentBot } = require('../src/bots/AutonomousAgentBot');
const { LenderBot } = require('../src/bots/LenderBot');

// Test duration: 30 minutes
const TEST_DURATION_MS = 30 * 60 * 1000;
const startTime = Date.now();

function timeRemaining() {
    const elapsed = Date.now() - startTime;
    const remaining = TEST_DURATION_MS - elapsed;
    return Math.max(0, Math.floor(remaining / 1000));
}

function shouldContinue() {
    return Date.now() - startTime < TEST_DURATION_MS;
}

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function log(message) {
    const timestamp = new Date().toISOString();
    const remaining = timeRemaining();
    console.log(`[${timestamp}] [${remaining}s] ${message}`);
}

async function createAgent(deployer, usdc, provider, contracts, config) {
    const botWallet = ethers.Wallet.createRandom().connect(provider);

    log(`Creating ${config.name}...`);

    // Fund with gas
    const gasTx = await deployer.sendTransaction({
        to: botWallet.address,
        value: ethers.parseEther('0.1')
    });
    await gasTx.wait();
    await sleep(2000);

    // Fund with USDC
    const usdcTx = await usdc.mint(botWallet.address, ethers.parseUnits('50000', 6));
    await usdcTx.wait();
    await sleep(2000);

    const bot = new AutonomousAgentBot({
        name: config.name,
        provider,
        wallet: botWallet,
        contracts,
        strategy: config.strategy
    });

    log(`   ✅ ${config.name} created`);
    return bot;
}

async function createLender(deployer, usdc, provider, contracts, config) {
    const botWallet = ethers.Wallet.createRandom().connect(provider);

    log(`Creating ${config.name}...`);

    // Fund with gas
    const gasTx = await deployer.sendTransaction({
        to: botWallet.address,
        value: ethers.parseEther('0.1')
    });
    await gasTx.wait();
    await sleep(2000);

    // Fund with USDC
    const usdcTx = await usdc.mint(botWallet.address, ethers.parseUnits(config.totalCapital.toString(), 6));
    await usdcTx.wait();
    await sleep(2000);

    const bot = new LenderBot({
        name: config.name,
        provider,
        wallet: botWallet,
        contracts,
        strategy: config.strategy
    });

    log(`   ✅ ${config.name} created`);
    return bot;
}

async function main() {
    console.log('\n🧪 GRADUAL 30-MINUTE LOAD TEST\n');
    console.log('═══════════════════════════════════════════════════════\n');
    console.log(`Start Time: ${new Date().toISOString()}`);
    console.log(`Duration: 30 minutes`);
    console.log(`Strategy: Deploy 1 agent or lender every 2-3 minutes\n`);

    // Load Arc addresses
    const addressesPath = path.join(__dirname, '..', 'src', 'config', 'arc-testnet-addresses.json');
    const addresses = JSON.parse(fs.readFileSync(addressesPath, 'utf8'));

    const [deployer] = await ethers.getSigners();
    const provider = ethers.provider;
    const usdc = await ethers.getContractAt('MockUSDC', addresses.mockUSDC);

    console.log(`Deployer: ${deployer.address}`);
    const balance = await usdc.balanceOf(deployer.address);
    console.log(`Deployer USDC: ${ethers.formatUnits(balance, 6)} USDC\n`);

    console.log('═══════════════════════════════════════════════════════\n');

    const agents = [];
    const lenders = [];
    const testResults = {
        agentsCreated: 0,
        lendersCreated: 0,
        scenarios: []
    };

    // Test scenarios - 1 every 2-3 minutes
    const scenarios = [
        // 0-3 min: Micro loan agent
        async () => {
            log('🧪 SCENARIO 1: Micro loan strategy');
            testResults.scenarios.push('Micro loans');
            const agent = await createAgent(deployer, usdc, provider, addresses, {
                name: 'Micro-Agent-1',
                strategy: { loanAmount: 50, loanDuration: 7, repaymentDelay: 0, targetLoans: 15, poolLiquidity: 3000 }
            });
            agent.start().catch(e => log(`Error: ${e.message}`));
            agents.push(agent);
            testResults.agentsCreated++;
        },

        // 3-6 min: Lender for micro loans
        async () => {
            log('🧪 SCENARIO 2: Micro loan lender');
            const lender = await createLender(deployer, usdc, provider, addresses, {
                name: 'Micro-Lender-1',
                totalCapital: 10000,
                diversification: 2,
                minAgentReputation: 50
            });
            lender.start().catch(e => log(`Error: ${e.message}`));
            lenders.push(lender);
            testResults.lendersCreated++;
        },

        // 6-9 min: Medium size agent
        async () => {
            log('🧪 SCENARIO 3: Medium loan strategy');
            testResults.scenarios.push('Medium loans');
            const agent = await createAgent(deployer, usdc, provider, addresses, {
                name: 'Medium-Agent-1',
                strategy: { loanAmount: 500, loanDuration: 30, repaymentDelay: 0, targetLoans: 10, poolLiquidity: 10000 }
            });
            agent.start().catch(e => log(`Error: ${e.message}`));
            agents.push(agent);
            testResults.agentsCreated++;
        },

        // 9-12 min: Another medium agent
        async () => {
            log('🧪 SCENARIO 4: Second medium agent');
            const agent = await createAgent(deployer, usdc, provider, addresses, {
                name: 'Medium-Agent-2',
                strategy: { loanAmount: 750, loanDuration: 60, repaymentDelay: 0, targetLoans: 8, poolLiquidity: 15000 }
            });
            agent.start().catch(e => log(`Error: ${e.message}`));
            agents.push(agent);
            testResults.agentsCreated++;
        },

        // 12-15 min: Diversified lender
        async () => {
            log('🧪 SCENARIO 5: Diversified lender');
            const lender = await createLender(deployer, usdc, provider, addresses, {
                name: 'Diversified-Lender',
                totalCapital: 50000,
                diversification: 4,
                minAgentReputation: 50
            });
            lender.start().catch(e => log(`Error: ${e.message}`));
            lenders.push(lender);
            testResults.lendersCreated++;
        },

        // 15-18 min: Large loan agent
        async () => {
            log('🧪 SCENARIO 6: Large loan strategy');
            testResults.scenarios.push('Large loans');
            const agent = await createAgent(deployer, usdc, provider, addresses, {
                name: 'Large-Agent-1',
                strategy: { loanAmount: 5000, loanDuration: 90, repaymentDelay: 0, targetLoans: 5, poolLiquidity: 30000 }
            });
            agent.start().catch(e => log(`Error: ${e.message}`));
            agents.push(agent);
            testResults.agentsCreated++;
        },

        // 18-21 min: Aggressive agent (many small loans)
        async () => {
            log('🧪 SCENARIO 7: Aggressive micro-cycling');
            testResults.scenarios.push('Aggressive cycling');
            const agent = await createAgent(deployer, usdc, provider, addresses, {
                name: 'Aggressive-Agent',
                strategy: { loanAmount: 100, loanDuration: 1, repaymentDelay: 0, targetLoans: 30, poolLiquidity: 5000 }
            });
            agent.start().catch(e => log(`Error: ${e.message}`));
            agents.push(agent);
            testResults.agentsCreated++;
        },

        // 21-24 min: Whale lender
        async () => {
            log('🧪 SCENARIO 8: Whale lender');
            const lender = await createLender(deployer, usdc, provider, addresses, {
                name: 'Whale-Lender',
                totalCapital: 100000,
                diversification: 6,
                minAgentReputation: 50
            });
            lender.start().catch(e => log(`Error: ${e.message}`));
            lenders.push(lender);
            testResults.lendersCreated++;
        },

        // 24-27 min: Conservative agent
        async () => {
            log('🧪 SCENARIO 9: Conservative strategy');
            testResults.scenarios.push('Conservative loans');
            const agent = await createAgent(deployer, usdc, provider, addresses, {
                name: 'Conservative-Agent',
                strategy: { loanAmount: 200, loanDuration: 180, repaymentDelay: 0, targetLoans: 6, poolLiquidity: 8000 }
            });
            agent.start().catch(e => log(`Error: ${e.message}`));
            agents.push(agent);
            testResults.agentsCreated++;
        },

        // 27-30 min: Final aggressive lender
        async () => {
            log('🧪 SCENARIO 10: Final aggressive lender');
            const lender = await createLender(deployer, usdc, provider, addresses, {
                name: 'Aggressive-Lender',
                totalCapital: 75000,
                diversification: 8,
                minAgentReputation: 50
            });
            lender.start().catch(e => log(`Error: ${e.message}`));
            lenders.push(lender);
            testResults.lendersCreated++;
        }
    ];

    log('🚀 Starting gradual deployment...\n');

    let scenarioIndex = 0;
    const scenarioInterval = 180000; // 3 minutes between scenarios
    let lastScenarioTime = Date.now();

    while (shouldContinue()) {
        const now = Date.now();

        // Launch next scenario if it's time and we have more
        if (scenarioIndex < scenarios.length && now - lastScenarioTime >= scenarioInterval) {
            try {
                await scenarios[scenarioIndex]();
                scenarioIndex++;
                lastScenarioTime = now;
            } catch (error) {
                log(`❌ Scenario ${scenarioIndex} failed: ${error.message}`);
                scenarioIndex++; // Skip to next
            }
        }

        // Status update every minute
        const elapsed = Math.floor((now - startTime) / 1000);
        if (elapsed % 60 === 0 && elapsed > 0) {
            log(`📊 Status: ${testResults.agentsCreated} agents, ${testResults.lendersCreated} lenders deployed`);
        }

        await sleep(10000); // Check every 10 seconds
    }

    // Final report
    log('\n═══════════════════════════════════════════════════════');
    log('📊 LOAD TEST COMPLETE\n');

    const report = {
        testDuration: '30 minutes',
        timestamp: new Date().toISOString(),
        network: 'Arc Testnet',
        agentsCreated: testResults.agentsCreated,
        lendersCreated: testResults.lendersCreated,
        scenariosCompleted: scenarioIndex,
        scenarios: testResults.scenarios,
        agents: agents.map(a => a.getState()),
        lenders: lenders.map(l => l.getState())
    };

    const reportPath = path.join(__dirname, '..', 'load-test-results.json');
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

    console.log('📈 FINAL STATISTICS:');
    console.log(`   Agents Created:        ${testResults.agentsCreated}`);
    console.log(`   Lenders Created:       ${testResults.lendersCreated}`);
    console.log(`   Scenarios Completed:   ${scenarioIndex}/${scenarios.length}`);
    console.log(`   Total Participants:    ${testResults.agentsCreated + testResults.lendersCreated}\n`);

    console.log('💾 Full report saved to: load-test-results.json\n');
    console.log('═══════════════════════════════════════════════════════\n');
    console.log('✅ Load test complete!\n');
}

main().catch(error => {
    console.error('Load test failed:', error);
    process.exit(1);
});
