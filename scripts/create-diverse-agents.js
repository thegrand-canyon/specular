/**
 * Create Diverse Test Agent Portfolio
 * Creates 10 agents with different profiles for comprehensive testing
 */

const { ethers } = require('hardhat');
const fs = require('fs');
const path = require('path');

async function main() {
    console.log('\n🤖 CREATING DIVERSE TEST AGENT PORTFOLIO\n');
    console.log('═══════════════════════════════════════════════════════\n');

    const addressesPath = path.join(__dirname, '..', 'src', 'config', 'sepolia-addresses.json');
    const addresses = JSON.parse(fs.readFileSync(addressesPath, 'utf8'));

    const agentRegistry = await ethers.getContractAt('AgentRegistry', addresses.agentRegistry);
    const reputationManager = await ethers.getContractAt('ReputationManagerV3', addresses.reputationManagerV3);
    const usdc = await ethers.getContractAt('MockUSDC', addresses.mockUSDC);

    const [deployer] = await ethers.getSigners();

    // Agent profiles with different characteristics
    const agentProfiles = [
        // Elite agents - high reputation, large loans
        { name: 'Elite-Emma', targetRep: 950, initialUSDC: 100000, loanSize: 50000, description: 'Elite borrower, perfect history' },
        { name: 'Elite-Frank', targetRep: 900, initialUSDC: 80000, loanSize: 40000, description: 'Elite borrower, excellent history' },

        // Good agents - good reputation, medium-large loans
        { name: 'Good-Grace', targetRep: 800, initialUSDC: 60000, loanSize: 25000, description: 'Good borrower, reliable' },
        { name: 'Good-Henry', targetRep: 750, initialUSDC: 50000, loanSize: 20000, description: 'Good borrower, consistent' },

        // Average agents - medium reputation, varied loans
        { name: 'Average-Ivy', targetRep: 600, initialUSDC: 30000, loanSize: 10000, description: 'Average borrower, some history' },
        { name: 'Average-Jack', targetRep: 550, initialUSDC: 25000, loanSize: 8000, description: 'Average borrower, building credit' },
        { name: 'Average-Kelly', targetRep: 500, initialUSDC: 20000, loanSize: 5000, description: 'Average borrower, moderate risk' },

        // New agents - low reputation, small loans
        { name: 'New-Leo', targetRep: 200, initialUSDC: 10000, loanSize: 2000, description: 'New borrower, limited history' },
        { name: 'New-Maya', targetRep: 150, initialUSDC: 8000, loanSize: 1000, description: 'New borrower, just starting' },

        // Risky agent - will test defaults
        { name: 'Risky-Noah', targetRep: 100, initialUSDC: 5000, loanSize: 500, description: 'Risky borrower, potential defaulter' }
    ];

    const createdAgents = [];
    let successCount = 0;
    let skippedCount = 0;

    console.log(`Creating ${agentProfiles.length} diverse test agents...\n`);

    for (const [index, profile] of agentProfiles.entries()) {
        console.log(`AGENT ${index + 1}/${agentProfiles.length}: ${profile.name}`);
        console.log(`   Profile: ${profile.description}`);
        console.log(`   Target Reputation: ${profile.targetRep}`);
        console.log(`   Initial USDC: ${profile.initialUSDC.toLocaleString()}`);
        console.log(`   Typical Loan Size: ${profile.loanSize.toLocaleString()} USDC`);

        try {
            // Generate new wallet
            const wallet = ethers.Wallet.createRandom();
            const connectedWallet = wallet.connect(ethers.provider);

            // Fund with ETH
            const ethAmount = ethers.parseEther('0.05');
            await deployer.sendTransaction({
                to: wallet.address,
                value: ethAmount
            });

            console.log(`   ✅ Wallet created: ${wallet.address}`);

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

            // Initialize reputation
            try {
                await reputationManager.initializeAgentReputation(wallet.address, profile.targetRep);
                console.log(`   ✅ Reputation set to: ${profile.targetRep}`);
            } catch (error) {
                console.log(`   ⚠️  Reputation already initialized`);
            }

            // Mint USDC
            const usdcAmount = ethers.parseUnits(profile.initialUSDC.toString(), 6);
            await usdc.mint(wallet.address, usdcAmount);
            console.log(`   ✅ Minted ${profile.initialUSDC.toLocaleString()} USDC`);

            // Save agent info
            createdAgents.push({
                name: profile.name,
                address: wallet.address,
                privateKey: wallet.privateKey,
                agentId: agentId,
                profile: profile.description,
                targetRep: profile.targetRep,
                initialUSDC: profile.initialUSDC.toString(),
                typicalLoanSize: profile.loanSize.toString(),
                created: new Date().toISOString()
            });

            console.log(`   ✅ ${profile.name} created successfully!\n`);
            successCount++;

            // Small delay to avoid rate limits
            await new Promise(resolve => setTimeout(resolve, 2000));

        } catch (error) {
            console.log(`   ❌ Failed: ${error.message}\n`);
            skippedCount++;
        }
    }

    // Save all agents to file
    const agentsPath = path.join(__dirname, '..', 'diverse-test-agents.json');
    const agentsData = {
        agents: createdAgents,
        created: new Date().toISOString(),
        network: 'sepolia',
        totalAgents: createdAgents.length,
        summary: {
            elite: createdAgents.filter(a => a.targetRep >= 900).length,
            good: createdAgents.filter(a => a.targetRep >= 700 && a.targetRep < 900).length,
            average: createdAgents.filter(a => a.targetRep >= 400 && a.targetRep < 700).length,
            new: createdAgents.filter(a => a.targetRep >= 100 && a.targetRep < 400).length
        }
    };

    fs.writeFileSync(agentsPath, JSON.stringify(agentsData, null, 2));

    console.log('═══════════════════════════════════════════════════════\n');
    console.log('📊 AGENT CREATION SUMMARY\n');
    console.log(`Total Created: ${successCount}`);
    console.log(`Failed/Skipped: ${skippedCount}`);
    console.log('');
    console.log('📈 Agent Distribution:');
    console.log(`   Elite (900+):      ${agentsData.summary.elite} agents`);
    console.log(`   Good (700-899):    ${agentsData.summary.good} agents`);
    console.log(`   Average (400-699): ${agentsData.summary.average} agents`);
    console.log(`   New (100-399):     ${agentsData.summary.new} agents`);
    console.log('');
    console.log(`📁 Saved to: diverse-test-agents.json\n`);

    console.log('🎯 NEXT STEPS:\n');
    console.log('1. Create agent pools for each agent');
    console.log('2. Run diverse lending scenarios');
    console.log('3. Test reputation changes over time');
    console.log('4. Simulate defaults and recoveries\n');

    console.log('✅ Diverse agent portfolio ready for testing! 🚀\n');
}

main().catch(error => {
    console.error('Error creating agents:', error);
    process.exit(1);
});
