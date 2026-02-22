/**
 * Comprehensive 30-Minute Load Test for Arc Testnet
 * Tests all scenarios, edge cases, and stress tests the platform
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

// Rate limit handler with exponential backoff
async function withRetry(fn, maxRetries = 5, baseDelay = 2000) {
    for (let i = 0; i < maxRetries; i++) {
        try {
            return await fn();
        } catch (error) {
            if (error.message.includes('Too Many Requests') && i < maxRetries - 1) {
                const delay = baseDelay * Math.pow(2, i);
                console.log(`   ⚠️  Rate limited, retrying in ${delay/1000}s...`);
                await sleep(delay);
            } else {
                throw error;
            }
        }
    }
}

class LoadTestOrchestrator {
    constructor(provider, contracts, deployer, usdc) {
        this.provider = provider;
        this.contracts = contracts;
        this.deployer = deployer;
        this.usdc = usdc;
        this.agents = [];
        this.lenders = [];
        this.testResults = {
            totalAgentsCreated: 0,
            totalLendersCreated: 0,
            totalLoansRequested: 0,
            totalLoansCompleted: 0,
            totalDefaultsSimulated: 0,
            totalLiquidityDeployed: 0,
            errors: [],
            scenarios: []
        };
        this.rpcDelay = 1000; // 1 second between RPC-heavy operations
    }

    log(message) {
        const timestamp = new Date().toISOString();
        const remaining = timeRemaining();
        console.log(`[${timestamp}] [${remaining}s remaining] ${message}`);
    }

    async createAgentBot(config) {
        const botWallet = ethers.Wallet.createRandom().connect(this.provider);

        // Fund with gas (with retry)
        const gasAmount = ethers.parseEther('0.1');
        await withRetry(async () => {
            const tx = await this.deployer.sendTransaction({
                to: botWallet.address,
                value: gasAmount
            });
            await tx.wait();
        });
        await sleep(this.rpcDelay);

        // Fund with USDC (with retry)
        const usdcAmount = ethers.parseUnits('50000', 6);
        await withRetry(async () => {
            const tx = await this.usdc.mint(botWallet.address, usdcAmount);
            await tx.wait();
        });
        await sleep(this.rpcDelay);

        const bot = new AutonomousAgentBot({
            name: config.name,
            provider: this.provider,
            wallet: botWallet,
            contracts: this.contracts,
            strategy: config.strategy
        });

        this.agents.push(bot);
        this.testResults.totalAgentsCreated++;
        return bot;
    }

    async createLenderBot(config) {
        const botWallet = ethers.Wallet.createRandom().connect(this.provider);

        // Fund with gas (with retry)
        const gasAmount = ethers.parseEther('0.1');
        await withRetry(async () => {
            const tx = await this.deployer.sendTransaction({
                to: botWallet.address,
                value: gasAmount
            });
            await tx.wait();
        });
        await sleep(this.rpcDelay);

        // Fund with USDC (with retry)
        const usdcAmount = ethers.parseUnits(config.totalCapital.toString(), 6);
        await withRetry(async () => {
            const tx = await this.usdc.mint(botWallet.address, usdcAmount);
            await tx.wait();
        });
        await sleep(this.rpcDelay);

        const bot = new LenderBot({
            name: config.name,
            provider: this.provider,
            wallet: botWallet,
            contracts: this.contracts,
            strategy: config.strategy
        });

        this.lenders.push(bot);
        this.testResults.totalLendersCreated++;
        return bot;
    }

    // Scenario 1: High-frequency micro loans
    async testMicroLoans() {
        this.log('🧪 SCENARIO 1: High-frequency micro loans');
        this.testResults.scenarios.push('Micro loans');

        const agent = await this.createAgentBot({
            name: 'MicroLoan-Agent',
            strategy: {
                loanAmount: 50,  // Small 50 USDC loans
                loanDuration: 7,  // Short duration
                repaymentDelay: 0,
                targetLoans: 20,  // Many loans
                poolLiquidity: 5000
            }
        });

        const lender = await this.createLenderBot({
            name: 'MicroLoan-Lender',
            totalCapital: 10000,
            diversification: 1,
            minAgentReputation: 50
        });

        // Start in parallel
        agent.start().catch(e => this.testResults.errors.push(e.message));
        await sleep(5000);
        lender.start().catch(e => this.testResults.errors.push(e.message));

        this.log('   ✅ Micro loan scenario initiated');
    }

    // Scenario 2: Large whale loans
    async testWhaleLoan() {
        this.log('🧪 SCENARIO 2: Large whale loans');
        this.testResults.scenarios.push('Whale loans');

        const agent = await this.createAgentBot({
            name: 'Whale-Agent',
            strategy: {
                loanAmount: 10000,  // Large loans
                loanDuration: 90,   // Longer duration
                repaymentDelay: 0,
                targetLoans: 5,
                poolLiquidity: 50000
            }
        });

        const lender = await this.createLenderBot({
            name: 'Whale-Lender',
            totalCapital: 100000,
            diversification: 2,
            minAgentReputation: 50
        });

        agent.start().catch(e => this.testResults.errors.push(e.message));
        await sleep(5000);
        lender.start().catch(e => this.testResults.errors.push(e.message));

        this.log('   ✅ Whale loan scenario initiated');
    }

    // Scenario 3: Reputation building race (reduced from 5 to 3 agents to avoid rate limits)
    async testReputationRace() {
        this.log('🧪 SCENARIO 3: Reputation building race');
        this.testResults.scenarios.push('Reputation race');

        // Create 3 competing agents (reduced to avoid rate limits)
        const agents = [];
        for (let i = 0; i < 3; i++) {
            const agent = await this.createAgentBot({
                name: `RepRace-Agent-${i}`,
                strategy: {
                    loanAmount: 500,
                    loanDuration: 30,
                    repaymentDelay: 0,
                    targetLoans: 10,  // First to 10 loans wins
                    poolLiquidity: 10000
                }
            });
            agents.push(agent);
            await sleep(2000); // Delay between agent creation
        }

        // Fund them all
        const lender = await this.createLenderBot({
            name: 'RepRace-Lender',
            totalCapital: 60000,
            diversification: 3,
            minAgentReputation: 50
        });

        // Start race
        agents.forEach(agent => agent.start().catch(e => this.testResults.errors.push(e.message)));
        await sleep(10000);
        lender.start().catch(e => this.testResults.errors.push(e.message));

        this.log('   ✅ Reputation race initiated with 3 agents');
    }

    // Scenario 4: Variable rate loans (different durations)
    async testVariableRates() {
        this.log('🧪 SCENARIO 4: Variable rate loans');
        this.testResults.scenarios.push('Variable rates');

        const durations = [7, 30, 60, 90, 180];

        for (let i = 0; i < durations.length; i++) {
            const agent = await this.createAgentBot({
                name: `VarRate-${durations[i]}d`,
                strategy: {
                    loanAmount: 1000,
                    loanDuration: durations[i],
                    repaymentDelay: 0,
                    targetLoans: 3,
                    poolLiquidity: 5000
                }
            });
            agent.start().catch(e => this.testResults.errors.push(e.message));
            await sleep(2000);
        }

        // One lender for all
        const lender = await this.createLenderBot({
            name: 'VarRate-Lender',
            totalCapital: 50000,
            diversification: 5,
            minAgentReputation: 50
        });

        await sleep(10000);
        lender.start().catch(e => this.testResults.errors.push(e.message));

        this.log('   ✅ Variable rate scenario initiated');
    }

    // Scenario 5: High utilization stress test (reduced from 10 to 5 borrowers)
    async testHighUtilization() {
        this.log('🧪 SCENARIO 5: High utilization stress test');
        this.testResults.scenarios.push('High utilization');

        // Create borrowers for one lender (reduced to avoid rate limits)
        const borrowers = [];
        for (let i = 0; i < 5; i++) {
            const agent = await this.createAgentBot({
                name: `HighUtil-Borrower-${i}`,
                strategy: {
                    loanAmount: 2000,
                    loanDuration: 30,
                    repaymentDelay: 0,
                    targetLoans: 5,
                    poolLiquidity: 5000
                }
            });
            borrowers.push(agent);
            await sleep(2000); // Delay between agent creation
        }

        const lender = await this.createLenderBot({
            name: 'HighUtil-Lender',
            totalCapital: 75000,
            diversification: 5,
            minAgentReputation: 50
        });

        // Start all
        borrowers.forEach(agent => agent.start().catch(e => this.testResults.errors.push(e.message)));
        await sleep(15000);
        lender.start().catch(e => this.testResults.errors.push(e.message));

        this.log('   ✅ High utilization test initiated with 5 borrowers');
    }

    // Scenario 6: Lender competition (reduced from 5 to 3 lenders)
    async testLenderCompetition() {
        this.log('🧪 SCENARIO 6: Lender competition');
        this.testResults.scenarios.push('Lender competition');

        // One popular agent
        const agent = await this.createAgentBot({
            name: 'Popular-Agent',
            strategy: {
                loanAmount: 1000,
                loanDuration: 30,
                repaymentDelay: 0,
                targetLoans: 15,
                poolLiquidity: 10000
            }
        });

        // Multiple lenders competing to fund it (reduced to avoid rate limits)
        const lenders = [];
        for (let i = 0; i < 3; i++) {
            const lender = await this.createLenderBot({
                name: `Competing-Lender-${i}`,
                totalCapital: 20000,
                diversification: 1,
                minAgentReputation: 50
            });
            lenders.push(lender);
            await sleep(2000); // Delay between lender creation
        }

        agent.start().catch(e => this.testResults.errors.push(e.message));
        await sleep(5000);
        lenders.forEach(lender => lender.start().catch(e => this.testResults.errors.push(e.message)));

        this.log('   ✅ Lender competition initiated with 3 lenders');
    }

    // Scenario 7: Mixed strategies
    async testMixedStrategies() {
        this.log('🧪 SCENARIO 7: Mixed strategies ecosystem');
        this.testResults.scenarios.push('Mixed strategies');

        const strategies = [
            { name: 'Conservative', loanAmount: 100, targetLoans: 20, poolLiquidity: 5000 },
            { name: 'Moderate', loanAmount: 500, targetLoans: 10, poolLiquidity: 10000 },
            { name: 'Aggressive', loanAmount: 2000, targetLoans: 8, poolLiquidity: 20000 },
            { name: 'Balanced', loanAmount: 1000, targetLoans: 12, poolLiquidity: 15000 }
        ];

        for (const strat of strategies) {
            const agent = await this.createAgentBot({
                name: `Mixed-${strat.name}`,
                strategy: {
                    loanAmount: strat.loanAmount,
                    loanDuration: 30,
                    repaymentDelay: 0,
                    targetLoans: strat.targetLoans,
                    poolLiquidity: strat.poolLiquidity
                }
            });
            agent.start().catch(e => this.testResults.errors.push(e.message));
            await sleep(5000); // Increased delay
        }

        // Diversified lenders (reduced from 3 to 2)
        for (let i = 0; i < 2; i++) {
            const lender = await this.createLenderBot({
                name: `Mixed-Lender-${i}`,
                totalCapital: 50000,
                diversification: 4,
                minAgentReputation: 50
            });
            await sleep(3000); // Increased delay
            lender.start().catch(e => this.testResults.errors.push(e.message));
        }

        this.log('   ✅ Mixed strategies ecosystem initiated');
    }

    // Scenario 8: Rapid cycling
    async testRapidCycling() {
        this.log('🧪 SCENARIO 8: Rapid loan cycling');
        this.testResults.scenarios.push('Rapid cycling');

        const agent = await this.createAgentBot({
            name: 'RapidCycle-Agent',
            strategy: {
                loanAmount: 200,
                loanDuration: 1,  // 1 day loans
                repaymentDelay: 0,
                targetLoans: 50,  // Many fast loans
                poolLiquidity: 15000
            }
        });

        const lender = await this.createLenderBot({
            name: 'RapidCycle-Lender',
            totalCapital: 30000,
            diversification: 1,
            minAgentReputation: 50
        });

        agent.start().catch(e => this.testResults.errors.push(e.message));
        await sleep(5000);
        lender.start().catch(e => this.testResults.errors.push(e.message));

        this.log('   ✅ Rapid cycling scenario initiated');
    }

    async generateReport() {
        this.log('\n═══════════════════════════════════════════════════════');
        this.log('📊 LOAD TEST COMPLETE - GENERATING REPORT\n');

        const report = {
            testDuration: '30 minutes',
            timestamp: new Date().toISOString(),
            network: 'Arc Testnet',
            results: this.testResults,
            agentSummary: this.agents.map(a => a.getState()),
            lenderSummary: this.lenders.map(l => l.getState())
        };

        // Save report
        const reportPath = path.join(__dirname, '..', 'load-test-results.json');
        fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

        console.log('📈 TEST STATISTICS:');
        console.log(`   Total Agents Created:     ${this.testResults.totalAgentsCreated}`);
        console.log(`   Total Lenders Created:    ${this.testResults.totalLendersCreated}`);
        console.log(`   Scenarios Tested:         ${this.testResults.scenarios.length}`);
        console.log(`   Errors Encountered:       ${this.testResults.errors.length}\n`);

        console.log('💾 Full report saved to: load-test-results.json\n');
        console.log('═══════════════════════════════════════════════════════\n');
    }
}

async function main() {
    console.log('\n🚀 COMPREHENSIVE 30-MINUTE LOAD TEST\n');
    console.log('═══════════════════════════════════════════════════════\n');
    console.log(`Start Time: ${new Date().toISOString()}`);
    console.log(`Duration: 30 minutes\n`);

    // Load Arc addresses
    const addressesPath = path.join(__dirname, '..', 'src', 'config', 'arc-testnet-addresses.json');
    const addresses = JSON.parse(fs.readFileSync(addressesPath, 'utf8'));

    const [deployer] = await ethers.getSigners();
    const provider = ethers.provider;
    const usdc = await ethers.getContractAt('MockUSDC', addresses.mockUSDC);

    console.log(`Deployer: ${deployer.address}`);
    const balance = await usdc.balanceOf(deployer.address);
    console.log(`Deployer USDC: ${ethers.formatUnits(balance, 6)} USDC\n`);

    const orchestrator = new LoadTestOrchestrator(provider, addresses, deployer, usdc);

    console.log('═══════════════════════════════════════════════════════\n');
    console.log('🎬 STARTING LOAD TEST SCENARIOS\n');

    // Run all scenarios with delays
    const scenarios = [
        () => orchestrator.testMicroLoans(),
        () => orchestrator.testWhaleLoan(),
        () => orchestrator.testReputationRace(),
        () => orchestrator.testVariableRates(),
        () => orchestrator.testHighUtilization(),
        () => orchestrator.testLenderCompetition(),
        () => orchestrator.testMixedStrategies(),
        () => orchestrator.testRapidCycling()
    ];

    for (const scenario of scenarios) {
        if (!shouldContinue()) break;
        await scenario();
        await sleep(60000); // 60 seconds between scenarios to avoid rate limits
    }

    orchestrator.log('\n🏃 ALL SCENARIOS LAUNCHED - Running for remaining time...\n');

    // Wait for remaining time
    while (shouldContinue()) {
        const remaining = timeRemaining();
        if (remaining % 60 === 0) {
            orchestrator.log(`⏰ ${Math.floor(remaining / 60)} minutes remaining...`);
        }
        await sleep(10000); // Check every 10 seconds
    }

    // Generate final report
    await orchestrator.generateReport();

    console.log('✅ Load test complete! Check load-test-results.json for details.\n');
}

main().catch(error => {
    console.error('Load test failed:', error);
    process.exit(1);
});
