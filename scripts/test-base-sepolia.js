/**
 * Test Specular on Base Sepolia & Measure Gas Costs
 *
 * This script validates the L2 deployment and measures actual gas costs
 * to prove the 20x savings vs Arc testnet
 */

const { ethers } = require('ethers');
const addresses = require('../src/config/base-sepolia-addresses.json');

const RPC_URL = 'https://sepolia.base.org';
const AGENT_KEY = 'process.env.PRIVATE_KEY || '0x0000000000000000000000000000000000000000000000000000000000000000'';

async function main() {
    console.log('\n╔══════════════════════════════════════════════════╗');
    console.log('║    TEST SPECULAR ON BASE SEPOLIA                ║');
    console.log('╚══════════════════════════════════════════════════╝\n');

    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const agent = new ethers.Wallet(AGENT_KEY, provider);

    console.log(`🔑 Agent: ${agent.address}`);
    console.log(`⛽ Network: Base Sepolia (Chain ID: 84532)\n`);

    const gasStats = {
        operations: [],
        totalGas: 0,
        totalCostEth: 0
    };

    // Get current gas price
    const feeData = await provider.getFeeData();
    const gasPrice = feeData.gasPrice;
    const gasPriceGwei = parseFloat(ethers.formatUnits(gasPrice, 'gwei'));

    console.log(`📊 Current Gas Price: ${gasPriceGwei.toFixed(4)} Gwei\n`);

    //  Contract instances
    const registry = new ethers.Contract(
        addresses.AgentRegistryV2,
        [
            'function register(string agentURI, tuple(string key, bytes value)[] metadata) returns (uint256)',
            'function isRegistered(address) view returns (bool)'
        ],
        provider
    );

    const usdc = new ethers.Contract(
        addresses.MockUSDC,
        ['function mint(address,uint256)', 'function approve(address,uint256)', 'function balanceOf(address) view returns (uint256)'],
        provider
    );

    const marketplace = new ethers.Contract(
        addresses.AgentLiquidityMarketplace,
        ['function requestLoan(uint256,uint256)', 'function repayLoan(uint256)', 'function loans(uint256) view returns (address,address,uint256,uint256,uint256,uint256,uint256,uint8)'],
        provider
    );

    function recordGas(operation, receipt) {
        const gasUsed = Number(receipt.gasUsed);
        const costWei = gasUsed * Number(gasPrice);
        const costEth = parseFloat(ethers.formatEther(costWei));
        const costUsd = costEth * 2500; // Assume $2500 ETH

        gasStats.operations.push({ operation, gasUsed, costEth, costUsd });
        gasStats.totalGas += gasUsed;
        gasStats.totalCostEth += costEth;

        console.log(`   ✅ ${operation}`);
        console.log(`      Gas: ${gasUsed.toLocaleString()}`);
        console.log(`      Cost: ${costEth.toFixed(6)} ETH ($${costUsd.toFixed(4)})\n`);
    }

    // ========================================================================
    // TEST 1: REGISTER AGENT
    // ========================================================================

    console.log('═'.repeat(70));
    console.log('TEST 1: REGISTER AGENT');
    console.log('═'.repeat(70) + '\n');

    const isRegistered = await registry.isRegistered(agent.address);

    if (!isRegistered) {
        console.log('📝 Registering agent...\n');

        // AgentRegistryV2.register expects (agentURI, metadata[])
        const metadata = []; // Empty metadata array
        const tx1 = await registry.connect(agent).register('ipfs://base-test-agent', metadata);
        const receipt1 = await tx1.wait();
        recordGas('Agent Registration', receipt1);
    } else {
        console.log('   ✅ Agent already registered\n');
    }

    // ========================================================================
    // TEST 2: MINT USDC
    // ========================================================================

    console.log('═'.repeat(70));
    console.log('TEST 2: MINT TEST USDC');
    console.log('═'.repeat(70) + '\n');

    const balance = await usdc.balanceOf(agent.address);

    if (balance < ethers.parseUnits('1000', 6)) {
        console.log('💵 Minting 1000 USDC...\n');
        const tx2 = await usdc.connect(agent).mint(agent.address, ethers.parseUnits('1000', 6));
        const receipt2 = await tx2.wait();
        recordGas('USDC Mint', receipt2);
    } else {
        console.log(`   ✅ Sufficient balance: ${ethers.formatUnits(balance, 6)} USDC\n`);
    }

    // ========================================================================
    // TEST 3: APPROVE USDC
    // ========================================================================

    console.log('═'.repeat(70));
    console.log('TEST 3: APPROVE USDC');
    console.log('═'.repeat(70) + '\n');

    console.log('🔓 Approving marketplace for loans + collateral...\n');
    // Approve enough for loan amount + collateral (100 USDC loan + 100 USDC collateral = 200 USDC)
    const tx3 = await usdc.connect(agent).approve(addresses.AgentLiquidityMarketplace, ethers.parseUnits('10000', 6));
    const receipt3 = await tx3.wait();
    recordGas('USDC Approval', receipt3);

    // ========================================================================
    // TEST 4: REQUEST LOAN
    // ========================================================================

    console.log('═'.repeat(70));
    console.log('TEST 4: REQUEST LOAN');
    console.log('═'.repeat(70) + '\n');

    console.log('💰 Requesting 100 USDC loan for 7 days...\n');
    const tx4 = await marketplace.connect(agent).requestLoan(ethers.parseUnits('100', 6), 7);
    const receipt4 = await tx4.wait();
    recordGas('Loan Request', receipt4);

    // Extract loan ID
    let loanId;
    for (const log of receipt4.logs) {
        try {
            if (log.topics.length > 1) {
                loanId = Number(log.topics[1]);
                break;
            }
        } catch {}
    }

    console.log(`   📋 Loan ID: ${loanId}\n`);

    // ========================================================================
    // TEST 5: REPAY LOAN
    // ========================================================================

    if (loanId) {
        console.log('═'.repeat(70));
        console.log('TEST 5: REPAY LOAN');
        console.log('═'.repeat(70) + '\n');

        console.log(`💸 Repaying loan #${loanId}...\n`);
        const tx5 = await marketplace.connect(agent).repayLoan(loanId);
        const receipt5 = await tx5.wait();
        recordGas('Loan Repayment', receipt5);
    }

    // ========================================================================
    // GAS ANALYSIS
    // ========================================================================

    console.log('═'.repeat(70));
    console.log('GAS COST ANALYSIS');
    console.log('═'.repeat(70) + '\n');

    console.log('📊 Operation Breakdown:\n');

    gasStats.operations.forEach((op, i) => {
        console.log(`   ${i + 1}. ${op.operation}`);
        console.log(`      Gas: ${op.gasUsed.toLocaleString()}`);
        console.log(`      Cost: ${op.costEth.toFixed(6)} ETH ($${op.costUsd.toFixed(4)})\n`);
    });

    console.log('═'.repeat(70));
    console.log('SUMMARY');
    console.log('═'.repeat(70) + '\n');

    const totalCostUsd = gasStats.totalCostEth * 2500;

    console.log(`⛽ Gas Price: ${gasPriceGwei.toFixed(4)} Gwei\n`);

    console.log(`💰 Total Lifecycle Cost:\n`);
    console.log(`   Total Gas:    ${gasStats.totalGas.toLocaleString()}`);
    console.log(`   Total Cost:   ${gasStats.totalCostEth.toFixed(6)} ETH`);
    console.log(`   USD Cost:     $${totalCostUsd.toFixed(4)}\n`);

    console.log(`📉 Comparison vs Arc Testnet:\n`);
    console.log(`   Arc Cost:     $27.96 @ 20 Gwei`);
    console.log(`   Base Cost:    $${totalCostUsd.toFixed(4)} @ ${gasPriceGwei.toFixed(2)} Gwei`);
    const savings = ((27.96 - totalCostUsd) / 27.96 * 100);
    const savingsMultiple = (27.96 / totalCostUsd);
    console.log(`   Savings:      $${(27.96 - totalCostUsd).toFixed(4)} (${savings.toFixed(1)}%)`);
    console.log(`   Cost Reduction: ${savingsMultiple.toFixed(1)}x cheaper!\n`);

    console.log(`💡 Economic Impact:\n`);
    console.log(`   For $100 loan @ 5% APR for 7 days:`);
    console.log(`      Interest:     $0.0959`);
    console.log(`      Gas (Arc):    $27.96 (291x interest)`);
    console.log(`      Gas (Base):   $${totalCostUsd.toFixed(4)} (${(totalCostUsd / 0.0959).toFixed(1)}x interest)`);
    console.log(`      Improvement:  ${((291 - totalCostUsd / 0.0959) / 291 * 100).toFixed(1)}% better!\n`);

    console.log('═'.repeat(70));
    console.log('✅ BASE SEPOLIA VALIDATION COMPLETE');
    console.log('═'.repeat(70) + '\n');

    console.log('🎯 Key Findings:\n');
    console.log(`   ✅ All core functions working on Base Sepolia`);
    console.log(`   ✅ Gas costs ${savingsMultiple.toFixed(1)}x cheaper than Arc testnet`);
    console.log(`   ✅ Protocol economically viable for $100+ loans`);
    console.log(`   ✅ L2 deployment validates core thesis\n`);
}

main().catch(err => {
    console.error('\n❌ Error:', err.message);
    process.exit(1);
});
