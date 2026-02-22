'use strict';
/**
 * Specular Autonomous Agent
 *
 * A self-directing agent that runs a full protocol lifecycle loop:
 *
 *   IDLE → ASSESSING → BORROWING → WORKING → REPAYING → IDLE → ...
 *
 * Each cycle:
 *   1. Discover protocol state (pools, credit score)
 *   2. Decide on loan amount based on score and available liquidity
 *   3. Borrow from the best pool
 *   4. Do work: gather market intelligence, produce a report
 *   5. Repay the loan
 *   6. Rest, then repeat
 *
 * Reputation grows +10 pts per on-time repayment.  The agent
 * automatically scales its borrow amount as its score improves.
 */

const fs   = require('fs');
const path = require('path');
const { SpecularSDK }    = require('../sdk/SpecularSDK');
const { AgentMessenger } = require('../xmtp/AgentMessenger');

// Agent states
const STATE = {
    BOOT:      'BOOT',
    IDLE:      'IDLE',
    ASSESSING: 'ASSESSING',
    BORROWING: 'BORROWING',
    WORKING:   'WORKING',
    REPAYING:  'REPAYING',
    DONE:      'DONE',
};

class AutonomousAgent {
    /**
     * @param {object}         opts
     * @param {ethers.Wallet}  opts.wallet           - Funded wallet (needs USDC + ETH for gas)
     * @param {string}         opts.apiUrl           - Specular Agent API base URL
     * @param {object}         [opts.config]
     * @param {number}         [opts.config.maxCycles]       - Max borrow cycles (default: 5)
     * @param {number}         [opts.config.restMs]          - ms between cycles (default: 5000)
     * @param {number}         [opts.config.workMs]          - ms to simulate work (default: 3000)
     * @param {number}         [opts.config.startLoanUsdc]   - First loan amount (default: 10)
     * @param {number}         [opts.config.maxLoanUsdc]     - Max single loan (default: 500)
     * @param {number}         [opts.config.loanDurationDays]- Days per loan (default: 7)
     * @param {string}         [opts.reportsDir]     - Where to save work reports
     * @param {string}         [opts.lenderAddress]  - Lender wallet address for XMTP notifications
     * @param {string}         [opts.xmtpEnv]        - 'dev' (default) | 'production'
     */
    constructor(opts = {}) {
        if (!opts.wallet) throw new Error('AutonomousAgent: wallet required');
        if (!opts.apiUrl) throw new Error('AutonomousAgent: apiUrl required');

        this.wallet = opts.wallet;
        this.sdk    = new SpecularSDK({ apiUrl: opts.apiUrl, wallet: opts.wallet, verbose: true });
        this.lenderAddress = opts.lenderAddress ?? null;
        this.xmtpEnv       = opts.xmtpEnv ?? 'dev';
        this.messenger     = null;  // initialised in run()

        const cfg = opts.config ?? {};
        this.cfg = {
            maxCycles:        cfg.maxCycles        ?? 5,
            restMs:           cfg.restMs           ?? 5000,
            workMs:           cfg.workMs           ?? 3000,
            startLoanUsdc:    cfg.startLoanUsdc    ?? 10,
            maxLoanUsdc:      cfg.maxLoanUsdc      ?? 500,
            loanDurationDays: cfg.loanDurationDays ?? 7,
        };

        this.reportsDir = opts.reportsDir
            ?? path.join(__dirname, 'reports');

        // Runtime state
        this.state      = STATE.BOOT;
        this.cycle      = 0;
        this.agentId    = null;
        this.activeLoan = null; // { loanId, amount, poolId }
        this.currentTier = null;
        this.stats      = { totalBorrowed: 0, totalRepaid: 0, cyclesCompleted: 0, tierPromotions: [] };
    }

    // ── Main loop ──────────────────────────────────────────────────────────────

