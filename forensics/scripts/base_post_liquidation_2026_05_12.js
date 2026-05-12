// Post-liquidation Base v4 experiment.
// Pool #1 now has avail=1.5, no active loans, but poolLenders[1] still has the
// §B1 duplicate (same address × 2). Tests:
//
//   1. Can secure wallet take a NEW small loan? (should succeed)
//   2. Does staticCall repay on the new loan still revert with Panic(0x11)?
//      → confirms §B1 is structural, not loan-specific
//   3. If yes, we now have a NEW stuck loan. Use immediate static-call
//      validation to AVOID broadcasting if repay would panic. Don't broadcast
//      the new loan unless we know repay works.
//
// Plan: just static-call requestLoan, no actual broadcast, to see if a loan
// CAN be created and what staticCall of repay-with-zero-elapsed would do.

require('dotenv').config();
const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

const BASE_RPC = process.env.BASE_RPC_URL || 'https://base.publicnode.com';
const ADDR = JSON.parse(fs.readFileSync('./src/config/base-addresses.json'));
const ABI = JSON.parse(fs.readFileSync('./artifacts/contracts/core/AgentLiquidityMarketplace.sol/AgentLiquidityMarketplace.json')).abi;
const USDC_ABI = ['function approve(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)'];
const fmt = v => Number(ethers.formatUnits(v, 6));
const OUT = './forensics/output/regression-2026-05-07';

(async () => {
    const provider = new ethers.JsonRpcProvider(BASE_RPC);
    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
    const mp = new ethers.Contract(ADDR.agentLiquidityMarketplace, ABI, wallet);
    const usdc = new ethers.Contract(ADDR.usdc, USDC_ABI, wallet);
    console.log('Wallet:', wallet.address);
    console.log('Base v4 marketplace:', ADDR.agentLiquidityMarketplace);

    // Confirm post-liquidation state
    const pool = await mp.getAgentPool(1);
    console.log('\n=== Pool 1 state ===');
    console.log(`  totalLiquidity: ${fmt(pool[1])}`);
    console.log(`  availableLiquidity: ${fmt(pool[2])}`);
    console.log(`  lenderCount: ${pool[6]} (still has §B1 duplicate)`);
    const lenders = [];
    for (let j = 0; j < Number(pool[6]); j++) {
        lenders.push((await mp.poolLenders(1, j)).toLowerCase());
    }
    console.log(`  poolLenders: ${JSON.stringify(lenders)}`);
    console.log(`  unique: ${new Set(lenders).size} (duplicate of ${lenders.length - new Set(lenders).size})`);

    // === Test 1: can we take a new loan? ===
    console.log('\n=== Test 1: static-call requestLoan(0.05 USDC, 7 days) ===');
    const LOAN = ethers.parseUnits('0.05', 6);
    try {
        await mp.requestLoan.staticCall(LOAN, 7);
        console.log('  ✅ requestLoan would succeed');
    } catch (e) {
        console.log('  ❌ requestLoan would revert:', (e.shortMessage || e.message).slice(0, 100));
        return;
    }

    // === Test 2: simulate the full lifecycle via staticCall (read-only) ===
    // We can't actually static-call "request then repay" because repay needs the
    // loan to exist. But we can reason about it:
    //   - The §B1 mechanism is: _distributeInterest iterates poolLenders[], reads
    //     positions[1][lender] which is the SAME slot for both duplicate entries.
    //   - That mechanism doesn't depend on which loanId is being repaid — it's
    //     entirely about the pool state.
    //   - Therefore: §B1 will still panic on any future repay-with-interest from
    //     pool 1 until the duplicate is removed.
    // We have evidence from earlier: loans #2/#3/#4 (with 0.1 USDC × 7d × 15%
    // = 0.0002875 USDC interest each) all panicked.
    // Confirm via a hypothetical: what would 0.05 USDC × 7d × 15% interest be?
    const expected_interest = (LOAN * 1500n * 7n * 86400n) / (365n * 86400n * 10000n);
    console.log(`  expected interest for hypothetical loan: ${fmt(expected_interest)} USDC = ${expected_interest} base units`);
    console.log(`  §B1 panic threshold: lenderInterest ≥ 1 base unit`);
    console.log(`  ${expected_interest >= 1n ? '⚠ would panic on repay (§B1 STILL ACTIVE)' : '✓ might not panic if interest rounds to 0'}`);

    // === Test 3: can the duplicate be removed via v4 admin? ===
    console.log('\n=== Test 3: v4 admin tools available ===');
    const v4Iface = new ethers.Interface(ABI);
    const v4Functions = ABI.filter(f => f.type === 'function').map(f => f.name);
    const adminFns = v4Functions.filter(n => /compact|reset|set|withdraw|pause|liquidate/.test(n));
    console.log(`  v4 admin functions: ${adminFns.join(', ')}`);
    console.log(`  → v4 has NO compactPoolLenders. The §B1 duplicate cannot be removed without contract replacement.`);
    console.log(`  → resetPoolAccounting only recomputes totalLoaned, doesn't touch poolLenders[]`);

    // === Conclusion ===
    console.log('\n=== CONCLUSION ===');
    console.log('Pool #1 on Base canonical is now operationally clean (no active loans)');
    console.log('but the §B1 duplicate poolLenders entries REMAIN.');
    console.log('Any new loan with non-trivial interest WILL still panic on repay.');
    console.log('Only V6 migration (or contract replacement) can clear the §B1 state.');
    console.log('Practical implication: pool #1 is unusable for borrowing until V6 migration.');

    fs.writeFileSync(path.join(OUT, '37-base-post-liquidation.json'), JSON.stringify({
        pool: { totalLiq: fmt(pool[1]), avail: fmt(pool[2]), lenderCount: Number(pool[6]) },
        poolLenders: lenders,
        duplicateCount: lenders.length - new Set(lenders).size,
        requestLoanStaticCall: 'would succeed',
        b1_still_active: expected_interest >= 1n,
        expected_interest_base_units: expected_interest.toString(),
        conclusion: 'Pool #1 borrowing is DoS-ed by §B1 until V6 migration. Liquidation cleared loans but not the structural duplicate.',
    }, null, 2));
    console.log('\nSaved.');
})().catch(e => { console.error('FATAL:', e); process.exit(2); });
