/**
 * Patient Rate-Limited Test for Arc Testnet
 *
 * Uses standalone ethers.js (no Hardhat) with a request queue to stay
 * well under Arc's rate limit (~1 req/sec). Runs 3 loan cycles across
 * 3 freshly-created agents.
 *
 * Usage:
 *   node scripts/patient-test-arc.js
 *
 * Approx run time: 2-3 hours (configurable via MAX_CYCLES / SLEEP_* constants)
 */

const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

// ─── Configuration ────────────────────────────────────────────────────────────

// Primary: dRPC (no daily quota issues)
// Fallback: rpc.testnet.arc.network (QuickNode-backed, has daily quota)
const ARC_RPC = process.env.ARC_TESTNET_RPC_URL || 'https://arc-testnet.drpc.org';
const CHAIN_ID = 5042002;

const DEPLOYER_KEY =
    process.env.PRIVATE_KEY ||
    '0x4fd4d9c9340c0dcd1f4845483e488afde4c69685f9ff5deec756fbfc1afb02ac';

const ADDRESSES_FILE = path.join(__dirname, '..', 'src', 'config', 'arc-testnet-addresses.json');
const RESULTS_FILE = path.join(__dirname, '..', 'patient-test-results.json');

// Inter-request delay enforced by the rate-limited provider (ms)
const REQUEST_DELAY_MS = 5000;
// Delay after sending a transaction before anything else
const POST_TX_DELAY_MS = 15000;
// Delay between major steps within one agent setup
const STEP_DELAY_MS = 20000;
// Delay between loan cycles
const LOAN_CYCLE_DELAY_MS = 60000;
// How many loan cycles to run per agent
const MAX_CYCLES = 3;
// Loan amount (USDC) per cycle
const LOAN_AMOUNT_USDC = 100;
// Loan duration in DAYS (contract minimum is 7)
const LOAN_DURATION_DAYS = 7;
// Number of agents to create
const AGENT_COUNT = 3;
// Gas funding per agent wallet. Each cycle ~4 txs × ~0.015 ETH = ~0.06 ETH
// Use 0.2 ETH to safely cover 3 cycles + setup overhead
const GAS_FUND_ETH = '0.2';
// USDC to mint per agent wallet
const USDC_MINT_AGENT = '5000';
// USDC to supply as pool liquidity (from deployer wallet)
const USDC_POOL_SUPPLY = '2000';

// ─── Rate-Limited Provider ────────────────────────────────────────────────────

class RateLimitedProvider extends ethers.JsonRpcProvider {
    constructor(url, network) {
        super(url, network);
        this._queue = [];
        this._processing = false;
        this._lastRequest = 0;
    }

    async send(method, params) {
        return new Promise((resolve, reject) => {
            this._queue.push({ method, params, resolve, reject });
            this._processQueue();
        });
    }

    async _processQueue() {
        if (this._processing) return;
        this._processing = true;

        while (this._queue.length > 0) {
            const item = this._queue.shift();
            const now = Date.now();
            const elapsed = now - this._lastRequest;

            if (elapsed < REQUEST_DELAY_MS) {
                await sleep(REQUEST_DELAY_MS - elapsed);
            }

            try {
                this._lastRequest = Date.now();
                const result = await super.send(item.method, item.params);
                item.resolve(result);
            } catch (err) {
                if (
                    err.message?.includes('Too Many Requests') ||
                    err.code === 429 ||
                    err.status === 429
                ) {
                    // Back-pressure: re-queue and wait longer
                    const backoff = REQUEST_DELAY_MS * 6; // 30s
                    log(`⚠️  Rate limited on ${item.method}, backing off ${backoff / 1000}s`);
                    await sleep(backoff);
                    this._queue.unshift(item); // back to front
                } else {
                    item.reject(err);
                }
            }
        }

        this._processing = false;
    }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

const START_TIME = Date.now();

function log(msg) {
    const elapsed = Math.floor((Date.now() - START_TIME) / 1000);
    const h = String(Math.floor(elapsed / 3600)).padStart(2, '0');
    const m = String(Math.floor((elapsed % 3600) / 60)).padStart(2, '0');
    const s = String(elapsed % 60).padStart(2, '0');
    const line = `[${h}:${m}:${s}] ${msg}`;
    console.log(line);
    return line;
}

async function withRetry(fn, label, maxAttempts = 5) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return await fn();
        } catch (err) {
            const tooMany =
                err.message?.includes('Too Many Requests') ||
                err.code === 429;
            if (tooMany && attempt < maxAttempts) {
                const wait = REQUEST_DELAY_MS * Math.pow(2, attempt); // exponential
                log(`   ↩  ${label}: rate-limited, retry ${attempt}/${maxAttempts} in ${Math.round(wait / 1000)}s`);
                await sleep(wait);
            } else if (attempt < maxAttempts) {
                log(`   ↩  ${label}: error (${err.message.substring(0, 80)}), retry ${attempt}/${maxAttempts}`);
                await sleep(REQUEST_DELAY_MS);
            } else {
                throw err;
            }
        }
    }
}

