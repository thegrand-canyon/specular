require('dotenv').config();
const { ethers } = require('ethers');
const SpecularAgent = require('../src/SpecularAgent');
const fs = require('fs');
const path = require('path');

async function main() {
    console.log('╔════════════════════════════════════════════════════════╗');
    console.log('║   Specular Protocol - Basic Agent Example             ║');
    console.log('╚════════════════════════════════════════════════════════╝\n');

    // Setup provider and wallet
    const network = process.env.DEFAULT_NETWORK || 'localhost';
    let provider, wallet;

    if (network === 'localhost') {
        provider = new ethers.JsonRpcProvider('http://127.0.0.1:8545');
        // Use hardhat test account
        wallet = new ethers.Wallet(
            '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
            provider
        );
    } else {
        const rpcUrl = process.env.SEPOLIA_RPC_URL || process.env.MAINNET_RPC_URL;
        const privateKey = process.env.PRIVATE_KEY;

        if (!rpcUrl || !privateKey) {
            throw new Error('Missing RPC_URL or PRIVATE_KEY in environment variables');
        }

        provider = new ethers.JsonRpcProvider(rpcUrl);
        wallet = new ethers.Wallet(privateKey, provider);
    }

    console.log(`Network: ${network}`);
    console.log(`Agent address: ${wallet.address}`);
    console.log(`Balance: ${ethers.formatEther(await provider.getBalance(wallet.address))} ETH\n`);

    // Load contract addresses
    const addressesPath = path.join(__dirname, '../src/config/contractAddresses.json');
    if (!fs.existsSync(addressesPath)) {
        throw new Error(`Contract addresses not found at ${addressesPath}. Please deploy contracts first.`);
    }

    const allAddresses = JSON.parse(fs.readFileSync(addressesPath, 'utf8'));
    const networkAddresses = allAddresses[network] || allAddresses['hardhat'];

    if (!networkAddresses) {
        throw new Error(`Contract addresses not found for network: ${network}`);
    }

    const contractAddresses = networkAddresses.contracts;

    // Create agent instance
    console.log('📝 Creating Specular Agent...\n');
    const agent = new SpecularAgent(wallet, contractAddresses);

    // Check if already registered (force refresh to avoid stale cache)
    let alreadyRegistered = false;
    try {
        const agentInfo = await agent.getAgentInfo(true); // Force refresh
        if (agentInfo && agentInfo.metadata) {
            console.log('✅ Agent already registered!');
            console.log(`   Metadata: ${agentInfo.metadata}`);
            console.log(`   Registration time: ${new Date(agentInfo.registrationTime * 1000).toISOString()}\n`);
            alreadyRegistered = true;
        }
    } catch (error) {
        // Not registered yet
    }

    if (!alreadyRegistered) {
        // Register the agent
        console.log('📝 Registering agent...');
        const metadata = {
            name: "Basic AI Agent",
            version: "1.0.0",
            capabilities: ["automated-trading", "risk-analysis"],
            timestamp: Date.now()
        };

        await agent.register(JSON.stringify(metadata));
        console.log('✅ Agent registered successfully!\n');
    }

    // Get reputation
    console.log('📊 Checking reputation...');
    const reputation = await agent.getFormattedReputation();
    console.log(`   Score: ${reputation.display}`);

    const creditLimit = await agent.getCreditLimit();
    console.log(`   Credit Limit: ${creditLimit} USDC\n`);

    // Request a loan
    console.log('💰 Requesting loan...');
    const loanAmount = 1000; // 1000 USDC
    const loanDuration = 30; // 30 days

    try {
        const loanId = await agent.requestLoan(loanAmount, loanDuration);
        console.log(`✅ Loan requested successfully!`);
        console.log(`   Loan ID: ${loanId}`);
        console.log(`   Amount: ${loanAmount} USDC`);
        console.log(`   Duration: ${loanDuration} days\n`);

        // Get loan status
        console.log('📋 Loan Status:');
        const loanStatus = await agent.getLoanStatus(loanId);
        console.log(`   State: ${loanStatus.state}`);
        console.log(`   Borrower: ${loanStatus.borrower}`);
        console.log(`   Amount: ${loanStatus.amount} USDC`);
        console.log(`   Duration: ${loanStatus.durationDays} days`);
        if (loanStatus.collateralAmount !== '0.0') {
            console.log(`   Collateral: ${loanStatus.collateralAmount} USDC`);
        }
        console.log();

        console.log('💡 Note: The loan needs to be approved by the pool owner before funds are disbursed.');
        console.log('    Run: npx hardhat console --network localhost');
        console.log(`    Then: lendingPool.approveLoan(${loanId})\n`);

    } catch (error) {
        if (error.message.includes('Insufficient USDC balance')) {
            console.log('⚠️  Insufficient USDC for collateral');
            console.log('    You can mint test USDC using:');
            console.log('    npx hardhat console --network localhost');
            console.log(`    mockUSDC.mint("${wallet.address}", ethers.parseUnits("10000", 6))\n`);
        } else {
            throw error;
        }
    }

    // Get all loans
    console.log('📜 All loans for this agent:');
    const loans = await agent.getLoans(true);
    if (loans.length === 0) {
        console.log('   No loans found\n');
    } else {
        for (const loan of loans) {
            console.log(`   Loan #${loan.loanId}:`);
            console.log(`     Amount: ${ethers.formatUnits(loan.amount, 6)} USDC`);
            console.log(`     State: ${['REQUESTED', 'APPROVED', 'ACTIVE', 'REPAID', 'DEFAULTED'][loan.state]}`);
        }
        console.log();
    }

    console.log('╔════════════════════════════════════════════════════════╗');
    console.log('║   Example Complete!                                    ║');
    console.log('╚════════════════════════════════════════════════════════╝\n');
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error('\n❌ Error:', error.message);
        console.error(error);
        process.exit(1);
    });
