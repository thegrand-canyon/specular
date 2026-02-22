/**
 * Test Cross-Chain Deposit: Sepolia → Arc
 * Bridges USDC from Sepolia to an Arc agent pool using CCTP
 */

const { ethers } = require('hardhat');
const fs = require('fs');
const path = require('path');

async function main() {
    console.log('\n🌉 TESTING SEPOLIA → ARC BRIDGE\n');
    console.log('═══════════════════════════════════════════════════════\n');

    // Load bridge config
    const bridgesPath = path.join(__dirname, '..', 'src', 'config', 'bridges.json');
    const bridges = JSON.parse(fs.readFileSync(bridgesPath, 'utf8'));
    const sepoliaBridge = bridges.sepolia;

    // Load Arc config
    const arcPath = path.join(__dirname, '..', 'src', 'config', 'arc-testnet-addresses.json');
    const arcConfig = JSON.parse(fs.readFileSync(arcPath, 'utf8'));

    const [deployer] = await ethers.getSigners();
    console.log(`Deployer: ${deployer.address}\n`);

    // Connect to contracts
    const bridge = await ethers.getContractAt('CCTPBridge', sepoliaBridge.bridge);
    const usdc = await ethers.getContractAt('MockUSDC', sepoliaBridge.usdc);

    // Check USDC balance
    const balance = await usdc.balanceOf(deployer.address);
    console.log(`Sepolia USDC balance: ${ethers.formatUnits(balance, 6)} USDC\n`);

    if (balance < ethers.parseUnits('100', 6)) {
        console.log('⚠️  Insufficient USDC. Get testnet USDC from:');
        console.log('   https://faucet.circle.com\n');
        return;
    }

    // Choose an Arc agent to deposit to
    // Using agent ID 5 (Alice) which has high reputation
    const targetAgentId = 5;
    const depositAmount = ethers.parseUnits('100', 6); // 100 USDC

    console.log('Bridge Configuration:');
    console.log(`  Bridge:          ${sepoliaBridge.bridge}`);
    console.log(`  USDC:            ${sepoliaBridge.usdc}`);
    console.log(`  Target Agent:    ${targetAgentId}`);
    console.log(`  Deposit Amount:  ${ethers.formatUnits(depositAmount, 6)} USDC`);
    console.log(`  Arc Router:      ${sepoliaBridge.arcDepositRouter}\n`);

    // Step 1: Approve USDC
    console.log('📝 Step 1: Approving USDC...');
    const approveTx = await usdc.approve(sepoliaBridge.bridge, depositAmount);
    await approveTx.wait();
    console.log('   ✅ Approved\n');

    // Step 2: Bridge to Arc pool
    console.log('🌉 Step 2: Bridging USDC to Arc...');
    console.log('   This will:');
    console.log('   1. Burn USDC on Sepolia via Circle CCTP');
    console.log('   2. Mint USDC on Arc');
    console.log('   3. Auto-deposit to agent pool via DepositRouter\n');

    const bridgeTx = await bridge.bridgeToArcPool(depositAmount, targetAgentId);
    const receipt = await bridgeTx.wait();

    console.log('   ✅ Bridge transaction sent!');
    console.log(`   Tx hash: ${receipt.hash}\n`);

    // Parse events to get nonce
    const burnEvent = receipt.logs.find(log => {
        try {
            const parsed = bridge.interface.parseLog(log);
            return parsed.name === 'DepositInitiated';
        } catch {
            return false;
        }
    });

    if (burnEvent) {
        const parsed = bridge.interface.parseLog(burnEvent);
        console.log('📋 Bridge Details:');
        console.log(`   CCTP Nonce:      ${parsed.args.nonce}`);
        console.log(`   Amount:          ${ethers.formatUnits(parsed.args.amount, 6)} USDC`);
        console.log(`   Target Agent:    ${parsed.args.agentId}\n`);
    }

    console.log('═══════════════════════════════════════════════════════\n');
    console.log('✅ BRIDGE TEST COMPLETE!\n');
    console.log('⏳ CCTP messages typically take 10-20 minutes to arrive.');
    console.log('   The USDC will be minted on Arc and auto-deposited to the pool.\n');
    console.log('🔍 Monitor Arc pool with:');
    console.log(`   npx hardhat run scripts/monitor-arc-protocol.js --network arcTestnet\n`);
}

main().catch(error => {
    console.error('Bridge test failed:', error);
    process.exit(1);
});