// ─── Contract ABIs (minimal) ──────────────────────────────────────────────────

const REGISTRY_ABI = [
    'function register(string agentURI, tuple(string key, bytes value)[] metadata) external returns (uint256)',
    'function addressToAgentId(address) external view returns (uint256)',
    'function totalAgents() external view returns (uint256)',
];

const REPUTATION_ABI = [
    'function initializeReputation() external',
    'function getReputationScore(address) external view returns (uint256)',
    'function calculateCollateralRequirement(address) external view returns (uint256)',
];

const MARKETPLACE_ABI = [
    'function createAgentPool() external',
    'function agentPools(uint256) external view returns (uint256, address, uint256, uint256, uint256, uint256, bool)',
    'function supplyLiquidity(uint256 agentId, uint256 amount) external',
    'function requestLoan(uint256 amount, uint256 durationDays) external returns (uint256)',
    'function repayLoan(uint256 loanId) external',
    'function loans(uint256) external view returns (uint256, address, uint256, uint256, uint256, uint256, uint256, uint256, uint256, uint8)',
    'function agentLoans(address, uint256) external view returns (uint256)',
    'function calculateInterest(uint256 amount, uint256 rate, uint256 duration) public pure returns (uint256)',
    // Correct 4-param event: loanId, agentId (both indexed), borrower (indexed), amount
    'event LoanRequested(uint256 indexed loanId, uint256 indexed agentId, address indexed borrower, uint256 amount)',
    'event LoanRepaid(uint256 indexed loanId, address indexed borrower, uint256 amount)',
];

// Precomputed keccak256 of "LoanRequested(uint256,uint256,address,uint256)"
// Used as raw-log fallback in case ABI parsing fails
const LOAN_REQUESTED_SIG = ethers.id('LoanRequested(uint256,uint256,address,uint256)');

const USDC_ABI = [
    'function mint(address to, uint256 amount) external',
    'function approve(address spender, uint256 amount) external returns (bool)',
    'function balanceOf(address owner) external view returns (uint256)',
];

// ─── Agent Setup ──────────────────────────────────────────────────────────────

