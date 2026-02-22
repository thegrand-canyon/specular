/**
 * Setup Fresh Agents for Quantity Testing
 *
 * Creates and funds 3 new agents with clean state:
 * 1. Generate new wallets
 * 2. Fund with ETH from Agent 1
 * 3. Mint USDC for testing
 * 4. Register as agents
 */

const { ethers } = require('ethers');
const fs = require('fs');

const AGENT1_KEY = process.env.PRIVATE_KEY || '0x0000000000000000000000000000000000000000000000000000000000000000'; // Has 177 ETH
const ETH_PER_AGENT = '1.0'; // 1 ETH each for gas
const USDC_PER_AGENT = '10000'; // 10k USDC each

async function main() {
    console.log('\n🆕 SETTING UP FRESH AGENTS FOR QUANTITY TEST\n');

    const provider = new ethers.JsonRpcProvider('https://arc-testnet.drpc.org', undefined, { batchMaxCount: 1 });
    const funder = new ethers.Wallet(AGENT1_KEY, provider);

    console.log(`Funder (Agent 1): ${funder.address}`);
    const funderBal = await provider.getBalance(funder.address);
    console.log(`Funder ETH Balance: ${ethers.formatEther(funderBal)} ETH\n`);

    const addresses = JSON.parse(fs.readFileSync('./src/config/arc-testnet-addresses.json', 'utf8'));
    const registryAbi = JSON.parse(fs.readFileSync('./artifacts/contracts/core/AgentRegistryV2.sol/AgentRegistryV2.json', 'utf8')).abi;
    const usdcAbi = JSON.parse(fs.readFileSync('./artifacts/contracts/tokens/MockUSDC.sol/MockUSDC.json', 'utf8')).abi;

    const registry = new ethers.Contract(addresses.agentRegistryV2, registryAbi, funder);
    const usdc = new ethers.Contract(addresses.mockUSDC, usdcAbi, funder);

    const newAgents = [];

    console.log('═'.repeat(70));
    console.log('CREATING AND FUNDING NEW AGENTS');
    console.log('═'.repeat(70) + '\n');

    for (let i = 1; i <= 3; i++) {
        console.log(`\n🔧 Agent ${i}:`);
        console.log('-'.repeat(70));

        // Generate new wallet
        const wallet = ethers.Wallet.createRandom();
        console.log(`Address: ${wallet.address}`);
        console.log(`Private Key: ${wallet.privateKey}`);

        // Fund with ETH
        console.log(`\nFunding with ${ETH_PER_AGENT} ETH...`);
        try {
            const ethTx = await funder.sendTransaction({
                to: wallet.address,
                value: ethers.parseEther(ETH_PER_AGENT)
            });
            await ethTx.wait();
            console.log(`✅ ETH sent (tx: ${ethTx.hash.substring(0, 10)}...)`);
        } catch (error) {
            console.log(`❌ ETH transfer failed: ${error.message.substring(0, 60)}`);
            continue;
        }

        // Mint USDC
        console.log(`\nMinting ${USDC_PER_AGENT} USDC...`);
        try {
            const mintTx = await usdc.mint(wallet.address, ethers.parseUnits(USDC_PER_AGENT, 6));
            await mintTx.wait();
            console.log(`✅ USDC minted (tx: ${mintTx.hash.substring(0, 10)}...)`);
        } catch (error) {
            console.log(`❌ USDC mint failed: ${error.message.substring(0, 60)}`);
        }

        // Register as agent
        console.log(`\nRegistering as agent...`);
        try {
            const walletConnected = wallet.connect(provider);
            const registryConnected = new ethers.Contract(addresses.agentRegistryV2, registryAbi, walletConnected);

            const registerTx = await registryConnected.registerAgent(
                JSON.stringify({ name: `Fresh Agent ${i}`, purpose: 'quantity-testing', created: Date.now() })
            );
            await registerTx.wait();

            const agentInfo = await registry.getAgentInfo(wallet.address);
            const agentId = Number(agentInfo.agentId);

            console.log(`✅ Registered as Agent ID ${agentId}`);

            newAgents.push({
                name: `Fresh Agent ${i}`,
                id: agentId,
                address: wallet.address,
                privateKey: wallet.privateKey,
            });

        } catch (error) {
            console.log(`❌ Registration failed: ${error.message.substring(0, 60)}`);
        }

        console.log('');
    }

    console.log('═'.repeat(70));
    console.log('FRESH AGENTS SUMMARY');
    console.log('═'.repeat(70) + '\n');

    for (const agent of newAgents) {
        const bal = await provider.getBalance(agent.address);
        const usdcBal = await usdc.balanceOf(agent.address);

        console.log(`${agent.name} (ID ${agent.id}):`);
        console.log(`  Address: ${agent.address}`);
        console.log(`  Private Key: ${agent.privateKey}`);
        console.log(`  ETH: ${ethers.formatEther(bal)}`);
        console.log(`  USDC: ${ethers.formatUnits(usdcBal, 6)}`);
        console.log('');
    }

    // Save to file for quantity test
    const configPath = './fresh-agents-config.json';
    fs.writeFileSync(configPath, JSON.stringify({
        created: new Date().toISOString(),
        network: 'arc-testnet',
        agents: newAgents,
        ethPerAgent: ETH_PER_AGENT,
        usdcPerAgent: USDC_PER_AGENT,
    }, null, 2));

    console.log(`✅ Configuration saved to: ${configPath}\n`);
    console.log(`🎯 Ready for quantity test with ${newAgents.length} fresh agents!\n`);
}

main().catch(err => {
    console.error('\n❌ Setup failed:', err.message);
    console.error(err);
    process.exit(1);
});
