/**
 * Master Test Suite - Complete P2P Marketplace Testing
 * Automatically deploys, tests, and generates comprehensive report
 */

const { ethers } = require('hardhat');
const fs = require('fs');
const path = require('path');

// ANSI color codes for terminal output
const colors = {
    reset: '\x1b[0m',
    bright: '\x1b[1m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    cyan: '\x1b[36m'
};

class MasterTestSuite {
    constructor() {
        this.results = {
            deployment: {},
            tests: [],
            gasMetrics: [],
            issues: [],
            recommendations: [],
            timestamp: new Date().toISOString()
        };
        this.startTime = Date.now();
    }

    log(message, color = 'reset') {
        console.log(`${colors[color]}${message}${colors.reset}`);
    }

    logSection(title) {
        this.log('\n' + '═'.repeat(60), 'cyan');
        this.log(title, 'bright');
        this.log('═'.repeat(60) + '\n', 'cyan');
    }

    async sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    // =============================================
    // PHASE 1: DEPLOYMENT
    // =============================================
    async deployMarketplace() {
        this.logSection('📦 PHASE 1: DEPLOYING P2P MARKETPLACE');

        try {
            const [deployer] = await ethers.getSigners();
            const balance = await ethers.provider.getBalance(deployer.address);

            this.log(`Deployer: ${deployer.address}`, 'blue');
            this.log(`Balance: ${ethers.formatEther(balance)} ETH`, 'blue');
            this.log('');

            // Load addresses
            const addressesPath = path.join(__dirname, '..', 'src', 'config', 'sepolia-addresses.json');
            const addresses = JSON.parse(fs.readFileSync(addressesPath, 'utf8'));

            // Check if already deployed
            if (addresses.agentLiquidityMarketplace) {
                this.log('⏭️  Marketplace already deployed!', 'yellow');
                this.log(`Address: ${addresses.agentLiquidityMarketplace}`, 'yellow');

                this.results.deployment = {
                    status: 'skipped',
                    address: addresses.agentLiquidityMarketplace,
                    reason: 'Already deployed'
                };

                return addresses;
            }

            // Deploy marketplace
            this.log('⏳ Deploying AgentLiquidityMarketplace...', 'yellow');

            const AgentLiquidityMarketplace = await ethers.getContractFactory('AgentLiquidityMarketplace');
            const marketplace = await AgentLiquidityMarketplace.deploy(
                addresses.agentRegistry,
                addresses.reputationManagerV3,
                addresses.mockUSDC
            );
            await marketplace.waitForDeployment();

            const marketplaceAddress = await marketplace.getAddress();
            const deploymentTx = marketplace.deploymentTransaction();
            const receipt = await deploymentTx.wait();

            this.log(`✅ Deployed to: ${marketplaceAddress}`, 'green');
            this.log(`Gas Used: ${receipt.gasUsed.toLocaleString()}`, 'blue');
            this.log('');

            // Authorize marketplace
            this.log('⏳ Authorizing marketplace in ReputationManagerV3...', 'yellow');
            const repManagerV3 = await ethers.getContractAt('ReputationManagerV3', addresses.reputationManagerV3);
            const authTx = await repManagerV3.authorizePool(marketplaceAddress);
            const authReceipt = await authTx.wait();

            this.log(`✅ Authorized! Gas: ${authReceipt.gasUsed.toLocaleString()}`, 'green');
            this.log('');

            // Save address
            addresses.agentLiquidityMarketplace = marketplaceAddress;
            fs.writeFileSync(addressesPath, JSON.stringify(addresses, null, 2));

            this.results.deployment = {
                status: 'success',
                address: marketplaceAddress,
                deploymentGas: Number(receipt.gasUsed),
                authorizationGas: Number(authReceipt.gasUsed),
                totalGas: Number(receipt.gasUsed) + Number(authReceipt.gasUsed)
            };

            this.log('✅ PHASE 1 COMPLETE', 'green');
            return addresses;

        } catch (error) {
            this.log(`❌ Deployment failed: ${error.message}`, 'red');
            this.results.deployment = {
                status: 'failed',
                error: error.message
            };
            this.results.issues.push({
                severity: 'CRITICAL',
                phase: 'Deployment',
                issue: 'Marketplace deployment failed',
                error: error.message
            });
            throw error;
        }
    }

    // =============================================
    // PHASE 2: POOL CREATION
    // =============================================
    async createAgentPools(addresses) {
        this.logSection('🏊 PHASE 2: CREATING AGENT POOLS');

        try {
            const testAgentsPath = path.join(__dirname, '..', 'test-agents.json');
            const testAgents = JSON.parse(fs.readFileSync(testAgentsPath, 'utf8'));

            const marketplace = await ethers.getContractAt('AgentLiquidityMarketplace', addresses.agentLiquidityMarketplace);

            const poolResults = [];

            for (const agent of testAgents) {
                this.log(`📋 ${agent.name} (Agent ${agent.agentId})`, 'cyan');

                try {
                    const wallet = new ethers.Wallet(agent.privateKey, ethers.provider);
                    const pool = await marketplace.agentPools(agent.agentId);

                    if (pool.isActive) {
                        this.log(`   ⏭️  Pool already exists`, 'yellow');
                        poolResults.push({
                            agent: agent.name,
                            status: 'skipped',
                            reason: 'Already exists'
                        });
                    } else {
                        const tx = await marketplace.connect(wallet).createAgentPool();
                        const receipt = await tx.wait();

                        this.log(`   ✅ Pool created! Gas: ${receipt.gasUsed.toLocaleString()}`, 'green');

                        poolResults.push({
                            agent: agent.name,
                            status: 'success',
                            gasUsed: Number(receipt.gasUsed)
                        });

                        this.results.gasMetrics.push({
                            operation: `Create ${agent.name} pool`,
                            gasUsed: Number(receipt.gasUsed)
                        });
                    }
                } catch (error) {
                    this.log(`   ❌ Failed: ${error.message}`, 'red');
                    poolResults.push({
                        agent: agent.name,
                        status: 'failed',
                        error: error.message
                    });

                    this.results.issues.push({
                        severity: 'HIGH',
                        phase: 'Pool Creation',
                        issue: `Failed to create pool for ${agent.name}`,
                        error: error.message
                    });
                }

                this.log('');
            }

            this.results.poolCreation = poolResults;
            this.log('✅ PHASE 2 COMPLETE', 'green');

        } catch (error) {
            this.log(`❌ Pool creation failed: ${error.message}`, 'red');
            throw error;
        }
    }

    // =============================================
    // PHASE 3: LIQUIDITY TESTING
    // =============================================
    async testLiquidityOperations(addresses) {
        this.logSection('💰 PHASE 3: LIQUIDITY OPERATIONS TESTING');

        try {
            const [deployer] = await ethers.getSigners();
            const testAgentsPath = path.join(__dirname, '..', 'test-agents.json');
            const testAgents = JSON.parse(fs.readFileSync(testAgentsPath, 'utf8'));
            const alice = testAgents[0];

            const marketplace = await ethers.getContractAt('AgentLiquidityMarketplace', addresses.agentLiquidityMarketplace);
            const usdc = await ethers.getContractAt('MockUSDC', addresses.mockUSDC);

            const supplyAmount = ethers.parseUnits('10000', 6);

            // Test 1: Supply Liquidity
            this.log('TEST 1: Supply Liquidity', 'cyan');
            try {
                const balanceBefore = await usdc.balanceOf(deployer.address);
                this.log(`   Lender balance: ${ethers.formatUnits(balanceBefore, 6)} USDC`, 'blue');

                const approveTx = await usdc.approve(addresses.agentLiquidityMarketplace, supplyAmount);
                await approveTx.wait();

                const tx = await marketplace.supplyLiquidity(alice.agentId, supplyAmount);
                const receipt = await tx.wait();

                const balanceAfter = await usdc.balanceOf(deployer.address);
                const transferred = balanceBefore - balanceAfter;

                this.log(`   ✅ Supplied ${ethers.formatUnits(transferred, 6)} USDC`, 'green');
                this.log(`   Gas Used: ${receipt.gasUsed.toLocaleString()}`, 'blue');

                this.results.tests.push({
                    name: 'Supply Liquidity',
                    status: 'pass',
                    amount: ethers.formatUnits(transferred, 6) + ' USDC',
                    gasUsed: Number(receipt.gasUsed)
                });

                this.results.gasMetrics.push({
                    operation: 'Supply Liquidity',
                    gasUsed: Number(receipt.gasUsed)
                });

            } catch (error) {
                this.log(`   ❌ Failed: ${error.message}`, 'red');
                this.results.tests.push({
                    name: 'Supply Liquidity',
                    status: 'fail',
                    error: error.message
                });
                this.results.issues.push({
                    severity: 'CRITICAL',
                    phase: 'Liquidity Testing',
                    issue: 'Cannot supply liquidity',
                    error: error.message
                });
            }

            this.log('');

            // Test 2: Verify Pool State
            this.log('TEST 2: Verify Pool State', 'cyan');
            try {
                const pool = await marketplace.getAgentPool(alice.agentId);
                const position = await marketplace.getLenderPosition(alice.agentId, deployer.address);

                this.log(`   Pool Liquidity: ${ethers.formatUnits(pool.totalLiquidity, 6)} USDC`, 'blue');
                this.log(`   Available: ${ethers.formatUnits(pool.availableLiquidity, 6)} USDC`, 'blue');
                this.log(`   Lender Position: ${ethers.formatUnits(position.amount, 6)} USDC`, 'blue');
                this.log(`   Share: ${Number(position.shareOfPool) / 100}%`, 'blue');

                const isCorrect = pool.totalLiquidity >= supplyAmount;

                if (isCorrect) {
                    this.log(`   ✅ Pool state correct`, 'green');
                    this.results.tests.push({
                        name: 'Pool State Verification',
                        status: 'pass',
                        poolLiquidity: ethers.formatUnits(pool.totalLiquidity, 6) + ' USDC'
                    });
                } else {
                    this.log(`   ❌ Pool state incorrect`, 'red');
                    this.results.tests.push({
                        name: 'Pool State Verification',
                        status: 'fail',
                        expected: ethers.formatUnits(supplyAmount, 6),
                        actual: ethers.formatUnits(pool.totalLiquidity, 6)
                    });
                    this.results.issues.push({
                        severity: 'HIGH',
                        phase: 'Liquidity Testing',
                        issue: 'Pool liquidity mismatch',
                        expected: ethers.formatUnits(supplyAmount, 6),
                        actual: ethers.formatUnits(pool.totalLiquidity, 6)
                    });
                }

            } catch (error) {
                this.log(`   ❌ Failed: ${error.message}`, 'red');
                this.results.tests.push({
                    name: 'Pool State Verification',
                    status: 'fail',
                    error: error.message
                });
            }

            this.log('');
            this.log('✅ PHASE 3 COMPLETE', 'green');

        } catch (error) {
            this.log(`❌ Liquidity testing failed: ${error.message}`, 'red');
            throw error;
        }
    }

    // =============================================
    // PHASE 4: LOAN LIFECYCLE TESTING
    // =============================================
    async testLoanLifecycle(addresses) {
        this.logSection('🔄 PHASE 4: LOAN LIFECYCLE TESTING');

        try {
            const testAgentsPath = path.join(__dirname, '..', 'test-agents.json');
            const testAgents = JSON.parse(fs.readFileSync(testAgentsPath, 'utf8'));
            const alice = testAgents[0];
            const aliceWallet = new ethers.Wallet(alice.privateKey, ethers.provider);

            const marketplace = await ethers.getContractAt('AgentLiquidityMarketplace', addresses.agentLiquidityMarketplace);
            const usdc = await ethers.getContractAt('MockUSDC', addresses.mockUSDC);
            const reputationManager = await ethers.getContractAt('ReputationManagerV3', addresses.reputationManagerV3);

            // Check credit limit and request within it
            const creditLimit = await reputationManager.calculateCreditLimit(alice.address);
            const loanAmount = creditLimit / 2n; // Request 50% of credit limit
            const duration = 30;

            // Test 1: Request Loan
            this.log('TEST 1: Request Loan', 'cyan');
            let loanId;

            try {
                const collateralPercent = await reputationManager.calculateCollateralRequirement(alice.address);
                const requiredCollateral = (loanAmount * collateralPercent) / 100n;
                const interestRate = await reputationManager.calculateInterestRate(alice.address);

                this.log(`   Amount: ${ethers.formatUnits(loanAmount, 6)} USDC`, 'blue');
                this.log(`   Duration: ${duration} days`, 'blue');
                this.log(`   Collateral: ${ethers.formatUnits(requiredCollateral, 6)} USDC (${collateralPercent}%)`, 'blue');
                this.log(`   Interest Rate: ${Number(interestRate) / 100}% APR`, 'blue');

                if (requiredCollateral > 0) {
                    await usdc.connect(aliceWallet).approve(addresses.agentLiquidityMarketplace, requiredCollateral);
                }

                const tx = await marketplace.connect(aliceWallet).requestLoan(loanAmount, duration);
                const receipt = await tx.wait();

                // Get loan ID
                const disbursedEvent = receipt.logs.find(log => {
                    try {
                        return marketplace.interface.parseLog(log)?.name === 'LoanDisbursed';
                    } catch { return false; }
                });

                if (disbursedEvent) {
                    loanId = marketplace.interface.parseLog(disbursedEvent).args.loanId;
                    this.log(`   ✅ Loan disbursed! ID: ${loanId}`, 'green');
                    this.log(`   Gas Used: ${receipt.gasUsed.toLocaleString()}`, 'blue');

                    this.results.tests.push({
                        name: 'Request Loan',
                        status: 'pass',
                        loanId: Number(loanId),
                        gasUsed: Number(receipt.gasUsed)
                    });

                    this.results.gasMetrics.push({
                        operation: 'Request Loan',
                        gasUsed: Number(receipt.gasUsed)
                    });

                } else {
                    throw new Error('Loan not disbursed');
                }

            } catch (error) {
                this.log(`   ❌ Failed: ${error.message}`, 'red');
                this.results.tests.push({
                    name: 'Request Loan',
                    status: 'fail',
                    error: error.message
                });
                this.results.issues.push({
                    severity: 'CRITICAL',
                    phase: 'Loan Lifecycle',
                    issue: 'Cannot request loan',
                    error: error.message
                });
                return; // Can't continue without loan
            }

            this.log('');

            // Test 2: Interest Calculation
            this.log('TEST 2: Interest Calculation Verification', 'cyan');
            try {
                const loan = await marketplace.loans(loanId);
                const interest = await marketplace.calculateInterest(
                    loan.amount,
                    loan.interestRate,
                    loan.duration
                );

                // Manual calculation
                const principal = Number(loan.amount);
                const rate = Number(loan.interestRate);
                const durationSeconds = Number(loan.duration);
                const durationDays = durationSeconds / 86400;

                const expectedInterest = (principal * rate * durationSeconds) / (10000 * 365 * 86400);
                const actualInterest = Number(interest);

                this.log(`   Principal: ${(principal / 1e6).toFixed(2)} USDC`, 'blue');
                this.log(`   Rate: ${rate / 100}% APR`, 'blue');
                this.log(`   Duration: ${durationDays} days`, 'blue');
                this.log(`   Expected Interest: ${(expectedInterest / 1e6).toFixed(6)} USDC`, 'blue');
                this.log(`   Calculated Interest: ${(actualInterest / 1e6).toFixed(6)} USDC`, 'blue');

                const tolerance = expectedInterest * 0.01; // 1% tolerance
                const difference = Math.abs(actualInterest - expectedInterest);
                const percentDiff = (difference / expectedInterest) * 100;

                if (difference <= tolerance) {
                    this.log(`   ✅ Interest calculation accurate (${percentDiff.toFixed(4)}% diff)`, 'green');
                    this.results.tests.push({
                        name: 'Interest Calculation',
                        status: 'pass',
                        expected: (expectedInterest / 1e6).toFixed(6),
                        actual: (actualInterest / 1e6).toFixed(6),
                        percentDifference: percentDiff.toFixed(4) + '%'
                    });
                } else {
                    this.log(`   ❌ Interest calculation off by ${percentDiff.toFixed(2)}%`, 'red');
                    this.results.tests.push({
                        name: 'Interest Calculation',
                        status: 'fail',
                        expected: (expectedInterest / 1e6).toFixed(6),
                        actual: (actualInterest / 1e6).toFixed(6),
                        percentDifference: percentDiff.toFixed(2) + '%'
                    });
                    this.results.issues.push({
                        severity: 'CRITICAL',
                        phase: 'Loan Lifecycle',
                        issue: 'Interest calculation inaccurate',
                        expected: (expectedInterest / 1e6).toFixed(6),
                        actual: (actualInterest / 1e6).toFixed(6),
                        difference: percentDiff.toFixed(2) + '%'
                    });
                }

            } catch (error) {
                this.log(`   ❌ Failed: ${error.message}`, 'red');
                this.results.tests.push({
                    name: 'Interest Calculation',
                    status: 'fail',
                    error: error.message
                });
            }

            this.log('');

            // Test 3: Repay Loan
            this.log('TEST 3: Repay Loan', 'cyan');
            try {
                const loan = await marketplace.loans(loanId);
                const interest = await marketplace.calculateInterest(
                    loan.amount,
                    loan.interestRate,
                    loan.duration
                );
                const totalRepayment = loan.amount + interest;
                const platformFee = (interest * 100n) / 10000n; // 1%
                const lenderInterest = interest - platformFee;

                this.log(`   Principal: ${ethers.formatUnits(loan.amount, 6)} USDC`, 'blue');
                this.log(`   Interest: ${ethers.formatUnits(interest, 6)} USDC`, 'blue');
                this.log(`   Platform Fee: ${ethers.formatUnits(platformFee, 6)} USDC`, 'blue');
                this.log(`   Lender Gets: ${ethers.formatUnits(lenderInterest, 6)} USDC`, 'blue');
                this.log(`   Total: ${ethers.formatUnits(totalRepayment, 6)} USDC`, 'blue');

                await usdc.connect(aliceWallet).approve(addresses.agentLiquidityMarketplace, totalRepayment);
                const tx = await marketplace.connect(aliceWallet).repayLoan(loanId);
                const receipt = await tx.wait();

                this.log(`   ✅ Loan repaid!`, 'green');
                this.log(`   Gas Used: ${receipt.gasUsed.toLocaleString()}`, 'blue');

                this.results.tests.push({
                    name: 'Repay Loan',
                    status: 'pass',
                    amount: ethers.formatUnits(totalRepayment, 6) + ' USDC',
                    gasUsed: Number(receipt.gasUsed)
                });

                this.results.gasMetrics.push({
                    operation: 'Repay Loan',
                    gasUsed: Number(receipt.gasUsed)
                });

            } catch (error) {
                this.log(`   ❌ Failed: ${error.message}`, 'red');
                this.results.tests.push({
                    name: 'Repay Loan',
                    status: 'fail',
                    error: error.message
                });
                this.results.issues.push({
                    severity: 'CRITICAL',
                    phase: 'Loan Lifecycle',
                    issue: 'Cannot repay loan',
                    error: error.message
                });
                return;
            }

            this.log('');

            // Test 4: Interest Distribution
            this.log('TEST 4: Verify Interest Distribution', 'cyan');
            try {
                const [deployer] = await ethers.getSigners();
                const position = await marketplace.getLenderPosition(alice.agentId, deployer.address);

                this.log(`   Lender Earned: ${ethers.formatUnits(position.earnedInterest, 6)} USDC`, 'blue');

                if (position.earnedInterest > 0) {
                    this.log(`   ✅ Interest distributed correctly`, 'green');
                    this.results.tests.push({
                        name: 'Interest Distribution',
                        status: 'pass',
                        amount: ethers.formatUnits(position.earnedInterest, 6) + ' USDC'
                    });
                } else {
                    this.log(`   ❌ No interest distributed`, 'red');
                    this.results.tests.push({
                        name: 'Interest Distribution',
                        status: 'fail',
                        error: 'No interest earned'
                    });
                    this.results.issues.push({
                        severity: 'CRITICAL',
                        phase: 'Loan Lifecycle',
                        issue: 'Interest not distributed to lender'
                    });
                }

            } catch (error) {
                this.log(`   ❌ Failed: ${error.message}`, 'red');
                this.results.tests.push({
                    name: 'Interest Distribution',
                    status: 'fail',
                    error: error.message
                });
            }

            this.log('');

            // Test 5: Claim Interest
            this.log('TEST 5: Claim Earned Interest', 'cyan');
            try {
                const [deployer] = await ethers.getSigners();
                const position = await marketplace.getLenderPosition(alice.agentId, deployer.address);

                if (position.earnedInterest > 0) {
                    const balanceBefore = await usdc.balanceOf(deployer.address);

                    const tx = await marketplace.claimInterest(alice.agentId);
                    const receipt = await tx.wait();

                    const balanceAfter = await usdc.balanceOf(deployer.address);
                    const claimed = balanceAfter - balanceBefore;

                    this.log(`   ✅ Claimed ${ethers.formatUnits(claimed, 6)} USDC`, 'green');
                    this.log(`   Gas Used: ${receipt.gasUsed.toLocaleString()}`, 'blue');

                    this.results.tests.push({
                        name: 'Claim Interest',
                        status: 'pass',
                        amount: ethers.formatUnits(claimed, 6) + ' USDC',
                        gasUsed: Number(receipt.gasUsed)
                    });

                    this.results.gasMetrics.push({
                        operation: 'Claim Interest',
                        gasUsed: Number(receipt.gasUsed)
                    });

                } else {
                    this.log(`   ⏭️  No interest to claim`, 'yellow');
                    this.results.tests.push({
                        name: 'Claim Interest',
                        status: 'skip',
                        reason: 'No interest available'
                    });
                }

            } catch (error) {
                this.log(`   ❌ Failed: ${error.message}`, 'red');
                this.results.tests.push({
                    name: 'Claim Interest',
                    status: 'fail',
                    error: error.message
                });
            }

            this.log('');
            this.log('✅ PHASE 4 COMPLETE', 'green');

        } catch (error) {
            this.log(`❌ Loan lifecycle testing failed: ${error.message}`, 'red');
            throw error;
        }
    }

    // =============================================
    // GENERATE FINAL REPORT
    // =============================================
    generateReport() {
        this.logSection('📊 FINAL TEST REPORT');

        const passed = this.results.tests.filter(t => t.status === 'pass').length;
        const failed = this.results.tests.filter(t => t.status === 'fail').length;
        const skipped = this.results.tests.filter(t => t.status === 'skip').length;
        const total = this.results.tests.length;
        const successRate = total > 0 ? ((passed / total) * 100).toFixed(1) : '0';

        const duration = ((Date.now() - this.startTime) / 1000).toFixed(2);

        // Summary
        this.log('📈 SUMMARY:', 'bright');
        this.log(`   Total Tests:    ${total}`);
        this.log(`   ✅ Passed:      ${passed}`, 'green');
        this.log(`   ❌ Failed:      ${failed}`, failed > 0 ? 'red' : 'reset');
        this.log(`   ⏭️  Skipped:     ${skipped}`, 'yellow');
        this.log(`   📊 Success Rate: ${successRate}%`, successRate === '100.0' ? 'green' : 'yellow');
        this.log(`   ⏱️  Duration:    ${duration}s`);
        this.log('');

        // Gas Metrics
        if (this.results.gasMetrics && this.results.gasMetrics.length > 0) {
            this.log('⛽ GAS METRICS:', 'bright');
            this.results.gasMetrics.forEach(metric => {
                this.log(`   ${metric.operation}: ${metric.gasUsed.toLocaleString()} gas`);
            });
            this.log('');
        }

        // Issues
        if (this.results.issues.length > 0) {
            this.log('🚨 ISSUES FOUND:', 'bright');
            this.results.issues.forEach((issue, idx) => {
                const color = issue.severity === 'CRITICAL' ? 'red' : issue.severity === 'HIGH' ? 'yellow' : 'reset';
                this.log(`   ${idx + 1}. [${issue.severity}] ${issue.issue}`, color);
                if (issue.error) {
                    this.log(`      Error: ${issue.error}`, color);
                }
            });
            this.log('');
        }

        // Recommendations
        this.generateRecommendations();
        if (this.results.recommendations.length > 0) {
            this.log('💡 RECOMMENDATIONS:', 'bright');
            this.results.recommendations.forEach((rec, idx) => {
                this.log(`   ${idx + 1}. ${rec}`);
            });
            this.log('');
        }

        // Final verdict
        if (failed === 0 && this.results.issues.length === 0) {
            this.log('🎉 ALL TESTS PASSED! Ready for mainnet deployment.', 'green');
        } else if (failed === 0 && this.results.issues.filter(i => i.severity === 'CRITICAL').length === 0) {
            this.log('✅ Tests passed with minor issues. Review recommendations before mainnet.', 'yellow');
        } else {
            this.log('❌ Critical issues found. Fix before proceeding to mainnet.', 'red');
        }

        // Save report
        this.results.summary = {
            total,
            passed,
            failed,
            skipped,
            successRate: successRate + '%',
            duration: duration + 's',
            timestamp: new Date().toISOString()
        };

        this.results.gasMetrics = this.gasMetrics;

        const reportPath = path.join(__dirname, '..', 'master-test-report.json');
        fs.writeFileSync(reportPath, JSON.stringify(this.results, null, 2));

        this.log('');
        this.log(`📁 Full report saved to: master-test-report.json`, 'cyan');
        this.log('');
    }

    generateRecommendations() {
        try {
            // Ensure recommendations array exists
            if (!this.results.recommendations) {
                this.results.recommendations = [];
            }

            // Gas optimization check
            if (Array.isArray(this.results.gasMetrics) && this.results.gasMetrics.length > 0) {
                try {
                    const avgGas = this.results.gasMetrics.reduce((sum, m) => sum + (m.gasUsed || 0), 0) / this.results.gasMetrics.length;
                    if (avgGas > 250000) {
                        this.results.recommendations.push('Consider gas optimizations - average gas usage is high');
                    }
                } catch (e) {
                    // Silently skip gas recommendations if calculation fails
                }
            }

            // Success recommendation
            if (Array.isArray(this.results.issues) && this.results.issues.length === 0) {
                this.results.recommendations.push('All tests passed! Consider deploying to Base Sepolia next');
            }

            // Critical issues check
            if (Array.isArray(this.results.issues)) {
                const criticalIssues = this.results.issues.filter(i => i && i.severity === 'CRITICAL').length;
                if (criticalIssues > 0) {
                    this.results.recommendations.push(`Fix ${criticalIssues} critical issue(s) before mainnet deployment`);
                }
            }

            // Deployment success check
            if (this.results.deployment && this.results.deployment.status === 'success') {
                this.results.recommendations.push('Consider setting up monitoring for the deployed marketplace');
            }
        } catch (error) {
            // If recommendations fail, just log and continue
            console.log('Note: Could not generate recommendations');
        }
    }

    // =============================================
    // RUN ALL TESTS
    // =============================================
    async runAll() {
        let addresses;

        try {
            this.log('🚀 MASTER TEST SUITE - P2P MARKETPLACE', 'bright');
            this.log(`Started at: ${new Date().toLocaleString()}`, 'cyan');
            this.log('');

            // Phase 1: Deploy
            try {
                addresses = await this.deployMarketplace();
            } catch (error) {
                this.log(`❌ Deployment phase failed: ${error.message}`, 'red');
                throw error;
            }

            // Phase 2: Create Pools
            try {
                await this.createAgentPools(addresses);
            } catch (error) {
                this.log(`⚠️  Pool creation phase had errors: ${error.message}`, 'yellow');
                // Continue anyway - pools might already exist
            }

            // Phase 3: Liquidity Testing
            try {
                await this.testLiquidityOperations(addresses);
            } catch (error) {
                this.log(`⚠️  Liquidity testing phase had errors: ${error.message}`, 'yellow');
                // Continue to next phase
            }

            // Phase 4: Loan Lifecycle
            try {
                await this.testLoanLifecycle(addresses);
            } catch (error) {
                this.log(`⚠️  Loan lifecycle phase had errors: ${error.message}`, 'yellow');
                // Continue to generate report
            }

        } catch (error) {
            this.log(`\n❌ Test suite crashed: ${error.message}`, 'red');
            console.error(error.stack);
        } finally {
            // ALWAYS generate report, even if tests failed
            try {
                this.generateReport();
            } catch (reportError) {
                this.log(`❌ Could not generate report: ${reportError.message}`, 'red');
            }

            // Exit with appropriate code
            const failed = Array.isArray(this.results.tests) ? this.results.tests.filter(t => t.status === 'fail').length : 0;
            const critical = Array.isArray(this.results.issues) ? this.results.issues.filter(i => i.severity === 'CRITICAL').length : 0;

            if (failed > 0 || critical > 0) {
                process.exit(1);
            } else {
                process.exit(0);
            }
        }
    }
}

// Execute
const suite = new MasterTestSuite();
suite.runAll();