async function setupAgent(provider, deployer, addresses, agentIndex) {
    log(`\n──────────────────────────────────────────`);
    log(`🤖 Setting up Agent ${agentIndex + 1}/${AGENT_COUNT}`);
    log(`──────────────────────────────────────────`);

    const agentWallet = ethers.Wallet.createRandom().connect(provider);
    log(`   Wallet: ${agentWallet.address}`);

    const registry = new ethers.Contract(addresses.agentRegistryV2, REGISTRY_ABI, deployer);
    const reputation = new ethers.Contract(addresses.reputationManagerV3, REPUTATION_ABI, deployer);
    const marketplace = new ethers.Contract(addresses.agentLiquidityMarketplace, MARKETPLACE_ABI, deployer);
    const usdc = new ethers.Contract(addresses.mockUSDC, USDC_ABI, deployer);

    // 1. Fund agent with ETH for gas
    log(`   💸 Funding with ${GAS_FUND_ETH} ETH for gas...`);
    await withRetry(async () => {
        const tx = await deployer.sendTransaction({
            to: agentWallet.address,
            value: ethers.parseEther(GAS_FUND_ETH),
        });
        log(`      tx: ${tx.hash}`);
        await tx.wait();
    }, 'fund-eth');
    await sleep(POST_TX_DELAY_MS);

    // 2. Mint USDC to agent
    log(`   💵 Minting ${USDC_MINT_AGENT} USDC...`);
    await withRetry(async () => {
        const tx = await usdc.mint(agentWallet.address, ethers.parseUnits(USDC_MINT_AGENT, 6));
        log(`      tx: ${tx.hash}`);
        await tx.wait();
    }, 'mint-usdc-agent');
    await sleep(POST_TX_DELAY_MS);

    // 3. Register agent
    log(`   📝 Registering agent...`);
    const agentRegistryAsAgent = new ethers.Contract(addresses.agentRegistryV2, REGISTRY_ABI, agentWallet);
    await withRetry(async () => {
        const tx = await agentRegistryAsAgent.register(
            `https://specular.ai/agents/patient-test-${agentIndex + 1}`,
            []
        );
        log(`      tx: ${tx.hash}`);
        await tx.wait();
    }, 'register');
    await sleep(STEP_DELAY_MS);

    // 4. Get agent ID
    const agentId = await withRetry(
        () => agentRegistryAsAgent.addressToAgentId(agentWallet.address),
        'get-agent-id'
    );
    log(`   ✅ Registered as Agent ID: ${agentId}`);
    await sleep(REQUEST_DELAY_MS);

    // 5. Initialize reputation
    log(`   ⭐ Initializing reputation...`);
    const repAsAgent = new ethers.Contract(addresses.reputationManagerV3, REPUTATION_ABI, agentWallet);
    await withRetry(async () => {
        const tx = await repAsAgent.initializeReputation();
        log(`      tx: ${tx.hash}`);
        await tx.wait();
    }, 'init-reputation');
    await sleep(STEP_DELAY_MS);

    const repScore = await withRetry(
        () => repAsAgent.getReputationScore(agentWallet.address),
        'get-rep-score'
    );
    log(`   ✅ Reputation initialized: ${repScore}`);
    await sleep(REQUEST_DELAY_MS);

    // 6. Create pool
    log(`   🏊 Creating liquidity pool...`);
    const marketAsAgent = new ethers.Contract(addresses.agentLiquidityMarketplace, MARKETPLACE_ABI, agentWallet);
    await withRetry(async () => {
        const tx = await marketAsAgent.createAgentPool();
        log(`      tx: ${tx.hash}`);
        await tx.wait();
    }, 'create-pool');
    await sleep(STEP_DELAY_MS);

    // 7. Deployer supplies liquidity to agent pool
    log(`   💧 Supplying ${USDC_POOL_SUPPLY} USDC to pool (from deployer)...`);
    const usdcAsDeployer = new ethers.Contract(addresses.mockUSDC, USDC_ABI, deployer);
    const marketAsDeployer = new ethers.Contract(addresses.agentLiquidityMarketplace, MARKETPLACE_ABI, deployer);

    // First mint supply to deployer (in case they need it)
    await withRetry(async () => {
        const tx = await usdcAsDeployer.mint(deployer.address, ethers.parseUnits('10000', 6));
        log(`      mint tx: ${tx.hash}`);
        await tx.wait();
    }, 'mint-usdc-deployer');
    await sleep(POST_TX_DELAY_MS);

    await withRetry(async () => {
        const tx = await usdcAsDeployer.approve(
            addresses.agentLiquidityMarketplace,
            ethers.parseUnits(USDC_POOL_SUPPLY, 6)
        );
        log(`      approve tx: ${tx.hash}`);
        await tx.wait();
    }, 'approve-liquidity');
    await sleep(POST_TX_DELAY_MS);

    await withRetry(async () => {
        const tx = await marketAsDeployer.supplyLiquidity(
            agentId,
            ethers.parseUnits(USDC_POOL_SUPPLY, 6)
        );
        log(`      supply tx: ${tx.hash}`);
        await tx.wait();
    }, 'supply-liquidity');
    await sleep(STEP_DELAY_MS);

    log(`   ✅ Agent ${agentId} fully set up with ${USDC_POOL_SUPPLY} USDC in pool`);

    return {
        wallet: agentWallet,
        privateKey: agentWallet.privateKey, // saved for loan recovery
        address: agentWallet.address,
        agentId: Number(agentId),
        reputation: Number(repScore),
        loansCompleted: 0,
        totalBorrowed: 0,
        totalRepaid: 0,
        errors: [],
    };
}