    async run() {
        this._log('='.repeat(56));
        this._log('  Specular Autonomous Agent starting');
        this._log(`  Wallet:    ${this.wallet.address}`);
        this._log(`  API:       ${this.sdk.apiUrl}`);
        this._log(`  Max cycles: ${this.cfg.maxCycles}`);
        if (this.lenderAddress) this._log(`  Notifying: ${this.lenderAddress} via XMTP`);
        this._log('='.repeat(56));

        fs.mkdirSync(this.reportsDir, { recursive: true });

        // Initialise XMTP messenger (gracefully no-ops if package missing)
        this.messenger = await AgentMessenger.create(this.wallet, this.xmtpEnv);

        // Step 0: discover + register
        await this._boot();

        // Main cycle loop
        while (this.cycle < this.cfg.maxCycles) {
            this.cycle++;
            this._log(`\n${'─'.repeat(56)}`);
            this._log(`  CYCLE ${this.cycle} / ${this.cfg.maxCycles}`);
            this._log('─'.repeat(56));

            try {
                await this._runCycle();
                this.stats.cyclesCompleted++;
            } catch (err) {
                this._log(`[!] Cycle ${this.cycle} failed: ${err.message}`);
                this._log('    Waiting before retry...');
            }

            if (this.cycle < this.cfg.maxCycles) {
                this._log(`\n  Resting ${this.cfg.restMs / 1000}s before next cycle...`);
                await this._sleep(this.cfg.restMs);
            }
        }

        this._transition(STATE.DONE);
        this._printSummary();
    }

    async _boot() {
        this._transition(STATE.BOOT);

        // Discover protocol
        const manifest = await this.sdk.discover();
        this._log(`Protocol: Specular v${manifest.version} on ${manifest.network}`);

        // Check/register
        const profile = await this.sdk.getAgentProfile(this.wallet.address);
        if (!profile.registered) {
            this._log('\nNot registered — registering now...');
            const result = await this.sdk.register({ name: 'SpecularAutonomousAgent' });
            this._log(`  Registered! tx: ${result.txHash}`);
            // Re-fetch profile
            await this._sleep(3000);
            const updated = await this.sdk.getAgentProfile(this.wallet.address);
            this.agentId = updated.agentId;
            this._log(`  Agent ID: ${this.agentId}`);
        } else {
            this.agentId = profile.agentId;
            this._log(`Already registered as Agent #${this.agentId}`);
            this._log(`  Score: ${profile.reputation?.score} (${profile.reputation?.tier})`);
            this._log(`  Credit limit: ${profile.reputation?.creditLimitUsdc?.toLocaleString()} USDC`);
        }

        // Ensure pool exists (required before borrowing or receiving liquidity)
        try {
            const pool = await this.sdk.getPool(this.agentId);
            this._log(`  Pool exists: ${pool.totalLiquidityUsdc?.toLocaleString() ?? 0} USDC liquidity`);
        } catch (err) {
            if (err.message?.includes('not found') || err.message?.includes('404')) {
                this._log('\nCreating lending pool...');
                const result = await this.sdk.createPool();
                this._log(`  Pool created! tx: ${result.txHash}`);
                await this._sleep(2000);
            } else {
                throw err;
            }
        }

        // Snapshot starting tier
        const startProfile = await this.sdk.getAgentProfile(this.wallet.address);
        this.currentTier = startProfile.reputation?.tier ?? 'UNRATED';

        this._transition(STATE.IDLE);
    }

    async _runCycle() {
        // ── Phase 1: Assess ──────────────────────────────────────────────────
        this._transition(STATE.ASSESSING);
        const { profile, bestPool, loanAmount } = await this._assess();

        // ── Phase 2: Borrow ──────────────────────────────────────────────────
        this._transition(STATE.BORROWING);
        const loanId = await this._borrow(bestPool, loanAmount);

        // ── Phase 3: Work ────────────────────────────────────────────────────
        this._transition(STATE.WORKING);
        await this._doWork(loanId, loanAmount, profile);

        // ── Phase 4: Repay ───────────────────────────────────────────────────
        this._transition(STATE.REPAYING);
        await this._repay(loanId);

        this._transition(STATE.IDLE);
    }

