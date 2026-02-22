const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
    console.log("╔════════════════════════════════════════════════════════╗");
    console.log("║   Specular Protocol Deployment                        ║");
    console.log("╚════════════════════════════════════════════════════════╝\n");

    const [deployer] = await hre.ethers.getSigners();
    console.log("Deploying contracts with account:", deployer.address);

    const balance = await hre.ethers.provider.getBalance(deployer.address);
    console.log("Account balance:", hre.ethers.formatEther(balance), "ETH\n");

    // ==================== Deploy AgentRegistry ====================
    console.log("📝 [1/4] Deploying AgentRegistry...");
    const AgentRegistry = await hre.ethers.getContractFactory("AgentRegistry");
    const agentRegistry = await AgentRegistry.deploy();
    await agentRegistry.waitForDeployment();
    const agentRegistryAddress = await agentRegistry.getAddress();
    console.log("   ✅ AgentRegistry deployed to:", agentRegistryAddress);

    // ==================== Deploy ReputationManager ====================
    console.log("\n📊 [2/4] Deploying ReputationManager...");
    const ReputationManager = await hre.ethers.getContractFactory("ReputationManager");
    const reputationManager = await ReputationManager.deploy(agentRegistryAddress);
    await reputationManager.waitForDeployment();
    const reputationManagerAddress = await reputationManager.getAddress();
    console.log("   ✅ ReputationManager deployed to:", reputationManagerAddress);

    // ==================== Deploy MockUSDC ====================
    console.log("\n💵 [3/4] Deploying MockUSDC...");
    const MockUSDC = await hre.ethers.getContractFactory("MockUSDC");
    const mockUSDC = await MockUSDC.deploy();
    await mockUSDC.waitForDeployment();
    const mockUSDCAddress = await mockUSDC.getAddress();
    console.log("   ✅ MockUSDC deployed to:", mockUSDCAddress);

    // ==================== Deploy LendingPool ====================
    console.log("\n🏦 [4/4] Deploying LendingPool...");
    const LendingPool = await hre.ethers.getContractFactory("LendingPool");
    const lendingPool = await LendingPool.deploy(
        agentRegistryAddress,
        reputationManagerAddress,
        mockUSDCAddress
    );
    await lendingPool.waitForDeployment();
    const lendingPoolAddress = await lendingPool.getAddress();
    console.log("   ✅ LendingPool deployed to:", lendingPoolAddress);

    // ==================== Setup Permissions ====================
    console.log("\n⚙️  Setting up permissions...");
    const tx = await reputationManager.setLendingPool(lendingPoolAddress);
    await tx.wait();
    console.log("   ✅ LendingPool authorized in ReputationManager");

    // ==================== Save Contract Addresses ====================
    console.log("\n💾 Saving contract addresses...");
    const addresses = {
        network: hre.network.name,
        deployedAt: new Date().toISOString(),
        contracts: {
            agentRegistry: agentRegistryAddress,
            reputationManager: reputationManagerAddress,
            lendingPool: lendingPoolAddress,
            mockUSDC: mockUSDCAddress
        }
    };

    // Create config directory if it doesn't exist
    const configDir = path.join(__dirname, "../src/config");
    if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true });
    }

    const addressesPath = path.join(configDir, "contractAddresses.json");
    let allAddresses = {};

    if (fs.existsSync(addressesPath)) {
        allAddresses = JSON.parse(fs.readFileSync(addressesPath, "utf8"));
    }

    allAddresses[hre.network.name] = addresses;
    fs.writeFileSync(addressesPath, JSON.stringify(allAddresses, null, 2));

    // ==================== Export ABIs ====================
    console.log("📄 Exporting ABIs...");
    const abiDir = path.join(__dirname, "../abis");
    if (!fs.existsSync(abiDir)) {
        fs.mkdirSync(abiDir, { recursive: true });
    }

    const contracts = [
        { name: "AgentRegistry", artifact: "contracts/core/AgentRegistry.sol/AgentRegistry.json" },
        { name: "ReputationManager", artifact: "contracts/core/ReputationManager.sol/ReputationManager.json" },
        { name: "LendingPool", artifact: "contracts/core/LendingPool.sol/LendingPool.json" },
        { name: "MockUSDC", artifact: "contracts/tokens/MockUSDC.sol/MockUSDC.json" }
    ];

    for (const contract of contracts) {
        const artifactPath = path.join(__dirname, "../artifacts", contract.artifact);
        if (fs.existsSync(artifactPath)) {
            const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
            const abiPath = path.join(abiDir, `${contract.name}.json`);
            fs.writeFileSync(abiPath, JSON.stringify(artifact.abi, null, 2));
            console.log(`   ✅ ${contract.name} ABI exported`);
        }
    }

    // ==================== Summary ====================
    console.log("\n╔════════════════════════════════════════════════════════╗");
    console.log("║   Deployment Complete!                                 ║");
    console.log("╚════════════════════════════════════════════════════════╝\n");

    console.log("📋 Contract Addresses:");
    console.log("   AgentRegistry:       ", agentRegistryAddress);
    console.log("   ReputationManager:   ", reputationManagerAddress);
    console.log("   LendingPool:         ", lendingPoolAddress);
    console.log("   MockUSDC:            ", mockUSDCAddress);

    console.log("\n📁 Files Created:");
    console.log("   Contract addresses:  ", addressesPath);
    console.log("   ABIs:                ", abiDir);

    // ==================== Verification Info ====================
    if (hre.network.name !== "hardhat" && hre.network.name !== "localhost") {
        console.log("\n📝 To verify contracts on Etherscan, run:");
        console.log(`   npx hardhat verify --network ${hre.network.name} ${agentRegistryAddress}`);
        console.log(`   npx hardhat verify --network ${hre.network.name} ${reputationManagerAddress} ${agentRegistryAddress}`);
        console.log(`   npx hardhat verify --network ${hre.network.name} ${mockUSDCAddress}`);
        console.log(`   npx hardhat verify --network ${hre.network.name} ${lendingPoolAddress} ${agentRegistryAddress} ${reputationManagerAddress} ${mockUSDCAddress}`);
    }

    // ==================== Next Steps ====================
    console.log("\n📖 Next Steps:");
    console.log("   1. Run tests:               npx hardhat test");
    console.log("   2. Setup pool liquidity:    npx hardhat run scripts/setup-pool.js --network", hre.network.name);
    console.log("   3. Run example agent:       node examples/basic-agent.js");

    console.log("\n✨ Deployment successful!\n");
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error("\n❌ Deployment failed:");
        console.error(error);
        process.exit(1);
    });
