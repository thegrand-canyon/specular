const { ethers } = require('ethers');
const fs = require('fs');

const CYCLES = 50;
const LOAN_AMOUNT = 20;
const RPC_URL = 'https://arc-testnet.drpc.org';
const AGENT_KEY = '0x41adb1d6ef22647a3de0e7993f4e33ec7bcd5b49359587967750ff8f3faddf67';

async function main() {
    console.log('\n🚀 AGENT 2 RAPID-FIRE TEST');
    console.log(`Cycles: ${CYCLES} × ${LOAN_AMOUNT} USDC\n`);

    const provider = new ethers.JsonRpcProvider(RPC_URL, undefined, { batchMaxCount: 1 });
    const wallet = new ethers.Wallet(AGENT_KEY, provider);

    function loadAbi(name) {
        const paths = [
            `./artifacts/contracts/${name}.sol/${name}.json`,
            `./artifacts/contracts/core/${name}.sol/${name}.json`,
            `./artifacts/contracts/tokens/${name}.sol/${name}.json`,
        ];
        for (const p of paths) {
            try { return JSON.parse(fs.readFileSync(p, 'utf8')).abi; } catch {}
        }
        throw new Error(`Cannot find ABI for ${name}`);
    }

    const addresses = JSON.parse(fs.readFileSync('./src/config/arc-testnet-addresses.json', 'utf8'));
    const marketplace = new ethers.Contract(addresses.agentLiquidityMarketplace, loadAbi('AgentLiquidityMarketplace'), wallet);
    const usdc = new ethers.Contract(addresses.mockUSDC, loadAbi('MockUSDC'), wallet);

    // Approve
    const approveTx = await usdc.approve(addresses.agentLiquidityMarketplace, ethers.parseUnits('50000', 6));
    await approveTx.wait();
    console.log('✅ Approved\n');

    let success = 0, failed = 0, totalTime = 0, minTime = Infinity, maxTime = 0;
    const testStart = Date.now();

    for (let i = 0; i < CYCLES; i++) {
        try {
            const cycleStart = Date.now();

            const loanTx = await marketplace.requestLoan(ethers.parseUnits(LOAN_AMOUNT.toString(), 6), 7);
            const receipt = await loanTx.wait();

            let loanId;
            for (const log of receipt.logs) {
                try {
                    const parsed = marketplace.interface.parseLog(log);
                    if (parsed?.name === 'LoanRequested') { loanId = Number(parsed.args.loanId); break; }
                } catch {}
            }

            const repayTx = await marketplace.repayLoan(loanId);
            await repayTx.wait();

            const cycleTime = Date.now() - cycleStart;
            success++;
            totalTime += cycleTime;
            minTime = Math.min(minTime, cycleTime);
            maxTime = Math.max(maxTime, cycleTime);

            if ((i + 1) % 10 === 0) console.log(`${i + 1}/${CYCLES} ✅ ${cycleTime}ms`);
        } catch (error) {
            failed++;
            if (failed % 5 === 1) console.log(`${i + 1}. ❌ ${error.message.substring(0, 60)}`);
        }
    }

    const duration = (Date.now() - testStart) / 1000;
    console.log(`\n✅ COMPLETE`);
    console.log(`Success: ${success}/${CYCLES} (${(success/CYCLES*100).toFixed(1)}%)`);
    console.log(`Failed: ${failed}`);
    console.log(`Duration: ${duration.toFixed(1)}s`);
    console.log(`Throughput: ${(success / duration).toFixed(2)} loans/sec`);
    console.log(`Avg Time: ${Math.round(totalTime/success)}ms`);
    console.log(`Range: ${minTime}ms - ${maxTime}ms\n`);
}

main().catch(console.error);
