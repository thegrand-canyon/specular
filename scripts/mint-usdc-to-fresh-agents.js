const { ethers } = require('ethers');
const fs = require('fs');

const MINT_AMOUNT = 50000; // 50,000 USDC each for collateral
const MINTER_KEY = '0x4fd4d9c9340c0dcd1f4845483e488afde4c69685f9ff5deec756fbfc1afb02ac'; // Main agent

async function main() {
    console.log('\n💵 MINTING USDC TO FRESH AGENTS\n');

    const provider = new ethers.JsonRpcProvider('https://arc-testnet.drpc.org', undefined, { batchMaxCount: 1 });
    const config = JSON.parse(fs.readFileSync('./fresh-agents-config.json', 'utf8'));
    const addresses = JSON.parse(fs.readFileSync('./src/config/arc-testnet-addresses.json', 'utf8'));

    const minter = new ethers.Wallet(MINTER_KEY, provider);
    const usdcAbi = JSON.parse(fs.readFileSync('./artifacts/contracts/tokens/MockUSDC.sol/MockUSDC.json', 'utf8')).abi;
    const usdc = new ethers.Contract(addresses.mockUSDC, usdcAbi, minter);

    console.log('Minter: ' + minter.address);
    console.log('Minting ' + MINT_AMOUNT + ' USDC to each agent\n');

    for (const agent of config.agents) {

        console.log(agent.name + ':');
        console.log('  Address: ' + agent.address);

        const balBefore = await usdc.balanceOf(agent.address);
        console.log('  Balance before: ' + ethers.formatUnits(balBefore, 6) + ' USDC');

        console.log('  Minting...');
        const mintTx = await usdc.mint(agent.address, ethers.parseUnits(MINT_AMOUNT.toString(), 6));
        const mintReceipt = await mintTx.wait();

        const balAfter = await usdc.balanceOf(agent.address);
        console.log('  Balance after: ' + ethers.formatUnits(balAfter, 6) + ' USDC');
        console.log('  Tx: ' + mintReceipt.hash);
        console.log('  Gas: ' + mintReceipt.gasUsed.toString() + '\n');

        // Small delay
        await new Promise(resolve => setTimeout(resolve, 1500));
    }

    console.log('✅ All agents funded with USDC for collateral!\n');
}

main().catch(err => {
    console.error('\n❌ Minting failed:', err.message);
    console.error(err);
    process.exit(1);
});
