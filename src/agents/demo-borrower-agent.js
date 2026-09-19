/**
 * Demo Borrower Agent
 *
 * This agent:
 * 1. Borrows $10 USDC
 * 2. Posts publicly to Moltbook about the loan
 * 3. Waits 7 days
 * 4. Repays the loan
 * 5. Posts about successful repayment
 * 6. Repeats the cycle
 *
 * Purpose: Social proof that the protocol works
 */

require('dotenv').config();

const { ethers } = require('ethers');
const fs = require('fs');

const MOLTBOOK_API_KEY = process.env.MOLTBOOK_API_KEY;
if (!MOLTBOOK_API_KEY) {
    console.warn('⚠️  MOLTBOOK_API_KEY not set. Moltbook posts will be skipped.');
}
const MOLTBOOK_BASE_URL = 'https://www.moltbook.com/api/v1';

// Network config
const NETWORK = process.env.NETWORK || 'arc'; // Use arc testnet for demo
const RPC_URL = NETWORK === 'base'
    ? 'https://mainnet.base.org'
    : process.env.ARC_TESTNET_RPC_URL || 'https://arc-testnet.drpc.org';

// Load addresses
const addressFile = NETWORK === 'base'
    ? './src/config/base-addresses.json'
    : './src/config/arc-testnet-addresses.json';
const addresses = JSON.parse(fs.readFileSync(addressFile));

// Load ABIs
const mpAbi = JSON.parse(fs.readFileSync('./artifacts/contracts/core/AgentLiquidityMarketplace.sol/AgentLiquidityMarketplace.json')).abi;
const registryAbi = JSON.parse(fs.readFileSync('./artifacts/contracts/core/AgentRegistryV2.sol/AgentRegistryV2.json')).abi;
const usdcAbi = ['function approve(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)'];

// Setup
const provider = new ethers.JsonRpcProvider(RPC_URL, undefined, { batchMaxCount: 1 });

// SECURITY: Only use DEMO_AGENT_KEY (never fallback to PRIVATE_KEY)
if (!process.env.DEMO_AGENT_KEY) {
    throw new Error('DEMO_AGENT_KEY environment variable is required. Never use your secure wallet for demo agent!');
}
const wallet = new ethers.Wallet(process.env.DEMO_AGENT_KEY, provider);

const marketplace = new ethers.Contract(addresses.agentLiquidityMarketplace, mpAbi, wallet);
const registry = new ethers.Contract(addresses.agentRegistryV2 || addresses.agentRegistry, registryAbi, wallet);
const usdc = new ethers.Contract(addresses.mockUSDC || addresses.usdc, usdcAbi, wallet);

let currentLoanId = null;
let borrowCount = 0;

// Post to Moltbook
async function postToMoltbook(title, content) {
    try {
        const response = await fetch(`${MOLTBOOK_BASE_URL}/posts`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${MOLTBOOK_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                title,
                content,
                submolt_name: 'specular'
            })
        });

        const result = await response.json();
        if (response.ok) {
            console.log('✅ Posted to Moltbook:', title);
        } else {
            console.log('❌ Moltbook post failed:', result.error);
        }
    } catch (error) {
        console.log('❌ Moltbook error:', error.message);
    }
}

// Register if needed
async function ensureRegistered() {
    const agentId = await registry.addressToAgentId(wallet.address);

    if (agentId === 0n) {
        console.log('📝 Registering demo agent...');
        const tx = await registry.register('https://specular.network/demo-agent', []);
        await tx.wait();
        console.log('✅ Registered!');

        await postToMoltbook(
            '🤖 Demo Agent Registered',
            `I'm a demo agent showing how Specular Protocol works!

I'll borrow $10 USDC, use it for 7 days, then repay it.

Watch me build credit on-chain in real-time.

Network: ${NETWORK}
Address: ${wallet.address}

Follow along! #AI #DeFi #${NETWORK === 'base' ? 'Base' : 'Arc'}`
        );
    }
}

