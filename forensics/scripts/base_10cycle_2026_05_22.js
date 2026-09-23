// Base V6 10-cycle production stress. Each cycle: requestLoan(0.05 USDC) + repayLoan.
// Total volume: 0.5 USDC across 20 tx. Real mainnet evidence.

require('dotenv').config();
const { ethers } = require('ethers');
const fs = require('fs');
const ADDR = JSON.parse(fs.readFileSync('./src/config/base-addresses.json'));
const V6 = ADDR.agentLiquidityMarketplace;
const ABI = JSON.parse(fs.readFileSync('./artifacts/contracts/core/AgentLiquidityMarketplaceV6.sol/AgentLiquidityMarketplaceV6.json')).abi;
const USDC_ABI = ['function balanceOf(address) view returns (uint256)'];
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function rT(fn, n=10) { for (let i=0;i<n;i++){try{return await fn();}catch(e){if(i===n-1)throw e; await sleep(3000*(i+1));}} }

(async () => {
    const provider = new ethers.JsonRpcProvider(process.env.BASE_RPC_URL || 'https://mainnet.base.org', undefined, { batchMaxCount: 1 });
    const owner = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
    const v6 = new ethers.Contract(V6, ABI, owner);
    const usdc = new ethers.Contract(ADDR.usdc, USDC_ABI, provider);

    console.log('=== BASE V6 10-CYCLE PRODUCTION STRESS ===');
    const startEth = await rT(() => provider.getBalance(owner.address));
    const startUsdc = await rT(() => usdc.balanceOf(owner.address));
    console.log('Pre: ETH=' + ethers.formatEther(startEth) + ', USDC=' + ethers.formatUnits(startUsdc, 6));
    await sleep(3000);

    const loanAmt = ethers.parseUnits('0.05', 6);
    const gasUsed = [];
    let completed = 0;
    let firstLoanId, lastLoanId;
    for (let i = 0; i < 10; i++) {
        try {
            await sleep(3000);
            const t1 = await rT(() => v6.requestLoan(loanAmt, 7));
            const r1 = await rT(() => t1.wait());
            let loanId;
            for (const log of r1.logs) {
                try { const p = v6.interface.parseLog(log); if (p && p.name === 'LoanRequested') loanId = p.args.loanId; } catch(e) {}
            }
            if (i === 0) firstLoanId = loanId;
            lastLoanId = loanId;
            gasUsed.push({ phase: 'request', cycle: i+1, gas: Number(r1.gasUsed) });
            await sleep(3000);
            const t2 = await rT(() => v6.repayLoan(loanId));
            const r2 = await rT(() => t2.wait());
            gasUsed.push({ phase: 'repay', cycle: i+1, gas: Number(r2.gasUsed) });
            completed++;
            console.log(`  cycle ${i+1}/10: loanId=${loanId}, req=${r1.gasUsed} gas, repay=${r2.gasUsed} gas ✓`);
        } catch (e) {
            console.log(`  cycle ${i+1}/10: ✗ ${(e.shortMessage || e.message).slice(0, 80)}`);
            break;
        }
    }

    const endEth = await rT(() => provider.getBalance(owner.address));
    const endUsdc = await rT(() => usdc.balanceOf(owner.address));

    const reqGas = gasUsed.filter(g => g.phase === 'request');
    const repayGas = gasUsed.filter(g => g.phase === 'repay');
    const avgReq = reqGas.length ? reqGas.reduce((a,b) => a + b.gas, 0) / reqGas.length : 0;
    const avgRepay = repayGas.length ? repayGas.reduce((a,b) => a + b.gas, 0) / repayGas.length : 0;

    console.log('\n=== RESULTS ===');
    console.log(`Completed: ${completed}/10`);
    console.log(`First loanId: ${firstLoanId}, Last: ${lastLoanId}`);
    console.log(`Avg request gas: ${avgReq.toFixed(0)}`);
    console.log(`Avg repay gas:   ${avgRepay.toFixed(0)}`);
    console.log(`Δ ETH: ${ethers.formatEther(endEth - startEth)}`);
    console.log(`Δ USDC: ${ethers.formatUnits(endUsdc - startUsdc, 6)}`);

    // Pool state final
    const pool = await rT(() => v6.getAgentPool(1));
    console.log(`\nFinal pool 1: totalLiq=${ethers.formatUnits(pool[1], 6)}, avail=${ethers.formatUnits(pool[2], 6)}, totalEarned=${ethers.formatUnits(pool[4], 6)}`);

    fs.writeFileSync('./forensics/output/regression-2026-05-07/92-base-10cycle.json', JSON.stringify({
        timestamp: new Date().toISOString(), v6: V6, completed, firstLoanId: firstLoanId?.toString(), lastLoanId: lastLoanId?.toString(),
        avgRequestGas: avgReq, avgRepayGas: avgRepay, gasUsed,
        deltaEth: ethers.formatEther(endEth - startEth),
        deltaUsdc: ethers.formatUnits(endUsdc - startUsdc, 6)
    }, null, 2));
    console.log('Saved.');
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