    // ── Assessment phase ───────────────────────────────────────────────────────

    async _assess() {
        this._log('\n[ASSESS] Evaluating protocol state...');

        const profile = await this.sdk.getAgentProfile(this.wallet.address);

        const score       = profile.reputation?.score        ?? 0;
        const limitUsdc   = profile.reputation?.creditLimitUsdc ?? this.cfg.startLoanUsdc;
        const interestPct = profile.reputation?.interestRatePct ?? 15;

        this._log(`  Agent #${this.agentId} | score ${score} | limit ${limitUsdc.toLocaleString()} USDC | APR ${interestPct}%`);

        // Each agent borrows from their OWN pool — look it up by agentId
        let ownPool;
        try {
            ownPool = await this.sdk.getPool(this.agentId);
        } catch {
            throw new Error(
                `Agent #${this.agentId} has no lending pool. ` +
                'Another party must supply liquidity via POST /tx/supply-liquidity first, ' +
                'or use an agent wallet that already has a funded pool.'
            );
        }

        const available = ownPool.availableLiquidityUsdc ?? 0;
        if (available <= 0) {
            throw new Error(`Pool #${this.agentId} has no available liquidity (${available} USDC)`);
        }

        this._log(`  Own pool #${this.agentId}: ${available.toLocaleString()} USDC available (util ${ownPool.utilizationPct}%)`);

        // Tier-adaptive sizing: each tier unlock increases borrow capacity
        // UNRATED: base, HIGH_RISK: +50%, SUBPRIME: +100%, STANDARD: +200%, PRIME: +400%
        const tierMultiplier = {
            UNRATED:  1.0, HIGH_RISK: 1.5, SUBPRIME: 2.0, STANDARD: 3.0, PRIME: 5.0,
        }[this.currentTier] ?? 1.0;
        const scaled     = Math.round(this.cfg.startLoanUsdc * tierMultiplier);
        const loanAmount = Math.min(scaled, this.cfg.maxLoanUsdc, limitUsdc, available);
        if (tierMultiplier > 1.0) {
            this._log(`  Tier bonus (${this.currentTier} ×${tierMultiplier}): scaling loan to ${scaled} USDC`);
        }
        this._log(`  Loan decision: ${loanAmount} USDC for ${this.cfg.loanDurationDays} days`);

        return { profile, bestPool: ownPool, loanAmount };
    }

    // ── Borrow phase ───────────────────────────────────────────────────────────

    async _borrow(pool, amount) {
        this._log(`\n[BORROW] Requesting ${amount} USDC from pool #${pool.id}...`);

        const result = await this._withRetry(() => this.sdk.requestLoan({
            amount,
            durationDays: this.cfg.loanDurationDays,
            poolId:       pool.id,
        }), 'requestLoan');

        // Parse loanId from receipt logs (LoanRequested event)
        let loanId = null;
        if (result.receipt?.logs) {
            // LoanRequested(loanId, borrower, poolId, amount, dueDate)
            // loanId is typically the first topic (indexed) or a parse from the data
            for (const log of result.receipt.logs) {
                // Event signature: LoanRequested(uint256 indexed loanId, ...)
                if (log.topics?.length >= 2) {
                    const candidate = parseInt(log.topics[1], 16);
                    if (candidate > 0 && candidate < 100000) {
                        loanId = candidate;
                        break;
                    }
                }
            }
        }

        // Fallback: query latest loan for this agent via API
        if (!loanId) {
            loanId = await this._findLatestLoanId();
        }

        this.activeLoan = { loanId, amount, poolId: pool.id };
        this.stats.totalBorrowed += amount;

        this._log(`  Loan #${loanId} approved! tx: ${result.txHash}`);

        // Notify lender via XMTP
        if (this.lenderAddress) {
            await this.messenger.send(
                this.lenderAddress,
                AgentMessenger.msg.borrowed(loanId, amount, this.wallet.address),
            );
        }

        return loanId;
    }

