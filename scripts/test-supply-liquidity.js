const { ethers } = require('hardhat');
const fs = require('fs');
const path = require('path');

async function main() {
    console.log('\n🧪 TESTING SUPPLY LIQUIDITY\n');

    const addressesPath = path.join(__dirname, '..', 'src', 'config', 'sepolia-addresses.json');
    const addresses = JSON.parse(fs.readFileSync(addressesPath, 'utf8'));

    const marketplace = await ethers.getContractAt('AgentLiquidityMarketplace', addresses.agentLiquidityMarketplace);
    const usdc = await ethers.getContractAt('MockUSDC', addresses.mockUSDC);
    const [deployer] = await ethers.getSigners();

    const testAgentsPath = path.join(__dirname, '..', 'test-agents.json');
    const testAgents = JSON.parse(fs.readFileSync(testAgentsPath, 'utf8'));
    const bob = testAgents.find(a => a.name === 'Bob');

    console.log(`Testing with Bob (Agent ID: ${bob.agentId})\n`);

    // Check deployer balance
    const balance = await usdc.balanceOf(deployer.address);
    console.log(`Deployer USDC balance: ${ethers.formatUnits(balance, 6)}`);

    // Check pool state
    const pool = await marketplace.agentPools(bob.agentId);
    console.log(`Pool active: ${pool.isActive}`);
    console.log(`Pool liquidity: ${ethers.formatUnits(pool.totalLiquidity, 6)}\n`);

    // Check contract paused
    const paused = await marketplace.paused();
    console.log(`Contract paused: ${paused}\n`);

    // Try to supply 1000 USDC
    const amount = ethers.parseUnits('1000', 6);
    console.log(`Approving ${ethers.formatUnits(amount, 6)} USDC...`);

    try {
        const approveTx = await usdc.approve(addresses.agentLiquidityMarketplace, amount);
        await approveTx.wait();
        console.log('✅ Approved\n');
    } catch (error) {
        console.log(`❌ Approval failed: ${error.message}\n`);
        return;
    }

    console.log(`Supplying ${ethers.formatUnits(amount, 6)} USDC to agentId ${bob.agentId}...`);

    try {
        // Try with gas estimation first
        const gasEstimate = await marketplace.supplyLiquidity.estimateGas(bob.agentId, amount);
        console.log(`Gas estimate: ${gasEstimate.toString()}\n`);

        const tx = await marketplace.supplyLiquidity(bob.agentId, amount);
        const receipt = await tx.wait();
        console.log(`✅ Success! Tx hash: ${receipt.hash}\n`);
    } catch (error) {
        console.log(`❌ Failed: ${error.message}`);
        if (error.data) {
            console.log(`Error data: ${error.data}`);
        }
        console.log('');
    }
}

main().catch(console.error);
