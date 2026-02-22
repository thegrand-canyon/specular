/**
 * Autonomous Agent Bot
 * Registers as an agent, creates pool, requests loans, repays, builds reputation
 */

const { ethers } = require('ethers');

class AutonomousAgentBot {
    constructor(config) {
        this.name = config.name;
        this.provider = config.provider;
        this.wallet = config.wallet || ethers.Wallet.createRandom().connect(this.provider);
        this.contracts = config.contracts;

        // Bot strategy
        this.strategy = config.strategy || {
            loanAmount: 1000, // USDC
            loanDuration: 30, // days
            repaymentDelay: 0, // days (0 = immediate)
            targetLoans: 5, // Number of loans to complete
            poolLiquidity: 10000 // Initial pool liquidity
        };

        this.state = {
            agentId: null,
            reputation: 0,
            loansCompleted: 0,
            totalBorrowed: 0,
            totalRepaid: 0,
            isRunning: false
        };

        this.log = [];
    }

    /**
     * Start the bot
     */
    async start() {
        console.log(`\n🤖 Starting ${this.name}...\n`);
        this.state.isRunning = true;

        try {
            // Step 1: Fund wallet with gas (Arc uses USDC)
            await this.ensureGas();

            // Step 2: Register as agent
            await this.registerAgent();

            // Step 3: Initialize reputation
            await this.initializeReputation();

            // Step 4: Create liquidity pool
            await this.createPool();

            // Step 5: Run loan cycle loop
            await this.runLoanCycle();

        } catch (error) {
            this.addLog(`❌ Error: ${error.message}`);
            console.error(`${this.name} error:`, error);
        } finally {
            this.state.isRunning = false;
        }
    }

    /**
     * Ensure wallet has gas
     */
    async ensureGas() {
        const balance = await this.provider.getBalance(this.wallet.address);
        this.addLog(`💰 Gas balance: ${ethers.formatEther(balance)} USDC`);

        if (balance < ethers.parseEther('0.01')) {
            throw new Error('Insufficient gas balance. Fund wallet first.');
        }
    }

    /**
     * Register as an agent
     */
    async registerAgent() {
        this.addLog('📝 Registering agent...');

        const agentRegistry = new ethers.Contract(
            this.contracts.agentRegistryV2,
            [
                'function register(string agentURI, tuple(string key, bytes value)[] metadata) external returns (uint256)',
                'function addressToAgentId(address) external view returns (uint256)'
            ],
            this.wallet
        );

        // Check if already registered
        const existingId = await agentRegistry.addressToAgentId(this.wallet.address);
        if (existingId > 0) {
            this.state.agentId = Number(existingId);
            this.addLog(`✅ Already registered as Agent ID: ${this.state.agentId}`);
            return;
        }

        // Register
        const agentURI = `https://specular.ai/agents/${this.name.toLowerCase()}`;
        const metadata = [];

        const tx = await agentRegistry.register(agentURI, metadata);
        await tx.wait();

        this.state.agentId = Number(await agentRegistry.addressToAgentId(this.wallet.address));
        this.addLog(`✅ Registered as Agent ID: ${this.state.agentId}`);
    }

    /**
     * Initialize reputation
     */
    async initializeReputation() {
        this.addLog('⭐ Initializing reputation...');

        const reputationManager = new ethers.Contract(
            this.contracts.reputationManagerV3,
            [
                'function initializeReputation() external',
                'function getReputationScore(address) external view returns (uint256)'
            ],
            this.wallet
        );

        // Check if already initialized
        const currentRep = await reputationManager['getReputationScore(address)'](this.wallet.address);
        if (currentRep > 0) {
            this.state.reputation = Number(currentRep);
            this.addLog(`✅ Reputation already initialized: ${this.state.reputation}`);
            return;
        }

        // Initialize
        const tx = await reputationManager.initializeReputation();
        await tx.wait();

        this.state.reputation = Number(await reputationManager['getReputationScore(address)'](this.wallet.address));
        this.addLog(`✅ Reputation initialized: ${this.state.reputation}`);
    }

