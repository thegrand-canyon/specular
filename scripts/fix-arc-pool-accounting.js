/**
 * Fix Arc Testnet Pool Accounting Bug
 *
 * Calls the new resetPoolAccounting() function to recalculate pool state
 */

const { ethers } = require('ethers');
const fs = require('fs');

const RPC_URL = 'https://arc-testnet.drpc.org';
const OWNER_KEY = 'process.env.PRIVATE_KEY || '0x0000000000000000000000000000000000000000000000000000000000000000'';
const AGENT_ID = 43;

async function main() {
    console.log('\n🔧 FIXING ARC TESTNET POOL ACCOUNTING\n');

    const provider = new ethers.JsonRpcProvider(RPC_URL, undefined, { batchMaxCount: 1 });
    const owner = new ethers.Wallet(OWNER_KEY, provider);

    console.log(`Owner: ${owner.address}\n`);

    const addresses = JSON.parse(
        fs.readFileSync('./src/config/arc-testnet-addresses.json', 'utf8')
    );

    function loadAbi(name) {
        const paths = [
            `./artifacts/contracts/${name}.sol/${name}.json`,
            `./artifacts/contracts/core/${name}.sol/${name}.json`,
            `./artifacts/contracts/tokens/${name}.sol/${name}.json`,
        ];
        for (const p of paths) {
            try {
                return JSON.parse(fs.readFileSync(p, 'utf8')).abi;
            } catch {}
        }
        throw new Error(`Cannot find ABI for ${name}`);
    }

    const marketplaceAbi = loadAbi('AgentLiquidityMarketplace');
    const marketplace = new ethers.Contract(
        addresses.agentLiquidityMarketplace,
        marketplaceAbi,
        owner
    );

    // Check pool state before fix
    console.log('═'.repeat(70));
    console.log('BEFORE FIX');
    console.log('═'.repeat(70) + '\n');

    const poolBefore = await marketplace.getAgentPool(AGENT_ID);

    console.log(`Agent ID: ${AGENT_ID}`);
    console.log(`Total Liquidity: ${ethers.formatUnits(poolBefore.totalLiquidity, 6)} USDC`);
    console.log(`Total Loaned: ${ethers.formatUnits(poolBefore.totalLoaned, 6)} USDC ❌`);
    console.log(`Available: ${ethers.formatUnits(poolBefore.availableLiquidity, 6)} USDC ❌`);
    console.log(`Total Earned: ${ethers.formatUnits(poolBefore.totalEarned, 6)} USDC\n`);

    // Call resetPoolAccounting
    console.log('═'.repeat(70));
    console.log('EXECUTING FIX');
    console.log('═'.repeat(70) + '\n');

    console.log('Calling resetPoolAccounting()...\n');

    try {
        const nonce = await provider.getTransactionCount(owner.address);
        const tx = await marketplace.resetPoolAccounting(AGENT_ID, { nonce });

        console.log(`Transaction: ${tx.hash}`);
        console.log('Waiting for confirmation...\n');

        const receipt = await tx.wait();

        console.log(`✅ Transaction confirmed!`);
        console.log(`Gas used: ${receipt.gasUsed.toString()}\n`);

        // Parse event
        for (const log of receipt.logs) {
            try {
                const parsed = marketplace.interface.parseLog(log);
                if (parsed && parsed.name === 'PoolAccountingReset') {
                    console.log('PoolAccountingReset Event:');
                    console.log(`  Agent ID: ${parsed.args.agentId}`);
                    console.log(`  Old Total Loaned: ${ethers.formatUnits(parsed.args.oldTotalLoaned, 6)} USDC`);
                    console.log(`  New Total Loaned: ${ethers.formatUnits(parsed.args.newTotalLoaned, 6)} USDC`);
                    console.log(`  New Available: ${ethers.formatUnits(parsed.args.newAvailableLiquidity, 6)} USDC\n`);
                }
            } catch {}
        }

    } catch (error) {
        console.log(`❌ Fix failed: ${error.message}\n`);
        process.exit(1);
    }

    // Check pool state after fix
    console.log('═'.repeat(70));
    console.log('AFTER FIX');
    console.log('═'.repeat(70) + '\n');

    const poolAfter = await marketplace.getAgentPool(AGENT_ID);

    console.log(`Agent ID: ${AGENT_ID}`);
    console.log(`Total Liquidity: ${ethers.formatUnits(poolAfter.totalLiquidity, 6)} USDC`);
    console.log(`Total Loaned: ${ethers.formatUnits(poolAfter.totalLoaned, 6)} USDC ✅`);
    console.log(`Available: ${ethers.formatUnits(poolAfter.availableLiquidity, 6)} USDC ✅`);
    console.log(`Total Earned: ${ethers.formatUnits(poolAfter.totalEarned, 6)} USDC\n`);

    // Verify fix
    const change = Number(poolBefore.totalLoaned) - Number(poolAfter.totalLoaned);
    const discrepancy = change / 1e6;

    console.log('═'.repeat(70));
    console.log('VERIFICATION');
    console.log('═'.repeat(70) + '\n');

    console.log(`Discrepancy corrected: ${discrepancy.toFixed(2)} USDC`);

    if (Number(poolAfter.totalLoaned) === 0 || Number(poolAfter.totalLoaned) < Number(poolBefore.totalLoaned)) {
        console.log(`✅ Pool accounting fixed successfully!\n`);
    } else {
        console.log(`⚠️  Pool state may still be incorrect\n`);
    }

    console.log('═'.repeat(70) + '\n');
}

main().catch(err => {
    console.error('\n❌ Fix failed:', err.message);
    console.error(err);
    process.exit(1);
});
