/**
 * Lender Bot
 * Supplies liquidity to agent pools, monitors returns, rebalances
 */

const { ethers } = require('ethers');

class LenderBot {
    constructor(config) {
        this.name = config.name;
        this.provider = config.provider;
        this.wallet = config.wallet;
        this.contracts = config.contracts;

        // Lender strategy
        this.strategy = config.strategy || {
            totalCapital: 50000, // USDC to deploy
            diversification: 4, // Number of agents to fund
            minAgentReputation: 100,
            rebalanceInterval: 60000, // 1 minute
            preferredAgentIds: [],    // Supply to these agent IDs first
            maxMonitorCycles: 3       // Exit after N monitoring cycles
        };

        this.state = {
            positions: {}, // agentId => { amount, earned }
            totalSupplied: 0,
            totalEarned: 0,
            isRunning: false
        };

        this.log = [];
    }

    /**
     * Start the bot
     */
    async start() {
        console.log(`\n💰 Starting ${this.name}...\n`);
        this.state.isRunning = true;

        try {
            // Step 1: Ensure we have USDC
            await this.ensureFunds();

            // Step 2: Find good agents to fund
            const agents = await this.findAgents();

            // Step 3: Supply liquidity
            await this.supplyLiquidity(agents);

            // Step 4: Monitor and rebalance loop
            await this.monitorLoop();

        } catch (error) {
            this.addLog(`❌ Error: ${error.message}`);
            console.error(`${this.name} error:`, error);
        } finally {
            this.state.isRunning = false;
        }
    }

    /**
     * Ensure wallet has USDC
     */
    async ensureFunds() {
        const usdc = new ethers.Contract(
            this.contracts.mockUSDC,
            ['function balanceOf(address) external view returns (uint256)'],
            this.wallet
        );

        const balance = await usdc.balanceOf(this.wallet.address);
        this.addLog(`💵 USDC balance: ${ethers.formatUnits(balance, 6)} USDC`);

        const requiredBalance = ethers.parseUnits(this.strategy.totalCapital.toString(), 6);
        if (balance < requiredBalance) {
            throw new Error(`Insufficient USDC. Have: ${ethers.formatUnits(balance, 6)}, Need: ${this.strategy.totalCapital}`);
        }
    }