    /**
     * Create liquidity pool and seed it with initial liquidity
     */
    async createPool() {
        this.addLog('🏊 Creating liquidity pool...');

        const marketplace = new ethers.Contract(
            this.contracts.agentLiquidityMarketplace,
            [
                'function createAgentPool() external',
                'function supplyLiquidity(uint256 agentId, uint256 amount) external',
                'function agentPools(uint256) external view returns (uint256, address, uint256, uint256, uint256, uint256, bool)'
            ],
            this.wallet
        );

        const usdc = new ethers.Contract(
            this.contracts.mockUSDC,
            [
                'function approve(address spender, uint256 amount) external returns (bool)',
                'function balanceOf(address) external view returns (uint256)'
            ],
            this.wallet
        );

        // Check if pool exists
        const pool = await marketplace.agentPools(this.state.agentId);
        if (pool[6]) { // isActive
            this.addLog(`✅ Pool already exists`);
        } else {
            // Create pool
            const tx = await marketplace.createAgentPool();
            await tx.wait();
            this.addLog(`✅ Pool created for Agent ID ${this.state.agentId}`);
        }

        // Seed pool with initial liquidity so loans can be taken
        const seedLiquidity = this.strategy.poolLiquidity || 5000;
        const seedAmount = ethers.parseUnits(seedLiquidity.toString(), 6);
        const balance = await usdc.balanceOf(this.wallet.address);

        if (balance >= seedAmount) {
            const currentPool = await marketplace.agentPools(this.state.agentId);
            if (Number(currentPool[2]) === 0) { // Only seed if pool is empty
                this.addLog(`💧 Seeding pool with ${seedLiquidity.toLocaleString()} USDC...`);
                const approveTx = await usdc.approve(this.contracts.agentLiquidityMarketplace, seedAmount);
                await approveTx.wait();
                const supplyTx = await marketplace.supplyLiquidity(this.state.agentId, seedAmount);
                await supplyTx.wait();
                this.addLog(`✅ Pool seeded with ${seedLiquidity.toLocaleString()} USDC`);
            }
        } else {
            this.addLog(`⚠️  Insufficient USDC to seed pool (have ${ethers.formatUnits(balance, 6)})`);
        }
    }

    /**
     * Run automated loan cycle
     */
    async runLoanCycle() {
        this.state.isRunning = true;
        this.addLog(`🔄 Starting loan cycle (target: ${this.strategy.targetLoans} loans)...\n`);

        let consecutiveErrors = 0;
        const maxConsecutiveErrors = 3;

        while (this.state.loansCompleted < this.strategy.targetLoans && this.state.isRunning) {
            try {
                const loanNumber = this.state.loansCompleted + 1;
                this.addLog(`--- LOAN #${loanNumber} ---`);

                // Request loan
                const loanId = await this.requestLoan();

                // Wait a bit (simulate time)
                await this.sleep(5000);

                // Repay loan
                await this.repayLoan(loanId);

                // Update reputation
                await this.checkReputation();

                consecutiveErrors = 0;
                this.state.loansCompleted++;
                this.addLog(`✅ Completed ${this.state.loansCompleted}/${this.strategy.targetLoans} loans\n`);

                // Wait before next loan
                if (this.state.loansCompleted < this.strategy.targetLoans) {
                    this.addLog(`⏳ Waiting 10 seconds before next loan...\n`);
                    await this.sleep(10000);
                }

            } catch (error) {
                consecutiveErrors++;
                this.addLog(`❌ Loan cycle error (${consecutiveErrors}/${maxConsecutiveErrors}): ${error.message}`);
                if (consecutiveErrors >= maxConsecutiveErrors) {
                    this.addLog(`🛑 Too many consecutive errors, stopping loan cycle`);
                    break;
                }
                await this.sleep(5000);
            }
        }

        if (this.state.loansCompleted >= this.strategy.targetLoans) {
            this.addLog(`\n🎉 ${this.name} completed all ${this.strategy.targetLoans} loans!`);
        } else {
            this.addLog(`\n⚠️  ${this.name} stopped after ${this.state.loansCompleted}/${this.strategy.targetLoans} loans`);
        }
        this.state.isRunning = false;
        this.addLog(`📊 Final stats:`);
        this.addLog(`   - Reputation: ${this.state.reputation}`);
        this.addLog(`   - Total Borrowed: ${this.state.totalBorrowed} USDC`);
        this.addLog(`   - Total Repaid: ${this.state.totalRepaid} USDC`);
    }

