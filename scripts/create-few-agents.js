/**
 * Create a Few More Test Agents
 * Creates 3 additional agents with delays to avoid nonce issues
 */

const { ethers } = require('hardhat');
const fs = require('fs');
const path = require('path');

async function main() {
    console.log('\n🤖 CREATING ADDITIONAL TEST AGENTS\n');
    console.log('═══════════════════════════════════════════════════════\n');

    const addressesPath = path.join(__dirname, '..', 'src', 'config', 'sepolia-addresses.json');
    const addresses = JSON.parse(fs.readFileSync(addressesPath, 'utf8'));

    const agentRegistry = await ethers.getContractAt('AgentRegistry', addresses.agentRegistry);
    const reputationManager = await ethers.getContractAt('ReputationManagerV3', addresses.reputationManagerV3);
    const usdc = await ethers.getContractAt('MockUSDC', addresses.mockUSDC);

    const [deployer] = await ethers.getSigners();

    // Load existing agents
    const testAgentsPath = path.join(__dirname, '..', 'test-agents.json');
    const existingAgents = JSON.parse(fs.readFileSync(testAgentsPath, 'utf8'));

    // Profiles for 3 new agents
    const agentProfiles = [
        { name: 'Elite-Emma', targetRep: 950, initialUSDC: 100000, description: 'Elite borrower, perfect history' },
        { name: 'Good-Grace', targetRep: 800, initialUSDC: 60000, description: 'Good borrower, reliable' },
        { name: 'Risky-Noah', targetRep: 100, initialUSDC: 5000, description: 'Risky borrower, potential defaulter' }
    ];

    const createdAgents = [];

    for (const [index, profile] of agentProfiles.entries()) {
        console.log(`AGENT ${index + 1}/3: ${profile.name}`);
        console.log(`   Profile: ${profile.description}`);
        console.log(`   Target Reputation: ${profile.targetRep}`);

        try {
            // Generate new wallet
            const wallet = ethers.Wallet.createRandom();
            const connectedWallet = wallet.connect(ethers.provider);

            // Fund with ETH
            const ethAmount = ethers.parseEther('0.05');
            const fundTx = await deployer.sendTransaction({
                to: wallet.address,
                value: ethAmount
            });
            await fundTx.wait();

            console.log(`   ✅ Wallet funded: ${wallet.address}`);

            // Wait 10 seconds
            await new Promise(resolve => setTimeout(resolve, 10000));

            // Register agent
            const metadata = JSON.stringify({
                name: profile.name,
                type: 'test-agent',
                profile: profile.description,
                targetReputation: profile.targetRep,
                created: new Date().toISOString()
            });

            const registerTx = await agentRegistry.connect(connectedWallet).registerAgent(metadata);
            const receipt = await registerTx.wait();

            // Get agent ID
            const registeredEvent = receipt.logs.find(log => {
                try {
                    const parsed = agentRegistry.interface.parseLog(log);
                    return parsed?.name === 'AgentRegistered';
                } catch { return false; }
            });

            const agentId = registeredEvent
                ? agentRegistry.interface.parseLog(registeredEvent).args.agentId.toString()
                : 'unknown';

            console.log(`   ✅ Registered as Agent ID: ${agentId}`);

            // Wait 10 seconds
            await new Promise(resolve => setTimeout(resolve, 10000));

            // Initialize reputation
            try {
                const repTx = await reputationManager.initializeAgentReputation(wallet.address, profile.targetRep);
                await repTx.wait();
                console.log(`   ✅ Reputation set to: ${profile.targetRep}`);
            } catch (error) {
                console.log(`   ⚠️  Reputation initialization: ${error.message}`);
            }

            // Wait 10 seconds
            await new Promise(resolve => setTimeout(resolve, 10000));

            // Mint USDC
            const usdcAmount = ethers.parseUnits(profile.initialUSDC.toString(), 6);
            const mintTx = await usdc.mint(wallet.address, usdcAmount);
            await mintTx.wait();
            console.log(`   ✅ Minted ${profile.initialUSDC.toLocaleString()} USDC`);

            // Save agent info
            createdAgents.push({
                name: profile.name,
                address: wallet.address,
                privateKey: wallet.privateKey,
                agentId: agentId,
                targetRep: profile.targetRep,
                initialUSDC: profile.initialUSDC.toString(),
                created: new Date().toISOString()
            });

            console.log(`   ✅ ${profile.name} created successfully!\n`);

            // Wait 15 seconds before next agent
            if (index < agentProfiles.length - 1) {
                console.log('   ⏳ Waiting 15 seconds before next agent...\n');
                await new Promise(resolve => setTimeout(resolve, 15000));
            }

        } catch (error) {
            console.log(`   ❌ Failed: ${error.message}\n`);
        }
    }

    // Add new agents to existing list
    const allAgents = [...existingAgents, ...createdAgents];

    // Save updated list
    fs.writeFileSync(testAgentsPath, JSON.stringify(allAgents, null, 2));

    console.log('═══════════════════════════════════════════════════════\n');
    console.log('📊 SUMMARY\n');
    console.log(`New Agents Created: ${createdAgents.length}`);
    console.log(`Total Agents: ${allAgents.length}`);
    console.log('');

    createdAgents.forEach(agent => {
        console.log(`✅ ${agent.name} (ID: ${agent.agentId})`);
    });

    console.log(`\n📁 Updated test-agents.json with ${allAgents.length} total agents\n`);
    console.log('✅ Agent creation complete! 🚀\n');
}

main().catch(error => {
    console.error('Error:', error);
    process.exit(1);
});
