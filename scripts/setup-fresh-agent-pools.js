const { ethers } = require('ethers');
const fs = require('fs');

const SUPPLY_AMOUNT = 10000; // 10,000 USDC per agent

async function setupAgentPool(agent, provider, addresses, mpAbi, usdcAbi) {
    console.log('═'.repeat(70));
    console.log('SETTING UP: ' + agent.name + ' (ID ' + agent.id + ')');
    console.log('═'.repeat(70) + '\n');

    const wallet = new ethers.Wallet(agent.privateKey, provider);
    const marketplace = new ethers.Contract(addresses.agentLiquidityMarketplace, mpAbi, wallet);
    const usdc = new ethers.Contract(addresses.mockUSDC, usdcAbi, wallet);

    console.log('Address: ' + wallet.address);
    console.log('Agent ID: ' + agent.id + '\n');

    const ethBal = await provider.getBalance(wallet.address);
    const usdcBal = await usdc.balanceOf(wallet.address);
    console.log('ETH: ' + ethers.formatEther(ethBal));
    console.log('USDC: ' + ethers.formatUnits(usdcBal, 6) + '\n');

    // Step 1: Create pool
    console.log('🏦 Creating agent pool...\n');
    try {
        const createPoolTx = await marketplace.createAgentPool();
        const createPoolReceipt = await createPoolTx.wait();
        console.log('   ✅ Pool created!');
        console.log('   📋 Tx: ' + createPoolReceipt.hash);
        console.log('   ⛽ Gas: ' + createPoolReceipt.gasUsed.toString() + '\n');
    } catch (error) {
        if (error.message.includes('Pool already exists')) {
            console.log('   ℹ️  Pool already exists\n');
        } else {
            throw error;
        }
    }

    // Step 2: Approve USDC
    console.log('🔓 Approving ' + SUPPLY_AMOUNT + ' USDC...\n');
    const approveTx = await usdc.approve(addresses.agentLiquidityMarketplace, ethers.parseUnits(SUPPLY_AMOUNT.toString(), 6));
    const approveReceipt = await approveTx.wait();
    console.log('   ✅ Approved!');
    console.log('   📋 Tx: ' + approveReceipt.hash);
    console.log('   ⛽ Gas: ' + approveReceipt.gasUsed.toString() + '\n');

    // Step 3: Supply liquidity
    console.log('💰 Supplying ' + SUPPLY_AMOUNT + ' USDC to pool...\n');
    const supplyTx = await marketplace.supplyLiquidity(agent.id, ethers.parseUnits(SUPPLY_AMOUNT.toString(), 6));
    const supplyReceipt = await supplyTx.wait();
    console.log('   ✅ Liquidity supplied!');
    console.log('   📋 Tx: ' + supplyReceipt.hash);
    console.log('   ⛽ Gas: ' + supplyReceipt.gasUsed.toString() + '\n');

    console.log('✅ ' + agent.name + ' pool setup complete!\n\n');
}

async function main() {
    console.log('\n🚀 FRESH AGENT POOL SETUP\n');

    const provider = new ethers.JsonRpcProvider('https://arc-testnet.drpc.org', undefined, { batchMaxCount: 1 });
    const addresses = JSON.parse(fs.readFileSync('./src/config/arc-testnet-addresses.json', 'utf8'));
    const config = JSON.parse(fs.readFileSync('./fresh-agents-config.json', 'utf8'));

    const mpAbi = JSON.parse(fs.readFileSync('./artifacts/contracts/core/AgentLiquidityMarketplace.sol/AgentLiquidityMarketplace.json', 'utf8')).abi;
    const usdcAbi = JSON.parse(fs.readFileSync('./artifacts/contracts/tokens/MockUSDC.sol/MockUSDC.json', 'utf8')).abi;

    console.log('Setting up pools for ' + config.agents.length + ' fresh agents');
    console.log('Supply per agent: ' + SUPPLY_AMOUNT + ' USDC\n');

    for (const agent of config.agents) {
        await setupAgentPool(agent, provider, addresses, mpAbi, usdcAbi);
        // Small delay between agents
        await new Promise(resolve => setTimeout(resolve, 2000));
    }

    console.log('═'.repeat(70));
    console.log('ALL POOLS SETUP COMPLETE');
    console.log('═'.repeat(70) + '\n');

    console.log('🎯 All ' + config.agents.length + ' agents now have pools with ' + SUPPLY_AMOUNT + ' USDC each!\n');
}

main().catch(err => {
    console.error('\n❌ Setup failed:', err.message);
    console.error(err);
    process.exit(1);
});
