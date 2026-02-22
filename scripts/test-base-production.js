/**
 * Test Base Production Deployment - End-to-End
 *
 * This script validates the production deployment by:
 * 1. Checking USDC balance
 * 2. Registering a test agent
 * 3. Creating a liquidity pool
 * 4. Requesting a loan
 * 5. Repaying the loan
 */

const { ethers } = require('ethers');
const fs = require('fs');

const RPC_URL = 'https://mainnet.base.org';
const DEPLOYER_KEY = process.env.PRIVATE_KEY;

async function main() {
    console.log('\n╔══════════════════════════════════════════════════╗');
    console.log('║  BASE PRODUCTION TEST - END TO END               ║');
    console.log('╚══════════════════════════════════════════════════╝\n');

    const provider = new ethers.JsonRpcProvider(RPC_URL, undefined, { batchMaxCount: 1 });
    const deployer = new ethers.Wallet(DEPLOYER_KEY, provider);

    console.log(`🔑 Test Account: ${deployer.address}\n`);

    // Load addresses
    const addresses = JSON.parse(fs.readFileSync('./src/config/base-addresses.json', 'utf8'));

    // Load ABIs
    const registryAbi = JSON.parse(fs.readFileSync(
        './artifacts/contracts/core/AgentRegistryV2.sol/AgentRegistryV2.json',
        'utf8'
    )).abi;

    const marketplaceAbi = JSON.parse(fs.readFileSync(
        './artifacts/contracts/core/AgentLiquidityMarketplace.sol/AgentLiquidityMarketplace.json',
        'utf8'
    )).abi;

    const usdcAbi = [
        'function balanceOf(address) view returns (uint256)',
        'function approve(address spender, uint256 amount) returns (bool)',
        'function decimals() view returns (uint8)'
    ];

    // Connect to contracts
    const registry = new ethers.Contract(addresses.agentRegistryV2, registryAbi, deployer);
    const marketplace = new ethers.Contract(addresses.agentLiquidityMarketplace, marketplaceAbi, deployer);
    const usdc = new ethers.Contract(addresses.usdc, usdcAbi, deployer);

    // Step 1: Check balances
    console.log('1️⃣  Checking balances...');
    const ethBalance = await provider.getBalance(deployer.address);
    const usdcBalance = await usdc.balanceOf(deployer.address);

    console.log(`   ETH: ${ethers.formatEther(ethBalance)}`);
    console.log(`   USDC: ${ethers.formatUnits(usdcBalance, 6)}\n`);

    const hasEnough = usdcBalance >= ethers.parseUnits('5', 6);
    if (!hasEnough) {
        console.log('⚠️  Warning: Need at least 5 USDC for test');
        console.log('   Current balance: ' + ethers.formatUnits(usdcBalance, 6) + ' USDC\n');

        console.log('To get USDC on Base:');
        console.log('   1. Bridge from Ethereum: https://bridge.base.org');
        console.log('   2. Swap on Base: https://app.uniswap.org');
        console.log('   3. Buy on exchange and withdraw to Base\n');

        console.log('⏸️  Pausing test until USDC is available.\n');
        return;
    }

    // Determine how much to use based on balance
    const useFullTest = usdcBalance >= ethers.parseUnits('50', 6);
    console.log(`   Mode: ${useFullTest ? 'Full test (50 USDC)' : 'Quick test (' + ethers.formatUnits(usdcBalance, 6) + ' USDC)'}\n`);

    // Step 2: Register agent
    console.log('2️⃣  Registering test agent...');

    // Check if already registered
    const existingAgentId = await registry.addressToAgentId(deployer.address);
    let agentId;

    if (existingAgentId > 0n) {
        console.log(`   ✅ Already registered as Agent #${existingAgentId}\n`);
        agentId = existingAgentId;
    } else {
        // AgentRegistryV2 uses agentURI + metadata array format
        const agentURI = 'https://specular.network/agents/base-test-1';
        const metadata = [
            { key: 'name', value: ethers.toUtf8Bytes('Base Production Test Agent') },
            { key: 'version', value: ethers.toUtf8Bytes('1.0') },
            { key: 'description', value: ethers.toUtf8Bytes('First agent on Base mainnet') },
            { key: 'createdAt', value: ethers.toUtf8Bytes(new Date().toISOString()) }
        ];

        const registerTx = await registry.register(agentURI, metadata);
        console.log(`   TX: ${registerTx.hash}`);
        const receipt = await registerTx.wait();

        // Parse event to get agent ID
        const event = receipt.logs.find(log => {
            try {
                return registry.interface.parseLog(log).name === 'AgentRegistered';
            } catch { return false; }
        });

        agentId = registry.interface.parseLog(event).args.agentId;
        console.log(`   ✅ Registered as Agent #${agentId}\n`);
    }

    // Step 3: Create liquidity pool
    console.log('3️⃣  Creating liquidity pool...');

    // Check if pool already exists for this agent
    const pool = await marketplace.agentPools(agentId);

    if (!pool.isActive) {
        // createAgentPool() creates a pool for the calling agent (no parameters)
        const createPoolTx = await marketplace.createAgentPool();
        console.log(`   TX: ${createPoolTx.hash}`);
        await createPoolTx.wait();
        console.log(`   ✅ Created pool for Agent #${agentId}\n`);
    } else {
        console.log(`   ✅ Pool already exists for Agent #${agentId}\n`);
    }

    // Step 4: Check pool liquidity and supply if needed
    console.log('4️⃣  Checking pool liquidity...');
    const poolData = await marketplace.agentPools(agentId);
    const currentLiquidity = poolData.totalLiquidity;

    console.log(`   Current pool liquidity: ${ethers.formatUnits(currentLiquidity, 6)} USDC`);

    if (currentLiquidity < ethers.parseUnits('10', 6)) {
        console.log('   Supplying additional liquidity...');
        const supplyAmount = ethers.parseUnits('10', 6);

        // Approve USDC
        const approveTx = await usdc.approve(addresses.agentLiquidityMarketplace, supplyAmount);
        await approveTx.wait();

        // Supply to pool
        const supplyTx = await marketplace.supplyLiquidity(agentId, supplyAmount);
        await supplyTx.wait();
        console.log(`   ✅ Supplied 10 USDC to pool\n`);
    } else {
        console.log(`   ✅ Pool has sufficient liquidity\n`);
    }

    // Wait a moment
    await new Promise(r => setTimeout(r, 2000));

    // Step 5: Request loan
    console.log('5️⃣  Requesting loan...');
    const loanAmount = ethers.parseUnits('5', 6); // 5 USDC
    const duration = 30; // 30 days

    // Load reputation manager to check collateral requirement
    const rmAbi = JSON.parse(fs.readFileSync(
        './artifacts/contracts/core/ReputationManagerV3.sol/ReputationManagerV3.json',
        'utf8'
    )).abi;
    const reputationManager = new ethers.Contract(addresses.reputationManagerV3, rmAbi, deployer);

    const collateralPercent = await reputationManager.calculateCollateralRequirement(deployer.address);
    const requiredCollateral = (loanAmount * collateralPercent) / 100n;

    console.log(`   Loan amount: ${ethers.formatUnits(loanAmount, 6)} USDC`);
    console.log(`   Collateral required: ${collateralPercent}% (${ethers.formatUnits(requiredCollateral, 6)} USDC)`);

    // Approve full balance to marketplace (for collateral + any fees)
    console.log(`   Approving USDC for loan...`);
    const maxApproval = await usdc.balanceOf(deployer.address);
    const approveCollateralTx = await usdc.approve(addresses.agentLiquidityMarketplace, maxApproval);
    await approveCollateralTx.wait();
    console.log(`   ✅ Approved ${ethers.formatUnits(maxApproval, 6)} USDC`);

    // requestLoan only takes amount and duration (gets agentId from caller)
    const requestTx = await marketplace.requestLoan(loanAmount, duration);
    console.log(`   TX: ${requestTx.hash}`);
    const loanReceipt = await requestTx.wait();

    const loanEvent = loanReceipt.logs.find(log => {
        try {
            return marketplace.interface.parseLog(log).name === 'LoanRequested';
        } catch { return false; }
    });

    const loanId = marketplace.interface.parseLog(loanEvent).args.loanId;
    console.log(`   ✅ Loan requested: Loan #${loanId}\n`);

    // Wait for loan to be active
    await new Promise(r => setTimeout(r, 2000));

    // Step 6: Repay loan
    console.log('6️⃣  Repaying loan...');

    const loan = await marketplace.loans(loanId);
    const repayAmount = BigInt(loan.amount) + BigInt(loan.interest);

    console.log(`   Loan amount: ${ethers.formatUnits(loan.amount, 6)} USDC`);
    console.log(`   Interest: ${ethers.formatUnits(loan.interest, 6)} USDC`);
    console.log(`   Total to repay: ${ethers.formatUnits(repayAmount, 6)} USDC`);

    // Approve repayment
    const approveRepayTx = await usdc.approve(addresses.agentLiquidityMarketplace, repayAmount);
    await approveRepayTx.wait();

    const repayTx = await marketplace.repayLoan(loanId);
    console.log(`   TX: ${repayTx.hash}`);
    await repayTx.wait();
    console.log(`   ✅ Loan repaid!\n`);

    // Final status
    console.log('╔══════════════════════════════════════════════════╗');
    console.log('║  ✅ PRODUCTION TEST COMPLETE!                     ║');
    console.log('╚══════════════════════════════════════════════════╝\n');

    console.log('📊 Summary:\n');
    console.log(`   Agent ID: #${agentId}`);
    console.log(`   Loan ID: #${loanId}`);
    console.log(`   Loan Amount: ${ethers.formatUnits(loanAmount, 6)} USDC`);
    console.log(`   Interest Paid: ${ethers.formatUnits(loan.interest, 6)} USDC\n`);

    console.log('🔗 View on BaseScan:\n');
    console.log(`   Registry: https://basescan.org/address/${addresses.agentRegistryV2}`);
    console.log(`   Marketplace: https://basescan.org/address/${addresses.agentLiquidityMarketplace}\n`);

    console.log('✅ Base mainnet deployment is FULLY OPERATIONAL!\n');
}

main().catch(err => {
    console.error('\n❌ Test failed:', err.message);
    console.error(err);
    process.exit(1);
});
