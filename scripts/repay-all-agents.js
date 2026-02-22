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
    { name: 'Main Agent', key: 'process.env.PRIVATE_KEY || '0x0000000000000000000000000000000000000000000000000000000000000000'' },
    { name: 'Fresh Agent 1', key: '0x47471cb7a2ba033f2085a82050ff16248ff3a9e5d9ea17ddb0f5d2f208e043ad' },
    { name: 'Fresh Agent 2', key: '0x41adb1d6ef22647a3de0e7993f4e33ec7bcd5b49359587967750ff8f3faddf67' },
    { name: 'Fresh Agent 3', key: '0xebd981dcdb6f6f4c8744a40a937f7b75de400290c58c2728cfff0d2af2418452' }
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
