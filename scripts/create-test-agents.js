/**
 * Create Multiple Test Agents with Different Profiles
 */

const { ethers } = require('hardhat');
const fs = require('fs');
const path = require('path');

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
    console.log('\n👥 CREATING TEST AGENTS\n');
    console.log('═══════════════════════════════════════════════════════\n');

    const [deployer] = await ethers.getSigners();
    console.log('Deployer:', deployer.address);

    const addressesPath = path.join(__dirname, '..', 'src', 'config', 'sepolia-addresses.json');
    const addresses = JSON.parse(fs.readFileSync(addressesPath, 'utf8'));

    const agentRegistry = await ethers.getContractAt('AgentRegistryV2', addresses.agentRegistry);
    const reputationManager = await ethers.getContractAt('ReputationManagerV2', addresses.reputationManager);
    const usdc = await ethers.getContractAt('MockUSDC', addresses.mockUSDC);

    const agentProfiles = [
        { name: 'Alice', metadata: 'High Rep Agent', targetRep: 1000, initialUSDC: '50000' },
        { name: 'Bob', metadata: 'Medium Rep Agent', targetRep: 700, initialUSDC: '30000' },
        { name: 'Carol', metadata: 'Low Rep Agent', targetRep: 500, initialUSDC: '20000' },
        { name: 'Dave', metadata: 'New Agent', targetRep: 100, initialUSDC: '10000' }
    ];

    const testAgents = [];

    console.log('📋 Creating Wallets and Funding...\n');

    for (let i = 0; i < agentProfiles.length; i++) {
        const profile = agentProfiles[i];
        const wallet = ethers.Wallet.createRandom().connect(ethers.provider);

        console.log(`Agent ${i + 1}: ${profile.name}`);
        console.log('  Address:', wallet.address);

        console.log('  Funding with ETH...');
        const ethTx = await deployer.sendTransaction({
            to: wallet.address,
            value: ethers.parseEther('0.1')
        });
        await ethTx.wait();

        console.log('  Minting USDC...');
        const mintTx = await usdc.mint(wallet.address, ethers.parseUnits(profile.initialUSDC, 6));
        await mintTx.wait();

        testAgents.push({
            name: profile.name,
            wallet: wallet,
            address: wallet.address,
            privateKey: wallet.privateKey,
            targetRep: profile.targetRep,
            initialUSDC: profile.initialUSDC
        });

        console.log('  ✅ Funded\n');
        await sleep(2000);
    }

    console.log('═══════════════════════════════════════════════════════\n');
    console.log('📝 Registering Agents...\n');

    for (let i = 0; i < testAgents.length; i++) {
        const agent = testAgents[i];

        console.log(`${agent.name} (${agent.address.substring(0, 10)}...)`);

        const agentContract = agentRegistry.connect(agent.wallet);
        const registerTx = await agentContract.register(
            JSON.stringify({ name: agent.name, type: 'test' }),
            []
        );
        await registerTx.wait();

        const agentId = await agentRegistry.addressToAgentId(agent.address);
        agent.agentId = agentId;

        const repContract = reputationManager.connect(agent.wallet);
        const initTx = await repContract['initializeReputation(uint256)'](agentId);
        await initTx.wait();

        const reputation = await reputationManager['getReputationScore(address)'](agent.address);

        console.log('  Agent ID:', agentId.toString());
        console.log('  Initial Reputation:', reputation.toString());
        console.log('  ✅ Registered\n');

        await sleep(3000);
    }

    const testAgentsData = testAgents.map(a => ({
        name: a.name,
        address: a.address,
        privateKey: a.privateKey,
        agentId: a.agentId.toString(),
        targetRep: a.targetRep,
        initialUSDC: a.initialUSDC
    }));

    const testAgentsPath = path.join(__dirname, '..', 'test-agents.json');
    fs.writeFileSync(testAgentsPath, JSON.stringify(testAgentsData, null, 2));

    console.log('═══════════════════════════════════════════════════════\n');
    console.log('✅ Test Agents Created!\n');
    console.log('Saved to:', testAgentsPath);
    console.log('\n📊 Agent Summary:\n');

    for (const agent of testAgents) {
        console.log(`${agent.name}:`);
        console.log(`  Address: ${agent.address}`);
        console.log(`  Agent ID: ${agent.agentId}`);
        console.log(`  Target Rep: ${agent.targetRep}`);
        console.log(`  Initial USDC: ${agent.initialUSDC}`);
        console.log('');
    }

    console.log('🎯 Next: Build reputation');
    console.log('   npx hardhat run scripts/build-agent-reputation.js --network sepolia\n');
}

main().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); });
