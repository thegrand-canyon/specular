require('dotenv').config();
const { ethers } = require('ethers');
const SpecularAgent = require('../src/SpecularAgent');
const fs = require('fs');
const path = require('path');

async function main() {
    console.log('╔════════════════════════════════════════════════════════╗');
    console.log('║   Specular Protocol - Event Monitoring Example        ║');
    console.log('╚════════════════════════════════════════════════════════╝\n');

    // Setup provider and wallet
    const provider = new ethers.JsonRpcProvider('http://127.0.0.1:8545');
    const wallet = new ethers.Wallet(
        '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
        provider
    );

    console.log(`Agent address: ${wallet.address}\n`);

    // Load contract addresses
    const addressesPath = path.join(__dirname, '../src/config/contractAddresses.json');
    const allAddresses = JSON.parse(fs.readFileSync(addressesPath, 'utf8'));
    const contractAddresses = allAddresses['hardhat'].contracts || allAddresses['localhost'].contracts;

    // Create agent instance
    const agent = new SpecularAgent(wallet, contractAddresses);

    // Setup event listeners
    console.log('📡 Setting up event listeners...\n');

    agent.on('AgentRegistered', (data) => {
        console.log('🎉 Agent Registered!');
        console.log(`   Address: ${data.agent}`);
        console.log(`   Metadata: ${data.metadata}`);
        console.log(`   Time: ${new Date(Number(data.timestamp) * 1000).toISOString()}\n`);
    });

    agent.on('ReputationUpdated', (data) => {
        console.log('📊 Reputation Updated!');
        console.log(`   Agent: ${data.agent}`);
        console.log(`   New Score: ${data.newScore}/1000`);
        console.log(`   Reason: ${data.reason}\n`);
    });

    agent.on('LoanRequested', (data) => {
        console.log('💰 Loan Requested!');
        console.log(`   Loan ID: ${data.loanId}`);
        console.log(`   Borrower: ${data.borrower}`);
        console.log(`   Amount: ${ethers.formatUnits(data.amount, 6)} USDC`);
        console.log(`   Duration: ${data.durationDays} days\n`);
    });

    agent.on('LoanApproved', (data) => {
        console.log('✅ Loan Approved!');
        console.log(`   Loan ID: ${data.loanId}`);
        console.log(`   Interest Rate: ${(data.interestRate / 100).toFixed(2)}%\n`);
    });

    agent.on('LoanRepaid', (data) => {
        console.log('💵 Loan Repaid!');
        console.log(`   Loan ID: ${data.loanId}`);
        console.log(`   Borrower: ${data.borrower}`);
        console.log(`   Total Amount: ${ethers.formatUnits(data.totalAmount, 6)} USDC`);
        console.log(`   On Time: ${data.onTime ? 'Yes ✓' : 'No ✗'}\n`);
    });

    agent.on('LoanDefaulted', (data) => {
        console.log('⚠️  Loan Defaulted!');
        console.log(`   Loan ID: ${data.loanId}`);
        console.log(`   Borrower: ${data.borrower}\n`);
    });

    agent.on('LiquidityDeposited', (data) => {
        console.log('💎 Liquidity Deposited!');
        console.log(`   Provider: ${data.provider}`);
        console.log(`   Amount: ${ethers.formatUnits(data.amount, 6)} USDC\n`);
    });

    // Start listening
    await agent.startListening();
    console.log('✅ Event listener started\n');
    console.log('Monitoring blockchain events...');
    console.log('Press Ctrl+C to stop\n');

    // Optionally perform some actions to generate events
    console.log('💡 Tip: In another terminal, run basic-agent.js to generate events\n');

    // Keep the process running
    process.on('SIGINT', () => {
        console.log('\n\n📴 Stopping event listener...');
        agent.stopListening();
        console.log('✅ Event listener stopped');
        console.log('\n╔════════════════════════════════════════════════════════╗');
        console.log('║   Monitoring Complete!                                 ║');
        console.log('╚════════════════════════════════════════════════════════╝\n');
        process.exit(0);
    });

    // Display current state periodically
    setInterval(async () => {
        try {
            const reputation = await agent.getFormattedReputation();
            const creditLimit = await agent.getCreditLimit();

            console.log('───────────────────────────────────────────────────────');
            console.log(`📊 Current State (${new Date().toLocaleTimeString()})`);
            console.log(`   Reputation: ${reputation.display}`);
            console.log(`   Credit Limit: ${creditLimit} USDC`);

            const loans = await agent.getLoans(true);
            console.log(`   Active Loans: ${loans.filter(l => l.state === 2).length}`);
            console.log(`   Total Loans: ${loans.length}`);
            console.log('───────────────────────────────────────────────────────\n');
        } catch (error) {
            // Agent not registered yet
        }
    }, 30000); // Every 30 seconds
}

main().catch((error) => {
    console.error('\n❌ Error:', error.message);
    process.exit(1);
});