    /**
     * Find agents to fund
     * Prefers preferred agent IDs (newly created in this simulation run),
     * then falls back to searching all agents by reputation.
     */
    async findAgents() {
        this.addLog('🔍 Searching for agents to fund...');

        const reputationManager = new ethers.Contract(
            this.contracts.reputationManagerV3,
            ['function getReputationScore(uint256) external view returns (uint256)'],
            this.provider
        );

        const marketplace = new ethers.Contract(
            this.contracts.agentLiquidityMarketplace,
            ['function agentPools(uint256) external view returns (uint256, address, uint256, uint256, uint256, uint256, bool)',
             'function totalPools() external view returns (uint256)',
             'function agentPoolIds(uint256) external view returns (uint256)'],
            this.provider
        );

        const goodAgents = [];
        const seenIds = new Set();

        // Step 1: Check preferred agent IDs first (agents created in this simulation run)
        if (this.strategy.preferredAgentIds && this.strategy.preferredAgentIds.length > 0) {
            this.addLog(`   Checking ${this.strategy.preferredAgentIds.length} preferred agents...`);
            for (const agentId of this.strategy.preferredAgentIds) {
                try {
                    const reputation = Number(await reputationManager['getReputationScore(uint256)'](agentId));
                    const pool = await marketplace.agentPools(agentId);
                    if (pool[6] && reputation >= this.strategy.minAgentReputation) {
                        goodAgents.push({
                            agentId,
                            reputation,
                            currentLiquidity: pool[2],
                            availableLiquidity: pool[3],
                            preferred: true
                        });
                        seenIds.add(agentId);
                    }
                } catch {}
            }
            this.addLog(`   Found ${goodAgents.length} preferred agents with active pools`);
        }

        // Step 2: Fill remaining slots — try pool discovery array first, fall back to agent scan
        if (goodAgents.length < this.strategy.diversification) {
            let usedPoolDiscovery = false;
            try {
                const totalPoolCount = Number(await marketplace.totalPools());
                usedPoolDiscovery = true;
                // Scan from newest to oldest
                for (let i = totalPoolCount - 1; i >= 0 && goodAgents.length < this.strategy.diversification; i--) {
                    try {
                        const agentId = Number(await marketplace.agentPoolIds(i));
                        if (seenIds.has(agentId)) continue;
                        seenIds.add(agentId);

                        const reputation = Number(await reputationManager['getReputationScore(uint256)'](agentId));
                        if (reputation < this.strategy.minAgentReputation) continue;

                        const pool = await marketplace.agentPools(agentId);
                        if (!pool[6]) continue;

                        goodAgents.push({ agentId, reputation, currentLiquidity: pool[2], availableLiquidity: pool[3], preferred: false });
                    } catch {}
                }
            } catch {
                // totalPools() not available on this deployment — fall back to agent registry scan
            }

            if (!usedPoolDiscovery) {
                const agentRegistry = new ethers.Contract(
                    this.contracts.agentRegistryV2,
                    ['function totalAgents() external view returns (uint256)'],
                    this.provider
                );
                const totalAgents = Number(await agentRegistry.totalAgents());
                // Scan from newest to oldest
                for (let agentId = totalAgents; agentId >= 1 && goodAgents.length < this.strategy.diversification; agentId--) {
                    if (seenIds.has(agentId)) continue;
                    seenIds.add(agentId);
                    try {
                        const reputation = Number(await reputationManager['getReputationScore(uint256)'](agentId));
                        if (reputation < this.strategy.minAgentReputation) continue;
                        const pool = await marketplace.agentPools(agentId);
                        if (!pool[6]) continue;
                        goodAgents.push({ agentId, reputation, currentLiquidity: pool[2], availableLiquidity: pool[3], preferred: false });
                    } catch {}
                }
            }
        }

        this.addLog(`   ✅ Found ${goodAgents.length} qualified agents (${goodAgents.filter(a => a.preferred).length} preferred)`);

        // Sort: preferred first, then by reputation descending
        goodAgents.sort((a, b) => {
            if (a.preferred && !b.preferred) return -1;
            if (!a.preferred && b.preferred) return 1;
            return b.reputation - a.reputation;
        });

        return goodAgents.slice(0, this.strategy.diversification);
    }

    /**
     * Supply liquidity to agents
     */
    async supplyLiquidity(agents) {
        this.addLog(`\n💸 Supplying liquidity to ${agents.length} agents...\n`);

        const amountPerAgent = Math.floor(this.strategy.totalCapital / agents.length);

        const marketplace = new ethers.Contract(
            this.contracts.agentLiquidityMarketplace,
            ['function supplyLiquidity(uint256 agentId, uint256 amount) external'],
            this.wallet
        );

        const usdc = new ethers.Contract(
            this.contracts.mockUSDC,
            ['function approve(address spender, uint256 amount) external returns (bool)'],
            this.wallet
        );

        for (const agent of agents) {
            try {
                this.addLog(`Agent ${agent.agentId} (Rep: ${agent.reputation}):`);
                this.addLog(`   Supplying ${amountPerAgent.toLocaleString()} USDC...`);

                const amount = ethers.parseUnits(amountPerAgent.toString(), 6);

                // Approve
                const approveTx = await usdc.approve(this.contracts.agentLiquidityMarketplace, amount);
                await approveTx.wait();

                // Supply
                const supplyTx = await marketplace.supplyLiquidity(agent.agentId, amount);
                await supplyTx.wait();

                // Track position
                this.state.positions[agent.agentId] = {
                    amount: amountPerAgent,
                    earned: 0,
                    suppliedAt: Date.now()
                };

                this.state.totalSupplied += amountPerAgent;

                this.addLog(`   ✅ Liquidity supplied\n`);

                // Wait between deposits
                await this.sleep(3000);

            } catch (error) {
                this.addLog(`   ❌ Failed: ${error.message}\n`);
            }
        }

        this.addLog(`✅ Total supplied: ${this.state.totalSupplied.toLocaleString()} USDC\n`);
    }