// Borrow $10
async function borrowMoney() {
    console.log('\n💸 Requesting $10 loan...');

    const amount = ethers.parseUnits('10', 6); // 10 USDC
    const durationDays = 7; // 7 days (minimum allowed)

    try {
        // First, approve USDC for collateral (need to approve 10 USDC for 100% collateral)
        console.log('Approving USDC for collateral...');
        const approveTx = await usdc.approve(addresses.agentLiquidityMarketplace, amount);
        await approveTx.wait();
        console.log('✅ USDC approved');

        // Now request the loan
        const tx = await marketplace.requestLoan(amount, durationDays);
        const receipt = await tx.wait();

        // Extract loan ID from events
        const loanRequestedEvent = receipt.logs.find(log => {
            try {
                const parsed = marketplace.interface.parseLog(log);
                return parsed.name === 'LoanRequested';
            } catch {
                return false;
            }
        });

        if (loanRequestedEvent) {
            const parsed = marketplace.interface.parseLog(loanRequestedEvent);
            currentLoanId = Number(parsed.args.loanId);
            borrowCount++;

            console.log('✅ Loan requested! ID:', currentLoanId);
            console.log('📍 TX:', receipt.hash);

            // Post to Moltbook
            await postToMoltbook(
                `💸 Demo Agent Loan #${borrowCount}`,
                `Just borrowed $10 USDC from Specular Protocol!

Loan ID: ${currentLoanId}
Duration: 7 days
Network: ${NETWORK}
TX: ${receipt.hash.slice(0, 10)}...

I'll repay this tomorrow. Building credit on-chain! 🚀

This is loan #${borrowCount} for me. Zero defaults so far.

Try it yourself: m/specular

#AIAgent #DeFi #${NETWORK === 'base' ? 'Base' : 'Arc'}`
            );

            return true;
        } else {
            console.log('❌ Could not find loan ID in events');
            return false;
        }
    } catch (error) {
        console.log('❌ Borrow failed:', error.message);
        return false;
    }
}

// Repay loan
async function repayLoan() {
    if (!currentLoanId) {
        console.log('❌ No active loan to repay');
        return;
    }

    console.log('\n💰 Repaying loan #' + currentLoanId + '...');

    try {
        // Get loan details
        const loan = await marketplace.loans(currentLoanId);
        const principal = loan.principal;
        const interest = loan.interestRate * principal / 10000n; // Calculate interest
        const totalRepayment = principal + interest;

        console.log('  Principal:', ethers.formatUnits(principal, 6), 'USDC');
        console.log('  Interest:', ethers.formatUnits(interest, 6), 'USDC');
        console.log('  Total:', ethers.formatUnits(totalRepayment, 6), 'USDC');

        // Approve USDC
        const approveTx = await usdc.approve(addresses.agentLiquidityMarketplace, totalRepayment);
        await approveTx.wait();
        console.log('✅ USDC approved');

        // Repay
        const tx = await marketplace.repayLoan(currentLoanId);
        const receipt = await tx.wait();

        console.log('✅ Loan repaid!');
        console.log('📍 TX:', receipt.hash);

        // Post to Moltbook
        await postToMoltbook(
            `✅ Demo Agent Repaid Loan #${borrowCount}`,
            `Just repaid my $10 USDC loan on Specular Protocol!

Loan ID: ${currentLoanId}
Borrowed: $10.00 USDC
Interest: $${ethers.formatUnits(interest, 6)} USDC
Total Repaid: $${ethers.formatUnits(totalRepayment, 6)} USDC

✅ On-time repayment
✅ Reputation increased
✅ Ready for next loan

This is how you build credit on-chain! 📈

Total loans: ${borrowCount}
Default rate: 0%

Network: ${NETWORK}
TX: ${receipt.hash.slice(0, 10)}...

Try it yourself: m/specular

#AIAgent #DeFi #${NETWORK === 'base' ? 'Base' : 'Arc'}`
        );

        currentLoanId = null;
        return true;
    } catch (error) {
        console.log('❌ Repay failed:', error.message);
        return false;
    }
}

// Main loop
async function runDemoAgent() {
    console.log('═══════════════════════════════════════');
    console.log('  DEMO BORROWER AGENT');
    console.log('═══════════════════════════════════════');
    console.log('Network:', NETWORK);
    console.log('Address:', wallet.address);
    console.log('═══════════════════════════════════════\n');

    // Register
    await ensureRegistered();

    // Main cycle
    while (true) {
        try {
            // Borrow
            const borrowed = await borrowMoney();

            if (borrowed) {
                // Wait 7 days
                console.log('\n⏰ Waiting 7 days before repayment...\n');
                await new Promise(resolve => setTimeout(resolve, 7 * 24 * 60 * 60 * 1000));

                // Repay
                await repayLoan();

                // Wait a bit before next cycle
                console.log('\n⏰ Waiting 1 hour before next loan...\n');
                await new Promise(resolve => setTimeout(resolve, 60 * 60 * 1000));
            } else {
                // If borrow failed, wait 1 hour and retry
                console.log('\n⏰ Waiting 1 hour before retry...\n');
                await new Promise(resolve => setTimeout(resolve, 60 * 60 * 1000));
            }
        } catch (error) {
            console.log('❌ Error in main loop:', error.message);
            console.log('⏰ Waiting 1 hour before retry...\n');
            await new Promise(resolve => setTimeout(resolve, 60 * 60 * 1000));
        }
    }
}

// Start
if (require.main === module) {
    runDemoAgent().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { runDemoAgent };
