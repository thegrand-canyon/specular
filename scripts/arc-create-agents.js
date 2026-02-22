/**
 * Create Test Agents on Arc Testnet
 * Creates 4 agents with different profiles for testing
 */

const { ethers } = require('hardhat');
const fs = require('fs');
const path = require('path');

async function main() {
    console.log('\n🤖 CREATING TEST AGENTS ON ARC\n');
    console.log('═══════════════════════════════════════════════════════\n');

    const addressesPath = path.join(__dirname, '..', 'src', 'config', 'arc-testnet-addresses.json');
    const addresses = JSON.parse(fs.readFileSync(addressesPath, 'utf8'));

    const agentRegistry = await ethers.getContractAt('AgentRegistry', addresses.agentRegistry);
    const reputationManager = await ethers.getContractAt('ReputationManagerV3', addresses.reputationManagerV3);
    const usdc = await ethers.getContractAt('MockUSDC', addresses.mockUSDC);

    const [deployer] = await ethers.getSigners();

    // Agent profiles
    const agentProfiles = [
        { name: 'Alice', targetRep: 1000, initialUSDC: 50000, description: 'Elite agent, max reputation' },
        { name: 'Bob', targetRep: 700, initialUSDC: 30000, description: 'Good agent, reliable' },
        { name: 'Carol', targetRep: 500, initialUSDC: 20000, description: 'Average agent' },
        { name: 'Dave', targetRep: 100, initialUSDC: 10000, description: 'New agent, limited history' }
    ];

    const createdAgents = [];

    console.log(`Creating ${agentProfiles.length} test agents...\n`);

    for (const [index, profile] of agentProfiles.entries()) {
        console.log(`AGENT ${index + 1}/${agentProfiles.length}: ${profile.name}`);
        console.log(`   Profile: ${profile.description}`);
        console.log(`   Target Reputation: ${profile.targetRep}`);

        try {
            // Generate new wallet - fund with USDC for gas (Arc uses USDC as gas!)
            const wallet = ethers.Wallet.createRandom();
            const connectedWallet = wallet.connect(ethers.provider);

            // Fund with USDC for gas (0.1 USDC should be plenty)
            const gasAmount = ethers.parseEther('0.1'); // 0.1 USDC (18 decimals on Arc!)
            await deployer.sendTransaction({
                to: wallet.address,
                value: gasAmount
            });

            console.log(`   ✅ Wallet funded with gas: ${wallet.address}`);

            // Wait a bit for transaction to settle
            await new Promise(resolve => setTimeout(resolve, 5000));

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

            // Wait before reputation initialization
            await new Promise(resolve => setTimeout(resolve, 5000));

            // Initialize reputation
            try {
                await reputationManager.initializeAgentReputation(wallet.address, profile.targetRep);
                console.log(`   ✅ Reputation set to: ${profile.targetRep}`);
            } catch (error) {
                console.log(`   ⚠️  Reputation: ${error.message}`);
            }

            // Wait before minting USDC
            await new Promise(resolve => setTimeout(resolve, 5000));

            // Mint USDC (6 decimals - for pool token)
            const usdcAmount = ethers.parseUnits(profile.initialUSDC.toString(), 6);
            await usdc.mint(wallet.address, usdcAmount);
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

            // Longer delay before next agent
            if (index < agentProfiles.length - 1) {
                console.log('   ⏳ Waiting 10 seconds...\n');
                await new Promise(resolve => setTimeout(resolve, 10000));
            }

        } catch (error) {
            console.log(`   ❌ Failed: ${error.message}\n`);
        }
    }

    // Save all agents to file
    const agentsPath = path.join(__dirname, '..', 'arc-test-agents.json');
    fs.writeFileSync(agentsPath, JSON.stringify(createdAgents, null, 2));

    console.log('═══════════════════════════════════════════════════════\n');
    console.log('📊 AGENT CREATION SUMMARY\n');
    console.log(`Total Created: ${createdAgents.length}`);
    console.log('');

    createdAgents.forEach(agent => {
        console.log(`✅ ${agent.name}:`);
        console.log(`   - Agent ID: ${agent.agentId}`);
        console.log(`   - Address: ${agent.address}`);
        console.log(`   - Reputation: ${agent.targetRep}`);
        console.log('');
    });

    console.log(`📁 Saved to: arc-test-agents.json\n`);

    console.log('🎯 NEXT STEPS:\n');
    console.log('1. Create agent pools');
    console.log('2. Supply liquidity');
    console.log('3. Test lending!\n');

    console.log('✅ Agent creation complete! 🚀\n');
}

main().catch(error => {
    console.error('Error creating agents:', error);
    process.exit(1);
});
