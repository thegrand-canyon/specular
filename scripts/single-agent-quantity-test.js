/**
 * Single-Agent Quantity Test
 * Simple rapid-fire test with one well-funded agent
 */

const { ethers } = require('ethers');
const fs = require('fs');

const TARGET = parseInt(process.env.TARGET || '300');
const LOAN_AMOUNT = parseInt(process.env.LOAN_AMOUNT || '20');

async function main() {
    console.log('\n🚀 SINGLE-AGENT QUANTITY TEST\n');
    console.log(`Target: ${TARGET} loans`);
    console.log(`Loan Amount: ${LOAN_AMOUNT} USDC`);
    console.log(`Strategy: Rapid-fire with immediate repayment\n`);

    const provider = new ethers.JsonRpcProvider('https://arc-testnet.drpc.org', undefined, { batchMaxCount: 1 });
    const wallet = new ethers.Wallet('process.env.PRIVATE_KEY || '0x0000000000000000000000000000000000000000000000000000000000000000'', provider);

    console.log(`Agent: ${wallet.address}\n`);

    const addresses = JSON.parse(fs.readFileSync('./src/config/arc-testnet-addresses.json', 'utf8'));
    const mpAbi = JSON.parse(fs.readFileSync('./artifacts/contracts/core/AgentLiquidityMarketplace.sol/AgentLiquidityMarketplace.json', 'utf8')).abi;
    const usdcAbi = JSON.parse(fs.readFileSync('./artifacts/contracts/tokens/MockUSDC.sol/MockUSDC.json', 'utf8')).abi;

    const mp = new ethers.Contract(addresses.agentLiquidityMarketplace, mpAbi, wallet);
    const usdc = new ethers.Contract(addresses.mockUSDC, usdcAbi, wallet);

    // Check balances
    const ethBal = await provider.getBalance(wallet.address);
    const usdcBal = await usdc.balanceOf(wallet.address);
    console.log(`ETH: ${ethers.formatEther(ethBal)}`);
    console.log(`USDC: ${ethers.formatUnits(usdcBal, 6)}\n`);

    console.log('Approving USDC...');
    await (await usdc.approve(addresses.agentLiquidityMarketplace, ethers.parseUnits('500000', 6))).wait();
    console.log('✅ Approved\n');

    console.log('═'.repeat(70));
    console.log('STARTING RAPID-FIRE LOAN CYCLES');
    console.log('═'.repeat(70) + '\n');

    let success = 0, failed = 0, totalGas = 0n, errorTypes = {};
    const start = Date.now();

    for (let i = 0; i < TARGET; i++) {
        try {
            const loanTx = await mp.requestLoan(ethers.parseUnits(LOAN_AMOUNT.toString(), 6), 7);
            const requestReceipt = await loanTx.wait();

            // Extract loan ID
            let loanId;
            for (const log of requestReceipt.logs) {
                try {
                    const parsed = mp.interface.parseLog(log);
                    if (parsed?.name === 'LoanRequested') {
                        loanId = Number(parsed.args.loanId);
                        break;
                    }
                } catch {}
            }

            // Repay immediately
            const repayTx = await mp.repayLoan(loanId);
            const repayReceipt = await repayTx.wait();

            totalGas += requestReceipt.gasUsed + repayReceipt.gasUsed;
            success++;

            // Progress every 25 loans
            if ((i + 1) % 25 === 0) {
                const elapsed = (Date.now() - start) / 1000;
                const rate = success / elapsed;
                const eta = (TARGET - success) / rate / 60;
                console.log(`${i + 1}/${TARGET} ✅ | ${rate.toFixed(2)} loans/sec | ETA: ${eta.toFixed(1)}m`);
            }

        } catch (error) {
            failed++;
            const errorMsg = error.message;

            const errorType = errorMsg.includes('Too many active') ? 'ACTIVE_LIMIT' :
                            errorMsg.includes('insufficient funds') ? 'OUT_OF_GAS' :
                            errorMsg.includes('408') ? 'RPC_TIMEOUT' :
                            errorMsg.includes('replacement') ? 'NONCE' : 'OTHER';

            errorTypes[errorType] = (errorTypes[errorType] || 0) + 1;

            // Log first error of each type
            if (errorTypes[errorType] === 1) {
                console.log(`${i + 1}. ❌ ${errorType}: ${errorMsg.substring(0, 50)}`);
            }

            // Stop if out of gas
            if (errorType === 'OUT_OF_GAS') {
                console.log(`\n🛑 OUT OF GAS - Stopping after ${success} loans\n`);
                break;
            }

            // Pause if hitting limit repeatedly
            if (errorType === 'ACTIVE_LIMIT' && errorTypes[errorType] === 10) {
                console.log(`\n⏸️  Pausing 10s to allow active loans to clear...\n`);
                await new Promise(resolve => setTimeout(resolve, 10000));
            }
        }
    }

    const duration = (Date.now() - start) / 1000;

    console.log('\n' + '═'.repeat(70));
    console.log('QUANTITY TEST RESULTS');
    console.log('═'.repeat(70) + '\n');

    console.log(`Success: ${success}/${TARGET} (${(success/TARGET*100).toFixed(1)}%)`);
    console.log(`Failed: ${failed}`);
    console.log(`Duration: ${duration.toFixed(1)}s (${(duration/60).toFixed(2)}m)`);
    console.log(`Total Gas: ${totalGas.toString().toLocaleString()}`);
    console.log(`Avg Gas: ${success > 0 ? Math.round(Number(totalGas) / success).toLocaleString() : 0}`);
    console.log(`\n**THROUGHPUT: ${(success / duration).toFixed(2)} loans/sec**`);
    console.log(`**HOURLY RATE: ${Math.round(success / duration * 3600).toLocaleString()} loans/hour**`);
    console.log(`**DAILY CAPACITY: ${Math.round(success / duration * 86400).toLocaleString()} loans/day**\n`);

    if (Object.keys(errorTypes).length > 0) {
        console.log('Error Breakdown:');
        for (const [type, count] of Object.entries(errorTypes)) {
            console.log(`  ${type}: ${count}`);
        }
        console.log('');
    }

    console.log('═'.repeat(70) + '\n');

    if (success >= 200) {
        console.log(`🎉 SUCCESS: Processed ${success} loans!\n`);
    } else {
        console.log(`⚠️  Reached ${success} loans\n`);
    }
}

main().catch(err => {
    console.error('\n❌ Test failed:', err.message);
    process.exit(1);
});
