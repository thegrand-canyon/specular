require('dotenv').config();
const { ethers } = require('ethers');
const SpecularAgentV2 = require('../src/SpecularAgentV2');
const fs = require('fs');
const path = require('path');

async function main() {
    console.log('╔════════════════════════════════════════════════════════╗');
    console.log('║   Specular Protocol V2 - ERC-8004 Demo                ║');
    console.log('╚════════════════════════════════════════════════════════╝\n');

    // Setup provider and wallets
    const provider = new ethers.JsonRpcProvider('http://127.0.0.1:8545');

    // Agent 1 (borrower)
    const wallet1 = new ethers.Wallet(
        '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
        provider
    );

    // Agent 2 (feedback provider)
    const wallet2 = new ethers.Wallet(
        '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
        provider
    );

    console.log(`Agent 1 (Borrower): ${wallet1.address}`);
    console.log(`Agent 2 (Lender):   ${wallet2.address}\n`);

    // Load contract addresses
    const addressesPath = path.join(__dirname, '../src/config/contractAddresses.json');
    const allAddresses = JSON.parse(fs.readFileSync(addressesPath, 'utf8'));
    const contractAddresses = allAddresses['localhost'].contracts;

    // ========== Part 1: ERC-8004 Agent Registration ==========

    console.log('═══════════════════════════════════════════════════════');
    console.log('  PART 1: ERC-8004 Identity Registry (NFT-based)');
    console.log('═══════════════════════════════════════════════════════\n');

    const agent1 = new SpecularAgentV2(wallet1, contractAddresses);

    // Register agent with NFT identity and metadata
    console.log('📝 Registering Agent 1 with ERC-8004 NFT identity...\n');

    const agentURI = 'ipfs://QmExample123/agent1-metadata.json'; // Would be real IPFS in production

    const metadata = {
        name: 'TradingBot Alpha',
        version: '2.0.0',
        capabilities: ['automated-trading', 'risk-analysis', 'portfolio-management'],
        model: 'GPT-4',
        endpoint: 'https://api.example.com/agent1',
        timestamp: Date.now()
    };

    const result = await agent1.register(agentURI, metadata);

    console.log('✅ Agent 1 registered successfully!');
    console.log(`   Agent NFT ID: ${result.agentId}`);
    console.log(`   Transaction: ${result.txHash}`);
    console.log(`   Metadata URI: ${agentURI}\n`);

    console.log('💡 Custom metadata can be set using setMetadata():');
    console.log('   - License information');
    console.log('   - Contact details');
    console.log('   - Service endpoints');
    console.log('   - Certifications\n');

    // ========== Part 2: Reputation & Feedback System ==========

    console.log('═══════════════════════════════════════════════════════');
    console.log('  PART 2: ERC-8004 Reputation Registry');
    console.log('═══════════════════════════════════════════════════════\n');

    // Check reputation
    console.log('📊 Checking Agent 1 reputation...');
    const reputation = await agent1.getFormattedReputation();
    console.log(`   Score: ${reputation.display}`);

    const creditLimit = await agent1.getCreditLimit();
    console.log(`   Credit Limit: ${creditLimit} USDC\n`);

    // Request and process a loan
    console.log('💰 Agent 1 requesting loan...');
    const loanAmount = 1000;
    const loanDuration = 30;

    const loanId = await agent1.requestLoan(loanAmount, loanDuration);
    console.log(`✅ Loan requested! Loan ID: ${loanId}\n`);

    // Get loan status
    const loanStatus = await agent1.getLoanStatus(loanId);
    console.log('📋 Loan Status:');
    console.log(`   State: ${loanStatus.state}`);
    console.log(`   Amount: ${loanStatus.amount} USDC`);
    console.log(`   Duration: ${loanStatus.durationDays} days`);
    console.log(`   Collateral: ${loanStatus.collateralAmount} USDC\n`);

    // ========== Part 3: ERC-8004 Feedback System ==========

    console.log('═══════════════════════════════════════════════════════');
    console.log('  PART 3: Cross-Agent Feedback (ERC-8004)');
    console.log('═══════════════════════════════════════════════════════\n');

    // Register Agent 2 (feedback provider)
    console.log('📝 Registering Agent 2...');
    const agent2 = new SpecularAgentV2(wallet2, contractAddresses);

    const agent2URI = 'ipfs://QmExample456/agent2-metadata.json';
    const agent2Result = await agent2.register(agent2URI, {
        name: 'LendingBot Beta',
        version: '1.0.0',
        capabilities: ['liquidity-provision', 'risk-assessment']
    });

    console.log(`✅ Agent 2 registered! NFT ID: ${agent2Result.agentId}\n`);

    // Agent 2 gives feedback to Agent 1
    console.log('💬 Agent 2 submitting feedback for Agent 1...');

    const agent1Id = await agent1.getAgentId();

    const feedbackResult = await agent2.giveFeedback(agent1Id, 85, {
        tag1: 'loan-request',
        tag2: 'professional',
        endpoint: loanStatus.state,
        feedbackURI: 'ipfs://QmFeedback123'
    });

    console.log(`✅ Feedback submitted!`);
    console.log(`   Feedback Hash: ${feedbackResult.feedbackHash}`);
    console.log(`   Score: 85/100\n`);

    // Read feedback
    console.log('📖 Reading feedback...');
    const feedback = await agent1.erc8004.readFeedback(feedbackResult.feedbackHash);
    console.log(`   From: ${feedback.clientAddress}`);
    console.log(`   Score: ${feedback.value}/${100}`);
    console.log(`   Tags: ${feedback.tag1}, ${feedback.tag2}`);
    console.log(`   Timestamp: ${new Date(feedback.timestamp * 1000).toISOString()}\n`);

    // Get all feedback for Agent 1
    console.log('📊 Getting all feedback for Agent 1...');
    const allFeedback = await agent1.getFeedback();
    console.log(`   Total feedback entries: ${allFeedback.length}\n`);

    // Get feedback summary
    console.log('📈 Feedback summary:');
    const feedbackSummary = await agent1.getFeedbackSummary();
    console.log(`   Count: ${feedbackSummary.count}`);
    console.log(`   Average: ${feedbackSummary.averageValue}/100`);
    console.log(`   Min: ${feedbackSummary.minValue}/100`);
    console.log(`   Max: ${feedbackSummary.maxValue}/100\n`);

    // Agent 1 responds to feedback
    console.log('💬 Agent 1 responding to feedback...');
    await agent1.respondToFeedback(
        feedbackResult.feedbackHash,
        'Thank you for the feedback! We appreciate your business.'
    );
    console.log('✅ Response added\n');

    // ========== Part 4: Validation Registry ==========

    console.log('═══════════════════════════════════════════════════════');
    console.log('  PART 4: ERC-8004 Validation Registry');
    console.log('═══════════════════════════════════════════════════════\n');

    console.log('📋 Note: Validation requires approved validators.');
    console.log('   In production, third-party validators would:');
    console.log('   - Re-execute agent tasks');
    console.log('   - Verify loan repayments');
    console.log('   - Provide cryptoeconomic guarantees\n');

    // Get approved validators
    const validators = await agent1.getApprovedValidators();
    console.log(`   Currently approved validators: ${validators.length}\n`);

    if (validators.length > 0) {
        console.log(`💡 Requesting validation from ${validators[0]}...`);

        const validationResult = await agent1.requestValidation(validators[0], {
            requestURI: 'ipfs://QmValidationRequest123'
        });

        console.log(`✅ Validation requested!`);
        console.log(`   Request Hash: ${validationResult.requestHash}\n`);

        // Check validation status
        const validationStatus = await agent1.getValidationStatus(validationResult.requestHash);
        console.log('📋 Validation Status:');
        console.log(`   Status: ${validationStatus.status}`);
        console.log(`   Validator: ${validationStatus.validatorAddress}\n`);
    }

    // ========== Part 5: NFT Ownership & Transfer ==========

    console.log('═══════════════════════════════════════════════════════');
    console.log('  PART 5: Agent NFT Ownership (ERC-721)');
    console.log('═══════════════════════════════════════════════════════\n');

    const owner = await agent1.getAgentOwner();
    console.log(`👤 Agent 1 NFT Owner: ${owner}`);
    console.log(`   Owned by: ${owner === wallet1.address ? 'Agent 1 (Self)' : 'Other'}\n`);

    console.log('💡 Agent identities are ERC-721 NFTs and can be:');
    console.log('   - Transferred to other addresses');
    console.log('   - Listed on NFT marketplaces');
    console.log('   - Used as collateral in other protocols');
    console.log('   - Integrated with DAO governance\n');

    // ========== Part 6: Cross-Protocol Interoperability ==========

    console.log('═══════════════════════════════════════════════════════');
    console.log('  PART 6: ERC-8004 Interoperability');
    console.log('═══════════════════════════════════════════════════════\n');

    console.log('🌐 With ERC-8004 compliance, Specular agents can:');
    console.log('   ✅ Be discovered by other ERC-8004 platforms');
    console.log('   ✅ Port reputation across different protocols');
    console.log('   ✅ Participate in multi-protocol agent economies');
    console.log('   ✅ Receive validation from third-party services');
    console.log('   ✅ Build composable agent networks\n');

    console.log('📖 Example use cases:');
    console.log('   - Agent builds reputation on Specular');
    console.log('   - Uses same NFT identity for task marketplace');
    console.log('   - Validators verify performance across platforms');
    console.log('   - Reputation aggregates from multiple sources');
    console.log('   - Agent participates in DAO voting with NFT\n');

    console.log('╔════════════════════════════════════════════════════════╗');
    console.log('║   ERC-8004 Demo Complete!                              ║');
    console.log('╚════════════════════════════════════════════════════════╝\n');

    console.log('📊 Summary:');
    console.log(`   - ${2} agents registered with NFT identities`);
    console.log(`   - ${1} loan requested`);
    console.log(`   - ${allFeedback.length} feedback entries`);
    console.log(`   - ERC-8004 fully compliant ✅\n`);
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error('\n❌ Error:', error.message);
        console.error(error);
        process.exit(1);
    });
