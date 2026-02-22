/**
 * Repay All Active Loans
 *
 * Cleans up any active loans for an agent to prepare for fresh testing
 */

const { ethers } = require('ethers');
const fs = require('fs');

const NETWORK = process.env.NETWORK || 'arc';
const AGENT_KEY = process.env.AGENT_KEY || process.env.PRIVATE_KEY || '0x0000000000000000000000000000000000000000000000000000000000000000'; // Agent 1

const RPC_URLS = {
    arc: 'https://arc-testnet.drpc.org',
    base: 'https://sepolia.base.org',
};

async function main() {
    console.log('\n🧹 REPAYING ALL ACTIVE LOANS\n');

    const RPC_URL = RPC_URLS[NETWORK];
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

    const configPath = NETWORK === 'arc'
        ? './src/config/arc-testnet-addresses.json'
        : './src/config/base-sepolia-addresses.json';

    const addresses = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const keys = NETWORK === 'arc'
        ? { marketplace: 'agentLiquidityMarketplace', usdc: 'mockUSDC', registry: 'agentRegistryV2' }
        : { marketplace: 'AgentLiquidityMarketplace', usdc: 'MockUSDC', registry: 'AgentRegistry' };

    const marketplaceAbi = loadAbi('AgentLiquidityMarketplace');
    const registryAbi = loadAbi('AgentRegistry');
    const usdcAbi = loadAbi('MockUSDC');

    const marketplace = new ethers.Contract(addresses[keys.marketplace], marketplaceAbi, wallet);
    const registry = new ethers.Contract(addresses[keys.registry], registryAbi, provider);
    const usdc = new ethers.Contract(addresses[keys.usdc], usdcAbi, wallet);

    console.log(`Network: ${NETWORK === 'arc' ? 'Arc Testnet' : 'Base Sepolia'}`);
    console.log(`Agent: ${wallet.address}\n`);

    // Get agent ID
    let agentId;
    try {
        const agentInfo = await registry.getAgentInfo(wallet.address);
        agentId = Number(agentInfo.agentId);
        console.log(`Agent ID: ${agentId}\n`);
    } catch (error) {
        console.log('❌ Could not get agent ID - agent may not be registered\n');
        return;
    }

    // Approve USDC for repayments
    console.log('Approving USDC for repayments...');
    try {
        const approveTx = await usdc.approve(addresses[keys.marketplace], ethers.parseUnits('1000000', 6));
        await approveTx.wait();
        console.log('✅ Approved\n');
    } catch (error) {
        console.log(`❌ Approval failed: ${error.message}\n`);
        return;
    }

    // Try to repay loan IDs - we'll brute force check recent loan IDs
    console.log('Searching for active loans (checking recent loan IDs)...\n');

    let repaid = 0;
    let notFound = 0;
    const maxConsecutiveNotFound = 50; // Stop after 50 consecutive not-found

    // Start from a high loan ID and work backwards
    // The 500-loan test likely created loans in the 200-700 range
    for (let loanId = 800; loanId >= 1 && notFound < maxConsecutiveNotFound; loanId--) {
        try {
            // Try to repay this loan
            const repayTx = await marketplace.repayLoan(loanId);
            await repayTx.wait();

            console.log(`✅ Repaid Loan #${loanId}`);
            repaid++;
            notFound = 0; // Reset counter on success

        } catch (error) {
            const errorMsg = error.message;

            if (errorMsg.includes('Loan does not exist') ||
                errorMsg.includes('Invalid loan') ||
                errorMsg.includes('Not borrower')) {
                notFound++;
                // Silent - these are expected
            } else if (errorMsg.includes('Loan not active')) {
                notFound++;
                // Loan exists but already repaid - expected
            } else {
                // Unexpected error
                if (repaid === 0 && loanId % 100 === 0) {
                    console.log(`Checking loan #${loanId}...`);
                }
            }
        }
    }

    console.log(`\n✅ Repayment Complete!`);
    console.log(`  Loans Repaid: ${repaid}`);
    console.log(`  Agent should now have 0 active loans\n`);
}

main().catch(err => {
    console.error('❌ Error:', err.message);
    process.exit(1);
});
