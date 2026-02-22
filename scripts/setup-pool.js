const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
    console.log("Setting up lending pool with initial liquidity...\n");

    const [deployer] = await hre.ethers.getSigners();
    console.log("Using account:", deployer.address);

    // Load contract addresses
    const addressesPath = path.join(__dirname, "../src/config/contractAddresses.json");
    const allAddresses = JSON.parse(fs.readFileSync(addressesPath, "utf8"));
    const addresses = allAddresses[hre.network.name].contracts;

    // Get contract instances
    const MockUSDC = await hre.ethers.getContractFactory("MockUSDC");
    const mockUSDC = MockUSDC.attach(addresses.mockUSDC);

    const LendingPool = await hre.ethers.getContractFactory("LendingPool");
    const lendingPool = LendingPool.attach(addresses.lendingPool);

    // Check deployer's USDC balance
    const balance = await mockUSDC.balanceOf(deployer.address);
    console.log(`Deployer USDC balance: ${hre.ethers.formatUnits(balance, 6)} USDC`);

    // Deposit 100,000 USDC into the pool
    const depositAmount = hre.ethers.parseUnits("100000", 6);

    console.log(`\nDepositing ${hre.ethers.formatUnits(depositAmount, 6)} USDC into lending pool...`);

    // Approve
    console.log("Approving USDC...");
    const approveTx = await mockUSDC.approve(addresses.lendingPool, depositAmount);
    await approveTx.wait();

    // Deposit
    console.log("Depositing liquidity...");
    const depositTx = await lendingPool.depositLiquidity(depositAmount);
    await depositTx.wait();

    // Verify
    const totalLiquidity = await lendingPool.totalLiquidity();
    const availableLiquidity = await lendingPool.availableLiquidity();

    console.log("\n✅ Pool setup complete!");
    console.log(`   Total Liquidity: ${hre.ethers.formatUnits(totalLiquidity, 6)} USDC`);
    console.log(`   Available Liquidity: ${hre.ethers.formatUnits(availableLiquidity, 6)} USDC\n`);
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