    async _findLatestLoanId() {
        // Walk down from a high number to find the newest loan for this agent
        // The API exposes /loans/:id — we do a quick binary-style search
        // Simpler: try IDs from 200 downward until we find ours
        const myAddr = this.wallet.address.toLowerCase();
        for (let id = 200; id >= 1; id--) {
            try {
                const loan = await this.sdk.getLoan(id);
                if (loan.borrower?.toLowerCase() === myAddr &&
                    (loan.state === 'ACTIVE' || loan.state === 'APPROVED' || loan.stateLabel === 'ACTIVE')) {
                    return id;
                }
            } catch {
                // loan doesn't exist, continue
            }
        }
        throw new Error('Could not find active loan ID');
    }

    // ── Work phase ─────────────────────────────────────────────────────────────

    async _doWork(loanId, loanAmount, agentProfile) {
        this._log(`\n[WORK] Loan #${loanId} active — running market intelligence + credit due-diligence...`);

        // ── Step 1: Gather market data ─────────────────────────────────────────
        const [statusResp, poolsResp] = await Promise.all([
            this.sdk.getStatus(),
            this.sdk.getPools({ limit: 50 }),
        ]);

        const pools         = poolsResp.pools ?? [];
        const totalPools    = pools.length;
        const activePools   = pools.filter(p => p.availableLiquidityUsdc > 0).length;
        const totalLiquidity = pools.reduce((s, p) => s + (p.availableLiquidityUsdc ?? 0), 0);
        const avgUtilization = pools.reduce((s, p) => s + parseFloat(p.utilizationPct ?? 0), 0) / (totalPools || 1);
        const bestPool       = pools
            .filter(p => p.id !== this.agentId)
            .reduce((best, p) =>
                (p.availableLiquidityUsdc > (best?.availableLiquidityUsdc ?? 0)) ? p : best, null);

        this._log(`  Analyzed ${totalPools} pools | TVL: ${totalLiquidity.toLocaleString()} USDC`);
        this._log(`  Avg utilization: ${avgUtilization.toFixed(1)}% | Active pools: ${activePools}/${totalPools}`);

        // ── Step 2: x402 credit due-diligence on top peer pool ────────────────
        let creditDueDiligence = null;

        if (bestPool) {
            this._log(`\n  [x402] Paying 1 USDC for credit report on pool #${bestPool.id} owner...`);
            try {
                // Resolve the pool owner's address
                const poolDetail  = await this.sdk.getPool(bestPool.id);
                const peerAddress = poolDetail.agentAddress;

                if (peerAddress) {
                    const creditReport = await this.sdk.getCreditReport(peerAddress);

                    creditDueDiligence = {
                        assessedPool:    bestPool.id,
                        agentAddress:    peerAddress,
                        creditScore:     creditReport.creditScore,
                        tier:            creditReport.tier,
                        creditLimit:     creditReport.creditLimit,
                        interestRate:    creditReport.interestRate,
                        recommendation:  creditReport.recommendation,
                        autoApprove:     creditReport.loanTerms?.autoApproveEligible,
                        assessedAt:      creditReport.assessedAt,
                    };

                    this._log(`  [x402] Credit result: ${peerAddress.slice(0, 10)}... → score ${creditReport.creditScore} (${creditReport.tier})`);
                    this._log(`  [x402] ${creditReport.recommendation}`);
                    this._log(`  [x402] Total spent on credit checks: ${this.sdk.totalSpentUsdc.toFixed(6)} USDC`);
                }
            } catch (err) {
                this._log(`  [x402] Credit check failed: ${err.message.slice(0, 80)}`);
            }
        }

        // ── Step 3: Build and save report ─────────────────────────────────────
        const recommendation = this._buildRecommendation(agentProfile, pools);
        const report = {
            generatedAt:    new Date().toISOString(),
            agentId:        this.agentId,
            agentAddress:   this.wallet.address,
            cycle:          this.cycle,
            fundedByLoan:   `${loanAmount} USDC (loan #${loanId})`,
            protocol: {
                totalAgents: statusResp.agents?.total,
                totalLoans:  statusResp.loans?.total,
                tvlUsdc:     statusResp.liquidity?.tvlUsdc,
            },
            market: {
                totalPools,
                activePools,
                totalAvailableLiquidityUsdc: Math.round(totalLiquidity * 100) / 100,
                avgUtilizationPct:           Math.round(avgUtilization * 100) / 100,
                bestExternalPool: bestPool ? {
                    id:             bestPool.id,
                    availableUsdc:  bestPool.availableLiquidityUsdc,
                    utilizationPct: bestPool.utilizationPct,
                } : null,
            },
            agentReputation: {
                score:        agentProfile.reputation?.score,
                tier:         agentProfile.reputation?.tier,
                creditLimit:  agentProfile.reputation?.creditLimitUsdc,
                interestRate: agentProfile.reputation?.interestRatePct,
            },
            creditDueDiligence,            // x402-funded peer assessment
            costs: {
                x402SpendUsdc: parseFloat(this.sdk.totalSpentUsdc.toFixed(6)),
                fundedByLoanUsdc: loanAmount,
            },
            recommendation,
        };

        const filename = `report-cycle${this.cycle}-${Date.now()}.json`;
        fs.writeFileSync(path.join(this.reportsDir, filename), JSON.stringify(report, null, 2));

        this._log(`  Recommendation: ${recommendation}`);
        this._log(`  Report saved: ${filename}`);

        // Simulate remaining compute time
        this._log(`  Compute workload (${this.cfg.workMs / 1000}s)...`);
        await this._sleep(this.cfg.workMs);

        return report;
    }