    /**
     * Request a loan
     */
    async requestLoan() {
        this.addLog(`💰 Requesting loan of ${this.strategy.loanAmount} USDC...`);

        const LOAN_REQUESTED_SIG = ethers.id('LoanRequested(uint256,uint256,address,uint256)');

        const marketplace = new ethers.Contract(
            this.contracts.agentLiquidityMarketplace,
            [
                'function requestLoan(uint256 amount, uint256 durationDays) external returns (uint256)',
                'function loans(uint256) external view returns (uint256, address, uint256, uint256, uint256, uint256, uint256, uint256, uint256, uint8)',
                'event LoanRequested(uint256 indexed loanId, uint256 indexed agentId, address indexed borrower, uint256 amount)',
            ],
            this.wallet
        );

        const usdc = new ethers.Contract(
            this.contracts.mockUSDC,
            [
                'function approve(address spender, uint256 amount) external returns (bool)',
                'function balanceOf(address) external view returns (uint256)'
            ],
            this.wallet
        );

        const reputationManager = new ethers.Contract(
            this.contracts.reputationManagerV3,
            ['function calculateCollateralRequirement(address) external view returns (uint256)'],
            this.wallet
        );

        // Check collateral requirement
        const collateralPercent = await reputationManager.calculateCollateralRequirement(this.wallet.address);
        const loanAmount = ethers.parseUnits(this.strategy.loanAmount.toString(), 6);
        const requiredCollateral = (loanAmount * collateralPercent) / 100n;

        if (requiredCollateral > 0) {
            this.addLog(`   Collateral required: ${ethers.formatUnits(requiredCollateral, 6)} USDC (${collateralPercent}%)`);

            // Approve collateral
            const approveTx = await usdc.approve(this.contracts.agentLiquidityMarketplace, requiredCollateral);
            await approveTx.wait();
        }

        // Request loan — contract takes durationDays (e.g. 7 for 7 days)
        const durationDays = this.strategy.loanDuration; // already in days
        const tx = await marketplace.requestLoan(loanAmount, durationDays);
        const receipt = await tx.wait();

        // Get loan ID — use raw topic[1] as primary (all 3 params are indexed)
        let loanId;
        for (const log of receipt.logs) {
            if (log.topics[0] === LOAN_REQUESTED_SIG && log.topics.length >= 2) {
                loanId = BigInt(log.topics[1]);
                break;
            }
        }
        // Fallback: ABI-based parse
        if (!loanId) {
            const event = receipt.logs.find(log => {
                try { return marketplace.interface.parseLog(log)?.name === 'LoanRequested'; }
                catch { return false; }
            });
            if (event) loanId = marketplace.interface.parseLog(event).args.loanId;
        }

        this.state.totalBorrowed += this.strategy.loanAmount;
        this.addLog(`✅ Loan approved: ID ${loanId}`);

        return loanId;
    }

    /**
     * Repay a loan
     */
    async repayLoan(loanId) {
        this.addLog(`💸 Repaying loan #${loanId}...`);

        const marketplace = new ethers.Contract(
            this.contracts.agentLiquidityMarketplace,
            [
                'function repayLoan(uint256 loanId) external',
                'function loans(uint256) external view returns (uint256, address, uint256, uint256, uint256, uint256, uint256, uint256, uint256, uint8)',
                'function calculateInterest(uint256 amount, uint256 rate, uint256 duration) public pure returns (uint256)'
            ],
            this.wallet
        );

        const usdc = new ethers.Contract(
            this.contracts.mockUSDC,
            ['function approve(address spender, uint256 amount) external returns (bool)'],
            this.wallet
        );

        // Get loan details
        const loan = await marketplace.loans(loanId);
        const principal = loan[3]; // amount
        const interestRate = loan[5];
        const duration = loan[8];

        // Calculate total repayment
        const interest = await marketplace.calculateInterest(principal, interestRate, duration);
        const totalRepayment = principal + interest;

        this.addLog(`   Principal: ${ethers.formatUnits(principal, 6)} USDC`);
        this.addLog(`   Interest: ${ethers.formatUnits(interest, 6)} USDC`);
        this.addLog(`   Total: ${ethers.formatUnits(totalRepayment, 6)} USDC`);

        // Approve repayment
        const approveTx = await usdc.approve(this.contracts.agentLiquidityMarketplace, totalRepayment);
        await approveTx.wait();

        // Repay
        const repayTx = await marketplace.repayLoan(loanId);
        await repayTx.wait();

        this.state.totalRepaid += Number(ethers.formatUnits(totalRepayment, 6));
        this.addLog(`✅ Loan repaid!`);
    }

    /**
     * Check and update reputation
     */
    async checkReputation() {
        const reputationManager = new ethers.Contract(
            this.contracts.reputationManagerV3,
            ['function getReputationScore(address) external view returns (uint256)'],
            this.wallet
        );

        const oldRep = this.state.reputation;
        const newRep = Number(await reputationManager['getReputationScore(address)'](this.wallet.address));

        if (newRep !== oldRep) {
            this.addLog(`⭐ Reputation: ${oldRep} → ${newRep} (+${newRep - oldRep})`);
            this.state.reputation = newRep;
        }
    }

    /**
     * Get current state
     */
    getState() {
        return {
            ...this.state,
            address: this.wallet.address,
            name: this.name,
            log: this.log
        };
    }

    /**
     * Add log entry
     */
    addLog(message) {
        const timestamp = new Date().toISOString();
        const logEntry = `[${timestamp}] ${this.name}: ${message}`;
        this.log.push(logEntry);
        console.log(logEntry);
    }

    /**
     * Sleep helper
     */
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Stop the bot
     */
    stop() {
        this.state.isRunning = false;
        this.addLog('🛑 Bot stopped');
    }
}

module.exports = { AutonomousAgentBot };
