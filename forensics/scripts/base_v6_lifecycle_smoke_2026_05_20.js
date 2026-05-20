// Base V6 first real-money lifecycle smoke. Secure wallet (also agent 1)
// takes a 0.1 USDC loan, repays, verifies state.

require('dotenv').config();
const { ethers } = require('ethers');
const fs = require('fs');
const ADDR = JSON.parse(fs.readFileSync('./src/config/base-addresses.json'));
const V6 = ADDR.agentLiquidityMarketplace;
const ABI = JSON.parse(fs.readFileSync('./artifacts/contracts/core/AgentLiquidityMarketplaceV6.sol/AgentLiquidityMarketplaceV6.json')).abi;
const USDC_ABI = ['function approve(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)'];
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function rT(fn, n=10) { for (let i=0;i<n;i++){try{return await fn();}catch(e){if(i===n-1)throw e; await sleep(3000*(i+1));}} }

(async () => {
    const provider = new ethers.JsonRpcProvider(process.env.BASE_RPC_URL || 'https://mainnet.base.org', undefined, { batchMaxCount: 1 });
    const owner = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
    const v6 = new ethers.Contract(V6, ABI, owner);
    const usdc = new ethers.Contract(ADDR.usdc, USDC_ABI, owner);

    console.log('=== BASE V6 FIRST REAL LIFECYCLE SMOKE ===');
    console.log('V6:', V6);
    console.log('Borrower (also agent 1):', owner.address);

    const ethBal = await rT(() => provider.getBalance(owner.address));
    const usdcBal = await rT(() => usdc.balanceOf(owner.address));
    console.log('Pre: ETH=' + ethers.formatEther(ethBal) + ', USDC=' + ethers.formatUnits(usdcBal, 6));
    await sleep(3000);

    const allowance = await rT(() => usdc.allowance(owner.address, V6));
    console.log('USDC allowance to V6:', ethers.formatUnits(allowance, 6));
    if (allowance < ethers.parseUnits('1', 6)) {
        console.log('  ⚠ approving V6 for MaxUint256');
        await rT(() => usdc.approve(V6, ethers.MaxUint256).then(t => t.wait()));
    }
    await sleep(3000);

    // Check pool state
    const pool = await rT(() => v6.getAgentPool(1));
    console.log('\nV6 Pool 1 state:');
    console.log('  totalLiquidity: ' + ethers.formatUnits(pool[1], 6));
    console.log('  availableLiquidity: ' + ethers.formatUnits(pool[2], 6));
    console.log('  totalLoaned: ' + ethers.formatUnits(pool[3], 6));
    console.log('  lenderCount: ' + pool[6].toString());
    await sleep(3000);

    // Request a 0.1 USDC loan
    console.log('\n[1] requestLoan(0.1 USDC, 7 days)');
    const loanAmt = ethers.parseUnits('0.1', 6);
    const t1 = await rT(() => v6.requestLoan(loanAmt, 7));
    console.log('  tx:', t1.hash);
    const r1 = await rT(() => t1.wait());
    let loanId;
    for (const log of r1.logs) {
        try { const p = v6.interface.parseLog(log); if (p && p.name === 'LoanRequested') loanId = p.args.loanId; } catch(e) {}
    }
    console.log('  ✓ loanId:', loanId.toString(), 'gas:', r1.gasUsed.toString());
    await sleep(5000);

    const loan = await rT(() => v6.loans(loanId));
    console.log('  loan state:', ['REQUESTED','ACTIVE','REPAID','DEFAULTED'][Number(loan.state)]);
    console.log('  loan amount:', ethers.formatUnits(loan.amount, 6));
    console.log('  loan collateral:', ethers.formatUnits(loan.collateralAmount, 6));
    console.log('  loan interest rate (bps):', loan.interestRate.toString());
    await sleep(3000);

    // Verify pool state shift
    const poolMid = await rT(() => v6.getAgentPool(1));
    console.log('\nMid-state V6 Pool 1:');
    console.log('  availableLiquidity: ' + ethers.formatUnits(poolMid[2], 6));
    console.log('  totalLoaned: ' + ethers.formatUnits(poolMid[3], 6));
    await sleep(3000);

    // Repay the loan
    console.log('\n[2] repayLoan(' + loanId + ')');
    const t2 = await rT(() => v6.repayLoan(loanId));
    console.log('  tx:', t2.hash);
    const r2 = await rT(() => t2.wait());
    console.log('  ✓ repaid, gas:', r2.gasUsed.toString());
    await sleep(5000);

    const loanFinal = await rT(() => v6.loans(loanId));
    console.log('  loan state final:', ['REQUESTED','ACTIVE','REPAID','DEFAULTED'][Number(loanFinal.state)]);
    await sleep(3000);

    const poolFinal = await rT(() => v6.getAgentPool(1));
    console.log('\nPost-repay V6 Pool 1:');
    console.log('  totalLiquidity: ' + ethers.formatUnits(poolFinal[1], 6));
    console.log('  availableLiquidity: ' + ethers.formatUnits(poolFinal[2], 6));
    console.log('  totalLoaned: ' + ethers.formatUnits(poolFinal[3], 6));
    console.log('  totalEarned: ' + ethers.formatUnits(poolFinal[4], 6));
    await sleep(3000);

    // Position check (we are the lender + borrower)
    const myPos = await rT(() => v6.positions(1, owner.address));
    console.log('\nSecure wallet position on pool 1:');
    console.log('  amount: ' + ethers.formatUnits(myPos.amount, 6));
    console.log('  earnedInterest: ' + ethers.formatUnits(myPos.earnedInterest, 6));

    const endEth = await provider.getBalance(owner.address);
    const endUsdc = await usdc.balanceOf(owner.address);
    console.log('\nFinal: ETH=' + ethers.formatEther(endEth) + ' (Δ ' + ethers.formatEther(endEth - ethBal) + '), USDC=' + ethers.formatUnits(endUsdc, 6) + ' (Δ ' + ethers.formatUnits(endUsdc - usdcBal, 6) + ')');

    console.log('\n✅ Base V6 first real loan lifecycle complete');
    fs.writeFileSync('./forensics/output/regression-2026-05-07/91-base-lifecycle.json', JSON.stringify({
        timestamp: new Date().toISOString(), v6: V6, loanId: loanId.toString(),
        requestTx: t1.hash, repayTx: t2.hash,
        finalPoolState: { totalLiquidity: poolFinal[1].toString(), availableLiquidity: poolFinal[2].toString(), totalLoaned: poolFinal[3].toString(), totalEarned: poolFinal[4].toString() },
        finalPosition: { amount: myPos.amount.toString(), earnedInterest: myPos.earnedInterest.toString() }
    }, null, 2));
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