    _buildRecommendation(profile, pools) {
        const score     = profile.reputation?.score ?? 0;
        const available = pools.filter(p => p.availableLiquidityUsdc > 100).length;
        // Tier thresholds: UNRATED < 200, HIGH_RISK 200-399, SUBPRIME 400-599,
        //                  STANDARD 600-799, PRIME 800+
        if (score < 200) {
            const n = Math.ceil((200 - score) / 10);
            return `${n} more on-time repayment${n !== 1 ? 's' : ''} to reach HIGH_RISK tier`;
        }
        if (score < 400) {
            const n = Math.ceil((400 - score) / 10);
            return `HIGH_RISK → ${n} repayment${n !== 1 ? 's' : ''} to SUBPRIME | ${available} pools available`;
        }
        if (score < 600) {
            const n = Math.ceil((600 - score) / 10);
            return `SUBPRIME → ${n} repayment${n !== 1 ? 's' : ''} to STANDARD tier`;
        }
        if (score < 800) {
            const n = Math.ceil((800 - score) / 10);
            return `STANDARD → ${n} repayment${n !== 1 ? 's' : ''} to PRIME tier`;
        }
        return `PRIME tier — eligible for up to ${profile.reputation?.creditLimitUsdc?.toLocaleString()} USDC`;
    }

    // ── Repay phase ────────────────────────────────────────────────────────────

