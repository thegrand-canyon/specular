// Base v4 deep state dump — comprehensive read of agent #1 pool + all loans.
// Doesn't require Basescan API or extensive event scanning.
// Produces a self-contained document of the §B1 state for the audit package.

require('dotenv').config();
const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

const BASE_RPC = process.env.BASE_RPC_URL || 'https://base.publicnode.com';
const ADDR = JSON.parse(fs.readFileSync('./src/config/base-addresses.json'));
const ABI = JSON.parse(fs.readFileSync('./artifacts/contracts/core/AgentLiquidityMarketplace.sol/AgentLiquidityMarketplace.json')).abi;
const REG_ABI = JSON.parse(fs.readFileSync('./artifacts/contracts/core/AgentRegistryV2.sol/AgentRegistryV2.json')).abi;
const RM_ABI = JSON.parse(fs.readFileSync('./artifacts/contracts/core/ReputationManagerV3.sol/ReputationManagerV3.json')).abi;
const fmt = v => Number(ethers.formatUnits(v, 6));
const OUT = './forensics/output/regression-2026-05-07';

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function withRetry(fn, label, attempts = 5) {
    for (let i = 0; i < attempts; i++) {
        try { return await fn(); }
        catch (e) {
            if (i === attempts - 1) throw e;
            await sleep(2000 * Math.pow(2, i));
        }
    }
}

