/**
 * Create Simple Test Agents on Arc
 * Simplified version with better error handling
 */

const { ethers } = require('hardhat');
const fs = require('fs');
const path = require('path');

async function main() {
    console.log('\n🤖 CREATING TEST AGENTS ON ARC (SIMPLIFIED)\n');
    console.log('═══════════════════════════════════════════════════════\n');

    const addressesPath = path.join(__dirname, '..', 'src', 'config', 'arc-testnet-addresses.json');
    const addresses = JSON.parse(fs.readFileSync(addressesPath, 'utf8'));

    const agentRegistry = await ethers.getContractAt('AgentRegistry', addresses.agentRegistry);
    const reputationManager = await ethers.getContractAt('ReputationManagerV3', addresses.reputationManagerV3);
    const usdc = await ethers.getContractAt('MockUSDC', addresses.mockUSDC);

    const [deployer] = await ethers.getSigners();

    // Agent profiles
    const agentProfiles = [
        { name: 'Alice', targetRep: 1000, initialUSDC: 50000 },
        { name: 'Bob', targetRep: 700, initialUSDC: 30000 },
        { name: 'Carol', targetRep: 500, initialUSDC: 20000 },
        { name: 'Dave', targetRep: 100, initialUSDC: 10000 }
    ];

    const createdAgents = [];

    for (const [index, profile] of agentProfiles.entries()) {
        console.log(`AGENT ${index + 1}/4: ${profile.name}`);

        try {
            // Generate wallet
            const wallet = ethers.Wallet.createRandom();
            const connectedWallet = wallet.connect(ethers.provider);

            // Fund with USDC for gas (Arc uses USDC!)
            const gasAmount = ethers.parseEther('0.1');
            const fundTx = await deployer.sendTransaction({
                to: wallet.address,
                value: gasAmount
            });
            await fundTx.wait();
            console.log(`   ✅ Wallet: ${wallet.address.slice(0, 10)}...`);

            await new Promise(resolve => setTimeout(resolve, 5000));

            // Register agent
            const metadata = JSON.stringify({ name: profile.name });
            const registerTx = await agentRegistry.connect(connectedWallet).registerAgent(metadata);
            await registerTx.wait();

            // Get agentId by querying the mapping
            const agentId = await agentRegistry.addressToAgentId(wallet.address);
            console.log(`   ✅ Agent ID: ${agentId.toString()}`);

            await new Promise(resolve => setTimeout(resolve, 5000));

            // Initialize reputation
            await reputationManager.initializeAgentReputation(wallet.address, profile.targetRep);
            console.log(`   ✅ Reputation: ${profile.targetRep}`);

            await new Promise(resolve => setTimeout(resolve, 5000));

            // Mint USDC
            const usdcAmount = ethers.parseUnits(profile.initialUSDC.toString(), 6);
            await usdc.mint(wallet.address, usdcAmount);
            console.log(`   ✅ USDC: ${profile.initialUSDC.toLocaleString()}`);

            createdAgents.push({
                name: profile.name,
                address: wallet.address,
                privateKey: wallet.privateKey,
                agentId: agentId.toString(),
                targetRep: profile.targetRep,
                initialUSDC: profile.initialUSDC.toString()
            });

            console.log(`   ✅ ${profile.name} ready!\n`);

            if (index < agentProfiles.length - 1) {
                console.log('   ⏳ Waiting 10 seconds...\n');
                await new Promise(resolve => setTimeout(resolve, 10000));
            }

        } catch (error) {
            console.log(`   ❌ Failed: ${error.message}\n`);
        }
    }

    // Save agents
    const agentsPath = path.join(__dirname, '..', 'arc-test-agents.json');
    fs.writeFileSync(agentsPath, JSON.stringify(createdAgents, null, 2));

    console.log('═══════════════════════════════════════════════════════\n');
    console.log(`✅ Created ${createdAgents.length}/4 agents\n`);

    createdAgents.forEach(agent => {
        console.log(`${agent.name}: Agent ID ${agent.agentId}, Rep ${agent.targetRep}`);
    });

    console.log(`\n📁 Saved to: arc-test-agents.json\n`);
    console.log('✅ Done! 🚀\n');
}

main().catch(console.error);
