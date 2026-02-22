const { ethers } = require('ethers');
const fs = require('fs');

const addresses = JSON.parse(fs.readFileSync('./src/config/arc-testnet-addresses.json', 'utf8'));

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

const mpAbi = loadAbi('AgentLiquidityMarketplace');
const usdcAbi = loadAbi('MockUSDC');

const agents = [
    { name: 'Main Agent', key: process.env.PRIVATE_KEY || '0x0000000000000000000000000000000000000000000000000000000000000000' },
    { name: 'Fresh Agent 1', key: 'process.env.TEST_KEY || '0x0000000000000000000000000000000000000000000000000000000000000000'' },
    { name: 'Fresh Agent 2', key: 'process.env.TEST_KEY || '0x0000000000000000000000000000000000000000000000000000000000000000'' },
    { name: 'Fresh Agent 3', key: 'process.env.TEST_KEY || '0x0000000000000000000000000000000000000000000000000000000000000000'' }
];

async function repayAllLoans(wallet, marketplace, usdc) {
    const activeLoans = await marketplace.getActiveLoans(wallet.address);

    if (activeLoans.length === 0) {
        console.log('  No active loans');
        return 0;
    }

    console.log(`  Found ${activeLoans.length} active loans`);
    let repaid = 0;

    for (const loanId of activeLoans) {
        try {
            const loan = await marketplace.loans(loanId);
            const amount = loan.principal + loan.interest;

            // Approve and repay
            const approveTx = await usdc.approve(addresses.agentLiquidityMarketplace, amount);
            await approveTx.wait();

            const repayTx = await marketplace.repayLoan(loanId);
            await repayTx.wait();

            console.log(`  ✓ Repaid loan ${loanId}: ${ethers.formatUnits(amount, 6)} USDC`);
            repaid++;
        } catch (error) {
            console.log(`  ✗ Failed to repay loan ${loanId}: ${error.message}`);
        }
    }

    return repaid;
}

async function main() {
    const provider = new ethers.JsonRpcProvider(
        process.env.ARC_TESTNET_RPC_URL || 'https://arc-testnet.drpc.org',
        undefined,
        { batchMaxCount: 1 }
    );

    console.log('=== REPAYING ALL ACTIVE LOANS ===\n');

    let totalRepaid = 0;

    for (const agent of agents) {
        console.log(`${agent.name}:`);
        const wallet = new ethers.Wallet(agent.key, provider);
        const marketplace = new ethers.Contract(addresses.agentLiquidityMarketplace, mpAbi, wallet);
        const usdc = new ethers.Contract(addresses.mockUSDC, usdcAbi, wallet);

        const repaid = await repayAllLoans(wallet, marketplace, usdc);
        totalRepaid += repaid;
        console.log('');
    }

    console.log(`\n✅ Total loans repaid: ${totalRepaid}`);
}

main().catch(console.error);