    /**
     * Monitor positions and rebalance
     * Exits after maxMonitorCycles iterations (default: 3)
     */
    async monitorLoop() {
        this.addLog('📊 Starting monitoring loop...\n');

        const maxCycles = this.strategy.maxMonitorCycles || 3;
        let cycle = 0;

        while (this.state.isRunning && cycle < maxCycles) {
            try {
                await this.checkPositions();
                cycle++;
                if (cycle < maxCycles) {
                    await this.sleep(this.strategy.rebalanceInterval);
                }
            } catch (error) {
                this.addLog(`❌ Monitor error: ${error.message}`);
                cycle++;
            }
        }

        this.addLog(`✅ Monitoring complete (${cycle} cycles)`);
        this.state.isRunning = false;
    }

    /**
     * Check all positions
     */
    async checkPositions() {
        const marketplace = new ethers.Contract(
            this.contracts.agentLiquidityMarketplace,
            [
                'function positions(uint256 agentId, address lender) external view returns (uint256 amount, uint256 earnedInterest, uint256 depositTimestamp)',
                'function agentPools(uint256) external view returns (uint256, address, uint256, uint256, uint256, uint256, bool)'
            ],
            this.provider
        );

        this.addLog('--- POSITION UPDATE ---');

        let totalEarned = 0;

        for (const agentId of Object.keys(this.state.positions)) {
            try {
                // Check position
                const position = await marketplace.positions(agentId, this.wallet.address);
                const earned = Number(ethers.formatUnits(position[1], 6));

                // Check pool
                const pool = await marketplace.agentPools(agentId);
                const totalLiquidity = ethers.formatUnits(pool[2], 6);
                const availableLiquidity = ethers.formatUnits(pool[3], 6);
                const totalLoaned = ethers.formatUnits(pool[4], 6);

                this.state.positions[agentId].earned = earned;
                totalEarned += earned;

                this.addLog(`Agent ${agentId}:`);
                this.addLog(`   Supplied: ${this.state.positions[agentId].amount.toLocaleString()} USDC`);
                this.addLog(`   Earned: ${earned.toFixed(2)} USDC`);
                this.addLog(`   Pool Total: ${totalLiquidity} USDC`);
                this.addLog(`   Pool Available: ${availableLiquidity} USDC`);
                this.addLog(`   Pool Loaned: ${totalLoaned} USDC`);

            } catch (error) {
                this.addLog(`Agent ${agentId}: Error checking position`);
            }
        }

        this.state.totalEarned = totalEarned;
        this.addLog(`\n💰 Total earned across all positions: ${totalEarned.toFixed(2)} USDC\n`);
    }

    /**
     * Withdraw from a position
     */
    async withdrawFromAgent(agentId, amount) {
        this.addLog(`💸 Withdrawing ${amount} USDC from Agent ${agentId}...`);

        const marketplace = new ethers.Contract(
            this.contracts.agentLiquidityMarketplace,
            ['function withdrawLiquidity(uint256 agentId, uint256 amount) external'],
            this.wallet
        );

        const amountWei = ethers.parseUnits(amount.toString(), 6);
        const tx = await marketplace.withdrawLiquidity(agentId, amountWei);
        await tx.wait();

        this.addLog(`✅ Withdrawal complete`);

        // Update position
        if (this.state.positions[agentId]) {
            this.state.positions[agentId].amount -= amount;
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

module.exports = { LenderBot };
