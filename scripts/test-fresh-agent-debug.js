const { ethers } = require('ethers');
const fs = require('fs');

async function main() {
    const provider = new ethers.JsonRpcProvider('https://arc-testnet.drpc.org', undefined, { batchMaxCount: 1 });
    const config = JSON.parse(fs.readFileSync('./fresh-agents-config.json', 'utf8'));
    const addresses = JSON.parse(fs.readFileSync('./src/config/arc-testnet-addresses.json', 'utf8'));

    const agent = config.agents[0]; // Fresh Agent 1
    const wallet = new ethers.Wallet(agent.privateKey, provider);

    const mpAbi = JSON.parse(fs.readFileSync('./artifacts/contracts/core/AgentLiquidityMarketplace.sol/AgentLiquidityMarketplace.json', 'utf8')).abi;
    const usdcAbi = JSON.parse(fs.readFileSync('./artifacts/contracts/tokens/MockUSDC.sol/MockUSDC.json', 'utf8')).abi;

    const mp = new ethers.Contract(addresses.agentLiquidityMarketplace, mpAbi, wallet);
    const usdc = new ethers.Contract(addresses.mockUSDC, usdcAbi, wallet);

    console.log('Testing with:', agent.name);
    console.log('Address:', wallet.address);
    console.log('Agent ID:', agent.id, '\n');

    // Check balances
    const usdcBal = await usdc.balanceOf(wallet.address);
    console.log('USDC Balance:', ethers.formatUnits(usdcBal, 6), '\n');

    // Check pool info
    console.log('Checking pool info...');
    try {
        const pool = await mp.agentPools(agent.id);
        console.log('Pool exists:', pool.totalLiquidity > 0n);
        console.log('Total Liquidity:', ethers.formatUnits(pool.totalLiquidity, 6), 'USDC');
        console.log('Available:', ethers.formatUnits(pool.availableLiquidity, 6), 'USDC\n');
    } catch (error) {
        console.log('Error checking pool:', error.message, '\n');
    }

    // Try to request a loan
    console.log('Requesting 20 USDC loan for 7 days...\n');
    try {
        const tx = await mp.requestLoan(ethers.parseUnits('20', 6), 7);
        const receipt = await tx.wait();
        console.log('✅ SUCCESS!');
        console.log('Tx:', receipt.hash);
    } catch (error) {
        console.log('❌ ERROR:', error.message);
        console.log('\nFull error:');
        console.log(error);

        // Try to get revert reason
        if (error.data) {
            console.log('\nError data:', error.data);
        }
    }
}

main().catch(console.error);
