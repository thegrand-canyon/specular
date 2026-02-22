/**
 * Cross-Protocol Agent Discovery Example
 *
 * This example demonstrates how ERC-8004 compliance enables agents to be
 * discovered and verified across multiple protocols using their NFT-based
 * identity and portable reputation.
 */

const { ethers } = require('hardhat');

async function main() {
    console.log('\n=== ERC-8004 Cross-Protocol Agent Discovery ===\n');

    // Get signers
    const [deployer, agent1, agent2, externalProtocol, client1] = await ethers.getSigners();

    console.log('Deploying contracts...');

    // Deploy V2 contracts
    const AgentRegistryV2 = await ethers.getContractFactory('AgentRegistryV2');
    const agentRegistry = await AgentRegistryV2.deploy();
    await agentRegistry.waitForDeployment();

    const ReputationManagerV2 = await ethers.getContractFactory('ReputationManagerV2');
    const reputationManager = await ReputationManagerV2.deploy(await agentRegistry.getAddress());
    await reputationManager.waitForDeployment();

    const ValidationRegistry = await ethers.getContractFactory('ValidationRegistry');
    const validationRegistry = await ValidationRegistry.deploy(await agentRegistry.getAddress());
    await validationRegistry.waitForDeployment();

    console.log(`\nContracts deployed:`);
    console.log(`- AgentRegistry: ${await agentRegistry.getAddress()}`);
    console.log(`- ReputationManager: ${await reputationManager.getAddress()}`);
    console.log(`- ValidationRegistry: ${await validationRegistry.getAddress()}`);

    // ==================================================================
    // SCENARIO 1: Agent Registration with Rich Metadata
    // ==================================================================
    console.log('\n\n--- Scenario 1: Agent Registration with Rich Metadata ---');

    const agentMetadata = [
        { key: 'name', value: ethers.toUtf8Bytes('QuantumTrader Alpha') },
        { key: 'version', value: ethers.toUtf8Bytes('2.0.0') },
        { key: 'protocol', value: ethers.toUtf8Bytes('Specular') },
        { key: 'capabilities', value: ethers.toUtf8Bytes(JSON.stringify(['trading', 'risk-analysis', 'lending'])) },
        { key: 'model', value: ethers.toUtf8Bytes('GPT-4') },
        { key: 'license', value: ethers.toUtf8Bytes('MIT') },
        { key: 'contact', value: ethers.toUtf8Bytes('quantum@tradingai.eth') }
    ];

    const tx1 = await agentRegistry.connect(agent1).register(
        'ipfs://QmQuantumTraderMetadata',
        agentMetadata
    );
    await tx1.wait();

    const agent1Id = await agentRegistry.addressToAgentId(agent1.address);
    console.log(`\nAgent registered with NFT ID: ${agent1Id}`);
    console.log(`Agent address: ${agent1.address}`);
    console.log(`Agent URI: ipfs://QmQuantumTraderMetadata`);

    // Initialize reputation
    await reputationManager.connect(agent1)['initializeReputation(address)'](agent1.address);
    console.log('Reputation initialized with score: 100');

    // ==================================================================
    // SCENARIO 2: External Protocol Discovery
    // ==================================================================
    console.log('\n\n--- Scenario 2: External Protocol Discovers Agent ---');

    console.log('\nExternal protocol (e.g., DeFi marketplace) discovers agent by ID...');

    // External protocol queries agent info
    const agentInfo = await agentRegistry.getAgentInfoById(agent1Id);
    console.log(`\nAgent Info (read-only, no authentication needed):`);
    console.log(`  - Owner: ${agentInfo.owner}`);
    console.log(`  - Agent URI: ${agentInfo.agentURI}`);
    console.log(`  - Active: ${agentInfo.isActive}`);

    // Format timestamp if available
    if (agentInfo.registeredAt && Number(agentInfo.registeredAt) > 0) {
        console.log(`  - Registered: ${new Date(Number(agentInfo.registeredAt) * 1000).toISOString()}`);
    }

    // Read agent metadata
    console.log('\nAgent Metadata:');
    const name = ethers.toUtf8String(await agentRegistry.getMetadata(agent1Id, 'name'));
    const version = ethers.toUtf8String(await agentRegistry.getMetadata(agent1Id, 'version'));
    const capabilities = JSON.parse(ethers.toUtf8String(await agentRegistry.getMetadata(agent1Id, 'capabilities')));
    const model = ethers.toUtf8String(await agentRegistry.getMetadata(agent1Id, 'model'));

    console.log(`  - Name: ${name}`);
    console.log(`  - Version: ${version}`);
    console.log(`  - Model: ${model}`);
    console.log(`  - Capabilities: ${capabilities.join(', ')}`);

    // ==================================================================
    // SCENARIO 3: Cross-Protocol Reputation Query
    // ==================================================================
    console.log('\n\n--- Scenario 3: Cross-Protocol Reputation Access ---');

    console.log('\nExternal protocol queries agent reputation (read-only)...');

    const reputation = await reputationManager['getReputationScore(uint256)'](agent1Id);
    const creditLimit = await reputationManager['calculateCreditLimit(uint256)'](agent1Id);
    const collateralReq = await reputationManager['calculateCollateralRequirement(uint256)'](agent1Id);

    console.log(`\nReputation Data:`);
    console.log(`  - Reputation Score: ${reputation}/1000`);
    console.log(`  - Credit Limit: ${ethers.formatUnits(creditLimit, 6)} USDC`);
    console.log(`  - Collateral Requirement: ${collateralReq}%`);

    // ==================================================================
    // SCENARIO 4: Feedback Across Protocols
    // ==================================================================
    console.log('\n\n--- Scenario 4: Cross-Protocol Feedback System ---');

    console.log('\nClient from external protocol gives feedback...');

    await reputationManager.connect(client1).giveFeedback(
        agent1Id,
        90,
        0,
        'external-protocol-task',
        'excellent',
        'https://api.external-protocol.com',
        'ipfs://QmFeedbackHash',
        ethers.ZeroHash
    );

    console.log('Feedback submitted from external protocol client');

    // Query all feedback (accessible to any protocol)
    const feedbackList = await reputationManager.readAllFeedback(agent1Id, [], []);
    console.log(`\nTotal Feedback Entries: ${feedbackList.length}`);

    const summary = await reputationManager.getSummary(agent1Id, [], []);
    console.log(`Feedback Summary:`);
    console.log(`  - Count: ${summary.count}`);
    console.log(`  - Average: ${summary.averageValue}`);
    console.log(`  - Min: ${summary.minValue}`);
    console.log(`  - Max: ${summary.maxValue}`);

    // ==================================================================
    // SCENARIO 5: Third-Party Validation Discovery
    // ==================================================================
    console.log('\n\n--- Scenario 5: Third-Party Validation Discovery ---');

    // Setup validator
    await validationRegistry.connect(deployer).approveValidator(
        externalProtocol.address,
        'ipfs://ExternalValidatorMetadata'
    );

    console.log('\nExternal validator approved');

    // Agent requests validation
    const validationTx = await validationRegistry.connect(agent1).validationRequest(
        externalProtocol.address,
        agent1Id,
        'ipfs://ValidationRequest',
        ethers.ZeroHash
    );
    const validationReceipt = await validationTx.wait();

    // Get request hash from event
    const validationEvent = validationReceipt.logs.find(log => {
        try {
            const parsed = validationRegistry.interface.parseLog(log);
            return parsed.name === 'ValidationRequested';
        } catch (e) {
            return false;
        }
    });
    const requestHash = validationRegistry.interface.parseLog(validationEvent).args.requestHash;

    console.log('Validation requested');

    // Validator responds
    await validationRegistry.connect(externalProtocol).validationResponse(
        requestHash,
        95,
        'ipfs://ValidationProof',
        ethers.ZeroHash,
        'code-execution'
    );

    console.log('Validator approved with score: 95/100');

    // Any protocol can query validation status
    const validation = await validationRegistry.validations(requestHash);
    console.log(`\nValidation Status:`);
    console.log(`  - Status: ${['PENDING', 'APPROVED', 'REJECTED', 'DISPUTED'][validation.status]}`);
    console.log(`  - Score: ${validation.responseScore}/100`);
    console.log(`  - Tag: ${validation.tag}`);

    // ==================================================================
    // SCENARIO 6: Agent Discovery by Capabilities
    // ==================================================================
    console.log('\n\n--- Scenario 6: Agent Discovery by Capabilities ---');

    // Register another agent with different capabilities
    const agent2Metadata = [
        { key: 'name', value: ethers.toUtf8Bytes('RiskGuard Beta') },
        { key: 'capabilities', value: ethers.toUtf8Bytes(JSON.stringify(['risk-analysis', 'compliance', 'reporting'])) },
        { key: 'protocol', value: ethers.toUtf8Bytes('Specular') }
    ];

    await agentRegistry.connect(agent2).register('ipfs://RiskGuardMetadata', agent2Metadata);
    const agent2Id = await agentRegistry.addressToAgentId(agent2.address);

    console.log('\nSecond agent registered');

    // External protocol discovers all agents in registry
    const totalAgents = await agentRegistry.totalAgents();
    console.log(`\nTotal agents in registry: ${totalAgents}`);

    console.log('\nAgent Directory:');
    for (let id = 1; id <= totalAgents; id++) {
        const info = await agentRegistry.getAgentInfoById(id);
        const name = ethers.toUtf8String(await agentRegistry.getMetadata(id, 'name'));
        const capsBytes = await agentRegistry.getMetadata(id, 'capabilities');
        let caps = [];
        if (capsBytes !== '0x') {
            caps = JSON.parse(ethers.toUtf8String(capsBytes));
        }

        console.log(`\nAgent #${id}:`);
        console.log(`  - Name: ${name}`);
        console.log(`  - Owner: ${info.owner}`);
        console.log(`  - Capabilities: ${caps.join(', ')}`);
        console.log(`  - Active: ${info.isActive}`);
    }

    // ==================================================================
    // SCENARIO 7: NFT Transfer & Identity Portability
    // ==================================================================
    console.log('\n\n--- Scenario 7: Agent Identity Transfer ---');

    console.log(`\nAgent #${agent1Id} current owner: ${agent1.address}`);

    // Transfer agent NFT to different owner
    await agentRegistry.connect(agent1).transferFrom(agent1.address, agent2.address, agent1Id);

    console.log(`Agent #${agent1Id} transferred to: ${agent2.address}`);

    // Reputation and history remain attached to the NFT ID
    const reputationAfterTransfer = await reputationManager['getReputationScore(uint256)'](agent1Id);
    const feedbackAfterTransfer = await reputationManager.readAllFeedback(agent1Id, [], []);

    console.log(`\nReputation remains with NFT ID:`);
    console.log(`  - Score: ${reputationAfterTransfer}/1000`);
    console.log(`  - Feedback entries: ${feedbackAfterTransfer.length}`);
    console.log(`\nNew owner can now operate the agent while maintaining full history!`);

    // ==================================================================
    // SUMMARY
    // ==================================================================
    console.log('\n\n=== Summary: ERC-8004 Cross-Protocol Benefits ===\n');

    console.log('✅ Agent Discovery: Any protocol can discover agents by NFT ID');
    console.log('✅ Portable Identity: Agent NFTs can be transferred while keeping history');
    console.log('✅ Cross-Protocol Reputation: Reputation accessible to all protocols');
    console.log('✅ Unified Feedback: Feedback from multiple protocols aggregated on-chain');
    console.log('✅ Third-Party Validation: Independent validators verify agent performance');
    console.log('✅ Rich Metadata: Flexible key-value storage for agent capabilities');
    console.log('✅ Interoperability: Standard interface enables ecosystem growth');

    console.log('\n=== Example Complete ===\n');
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
