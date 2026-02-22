/**
 * Find and Repay Active Loans
 * Queries the contract for active loans and repays them
 */

const { ethers } = require('ethers');
const fs = require('fs');

async function main() {
    console.log('\n🔍 FINDING AND REPAYING ACTIVE LOANS\n');

    const provider = new ethers.JsonRpcProvider('https://arc-testnet.drpc.org', undefined, { batchMaxCount: 1 });
    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY || '0x0000000000000000000000000000000000000000000000000000000000000000', provider);

    const addresses = JSON.parse(fs.readFileSync('./src/config/arc-testnet-addresses.json', 'utf8'));
    const mpAbi = JSON.parse(fs.readFileSync('./artifacts/contracts/core/AgentLiquidityMarketplace.sol/AgentLiquidityMarketplace.json', 'utf8')).abi;
    const usdcAbi = JSON.parse(fs.readFileSync('./artifacts/contracts/tokens/MockUSDC.sol/MockUSDC.json', 'utf8')).abi;

    const mp = new ethers.Contract(addresses.agentLiquidityMarketplace, mpAbi, wallet);
    const usdc = new ethers.Contract(addresses.mockUSDC, usdcAbi, wallet);

    console.log(`Agent: ${wallet.address}\n`);

    // Approve
    console.log('Approving USDC...');
    await (await usdc.approve(addresses.agentLiquidityMarketplace, ethers.parseUnits('1000000', 6))).wait();
    console.log('✅ Approved\n');

    // Try to find active loans by checking recent loan IDs
    console.log('Searching for active loans (checking loan IDs 1-1000)...\n');

    const activeLoanIds = [];

    for (let loanId = 1; loanId <= 1000; loanId++) {
        try {
            // Try to get loan info
            const loan = await mp.loans(loanId);

            // Check if this is our loan and if it's active
            if (loan.borrower.toLowerCase() === wallet.address.toLowerCase() &&
                loan.status === 1n) { // 1 = ACTIVE status
                activeLoanIds.push({
                    id: loanId,
                    amount: ethers.formatUnits(loan.amount, 6),
                    dueDate: new Date(Number(loan.dueDate) * 1000).toLocaleString(),
                });
                console.log(`Found active loan #${loanId}: ${ethers.formatUnits(loan.amount, 6)} USDC, due ${new Date(Number(loan.dueDate) * 1000).toLocaleDateString()}`);
            }
        } catch (error) {
            // Silent - loan doesn't exist or other error
        }

        // Progress indicator
        if (loanId % 100 === 0) {
            console.log(`Checked ${loanId}/1000...`);
        }
    }

    console.log(`\n✅ Found ${activeLoanIds.length} active loans\n`);

    if (activeLoanIds.length === 0) {
        console.log('No active loans to repay!\n');
        return;
    }

    // Repay all active loans
    console.log('Repaying active loans...\n');

    let repaid = 0;
    for (const loan of activeLoanIds) {
        try {
            console.log(`Repaying loan #${loan.id} (${loan.amount} USDC)...`);
            const repayTx = await mp.repayLoan(loan.id);
            await repayTx.wait();
            console.log(`✅ Repaid loan #${loan.id}\n`);
            repaid++;
        } catch (error) {
            console.log(`❌ Failed to repay loan #${loan.id}: ${error.message.substring(0, 60)}\n`);
        }
    }

    console.log(`✅ COMPLETE - Repaid ${repaid}/${activeLoanIds.length} loans\n`);
}

main().catch(err => {
    console.error('❌ Error:', err.message);
    process.exit(1);
});
