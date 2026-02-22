/**
 * Setup pools for Agents 2 and 3
 */

const { ethers } = require('ethers');
const fs = require('fs');

const RPC_URL = 'https://arc-testnet.drpc.org';

const AGENTS = [
    {
        name: 'Agent 2',
        key: '0x41adb1d6ef22647a3de0e7993f4e33ec7bcd5b49359587967750ff8f3faddf67',
        liquidity: 500, // USDC to supply
    },
    {
        name: 'Agent 3',
        key: '0xebd981dcdb6f6f4c8744a40a937f7b75de400290c58c2728cfff0d2af2418452',
        liquidity: 500,
    },
];

async function main() {
    console.log('\n╔══════════════════════════════════════════════════╗');
    console.log('║    SETUP AGENT POOLS - ARC TESTNET            ║');
    console.log('╚══════════════════════════════════════════════════╝\n');

    const provider = new ethers.JsonRpcProvider(RPC_URL, undefined, { batchMaxCount: 1 });

    const addresses = JSON.parse(
        fs.readFileSync('./src/config/arc-testnet-addresses.json', 'utf8')
    );

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

    const registryAbi = loadAbi('AgentRegistryV2');
    const marketplaceAbi = loadAbi('AgentLiquidityMarketplace');
    const usdcAbi = loadAbi('MockUSDC');

    for (const agentConfig of AGENTS) {
        console.log(`\n${agentConfig.name}:`);
        console.log('═'.repeat(60));

        const wallet = new ethers.Wallet(agentConfig.key, provider);
        const registry = new ethers.Contract(addresses.agentRegistryV2, registryAbi, provider);
        const marketplace = new ethers.Contract(addresses.agentLiquidityMarketplace, marketplaceAbi, wallet);
        const usdc = new ethers.Contract(addresses.mockUSDC, usdcAbi, wallet);

        console.log(`Address: ${wallet.address}`);

        const agentId = await registry.addressToAgentId(wallet.address);
        console.log(`Agent ID: ${agentId}`);

        // Check if pool exists
        const pool = await marketplace.getAgentPool(agentId);
        if (Number(pool.totalLiquidity) > 0) {
            console.log(`✅ Pool already exists (${ethers.formatUnits(pool.totalLiquidity, 6)} USDC)\n`);
            continue;
        }

        // Create pool
        console.log('Creating pool...');
        let nonce = await provider.getTransactionCount(wallet.address);

        try {
            const createTx = await marketplace.createAgentPool({ nonce });
            await createTx.wait();
            console.log('✅ Pool created');
        } catch (error) {
            console.log(`⚠️  Pool creation: ${error.message.split('\n')[0]}`);
        }

        // Approve USDC
        console.log('Approving USDC...');
        nonce = await provider.getTransactionCount(wallet.address);
        await usdc.approve(addresses.agentLiquidityMarketplace, ethers.parseUnits('10000', 6), { nonce });
        console.log('✅ Approved');

        // Supply liquidity
        console.log(`Supplying ${agentConfig.liquidity} USDC...`);
        nonce = await provider.getTransactionCount(wallet.address);

        try {
            const supplyTx = await marketplace.supplyLiquidity(
                agentId,
                ethers.parseUnits(agentConfig.liquidity.toString(), 6),
                { nonce }
            );
            await supplyTx.wait();
            console.log('✅ Liquidity supplied');
        } catch (error) {
            console.log(`❌ Failed: ${error.message.split('\n')[0]}`);
        }

        // Verify pool state
        const poolAfter = await marketplace.getAgentPool(agentId);
        console.log(`\nPool Status:`);
        console.log(`  Total Liquidity: ${ethers.formatUnits(poolAfter.totalLiquidity, 6)} USDC`);
        console.log(`  Available: ${ethers.formatUnits(poolAfter.availableLiquidity, 6)} USDC`);
    }

    console.log('\n' + '═'.repeat(60));
    console.log('Setup complete!\n');
}

main().catch(err => {
    console.error('\n❌ Setup failed:', err.message);
    console.error(err);
    process.exit(1);
});