(async () => {
    const provider = new ethers.JsonRpcProvider(BASE_RPC);
    const mp = new ethers.Contract(ADDR.agentLiquidityMarketplace, ABI, provider);
    const reg = new ethers.Contract(ADDR.agentRegistryV2, REG_ABI, provider);
    const rm = new ethers.Contract(ADDR.reputationManagerV3, RM_ABI, provider);
    const usdc = new ethers.Contract(ADDR.usdc, ['function balanceOf(address) view returns (uint256)'], provider);

    const out = { capturedAt: new Date().toISOString(), network: 'Base mainnet', marketplace: ADDR.agentLiquidityMarketplace };

    // === Marketplace state ===
    out.marketplace_state = {
        owner: await withRetry(() => mp.owner(), 'owner'),
        paused: await withRetry(() => mp.paused(), 'paused'),
        nextLoanId: (await withRetry(() => mp.nextLoanId(), 'nLid')).toString(),
        totalPools: Number(await withRetry(() => mp.totalPools(), 'tp')),
        accumulatedFees: fmt(await withRetry(() => mp.accumulatedFees(), 'af')),
        platformFeeRate: Number(await withRetry(() => mp.platformFeeRate(), 'fr')),
        MAX_LENDERS_PER_POOL: Number(await withRetry(() => mp.MAX_LENDERS_PER_POOL(), 'maxL')),
        MAX_ACTIVE_LOANS_PER_AGENT: Number(await withRetry(() => mp.MAX_ACTIVE_LOANS_PER_AGENT(), 'maxA')),
        usdc_balance: fmt(await withRetry(() => usdc.balanceOf(ADDR.agentLiquidityMarketplace), 'mpBal')),
    };

    // === Registry state ===
    out.registry_state = {
        totalAgents: Number(await withRetry(() => reg.totalAgents(), 'ta')),
    };

    // === Pool #1 deep dump ===
    const pool = await withRetry(() => mp.getAgentPool(1), 'pool1');
    out.pool_1 = {
        agentAddress: pool.agentAddress,
        totalLiquidity: fmt(pool.totalLiquidity),
        availableLiquidity: fmt(pool.availableLiquidity),
        totalLoaned: fmt(pool.totalLoaned),
        totalEarned: fmt(pool.totalEarned),
        utilizationRate: Number(pool.utilizationRate),
        lenderCount: Number(pool.lenderCount),
        lenders: [],
    };
    for (let j = 0; j < Number(pool.lenderCount); j++) {
        const lender = await withRetry(() => mp.poolLenders(1, j), `pl${j}`);
        const pos = await withRetry(() => mp.positions(1, lender), `pos${j}`);
        out.pool_1.lenders.push({
            slot: j, address: lender,
            supplied: fmt(pos.amount), earnedInterest: fmt(pos.earnedInterest),
            depositTimestamp: pos.depositTimestamp.toString(),
            depositDate: new Date(Number(pos.depositTimestamp) * 1000).toISOString(),
        });
    }
    out.pool_1.unique_lenders = new Set(out.pool_1.lenders.map(l => l.address.toLowerCase())).size;
    out.pool_1.duplicate_count = out.pool_1.lenders.length - out.pool_1.unique_lenders;

    // === All loans ===
    out.loans = [];
    const stateNames = ['REQUESTED', 'ACTIVE', 'REPAID', 'DEFAULTED'];
    const next = Number(await withRetry(() => mp.nextLoanId(), 'nlid'));
    for (let i = 1; i < next; i++) {
        const l = await withRetry(() => mp.loans(i), `l${i}`);
        const stateName = stateNames[Number(l.state)] || `unknown(${l.state})`;
        let panic = null;
        try {
            await mp.repayLoan.staticCall(i, { from: l.borrower });
            panic = 'would_succeed';
        } catch (e) {
            const data = e.data || e.info?.error?.data || '';
            panic = data.startsWith('0x4e487b71') && data.endsWith('11') ? 'Panic(0x11)_§B1' :
                ((e.shortMessage || e.message).slice(0, 80));
        }
        out.loans.push({
            id: i, state: stateName, agentId: l.agentId.toString(),
            borrower: l.borrower, amount: fmt(l.amount), collateralAmount: fmt(l.collateralAmount),
            interestRate_bps: Number(l.interestRate),
            startTime: new Date(Number(l.startTime) * 1000).toISOString(),
            endTime: new Date(Number(l.endTime) * 1000).toISOString(),
            duration_days: Number(l.duration) / 86400,
            staticCall_repayLoan: panic,
        });
    }

    // === Reputation of agent #1's owner ===
    const a1 = await withRetry(() => reg.agents(1), 'a1');
    out.agent_1 = {
        owner: a1.owner, agentWallet: a1.agentWallet, agentURI: a1.agentURI,
        reputationScore: Number(await withRetry(() => rm['getReputationScore(address)'](a1.agentWallet), 'rep')),
        creditLimit: fmt(await withRetry(() => rm.calculateCreditLimit(a1.agentWallet), 'cred')),
        interestRate_bps: Number(await withRetry(() => rm.calculateInterestRate(a1.agentWallet), 'irate')),
        collateralRequirement_pct: Number(await withRetry(() => rm.calculateCollateralRequirement(a1.agentWallet), 'creq')),
    };

    // === §B1 deduction from contract logic + state ===
    out.b1_analysis = {
        finding: `pool #1 has ${out.pool_1.lenders.length} entries in poolLenders[] but only ${out.pool_1.unique_lenders} unique address(es)`,
        duplicate_address: out.pool_1.lenders[0]?.address,
        mechanism_per_contract_logic: [
            "1. Lender supplied to pool #1 → pushed to poolLenders[] (entry 0)",
            "2. Lender called withdrawLiquidity for FULL position → position.amount = 0, but poolLenders[0] NOT removed (this is the v4 bug)",
            "3. Lender supplied AGAIN → since position.amount == 0, push fired again (entry 1)",
            "Result: poolLenders[] = [lender, lender], position.amount = newSupply",
            "Subsequent repayLoan with non-zero interest panics in _distributeInterest:",
            "  share[iter1] = pos.amount * interest / totalLiquidity",
            "  share[iter2] = pos.amount * interest / totalLiquidity (same mapping read)",
            "  distributed = 2 × share > interest",
            "  dust = interest - distributed → underflow → Panic(0x11)",
        ],
        loans_blocked_by_b1: out.loans.filter(l => l.staticCall_repayLoan === 'Panic(0x11)_§B1').map(l => l.id),
    };

    // === §S1 baseline check on Base ===
    const slack = out.pool_1.totalLiquidity - out.pool_1.availableLiquidity - out.pool_1.totalLoaned;
    out.s1_check = {
        totalLiquidity: out.pool_1.totalLiquidity,
        availableLiquidity: out.pool_1.availableLiquidity,
        totalLoaned: out.pool_1.totalLoaned,
        derived_avail: out.pool_1.totalLiquidity - out.pool_1.totalLoaned,
        accounting_slack: slack,
        mp_balance: out.marketplace_state.usdc_balance,
        solvency_check: out.marketplace_state.usdc_balance >= out.pool_1.availableLiquidity,
    };

    // === Output ===
    console.log(JSON.stringify(out, null, 2));
    fs.writeFileSync(path.join(OUT, '27-base-v4-state-dump.json'), JSON.stringify(out, null, 2));
    console.log('\nSaved to', path.join(OUT, '27-base-v4-state-dump.json'));
})().catch(e => { console.error('FATAL:', e); process.exit(2); });
