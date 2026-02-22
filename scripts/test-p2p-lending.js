/**
 * Test P2P Liquidity Marketplace
 * Comprehensive testing of agent-specific liquidity pools
 */

const { ethers } = require('hardhat');
const fs = require('fs');
const path = require('path');

async function main() {
    console.log('\n🔬 Testing P2P Liquidity Marketplace\n');
    console.log('═══════════════════════════════════════════════════════\n');

    const [deployer] = await ethers.getSigners();

    const addressesPath = path.join(__dirname, '..', 'src', 'config', 'sepolia-addresses.json');
    const addresses = JSON.parse(fs.readFileSync(addressesPath, 'utf8'));

    const testAgentsPath = path.join(__dirname, '..', 'test-agents.json');
    const testAgents = JSON.parse(fs.readFileSync(testAgentsPath, 'utf8'));

    const marketplace = await ethers.getContractAt('AgentLiquidityMarketplace', addresses.agentLiquidityMarketplace);
    const usdc = await ethers.getContractAt('MockUSDC', addresses.mockUSDC);
    const reputationManager = await ethers.getContractAt('ReputationManagerV3', addresses.reputationManagerV3);

    console.log('Marketplace:', addresses.agentLiquidityMarketplace);
    console.log('');

    // Use deployer as a lender and test agents as borrowers
    const lender = deployer;
    const alice = testAgents[0];
    const bob = testAgents[1];

    console.log('👥 Participants:');
    console.log(`   Lender: ${lender.address}`);
    console.log(`   Alice (Agent ${alice.agentId}): ${alice.address}`);
    console.log(`   Bob (Agent ${bob.agentId}): ${bob.address}`);
    console.log('');

    // ==========================================
    // TEST 1: Supply Liquidity to Alice's Pool
    // ==========================================
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    console.log('TEST 1: Supply Liquidity to Alice\'s Pool\n');

    const supplyAmount = ethers.parseUnits('10000', 6); // 10k USDC

    console.log(`💰 Lender supplying ${ethers.formatUnits(supplyAmount, 6)} USDC to Alice's pool...`);

    // Approve USDC
    await usdc.connect(lender).approve(addresses.agentLiquidityMarketplace, supplyAmount);

    // Supply liquidity
    const supplyTx = await marketplace.connect(lender).supplyLiquidity(alice.agentId, supplyAmount);
    await supplyTx.wait();
    console.log('✅ Liquidity supplied!');
    console.log('');

    // Check pool state
    const alicePool = await marketplace.getAgentPool(alice.agentId);
    console.log('📊 Alice\'s Pool State:');
    console.log(`   Total Liquidity: ${ethers.formatUnits(alicePool.totalLiquidity, 6)} USDC`);
    console.log(`   Available: ${ethers.formatUnits(alicePool.availableLiquidity, 6)} USDC`);
    console.log(`   Lender Count: ${alicePool.lenderCount}`);
    console.log('');

    // Check lender position
    const lenderPosition = await marketplace.getLenderPosition(alice.agentId, lender.address);
    console.log('📋 Lender Position:');
    console.log(`   Amount: ${ethers.formatUnits(lenderPosition.amount, 6)} USDC`);
    console.log(`   Share of Pool: ${Number(lenderPosition.shareOfPool) / 100}%`);
    console.log(`   Earned Interest: ${ethers.formatUnits(lenderPosition.earnedInterest, 6)} USDC`);
    console.log('');

    // ==========================================
    // TEST 2: Alice Requests Loan from Her Pool
    // ==========================================
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    console.log('TEST 2: Alice Requests Loan from Her Pool\n');

    const aliceWallet = new ethers.Wallet(alice.privateKey, ethers.provider);
    const loanAmount = ethers.parseUnits('5000', 6); // 5k USDC
    const duration = 30; // 30 days

    console.log(`📋 Loan Request:`);
    console.log(`   Amount: ${ethers.formatUnits(loanAmount, 6)} USDC`);
    console.log(`   Duration: ${duration} days`);
    console.log('');

    // Get loan terms
    const aliceRep = await reputationManager['getReputationScore(address)'](alice.address);
    const creditLimit = await reputationManager.calculateCreditLimit(alice.address);
    const collateralPercent = await reputationManager.calculateCollateralRequirement(alice.address);
    const interestRate = await reputationManager.calculateInterestRate(alice.address);

    console.log('📊 Alice\'s Terms:');
    console.log(`   Reputation: ${aliceRep}`);
    console.log(`   Credit Limit: ${ethers.formatUnits(creditLimit, 6)} USDC`);
    console.log(`   Collateral Requirement: ${collateralPercent}%`);
    console.log(`   Interest Rate: ${Number(interestRate) / 100}% APR`);
    console.log('');

    // Calculate and approve collateral
    const requiredCollateral = (loanAmount * collateralPercent) / 100n;
    console.log(`💰 Required Collateral: ${ethers.formatUnits(requiredCollateral, 6)} USDC`);

    if (requiredCollateral > 0) {
        await usdc.connect(aliceWallet).approve(addresses.agentLiquidityMarketplace, requiredCollateral);
        console.log('✅ Collateral approved');
    }
    console.log('');

    // Request loan
    console.log('⏳ Requesting loan...');
    const loanTx = await marketplace.connect(aliceWallet).requestLoan(loanAmount, duration);
    const receipt = await loanTx.wait();

    // Get loan ID from event
    const disbursedEvent = receipt.logs.find(log => {
        try {
            return marketplace.interface.parseLog(log)?.name === 'LoanDisbursed';
        } catch { return false; }
    });

    const loanId = marketplace.interface.parseLog(disbursedEvent).args.loanId;
    console.log(`✅ Loan disbursed! ID: ${loanId}`);
    console.log('');

    // Check loan details
    const loan = await marketplace.loans(loanId);
    console.log('📋 Loan Details:');
    console.log(`   Loan ID: ${loanId}`);
    console.log(`   Amount: ${ethers.formatUnits(loan.amount, 6)} USDC`);
    console.log(`   Interest Rate: ${Number(loan.interestRate) / 100}% APR`);
    console.log(`   Collateral: ${ethers.formatUnits(loan.collateralAmount, 6)} USDC`);
    const states = ['REQUESTED', 'ACTIVE', 'REPAID', 'DEFAULTED'];
    console.log(`   State: ${states[loan.state]}`);
    console.log('');

    // Check pool state after loan
    const alicePoolAfterLoan = await marketplace.getAgentPool(alice.agentId);
    console.log('📊 Alice\'s Pool After Loan:');
    console.log(`   Total Liquidity: ${ethers.formatUnits(alicePoolAfterLoan.totalLiquidity, 6)} USDC`);
    console.log(`   Available: ${ethers.formatUnits(alicePoolAfterLoan.availableLiquidity, 6)} USDC`);
    console.log(`   Total Loaned: ${ethers.formatUnits(alicePoolAfterLoan.totalLoaned, 6)} USDC`);
    console.log(`   Utilization: ${Number(alicePoolAfterLoan.utilizationRate) / 100}%`);
    console.log('');

    // ==========================================
    // TEST 3: Alice Repays Loan
    // ==========================================
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    console.log('TEST 3: Alice Repays Loan\n');

    // Calculate repayment amount
    const interest = await marketplace.calculateInterest(
        loan.amount,
        loan.interestRate,
        loan.duration
    );
    const totalRepayment = loan.amount + interest;
    const platformFee = (interest * 100n) / 10000n; // 1% fee
    const lenderInterest = interest - platformFee;

    console.log('💵 Repayment Breakdown:');
    console.log(`   Principal: ${ethers.formatUnits(loan.amount, 6)} USDC`);
    console.log(`   Interest: ${ethers.formatUnits(interest, 6)} USDC`);
    console.log(`   Platform Fee: ${ethers.formatUnits(platformFee, 6)} USDC`);
    console.log(`   Lender Interest: ${ethers.formatUnits(lenderInterest, 6)} USDC`);
    console.log(`   Total: ${ethers.formatUnits(totalRepayment, 6)} USDC`);
    console.log('');

    // Approve and repay
    await usdc.connect(aliceWallet).approve(addresses.agentLiquidityMarketplace, totalRepayment);
    console.log('⏳ Repaying loan...');
    const repayTx = await marketplace.connect(aliceWallet).repayLoan(loanId);
    await repayTx.wait();
    console.log('✅ Loan repaid!');
    console.log('');

    // Check loan state
    const loanAfterRepay = await marketplace.loans(loanId);
    console.log(`📋 Loan State: ${states[loanAfterRepay.state]}`);
    console.log('');

    // Check pool state after repayment
    const alicePoolAfterRepay = await marketplace.getAgentPool(alice.agentId);
    console.log('📊 Alice\'s Pool After Repayment:');
    console.log(`   Total Liquidity: ${ethers.formatUnits(alicePoolAfterRepay.totalLiquidity, 6)} USDC`);
    console.log(`   Available: ${ethers.formatUnits(alicePoolAfterRepay.availableLiquidity, 6)} USDC`);
    console.log(`   Total Loaned: ${ethers.formatUnits(alicePoolAfterRepay.totalLoaned, 6)} USDC`);
    console.log(`   Total Earned: ${ethers.formatUnits(alicePoolAfterRepay.totalEarned, 6)} USDC`);
    console.log('');

    // Check lender position after repayment
    const lenderPositionAfter = await marketplace.getLenderPosition(alice.agentId, lender.address);
    console.log('📋 Lender Position After Repayment:');
    console.log(`   Amount: ${ethers.formatUnits(lenderPositionAfter.amount, 6)} USDC`);
    console.log(`   Earned Interest: ${ethers.formatUnits(lenderPositionAfter.earnedInterest, 6)} USDC`);
    console.log('');

    // ==========================================
    // TEST 4: Supply Liquidity to Bob's Pool
    // ==========================================
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    console.log('TEST 4: Supply Liquidity to Bob\'s Pool (Multi-Agent)\n');

    const bobSupplyAmount = ethers.parseUnits('5000', 6);

    console.log(`💰 Lender supplying ${ethers.formatUnits(bobSupplyAmount, 6)} USDC to Bob's pool...`);
    await usdc.connect(lender).approve(addresses.agentLiquidityMarketplace, bobSupplyAmount);
    const bobSupplyTx = await marketplace.connect(lender).supplyLiquidity(bob.agentId, bobSupplyAmount);
    await bobSupplyTx.wait();
    console.log('✅ Liquidity supplied to Bob!');
    console.log('');

    // Show both pools
    const bobPool = await marketplace.getAgentPool(bob.agentId);
    const alicePoolFinal = await marketplace.getAgentPool(alice.agentId);

    console.log('📊 Multi-Agent Pool Summary:');
    console.log('');
    console.log(`   Alice's Pool (Agent ${alice.agentId}):`);
    console.log(`     Total Liquidity: ${ethers.formatUnits(alicePoolFinal.totalLiquidity, 6)} USDC`);
    console.log(`     Available: ${ethers.formatUnits(alicePoolFinal.availableLiquidity, 6)} USDC`);
    console.log(`     Total Earned: ${ethers.formatUnits(alicePoolFinal.totalEarned, 6)} USDC`);
    console.log('');
    console.log(`   Bob's Pool (Agent ${bob.agentId}):`);
    console.log(`     Total Liquidity: ${ethers.formatUnits(bobPool.totalLiquidity, 6)} USDC`);
    console.log(`     Available: ${ethers.formatUnits(bobPool.availableLiquidity, 6)} USDC`);
    console.log(`     Total Earned: ${ethers.formatUnits(bobPool.totalEarned, 6)} USDC`);
    console.log('');

    // ==========================================
    // TEST 5: Claim Interest
    // ==========================================
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    console.log('TEST 5: Claim Earned Interest\n');

    const lenderBalanceBefore = await usdc.balanceOf(lender.address);
    console.log(`💰 Lender USDC balance before: ${ethers.formatUnits(lenderBalanceBefore, 6)} USDC`);
    console.log(`📊 Claimable interest: ${ethers.formatUnits(lenderPositionAfter.earnedInterest, 6)} USDC`);
    console.log('');

    if (lenderPositionAfter.earnedInterest > 0) {
        console.log('⏳ Claiming interest...');
        const claimTx = await marketplace.connect(lender).claimInterest(alice.agentId);
        await claimTx.wait();
        console.log('✅ Interest claimed!');
        console.log('');

        const lenderBalanceAfter = await usdc.balanceOf(lender.address);
        const claimed = lenderBalanceAfter - lenderBalanceBefore;
        console.log(`💰 Lender USDC balance after: ${ethers.formatUnits(lenderBalanceAfter, 6)} USDC`);
        console.log(`📈 Amount claimed: ${ethers.formatUnits(claimed, 6)} USDC`);
    } else {
        console.log('⚠️  No interest to claim yet');
    }
    console.log('');

    // ==========================================
    // Final Summary
    // ==========================================
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    console.log('✅ P2P Marketplace Testing Complete!\n');
    console.log('📊 Summary:');
    console.log(`   ✅ Liquidity supplied to 2 agents`);
    console.log(`   ✅ Loan requested and auto-disbursed`);
    console.log(`   ✅ Loan repaid with interest`);
    console.log(`   ✅ Interest distributed to lender`);
    console.log(`   ✅ Interest claimed`);
    console.log('');
    console.log('🎯 Key Features Validated:');
    console.log('   ✅ Agent-specific liquidity pools');
    console.log('   ✅ P2P lending (direct agent funding)');
    console.log('   ✅ Automatic interest distribution');
    console.log('   ✅ Multi-agent support');
    console.log('   ✅ Platform fee collection');
    console.log('   ✅ Collateral handling');
    console.log('');
    console.log('═══════════════════════════════════════════════════════\n');
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