    async _repay(loanId) {
        this._log(`\n[REPAY] Repaying loan #${loanId}...`);

        const result = await this._withRetry(() => this.sdk.repayLoan(loanId), 'repayLoan');
        this.stats.totalRepaid += this.activeLoan?.amount ?? 0;
        this.activeLoan = null;

        this._log(`  Repaid! tx: ${result.txHash}`);
        this._log(`  Block: ${result.blockNumber}`);

        // Notify lender via XMTP
        if (this.lenderAddress) {
            await this.messenger.send(
                this.lenderAddress,
                AgentMessenger.msg.repaid(loanId, this.activeLoan?.amount ?? 0, this.wallet.address),
            );
        }

        // Check updated reputation and detect tier promotion
        await this._sleep(2000);
        const profile  = await this.sdk.getAgentProfile(this.wallet.address);
        const score    = profile.reputation?.score ?? 0;
        const newTier  = profile.reputation?.tier ?? 'UNRATED';

        if (newTier !== this.currentTier) {
            await this._logPromotion(this.currentTier, newTier, profile);
            this.currentTier = newTier;
        } else {
            this._log(`  Reputation score: ${score} (${newTier})`);
        }
    }

    async _logPromotion(oldTier, newTier, profile) {
        const score = profile.reputation?.score ?? 0;
        this._log('');
        this._log('  ★'.repeat(28));
        this._log(`  TIER PROMOTION: ${oldTier} → ${newTier}`);
        this._log(`  New score:      ${score}`);
        this._log(`  Credit limit:   ${profile.reputation?.creditLimitUsdc?.toLocaleString()} USDC`);
        this._log(`  Interest rate:  ${profile.reputation?.interestRatePct}% APR`);
        this._log(`  Collateral req: ${profile.reputation?.collateralRequiredPct ?? '?'}%`);
        this._log('  ★'.repeat(28));
        this.stats.tierPromotions.push({
            cycle: this.cycle, from: oldTier, to: newTier, score,
        });

        // Notify lender of tier promotion via XMTP
        if (this.lenderAddress) {
            await this.messenger.send(
                this.lenderAddress,
                AgentMessenger.msg.promoted(oldTier, newTier, score, this.wallet.address),
            );
        }
    }

    // ── Helpers ────────────────────────────────────────────────────────────────

    _transition(newState) {
        this.state = newState;
        this._log(`\n→ [${newState}]`);
    }

    _printSummary() {
        this._log('\n' + '='.repeat(56));
        this._log('  Agent session complete');
        this._log('─'.repeat(56));
        this._log(`  Cycles completed:  ${this.stats.cyclesCompleted}`);
        this._log(`  Total borrowed:    ${this.stats.totalBorrowed.toFixed(2)} USDC`);
        this._log(`  Total repaid:      ${this.stats.totalRepaid.toFixed(2)} USDC`);
        this._log(`  x402 spend:        ${this.sdk.totalSpentUsdc.toFixed(6)} USDC (credit checks)`);
        this._log(`  XMTP messages:     ${this.messenger?.sentCount ?? 0} sent`);
        if (this.stats.tierPromotions.length > 0) {
            this.stats.tierPromotions.forEach(p =>
                this._log(`  Tier promotion:    ${p.from} → ${p.to} (cycle ${p.cycle}, score ${p.score})`));
        }
        this._log(`  Reports saved:     ${this.reportsDir}`);
        this._log('='.repeat(56));
    }

    async _withRetry(fn, label, maxAttempts = 4, baseDelayMs = 4000) {
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                return await fn();
            } catch (err) {
                const isTimeout = err.message?.includes('408') || err.message?.includes('timeout') || err.code === 'SERVER_ERROR';
                if (!isTimeout || attempt === maxAttempts) throw err;
                const delay = baseDelayMs * attempt;
                this._log(`  [retry] ${label} attempt ${attempt}/${maxAttempts} failed (timeout) — waiting ${delay / 1000}s...`);
                await this._sleep(delay);
            }
        }
    }

    _sleep(ms) {
        return new Promise(r => setTimeout(r, ms));
    }

    _log(msg) {
        const ts = new Date().toTimeString().slice(0, 8);
        console.log(`[${ts}] ${msg}`);
    }
}

module.exports = { AutonomousAgent, STATE };
