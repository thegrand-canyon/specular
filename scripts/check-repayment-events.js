/**
 * Check Repayment Transaction Events
 */

const { ethers } = require('ethers');
const fs = require('fs');

const RPC_URL = 'https://sepolia.base.org';
const TX_HASH = process.argv[2] || ''; // Pass tx hash as argument

async function main() {
    if (!TX_HASH) {
        console.log('Usage: node check-repayment-events.js <tx_hash>');
        return;
    }

    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const addresses = JSON.parse(
        fs.readFileSync('./src/config/base-sepolia-addresses.json', 'utf8')
    );

    const rmAbi = JSON.parse(
        fs.readFileSync('./artifacts/contracts/core/ReputationManagerV3.sol/ReputationManagerV3.json', 'utf8')
    ).abi;

    const marketplace = JSON.parse(
        fs.readFileSync('./artifacts/contracts/core/AgentLiquidityMarketplace.sol/AgentLiquidityMarketplace.json', 'utf8')
    ).abi;

    const rm = new ethers.Contract(addresses.ReputationManagerV3, rmAbi, provider);
    const mp = new ethers.Contract(addresses.AgentLiquidityMarketplace, marketplace, provider);

    console.log(`\nChecking transaction: ${TX_HASH}\n`);

    const receipt = await provider.getTransactionReceipt(TX_HASH);

    if (!receipt) {
        console.log('Transaction not found');
        return;
    }

    console.log(`Status: ${receipt.status === 1 ? 'SUCCESS' : 'FAILED'}`);
    console.log(`Block: ${receipt.blockNumber}\n`);

    console.log('Events:\n');

    for (const log of receipt.logs) {
        try {
            // Try ReputationManager events
            const parsed = rm.interface.parseLog(log);
            if (parsed) {
                console.log(`✅ ReputationManager.${parsed.name}`);
                if (parsed.name === 'ReputationUpdated') {
                    console.log(`   Agent ID: ${parsed.args.agentId}`);
                    console.log(`   Old Score: ${parsed.args.oldScore}`);
                    console.log(`   New Score: ${parsed.args.newScore}`);
                    console.log(`   Reason: ${parsed.args.reason}\n`);
                } else if (parsed.name === 'LoanCompleted') {
                    console.log(`   Agent ID: ${parsed.args.agentId}`);
                    console.log(`   Amount: ${ethers.formatUnits(parsed.args.amount, 6)} USDC`);
                    console.log(`   On Time: ${parsed.args.onTime}\n`);
                }
            }
        } catch {}

        try {
            // Try Marketplace events
            const parsed2 = mp.interface.parseLog(log);
            if (parsed2) {
                console.log(`✅ Marketplace.${parsed2.name}`);
                if (parsed2.name === 'LoanRepaid') {
                    console.log(`   Loan ID: ${parsed2.args.loanId}`);
                    console.log(`   Amount: ${ethers.formatUnits(parsed2.args.amount, 6)} USDC`);
                    console.log(`   Interest: ${ethers.formatUnits(parsed2.args.interest, 6)} USDC\n`);
                }
            }
        } catch {}
    }
}

main().catch(console.error);
