/**
 * Setup Initial Liquidity on Base Sepolia
 *
 * Creates a lending pool and supplies initial liquidity
 */

const { ethers } = require('ethers');
const fs = require('fs');

const RPC_URL = 'https://sepolia.base.org';
const LENDER_KEY = '0x4fd4d9c9340c0dcd1f4845483e488afde4c69685f9ff5deec756fbfc1afb02ac';
const SUPPLY_AMOUNT = 10000; // 10,000 USDC

async function main() {
    console.log('\n💧 SETUP BASE SEPOLIA LIQUIDITY\n');

    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const lender = new ethers.Wallet(LENDER_KEY, provider);

    console.log(`Lender: ${lender.address}`);
    console.log(`Balance: ${ethers.formatEther(await provider.getBalance(lender.address))} ETH\n`);

    // Load addresses
    const addresses = JSON.parse(
        fs.readFileSync('./src/config/base-sepolia-addresses.json', 'utf8')
    );

    // Load ABIs
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

    const usdcAbi = loadAbi('MockUSDC');
    const marketplaceAbi = loadAbi('AgentLiquidityMarketplace');

    const usdc = new ethers.Contract(addresses.MockUSDC, usdcAbi, lender);
    const marketplace = new ethers.Contract(addresses.AgentLiquidityMarketplace, marketplaceAbi, lender);

    console.log('═'.repeat(70));
    console.log('STEP 1: MINT USDC');
    console.log('═'.repeat(70) + '\n');

    const balance = await usdc.balanceOf(lender.address);
    console.log(`Current balance: ${ethers.formatUnits(balance, 6)} USDC\n`);

    if (balance < ethers.parseUnits(SUPPLY_AMOUNT.toString(), 6)) {
        console.log(`💵 Minting ${SUPPLY_AMOUNT} USDC...\n`);

        const feeData = await provider.getFeeData();
        const gasPrice = feeData.gasPrice * 120n / 100n;

        const mintTx = await usdc.mint(lender.address, ethers.parseUnits(SUPPLY_AMOUNT.toString(), 6), { gasPrice });
        const mintReceipt = await mintTx.wait();

        console.log(`   ✅ Minted!`);
        console.log(`   📋 Tx: ${mintReceipt.hash}`);
        console.log(`   ⛽ Gas: ${mintReceipt.gasUsed.toString()}\n`);
    } else {
        console.log('   ✅ Sufficient balance\n');
    }

    console.log('═'.repeat(70));
    console.log('STEP 2: APPROVE MARKETPLACE');
    console.log('═'.repeat(70) + '\n');

    console.log(`🔓 Approving ${SUPPLY_AMOUNT} USDC...\n`);

    const feeData2 = await provider.getFeeData();
    const gasPrice2 = feeData2.gasPrice * 120n / 100n;

    const approveTx = await usdc.approve(addresses.AgentLiquidityMarketplace, ethers.parseUnits(SUPPLY_AMOUNT.toString(), 6), { gasPrice: gasPrice2 });
    const approveReceipt = await approveTx.wait();

    console.log(`   ✅ Approved!`);
    console.log(`   📋 Tx: ${approveReceipt.hash}`);
    console.log(`   ⛽ Gas: ${approveReceipt.gasUsed.toString()}\n`);

    console.log('═'.repeat(70));
    console.log('STEP 3: CREATE AGENT POOL');
    console.log('═'.repeat(70) + '\n');

    // Get agent's registry ID
    const registryAbi = loadAbi('AgentRegistryV2');
    const registry = new ethers.Contract(addresses.AgentRegistryV2, registryAbi, provider);
    const agentId = await registry.addressToAgentId(lender.address);

    console.log(`Agent ID: ${agentId}\n`);

    if (agentId === 0n) {
        console.log('⚠️  Agent not registered! Registering first...\n');

        const feeData3 = await provider.getFeeData();
        const gasPrice3 = feeData3.gasPrice * 120n / 100n;

        const regTx = await registry.connect(lender).register('ipfs://lender-agent', [], { gasPrice: gasPrice3 });
        const regReceipt = await regTx.wait();

        console.log(`   ✅ Registered!`);
        console.log(`   📋 Tx: ${regReceipt.hash}\n`);

        // Get new agent ID
        const newAgentId = await registry.addressToAgentId(lender.address);
        console.log(`   Agent ID: ${newAgentId}\n`);
    }

    const poolAgentId = await registry.addressToAgentId(lender.address);

    console.log('🏦 Creating agent pool...\n');

    const feeData3 = await provider.getFeeData();
    const gasPrice3 = feeData3.gasPrice * 120n / 100n;

    const createPoolTx = await marketplace.connect(lender).createAgentPool({ gasPrice: gasPrice3 });
    const createPoolReceipt = await createPoolTx.wait();

    console.log(`   ✅ Pool created!`);
    console.log(`   📋 Tx: ${createPoolReceipt.hash}`);
    console.log(`   ⛽ Gas: ${createPoolReceipt.gasUsed.toString()}\n`);

    console.log('═'.repeat(70));
    console.log('STEP 4: SUPPLY LIQUIDITY');
    console.log('═'.repeat(70) + '\n');

    console.log(`💰 Supplying ${SUPPLY_AMOUNT} USDC to agent pool...\n`);

    const feeData4 = await provider.getFeeData();
    const gasPrice4 = feeData4.gasPrice * 120n / 100n;

    const supplyTx = await marketplace.connect(lender).supplyLiquidity(poolAgentId, ethers.parseUnits(SUPPLY_AMOUNT.toString(), 6), { gasPrice: gasPrice4 });
    const supplyReceipt = await supplyTx.wait();

    console.log(`   ✅ Liquidity supplied!`);
    console.log(`   📋 Tx: ${supplyReceipt.hash}`);
    console.log(`   ⛽ Gas: ${supplyReceipt.gasUsed.toString()}\n`);

    console.log('═'.repeat(70));
    console.log('LIQUIDITY SETUP COMPLETE');
    console.log('═'.repeat(70) + '\n');

    console.log(`🎯 Pool now has ${SUPPLY_AMOUNT} USDC available for loans!\n`);
}

main().catch(err => {
    console.error('\n❌ Setup failed:', err.message);
    console.error(err);
    process.exit(1);
});
