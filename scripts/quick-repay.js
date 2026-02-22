const { ethers } = require('ethers');
const fs = require('fs');

async function main() {
    console.log('\n🧹 Repaying Active Loans\n');

    const provider = new ethers.JsonRpcProvider('https://arc-testnet.drpc.org', undefined, { batchMaxCount: 1 });
    const wallet = new ethers.Wallet('0x4fd4d9c9340c0dcd1f4845483e488afde4c69685f9ff5deec756fbfc1afb02ac', provider);

    const addresses = JSON.parse(fs.readFileSync('./src/config/arc-testnet-addresses.json', 'utf8'));
    const marketplaceAbi = JSON.parse(fs.readFileSync('./artifacts/contracts/core/AgentLiquidityMarketplace.sol/AgentLiquidityMarketplace.json', 'utf8')).abi;
    const usdcAbi = JSON.parse(fs.readFileSync('./artifacts/contracts/tokens/MockUSDC.sol/MockUSDC.json', 'utf8')).abi;

    const marketplace = new ethers.Contract(addresses.agentLiquidityMarketplace, marketplaceAbi, wallet);
    const usdc = new ethers.Contract(addresses.mockUSDC, usdcAbi, wallet);

    // Approve
    console.log('Approving USDC...');
    const approveTx = await usdc.approve(addresses.agentLiquidityMarketplace, ethers.parseUnits('1000000', 6));
    await approveTx.wait();
    console.log('✅ Approved\n');

    console.log('Attempting to repay recent loans (ID 700-900)...\n');

    let repaid = 0;
    for (let loanId = 900; loanId >= 700; loanId--) {
        try {
            const repayTx = await marketplace.repayLoan(loanId);
            await repayTx.wait();
            console.log(`✅ Repaid Loan #${loanId}`);
            repaid++;
        } catch (error) {
            // Silent - most will fail (loan doesn't exist or not ours)
        }
    }

    console.log(`\n✅ Complete - Repaid ${repaid} loans\n`);
}

main().catch(console.error);
