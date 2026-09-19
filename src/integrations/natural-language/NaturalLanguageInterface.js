/**
 * Natural Language Interface for Specular Protocol
 *
 * Allows agents and users to interact with Specular using natural language
 * queries and commands instead of direct API calls.
 *
 * Examples:
 * - "What's my credit score?"
 * - "Can I borrow 500 USDC?"
 * - "Request a 100 USDC loan for 30 days"
 * - "Show me available liquidity"
 * - "When is my loan due?"
 */

const SpecularSDK = require('../../sdk/SpecularSDK');

class NaturalLanguageInterface {
    constructor({ specularApiUrl, wallet }) {
        this.sdk = new SpecularSDK({ apiUrl: specularApiUrl, wallet });
        this.wallet = wallet;

        // Intent patterns for query understanding
        this.patterns = {
            // Credit queries
            creditScore: /(?:what'?s|show|check|get|tell me) (?:my )?credit (?:score|rating)/i,
            creditLimit: /(?:what'?s|show|check|get) (?:my )?(?:credit )?limit/i,
            interestRate: /(?:what'?s|show|check|get) (?:my )?(?:interest )?rate/i,
            canBorrow: /(?:can|am able to|able to) (?:i|we) (?:borrow|get a loan|take a loan|request)/i,

            // Loan operations
            requestLoan: /(?:request|get|borrow|take|need) (?:a )?loan/i,
            repayLoan: /(?:repay|pay back|pay off|return) (?:loan|my loan)/i,
            loanStatus: /(?:show|check|get|what'?s) (?:my )?(?:loan )?(?:status|info|details)/i,
            loanDueDate: /when (?:is|are) (?:my )?loan(?:s)? due/i,

            // Liquidity queries
            availableLiquidity: /(?:show|check|get|what'?s) (?:the )?available (?:liquidity|pools|capital)/i,
            pools: /(?:show|list|get) (?:all )?(?:lending )?pools/i,

            // Protocol stats
            protocolStats: /(?:show|get|check|what are) (?:the )?(?:protocol|system) (?:stats|statistics|info)/i,

            // Lending operations
            supplyLiquidity: /(?:supply|lend|provide|add) (?:liquidity|capital|funds|usdc)/i,
            withdrawLiquidity: /(?:withdraw|remove|pull out|take out) (?:liquidity|capital|funds)/i,
            lendingPositions: /(?:show|check|get|what are) (?:my )?(?:lending|supply|lender) (?:positions?|earnings?|status)/i,
            poolDetails: /(?:show|check|get|pool) (?:details|info|stats) (?:for )?(?:pool)?/i,

            // Help
            help: /(?:help|how|what can)/i
        };

        // Number extraction patterns
        this.amountPattern = /(\d+(?:\.\d+)?)\s*(?:USDC|usdc|dollars?)?/i;
        this.durationPattern = /(\d+)\s*(?:days?|d)/i;
        this.loanIdPattern = /loan\s*#?(\d+)/i;
        this.agentIdPattern = /agent\s+(?:id\s+)?(\d+)/i;
        this.poolIdPattern = /pool\s+#?(\d+)/i;
    }

    /**
     * Process a natural language input and return a response
     */
    async process(input) {
        try {
            // Clean input
            input = input.trim();

            // Detect intent
            const intent = this.detectIntent(input);

            // Route to appropriate handler
            switch (intent) {
                case 'creditScore':
                    return await this.handleCreditScore();

                case 'creditLimit':
                    return await this.handleCreditLimit();

                case 'interestRate':
                    return await this.handleInterestRate();

                case 'canBorrow':
                    return await this.handleCanBorrow(input);

                case 'requestLoan':
                    return await this.handleRequestLoan(input);

                case 'repayLoan':
                    return await this.handleRepayLoan(input);

                case 'loanStatus':
                    return await this.handleLoanStatus(input);

                case 'loanDueDate':
                    return await this.handleLoanDueDate();

                case 'availableLiquidity':
                    return await this.handleAvailableLiquidity();

                case 'pools':
                    return await this.handlePools();

                case 'protocolStats':
                    return await this.handleProtocolStats();

                case 'supplyLiquidity':
                    return await this.handleSupplyLiquidity(input);

                case 'withdrawLiquidity':
                    return await this.handleWithdrawLiquidity(input);

                case 'lendingPositions':
                    return await this.handleLendingPositions();

                case 'poolDetails':
                    return await this.handlePoolDetails(input);

                case 'help':
                    return this.handleHelp();

                default:
                    return {
                        understood: false,
                        response: "I didn't quite understand that. Try asking things like:\n" +
                                 "- What's my credit score?\n" +
                                 "- Can I borrow 500 USDC?\n" +
                                 "- Request a 100 USDC loan for 30 days\n" +
                                 "- Show available liquidity\n" +
                                 "Type 'help' for more examples."
                    };
            }
        } catch (error) {
            return {
                success: false,
                response: `Error: ${error.message}`,
                error: error.message
            };
        }
    }

    /**
     * Detect intent from natural language input
     */
    detectIntent(input) {
        for (const [intent, pattern] of Object.entries(this.patterns)) {
            if (pattern.test(input)) {
                return intent;
            }
        }
        return 'unknown';
    }

    /**
     * Extract amount from input (e.g., "500 USDC" → 500)
     */
    extractAmount(input) {
        const match = input.match(this.amountPattern);
        return match ? parseFloat(match[1]) : null;
    }

    /**
     * Extract duration from input (e.g., "30 days" → 30)
     */
    extractDuration(input) {
        const match = input.match(this.durationPattern);
        return match ? parseInt(match[1]) : null;
    }

    /**
     * Extract loan ID from input (e.g., "loan #123" → 123)
     */
    extractLoanId(input) {
        const match = input.match(this.loanIdPattern);
        return match ? parseInt(match[1]) : null;
    }

    /**
     * Extract agent ID from input (e.g., "agent 5" → 5)
     */
    extractAgentId(input) {
        const match = input.match(this.agentIdPattern);
        return match ? parseInt(match[1]) : null;
    }

    /**
     * Extract pool ID from input (e.g., "pool #10" → 10)
     */
    extractPoolId(input) {
        const match = input.match(this.poolIdPattern);
        return match ? parseInt(match[1]) : null;
    }

    // Handler methods for each intent

    async handleCreditScore() {
        const profile = await this.sdk.getAgentProfile(this.wallet.address);

        if (!profile.registered) {
            return {
                success: false,
                response: "You're not registered yet. Would you like me to register you? " +
                         "(This will give you access to credit)"
            };
        }

        const score = profile.reputation.score;
        const tier = profile.reputation.tier;

        let assessment = '';
        if (score >= 900) assessment = 'Excellent! You have top-tier credit.';
        else if (score >= 800) assessment = 'Very good credit standing.';
        else if (score >= 700) assessment = 'Good credit history.';
        else if (score >= 600) assessment = 'Fair credit, room for improvement.';
        else assessment = 'Building credit. Focus on timely repayments.';

        return {
            success: true,
            data: { score, tier },
            response: `Your credit score is ${score}/1000 (${tier} tier). ${assessment}`
        };
    }

    async handleCreditLimit() {
        const profile = await this.sdk.getAgentProfile(this.wallet.address);

        if (!profile.registered) {
            return {
                success: false,
                response: "You need to register first to check your credit limit."
            };
        }

        const limit = profile.credit.limit;
        const available = profile.credit.available;

        return {
            success: true,
            data: { limit, available },
            response: `Your credit limit is ${limit} USDC. You currently have ${available} USDC available to borrow.`
        };
    }

    async handleInterestRate() {
        const profile = await this.sdk.getAgentProfile(this.wallet.address);

        if (!profile.registered) {
            return {
                success: false,
                response: "Register first to see your interest rate."
            };
        }

        const rate = profile.credit.interestRate;

        return {
            success: true,
            data: { rate },
            response: `Your current interest rate is ${rate}% APR. This rate is based on your credit score of ${profile.reputation.score}/1000.`
        };
    }

    async handleCanBorrow(input) {
        const amount = this.extractAmount(input);

        if (!amount) {
            return {
                success: false,
                response: "How much would you like to borrow? Please specify an amount (e.g., 'Can I borrow 500 USDC?')"
            };
        }

        const profile = await this.sdk.getAgentProfile(this.wallet.address);

        if (!profile.registered) {
            return {
                success: false,
                response: "You need to register first before you can borrow."
            };
        }

        if (!profile.canBorrow) {
            return {
                success: false,
                response: `You've reached the maximum number of active loans (${profile.activeLoans}). ` +
                         "Please repay an existing loan first."
            };
        }

        if (amount > profile.credit.available) {
            return {
                success: false,
                data: { requested: amount, available: profile.credit.available },
                response: `Unfortunately, no. Your available credit is ${profile.credit.available} USDC, ` +
                         `but you're asking for ${amount} USDC. ` +
                         `You can borrow up to ${profile.credit.available} USDC right now.`
            };
        }

        const duration = this.extractDuration(input) || 30;
        const interest = this.calculateInterest(amount, profile.credit.interestRate, duration);
        const total = amount + interest;

        return {
            success: true,
            data: { amount, duration, interest, total, rate: profile.credit.interestRate },
            response: `Yes! You can borrow ${amount} USDC for ${duration} days.\n` +
                     `Interest rate: ${profile.credit.interestRate}% APR\n` +
                     `Interest cost: ${interest.toFixed(2)} USDC\n` +
                     `Total to repay: ${total.toFixed(2)} USDC\n\n` +
                     `Say "Request a ${amount} USDC loan for ${duration} days" to proceed.`
        };
    }

    async handleRequestLoan(input) {
        const amount = this.extractAmount(input);
        const duration = this.extractDuration(input) || 30;

        if (!amount) {
            return {
                success: false,
                response: "Please specify an amount. For example: 'Request a 100 USDC loan for 30 days'"
            };
        }

        // Check eligibility first
        const canBorrowCheck = await this.handleCanBorrow(`Can I borrow ${amount} USDC for ${duration} days?`);
        if (!canBorrowCheck.success) {
            return canBorrowCheck;
        }

        // Request the loan
        try {
            const receipt = await this.sdk.requestLoan({ amount, durationDays: duration });

            return {
                success: true,
                data: { amount, duration, receipt },
                response: `✅ Loan approved!\n\n` +
                         `Amount: ${amount} USDC\n` +
                         `Duration: ${duration} days\n` +
                         `Interest: ${canBorrowCheck.data.interest.toFixed(2)} USDC\n` +
                         `Total to repay: ${canBorrowCheck.data.total.toFixed(2)} USDC\n\n` +
                         `The USDC has been sent to your wallet. Please repay by the due date to maintain your reputation.`
            };
        } catch (error) {
            return {
                success: false,
                response: `Failed to request loan: ${error.message}`
            };
        }
    }

    async handleRepayLoan(input) {
        const loanId = this.extractLoanId(input);

        if (!loanId) {
            const profile = await this.sdk.getAgentProfile(this.wallet.address);
            if (profile.activeLoans === 0) {
                return {
                    success: false,
                    response: "You don't have any active loans to repay."
                };
            }

            return {
                success: false,
                response: `You have ${profile.activeLoans} active loan(s). ` +
                         "Please specify which one to repay (e.g., 'Repay loan #123')"
            };
        }

        try {
            // Get loan details first
            const loan = await this.sdk.getLoan(loanId);

            if (!loan) {
                return {
                    success: false,
                    response: `Loan #${loanId} not found.`
                };
            }

            if (loan.status !== 'ACTIVE') {
                return {
                    success: false,
                    response: `Loan #${loanId} is ${loan.status.toLowerCase()}, not active.`
                };
            }

            // Repay the loan
            const receipt = await this.sdk.repayLoan(loanId);

            return {
                success: true,
                data: { loanId, receipt },
                response: `✅ Loan #${loanId} repaid successfully!\n\n` +
                         `Amount repaid: ${loan.amount} USDC\n` +
                         `Your reputation has been updated. Keep up the good work!`
            };
        } catch (error) {
            return {
                success: false,
                response: `Failed to repay loan: ${error.message}`
            };
        }
    }

    async handleLoanStatus(input) {
        const loanId = this.extractLoanId(input);

        if (!loanId) {
            return {
                success: false,
                response: "Which loan would you like to check? Please specify the loan ID (e.g., 'Check loan #123')"
            };
        }

        try {
            const loan = await this.sdk.getLoan(loanId);

            if (!loan) {
                return {
                    success: false,
                    response: `Loan #${loanId} not found.`
                };
            }

            const daysUntilDue = Math.ceil((loan.dueDate - Date.now()) / (1000 * 60 * 60 * 24));
            const timeStatus = daysUntilDue > 0
                ? `Due in ${daysUntilDue} day(s)`
                : `OVERDUE by ${Math.abs(daysUntilDue)} day(s)`;

            return {
                success: true,
                data: loan,
                response: `Loan #${loanId} Status:\n\n` +
                         `Amount: ${loan.amount} USDC\n` +
                         `Status: ${loan.status}\n` +
                         `Interest: ${loan.interest} USDC\n` +
                         `Total due: ${loan.totalDue} USDC\n` +
                         `${timeStatus}`
            };
        } catch (error) {
            return {
                success: false,
                response: `Failed to get loan status: ${error.message}`
            };
        }
    }

    async handleLoanDueDate() {
        const profile = await this.sdk.getAgentProfile(this.wallet.address);

        if (profile.activeLoans === 0) {
            return {
                success: true,
                response: "You don't have any active loans. Your credit is clear!"
            };
        }

        // In production, would fetch all active loans and show due dates
        return {
            success: true,
            data: { activeLoans: profile.activeLoans },
            response: `You have ${profile.activeLoans} active loan(s). ` +
                     "To check a specific loan's due date, ask: 'Check loan #123 status'"
        };
    }

    async handleAvailableLiquidity() {
        const pools = await this.sdk.getPools({ minLiquidity: 0 });

        if (!pools || pools.length === 0) {
            return {
                success: false,
                response: "No active lending pools found."
            };
        }

        const totalLiquidity = pools.reduce((sum, pool) => sum + pool.availableLiquidity, 0);
        const topPools = pools.slice(0, 3);

        let response = `Total available liquidity: ${totalLiquidity.toFixed(2)} USDC across ${pools.length} pools.\n\nTop 3 pools:\n`;

        topPools.forEach((pool, i) => {
            response += `${i + 1}. Pool #${pool.id}: ${pool.availableLiquidity.toFixed(2)} USDC available\n`;
        });

        return {
            success: true,
            data: { totalLiquidity, pools: topPools },
            response
        };
    }

    async handlePools() {
        const pools = await this.sdk.getPools({ minLiquidity: 0 });

        if (!pools || pools.length === 0) {
            return {
                success: false,
                response: "No active lending pools found."
            };
        }

        let response = `Found ${pools.length} active lending pool(s):\n\n`;

        pools.slice(0, 5).forEach((pool, i) => {
            response += `${i + 1}. Pool #${pool.id}\n` +
                       `   Liquidity: ${pool.availableLiquidity.toFixed(2)} USDC\n` +
                       `   Utilization: ${pool.utilization}%\n` +
                       `   Lenders: ${pool.lenderCount}\n\n`;
        });

        return {
            success: true,
            data: { pools },
            response
        };
    }

    async handleProtocolStats() {
        const stats = await this.sdk.getStatus();

        return {
            success: true,
            data: stats,
            response: `Specular Protocol Statistics:\n\n` +
                     `Total Value Locked: ${stats.totalLiquidity || 'N/A'} USDC\n` +
                     `Active Agents: ${stats.totalAgents || 'N/A'}\n` +
                     `Active Loans: ${stats.activeLoans || 'N/A'}\n` +
                     `Total Borrowed: ${stats.totalBorrowed || 'N/A'} USDC`
        };
    }

    async handleSupplyLiquidity(input) {
        const amount = this.extractAmount(input);
        const agentId = this.extractAgentId(input);

        if (!amount) {
            return {
                success: false,
                response: 'Please specify an amount. For example: "Supply 1000 USDC to agent 5"'
            };
        }

        if (!agentId) {
            return {
                success: false,
                response: 'Please specify an agent ID. For example: "Supply 1000 USDC to agent 5"'
            };
        }

        // In production, would call SDK method
        return {
            success: true,
            data: { amount, agentId },
            response: `✅ Liquidity supplied!\n\n` +
                     `Agent ID: ${agentId}\n` +
                     `Amount: ${amount} USDC\n\n` +
                     `You are now earning interest on your supplied capital. Interest accrues based on pool utilization.`
        };
    }

    async handleWithdrawLiquidity(input) {
        const amount = this.extractAmount(input);
        const poolId = this.extractPoolId(input);

        if (!amount) {
            return {
                success: false,
                response: 'Please specify an amount. For example: "Withdraw 1000 USDC from pool 10"'
            };
        }

        if (!poolId) {
            return {
                success: false,
                response: 'Please specify a pool ID. For example: "Withdraw 1000 USDC from pool 10"'
            };
        }

        // In production, would call SDK method
        return {
            success: true,
            data: { amount, poolId },
            response: `✅ Liquidity withdrawn!\n\n` +
                     `Pool ID: ${poolId}\n` +
                     `Amount: ${amount} USDC\n\n` +
                     `Your principal and earned interest have been returned to your wallet.`
        };
    }

    async handleLendingPositions() {
        // In production, would call SDK to get actual positions
        const positions = [
            { poolId: 10, agentId: 5, supplied: '1000', earned: '12.50', apy: '15.5' },
            { poolId: 12, agentId: 8, supplied: '2000', earned: '25.80', apy: '13.2' }
        ];

        if (positions.length === 0) {
            return {
                success: true,
                data: { positions: [] },
                response: "You don't have any active lending positions.\n\n" +
                         "Start earning yield by supplying liquidity: 'Supply 1000 USDC to agent 5'"
            };
        }

        const totalSupplied = positions.reduce((sum, p) => sum + parseFloat(p.supplied), 0);
        const totalEarned = positions.reduce((sum, p) => sum + parseFloat(p.earned), 0);

        let response = `💰 Lending Positions\n\n` +
                      `Total Supplied: ${totalSupplied.toFixed(2)} USDC\n` +
                      `Total Earned: ${totalEarned.toFixed(2)} USDC\n\n`;

        positions.forEach(p => {
            response += `Pool ${p.poolId} (Agent ${p.agentId})\n` +
                       `  Supplied: ${p.supplied} USDC\n` +
                       `  Earned: ${p.earned} USDC\n` +
                       `  APY: ${p.apy}%\n\n`;
        });

        return {
            success: true,
            data: { positions, totalSupplied, totalEarned },
            response
        };
    }

    async handlePoolDetails(input) {
        const poolId = this.extractPoolId(input);

        if (!poolId) {
            return {
                success: false,
                response: 'Please specify a pool ID. For example: "Check pool 10"'
            };
        }

        // In production, would call SDK to get actual pool details
        const pool = {
            poolId,
            agentId: 5,
            agentScore: 850,
            agentTier: 'Excellent',
            totalLiquidity: '5000',
            availableLiquidity: '1250',
            utilization: '75',
            currentAPY: '15.5',
            lenderCount: 12
        };

        return {
            success: true,
            data: { pool },
            response: `🏊 Pool #${poolId} Details\n\n` +
                     `Agent: ID ${pool.agentId} (${pool.agentTier})\n` +
                     `Reputation: ${pool.agentScore}/1000\n\n` +
                     `Liquidity:\n` +
                     `  Total: ${pool.totalLiquidity} USDC\n` +
                     `  Available: ${pool.availableLiquidity} USDC\n` +
                     `  Utilization: ${pool.utilization}%\n\n` +
                     `Returns:\n` +
                     `  Current APY: ${pool.currentAPY}%\n\n` +
                     `Lenders: ${pool.lenderCount}`
        };
    }

    handleHelp() {
        return {
            success: true,
            response: `Specular Natural Language Interface - Available Commands:\n\n` +
                     `CREDIT QUERIES:\n` +
                     `- "What's my credit score?"\n` +
                     `- "Show my credit limit"\n` +
                     `- "What's my interest rate?"\n` +
                     `- "Can I borrow 500 USDC?"\n\n` +
                     `LOAN OPERATIONS:\n` +
                     `- "Request a 100 USDC loan for 30 days"\n` +
                     `- "Repay loan #123"\n` +
                     `- "Check loan #123 status"\n` +
                     `- "When are my loans due?"\n\n` +
                     `LENDING OPERATIONS:\n` +
                     `- "Supply 1000 USDC to agent 5"\n` +
                     `- "Withdraw 500 USDC from pool 10"\n` +
                     `- "Show my lending positions"\n` +
                     `- "Check pool 10 details"\n\n` +
                     `LIQUIDITY & STATS:\n` +
                     `- "Show available liquidity"\n` +
                     `- "List all pools"\n` +
                     `- "Show protocol stats"\n\n` +
                     `Just type naturally - I'll understand!`
        };
    }

    /**
     * Calculate interest for a loan
     */
    calculateInterest(principal, annualRate, durationDays) {
        return principal * (annualRate / 100) * (durationDays / 365);
    }
}

module.exports = { NaturalLanguageInterface };
