const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
    console.log("╔════════════════════════════════════════════════════════╗");
    console.log("║   Specular Protocol V2 Deployment (ERC-8004)          ║");
    console.log("╚════════════════════════════════════════════════════════╝\n");

    const [deployer] = await hre.ethers.getSigners();
    console.log("Deploying contracts with account:", deployer.address);
    console.log("Account balance:", hre.ethers.formatEther(await hre.ethers.provider.getBalance(deployer.address)), "ETH\n");

    // Deploy AgentRegistryV2 (ERC-8004 Identity Registry)
    console.log("📝 [1/5] Deploying AgentRegistryV2 (ERC-8004 Identity Registry)...");
    const AgentRegistryV2 = await hre.ethers.getContractFactory("AgentRegistryV2");
    const agentRegistry = await AgentRegistryV2.deploy();
    await agentRegistry.waitForDeployment();
    const agentRegistryAddress = await agentRegistry.getAddress();
    console.log("   ✅ AgentRegistryV2 deployed to:", agentRegistryAddress);

    // Deploy ReputationManagerV2 (ERC-8004 Reputation Registry)
    console.log("\n📊 [2/5] Deploying ReputationManagerV2 (ERC-8004 Reputation Registry)...");
    const ReputationManagerV2 = await hre.ethers.getContractFactory("ReputationManagerV2");
    const reputationManager = await ReputationManagerV2.deploy(agentRegistryAddress);
    await reputationManager.waitForDeployment();
    const reputationManagerAddress = await reputationManager.getAddress();
    console.log("   ✅ ReputationManagerV2 deployed to:", reputationManagerAddress);

    // Deploy ValidationRegistry (ERC-8004 Validation Registry)
    console.log("\n🔍 [3/5] Deploying ValidationRegistry (ERC-8004 Validation Registry)...");
    const ValidationRegistry = await hre.ethers.getContractFactory("ValidationRegistry");
    const validationRegistry = await ValidationRegistry.deploy(agentRegistryAddress);
    await validationRegistry.waitForDeployment();
    const validationRegistryAddress = await validationRegistry.getAddress();
    console.log("   ✅ ValidationRegistry deployed to:", validationRegistryAddress);

    // Deploy MockUSDC
    console.log("\n💵 [4/5] Deploying MockUSDC...");
    const MockUSDC = await hre.ethers.getContractFactory("MockUSDC");
    const mockUSDC = await MockUSDC.deploy();
    await mockUSDC.waitForDeployment();
    const mockUSDCAddress = await mockUSDC.getAddress();
    console.log("   ✅ MockUSDC deployed to:", mockUSDCAddress);

    // Mint initial USDC to deployer
    const mintAmount = hre.ethers.parseUnits("1000000", 6); // 1M USDC
    await mockUSDC.mint(deployer.address, mintAmount);
    console.log("   ✅ Minted", hre.ethers.formatUnits(mintAmount, 6), "USDC to deployer");

    // Deploy LendingPoolV2
    console.log("\n🏦 [5/5] Deploying LendingPoolV2...");
    const LendingPoolV2 = await hre.ethers.getContractFactory("LendingPoolV2");
    const lendingPool = await LendingPoolV2.deploy(
        agentRegistryAddress,
        reputationManagerAddress,
        mockUSDCAddress
    );
    await lendingPool.waitForDeployment();
    const lendingPoolAddress = await lendingPool.getAddress();
    console.log("   ✅ LendingPoolV2 deployed to:", lendingPoolAddress);

    // Setup permissions
    console.log("\n⚙️  Setting up permissions...");
    await reputationManager.setLendingPool(lendingPoolAddress);
    console.log("   ✅ LendingPool authorized in ReputationManager");

    // Save contract addresses
    console.log("\n💾 Saving contract addresses...");
    const addresses = {
        network: hre.network.name,
        deployedAt: new Date().toISOString(),
        contracts: {
            agentRegistry: agentRegistryAddress,
            reputationManager: reputationManagerAddress,
            validationRegistry: validationRegistryAddress,
            lendingPool: lendingPoolAddress,
            mockUSDC: mockUSDCAddress
        }
    };

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

    // Export ABIs
    console.log("📄 Exporting ABIs...");
    const abiDir = path.join(__dirname, "../abis");
    if (!fs.existsSync(abiDir)) {
        fs.mkdirSync(abiDir, { recursive: true });
    }

    const contracts = [
        { name: "AgentRegistryV2", artifact: AgentRegistryV2 },
        { name: "ReputationManagerV2", artifact: ReputationManagerV2 },
        { name: "ValidationRegistry", artifact: ValidationRegistry },
        { name: "LendingPoolV2", artifact: LendingPoolV2 },
        { name: "MockUSDC", artifact: MockUSDC }
    ];

    for (const contract of contracts) {
        const artifact = await hre.artifacts.readArtifact(contract.name);
        fs.writeFileSync(
            path.join(abiDir, `${contract.name}.json`),
            JSON.stringify(artifact.abi, null, 2)
        );
        console.log(`   ✅ ${contract.name} ABI exported`);
    }

    console.log("\n╔════════════════════════════════════════════════════════╗");
    console.log("║   Deployment Complete!                                 ║");
    console.log("╚════════════════════════════════════════════════════════╝\n");

    console.log("📋 Contract Addresses:");
    console.log("   AgentRegistryV2:      ", agentRegistryAddress);
    console.log("   ReputationManagerV2:  ", reputationManagerAddress);
    console.log("   ValidationRegistry:   ", validationRegistryAddress);
    console.log("   LendingPoolV2:        ", lendingPoolAddress);
    console.log("   MockUSDC:             ", mockUSDCAddress);

    console.log("\n📁 Files Created:");
    console.log("   Contract addresses:   ", addressesPath);
    console.log("   ABIs:                 ", abiDir);

    console.log("\n📖 ERC-8004 Compliance:");
    console.log("   ✅ Identity Registry (ERC-721):   AgentRegistryV2");
    console.log("   ✅ Reputation Registry:           ReputationManagerV2");
    console.log("   ✅ Validation Registry:           ValidationRegistry");

    console.log("\n📖 Next Steps:");
    console.log("   1. Setup pool liquidity:    npx hardhat run scripts/setup-pool.js --network", hre.network.name);
    console.log("   2. Run tests:               npx hardhat test test/v2/*.test.js");
    console.log("   3. Run example agent:       node examples/basic-agent-v2.js");

    console.log("\n✨ Deployment successful!\n");
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
