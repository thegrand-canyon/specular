/**
 * Supply Liquidity to Base Sepolia Pool
 */

const { ethers } = require('ethers');
const fs = require('fs');

const RPC_URL = 'https://sepolia.base.org';
const LENDER_KEY = '0x4fd4d9c9340c0dcd1f4845483e488afde4c69685f9ff5deec756fbfc1afb02ac';
const AGENT_ID = 1;
const AMOUNT = 10000; // 10,000 USDC

async function main() {
    console.log('\n💧 SUPPLY LIQUIDITY TO BASE SEPOLIA\n');

    const provider = new ethers.JsonRpcProvider(RPC_URL, undefined, { batchMaxCount: 1 });
    const lender = new ethers.Wallet(LENDER_KEY, provider);

    console.log(`Lender: ${lender.address}`);
    console.log(`ETH Balance: ${ethers.formatEther(await provider.getBalance(lender.address))} ETH\n`);

    // Load addresses
    const addresses = JSON.parse(
        fs.readFileSync('./src/config/base-sepolia-addresses.json', 'utf8')
    );

    // Load ABIs
    const marketplaceAbi = JSON.parse(
        fs.readFileSync('./artifacts/contracts/core/AgentLiquidityMarketplace.sol/AgentLiquidityMarketplace.json', 'utf8')
    ).abi;

    const marketplace = new ethers.Contract(addresses.AgentLiquidityMarketplace, marketplaceAbi, lender);

    console.log(`💰 Supplying ${AMOUNT} USDC to agent pool ${AGENT_ID}...\n`);

    try {
        // Get current nonce
        const nonce = await provider.getTransactionCount(lender.address);
        console.log(`Current nonce: ${nonce}\n`);

        // Get gas price
        const feeData = await provider.getFeeData();
        const gasPrice = feeData.gasPrice * 120n / 100n;

        const tx = await marketplace.supplyLiquidity(
            AGENT_ID,
            ethers.parseUnits(AMOUNT.toString(), 6),
            { gasPrice, nonce }
        );

        console.log(`📋 Tx sent: ${tx.hash}`);
        console.log(`⏳ Waiting for confirmation...\n`);

        const receipt = await tx.wait();

        console.log(`✅ Liquidity supplied!`);
        console.log(`   📋 Tx: ${receipt.hash}`);
        console.log(`   ⛽ Gas used: ${receipt.gasUsed.toString()}\n`);

        console.log(`🎯 Pool now has ${AMOUNT} USDC available!\n`);

    } catch (err) {
        console.error(`\n❌ Failed: ${err.message}`);
        if (err.data) {
            console.error(`Data: ${err.data}`);
        }
        process.exit(1);
    }
}

main();
