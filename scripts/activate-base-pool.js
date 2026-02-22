/**
 * Activate Agent Pool on Base Sepolia
 */

const { ethers } = require('ethers');
const fs = require('fs');

const RPC_URL = 'https://sepolia.base.org';
const AGENT_KEY = 'process.env.PRIVATE_KEY || '0x0000000000000000000000000000000000000000000000000000000000000000'';

async function main() {
    console.log('\n🏦 ACTIVATE AGENT POOL ON BASE SEPOLIA\n');

    const provider = new ethers.JsonRpcProvider(RPC_URL, undefined, { batchMaxCount: 1 });
    const agent = new ethers.Wallet(AGENT_KEY, provider);

    console.log(`Agent: ${agent.address}\n`);

    // Load addresses
    const addresses = JSON.parse(
        fs.readFileSync('./src/config/base-sepolia-addresses.json', 'utf8')
    );

    // Load ABI
    const marketplaceAbi = JSON.parse(
        fs.readFileSync('./artifacts/contracts/core/AgentLiquidityMarketplace.sol/AgentLiquidityMarketplace.json', 'utf8')
    ).abi;

    const marketplace = new ethers.Contract(addresses.AgentLiquidityMarketplace, marketplaceAbi, agent);

    console.log('🏦 Creating/activating agent pool...\n');

    try {
        const nonce = await provider.getTransactionCount(agent.address);
        const feeData = await provider.getFeeData();
        const gasPrice = feeData.gasPrice * 120n / 100n;

        const tx = await marketplace.createAgentPool({ gasPrice, nonce });
        console.log(`📋 Tx sent: ${tx.hash}`);
        console.log(`⏳ Waiting for confirmation...\n`);

        const receipt = await tx.wait();

        console.log(`✅ Pool activated!`);
        console.log(`   📋 Tx: ${receipt.hash}`);
        console.log(`   ⛽ Gas used: ${receipt.gasUsed.toString()}\n`);

    } catch (err) {
        if (err.message.includes('Pool already exists')) {
            console.log(`✅ Pool already exists and is active!\n`);
        } else {
            console.error(`\n❌ Failed: ${err.message}`);
            if (err.data) {
                console.error(`Data: ${err.data}`);
            }
            process.exit(1);
        }
    }
}

main();
