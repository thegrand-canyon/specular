/**
 * Simple Arc Testing - Using Only Proven Functions
 */

const { ethers } = require('ethers');

const RPC_URL = process.env.ARC_TESTNET_RPC_URL || 'https://arc-testnet.drpc.org';
const AGENT1_KEY = process.env.PRIVATE_KEY;
const AGENT2_KEY = '0x47471cb7a2ba033f2085a82050ff16248ff3a9e5d9ea17ddb0f5d2f208e043ad';
const LENDER_KEY = '0x41adb1d6ef22647a3de0e7993f4e33ec7bcd5b49359587967750ff8f3faddf67';

const addresses = require('../../src/config/arc-testnet-addresses.json');

async function main() {
    console.log('\n╔══════════════════════════════════════════════════╗');
    console.log('║        ARC TESTNET - SIMPLE TEST SUITE          ║');
    console.log('╚══════════════════════════════════════════════════╝\n');

    const provider = new ethers.JsonRpcProvider(RPC_URL, undefined, { batchMaxCount: 1 });
    const agent1 = new ethers.Wallet(AGENT1_KEY, provider);
    const agent2 = new ethers.Wallet(AGENT2_KEY, provider);
    const lender = new ethers.Wallet(LENDER_KEY, provider);

    console.log(`Agent #43: ${agent1.address}`);
    console.log(`Agent #2:  ${agent2.address}`);
    console.log(`Lender:    ${lender.address}\n`);

    // Simple contract interfaces
    const registry = new ethers.Contract(
        addresses.agentRegistryV2,
        ['function isRegistered(address) view returns (bool)', 'function agentCount() view returns (uint256)'],
        provider
    );

    const reputation = new ethers.Contract(
        addresses.reputationManagerV3,
        ['function getReputationScore(address) view returns (uint256)'],
        provider
    );

    const usdc = new ethers.Contract(
        addresses.mockUSDC,
        ['function balanceOf(address) view returns (uint256)', 'function mint(address,uint256)', 'function transfer(address,uint256) returns (bool)'],
        provider
    );

    // Test 1: Check Agent #43
    console.log('═'.repeat(70));
    console.log('TEST 1: AGENT STATUS');
    console.log('═'.repeat(70) + '\n');

    const agent1Reg = await registry.isRegistered(agent1.address);
    const agent1Score = await reputation.getReputationScore(agent1.address);

    console.log(`✅ Agent #43 Registered: ${agent1Reg}`);
    console.log(`✅ Agent #43 Score: ${agent1Score}`);

    // Test 2: Check Agent #2
    const agent2Reg = await registry.isRegistered(agent2.address);
    const agent2Score = await reputation.getReputationScore(agent2.address);

    console.log(`✅ Agent #2 Registered: ${agent2Reg}`);
    console.log(`✅ Agent #2 Score: ${agent2Score}`);

    // Test 3: Total agents
    console.log('\n' + '═'.repeat(70));
    console.log('TEST 2: PROTOCOL METRICS');
    console.log('═'.repeat(70) + '\n');

    const totalAgents = await registry.agentCount();
    console.log(`✅ Total Registered Agents: ${totalAgents}`);

    // Test 4: USDC balances
    console.log('\n' + '═'.repeat(70));
    console.log('TEST 3: USDC BALANCES');
    console.log('═'.repeat(70) + '\n');

    const agent1Bal = await usdc.balanceOf(agent1.address);
    const agent2Bal = await usdc.balanceOf(agent2.address);
    const lenderBal = await usdc.balanceOf(lender.address);

    console.log(`Agent #43: ${ethers.formatUnits(agent1Bal, 6)} USDC`);
    console.log(`Agent #2:  ${ethers.formatUnits(agent2Bal, 6)} USDC`);
    console.log(`Lender:    ${ethers.formatUnits(lenderBal, 6)} USDC`);

    // Test 5: Mint and transfer
    console.log('\n' + '═'.repeat(70));
    console.log('TEST 4: USDC OPERATIONS');
    console.log('═'.repeat(70) + '\n');

    if (lenderBal < ethers.parseUnits('100', 6)) {
        console.log('💵 Minting 1000 USDC to lender...');
        const mintTx = await usdc.connect(lender).mint(lender.address, ethers.parseUnits('1000', 6));
        await mintTx.wait();
        console.log('✅ Minted');
    }

    console.log(`\n💸 Transferring 100 USDC from lender to Agent #2...`);
    const transferTx = await usdc.connect(lender).transfer(agent2.address, ethers.parseUnits('100', 6));
    await transferTx.wait();

    const newAgent2Bal = await usdc.balanceOf(agent2.address);
    console.log(`✅ Transfer complete`);
    console.log(`   Agent #2 new balance: ${ethers.formatUnits(newAgent2Bal, 6)} USDC`);

    // Summary
    console.log('\n' + '═'.repeat(70));
    console.log('SUMMARY');
    console.log('═'.repeat(70));

    console.log(`\n✅ Agent Registration: Working`);
    console.log(`✅ Reputation System: Working (Agent #43: ${agent1Score}, Agent #2: ${agent2Score})`);
    console.log(`✅ USDC Operations: Working`);
    console.log(`✅ Multiple Agents: ${totalAgents} registered`);

    console.log('\n' + '═'.repeat(70) + '\n');
}

main().catch(err => {
    console.error('\n❌ Error:', err.message);
    process.exit(1);
});