// ─── Loan Cycle ───────────────────────────────────────────────────────────────

async function runLoanCycle(provider, deployer, addresses, agentState, cycleNum) {
    const { wallet, agentId } = agentState;
    log(`\n  📋 Agent ${agentId} — Loan Cycle ${cycleNum}/${MAX_CYCLES}`);

    const marketAsAgent = new ethers.Contract(addresses.agentLiquidityMarketplace, MARKETPLACE_ABI, wallet);
    const usdcAsAgent = new ethers.Contract(addresses.mockUSDC, USDC_ABI, wallet);
    const repAsAgent = new ethers.Contract(addresses.reputationManagerV3, REPUTATION_ABI, wallet);

    // Check collateral requirement
    const collateralPct = await withRetry(
        () => repAsAgent.calculateCollateralRequirement(wallet.address),
        'collateral-check'
    );
    await sleep(REQUEST_DELAY_MS);

    const loanAmt = ethers.parseUnits(LOAN_AMOUNT_USDC.toString(), 6);
    const collateralAmt = (loanAmt * BigInt(collateralPct)) / 100n;
    log(`     Collateral: ${collateralPct}% = ${ethers.formatUnits(collateralAmt, 6)} USDC`);

    // Approve collateral if needed
    if (collateralAmt > 0n) {
        log(`     Approving collateral...`);
        await withRetry(async () => {
            const tx = await usdcAsAgent.approve(addresses.agentLiquidityMarketplace, collateralAmt);
            log(`       approve tx: ${tx.hash}`);
            await tx.wait();
        }, 'approve-collateral');
        await sleep(POST_TX_DELAY_MS);
    }

    // Request loan (duration in DAYS)
    log(`     Requesting ${LOAN_AMOUNT_USDC} USDC loan (${LOAN_DURATION_DAYS} days)...`);
    let loanId;
    await withRetry(async () => {
        const tx = await marketAsAgent.requestLoan(loanAmt, LOAN_DURATION_DAYS);
        log(`       request tx: ${tx.hash}`);
        const receipt = await tx.wait();

        // Parse LoanRequested event — try ABI first, fall back to raw topics
        const iface = marketAsAgent.interface;
        for (const logEntry of receipt.logs) {
            // Raw fallback: topic[0] = event sig, topic[1] = loanId (first indexed)
            if (logEntry.topics[0] === LOAN_REQUESTED_SIG && logEntry.topics.length >= 2) {
                loanId = Number(BigInt(logEntry.topics[1]));
                break;
            }
            try {
                const parsed = iface.parseLog(logEntry);
                if (parsed?.name === 'LoanRequested') {
                    loanId = Number(parsed.args.loanId);
                    break;
                }
            } catch (_) {}
        }
    }, 'request-loan');
    await sleep(STEP_DELAY_MS);

    if (!loanId) {
        log(`     ⚠️  Could not parse loan ID from event, skipping repay`);
        agentState.errors.push(`cycle ${cycleNum}: loan ID not found`);
        return;
    }

    log(`     ✅ Loan ID: ${loanId} approved`);
    agentState.totalBorrowed += LOAN_AMOUNT_USDC;

    // Fetch loan details to calculate repayment
    log(`     Fetching loan details...`);
    const loanData = await withRetry(
        () => marketAsAgent.loans(loanId),
        'get-loan'
    );
    await sleep(REQUEST_DELAY_MS);

    // loanData: [loanId, borrower, agentId, amount, collateral, interestRate, startTime, endTime, duration, state]
    const principal = loanData[3];
    const rate = loanData[5];
    const duration = loanData[8]; // duration in seconds (set by contract)

    const interest = await withRetry(
        () => marketAsAgent.calculateInterest(principal, rate, duration),
        'calc-interest'
    );
    await sleep(REQUEST_DELAY_MS);

    const totalRepay = principal + interest + collateralAmt;
    log(`     Repayment: ${ethers.formatUnits(principal, 6)} + ${ethers.formatUnits(interest, 6)} interest = ${ethers.formatUnits(principal + interest, 6)} USDC`);

    // Approve repayment amount
    log(`     Approving repayment...`);
    await withRetry(async () => {
        const tx = await usdcAsAgent.approve(addresses.agentLiquidityMarketplace, totalRepay);
        log(`       approve tx: ${tx.hash}`);
        await tx.wait();
    }, 'approve-repay');
    await sleep(POST_TX_DELAY_MS);

    // Repay loan
    log(`     Repaying loan #${loanId}...`);
    await withRetry(async () => {
        const tx = await marketAsAgent.repayLoan(loanId);
        log(`       repay tx: ${tx.hash}`);
        await tx.wait();
    }, 'repay-loan');
    await sleep(STEP_DELAY_MS);

    agentState.totalRepaid += LOAN_AMOUNT_USDC + Number(ethers.formatUnits(interest, 6));
    agentState.loansCompleted++;

    // Update reputation
    const newRep = await withRetry(
        () => repAsAgent.getReputationScore(wallet.address),
        'get-rep-score'
    );
    await sleep(REQUEST_DELAY_MS);

    agentState.reputation = Number(newRep);
    log(`     ✅ Cycle ${cycleNum} done! Reputation: ${agentState.reputation} (+${agentState.reputation - 100 + (cycleNum - 1) * 10})`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
    console.log('\n════════════════════════════════════════════');
    console.log('  SPECULAR PROTOCOL — PATIENT ARC TEST');
    console.log('════════════════════════════════════════════');
    console.log(`Start: ${new Date().toISOString()}`);
    console.log(`Agents: ${AGENT_COUNT}  |  Cycles per agent: ${MAX_CYCLES}`);
    console.log(`Request delay: ${REQUEST_DELAY_MS / 1000}s  |  Post-tx delay: ${POST_TX_DELAY_MS / 1000}s`);
    console.log('════════════════════════════════════════════\n');

    const addresses = JSON.parse(fs.readFileSync(ADDRESSES_FILE, 'utf8'));
    log(`Contracts loaded from ${ADDRESSES_FILE}`);

    // Create rate-limited provider
    const provider = new RateLimitedProvider(ARC_RPC, { chainId: CHAIN_ID, name: 'arcTestnet' });
    const deployer = new ethers.Wallet(DEPLOYER_KEY, provider);

    // Check deployer balance
    const ethBal = await withRetry(() => provider.getBalance(deployer.address), 'deployer-balance');
    log(`Deployer: ${deployer.address}`);
    log(`Deployer ETH: ${ethers.formatEther(ethBal)}`);
    await sleep(REQUEST_DELAY_MS);

    const usdcCheck = new ethers.Contract(addresses.mockUSDC, USDC_ABI, deployer);
    const usdcBal = await withRetry(() => usdcCheck.balanceOf(deployer.address), 'deployer-usdc');
    log(`Deployer USDC: ${ethers.formatUnits(usdcBal, 6)}`);
    await sleep(REQUEST_DELAY_MS);

    const results = {
        startTime: new Date().toISOString(),
        network: 'Arc Testnet',
        agents: [],
        summary: {},
    };

    // ── Phase 1: Setup all agents ─────────────────────────────────────────────
    log('\n╔══════════════════════════════════════════╗');
    log('║  PHASE 1: Setting up agents              ║');
    log('╚══════════════════════════════════════════╝');

    const agentStates = [];
    for (let i = 0; i < AGENT_COUNT; i++) {
        try {
            const state = await setupAgent(provider, deployer, addresses, i);
            agentStates.push(state);
            results.agents.push(state);
            log(`\n   [Agent ${i + 1} setup complete — ID ${state.agentId}]`);
        } catch (err) {
            log(`\n❌ Failed to setup agent ${i + 1}: ${err.message}`);
            results.agents.push({ error: err.message, agentIndex: i + 1 });
        }

        // Wait between agent setups to spread RPC load
        if (i < AGENT_COUNT - 1) {
            log(`\n⏳ Waiting ${STEP_DELAY_MS / 1000}s before next agent setup...`);
            await sleep(STEP_DELAY_MS);
        }
    }

    log(`\n✅ Phase 1 complete — ${agentStates.length} agents created`);

    // Save intermediate results
    fs.writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2));

    // ── Phase 2: Run loan cycles ──────────────────────────────────────────────
    log('\n╔══════════════════════════════════════════╗');
    log('║  PHASE 2: Running loan cycles            ║');
    log('╚══════════════════════════════════════════╝');

    for (let cycle = 1; cycle <= MAX_CYCLES; cycle++) {
        log(`\n━━━ CYCLE ${cycle}/${MAX_CYCLES} ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
        for (let i = 0; i < agentStates.length; i++) {
            const state = agentStates[i];
            if (!state.wallet) continue; // skip failed setups

            try {
                await runLoanCycle(provider, deployer, addresses, state, cycle);
            } catch (err) {
                log(`❌ Agent ${state.agentId} cycle ${cycle} failed: ${err.message}`);
                state.errors.push(`cycle ${cycle}: ${err.message.substring(0, 120)}`);
            }

            // Pause between agents in same cycle
            if (i < agentStates.length - 1) {
                log(`\n⏳ Waiting ${LOAN_CYCLE_DELAY_MS / 1000}s before next agent...`);
                await sleep(LOAN_CYCLE_DELAY_MS);
            }
        }

        // Pause between cycles
        if (cycle < MAX_CYCLES) {
            log(`\n⏳ Waiting ${LOAN_CYCLE_DELAY_MS / 1000}s before next cycle...`);
            await sleep(LOAN_CYCLE_DELAY_MS);
        }

        // Save progress after each cycle (exclude non-serialisable wallet object)
        results.agents = agentStates.map(({ wallet, ...rest }) => rest);
        fs.writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2));
        log(`💾 Progress saved to ${RESULTS_FILE}`);
    }

    // ── Final report ──────────────────────────────────────────────────────────
    const elapsed = Math.floor((Date.now() - START_TIME) / 1000);
    results.endTime = new Date().toISOString();
    results.elapsedSeconds = elapsed;
    results.summary = {
        agentsCreated: agentStates.length,
        totalLoansCompleted: agentStates.reduce((s, a) => s + (a.loansCompleted || 0), 0),
        totalErrors: agentStates.reduce((s, a) => s + (a.errors?.length || 0), 0),
        agentDetails: agentStates.map(a => ({
            agentId: a.agentId,
            finalReputation: a.reputation,
            loansCompleted: a.loansCompleted,
            totalBorrowed: a.totalBorrowed,
            totalRepaid: a.totalRepaid,
            errors: a.errors,
        })),
    };

    // Strip non-serializable fields (wallet object, keep privateKey string)
    results.agents = agentStates.map(({ wallet, ...rest }) => rest);
    fs.writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2));

    console.log('\n════════════════════════════════════════════');
    console.log('  TEST COMPLETE');
    console.log('════════════════════════════════════════════');
    console.log(`Elapsed:          ${Math.floor(elapsed / 60)}m ${elapsed % 60}s`);
    console.log(`Agents created:   ${results.summary.agentsCreated}`);
    console.log(`Loans completed:  ${results.summary.totalLoansCompleted}`);
    console.log(`Errors:           ${results.summary.totalErrors}`);
    console.log(`\nResults saved to: ${RESULTS_FILE}`);
    console.log('════════════════════════════════════════════\n');
}

main().catch(err => {
    console.error('\n💥 Fatal error:', err);
    process.exit(1);
});
