require('dotenv').config();
const { ethers } = require('ethers');
const fs = require('fs');

async function main() {
    console.log('Completing Base Mainnet Deployment...\n');
    
    const provider = new ethers.JsonRpcProvider('https://mainnet.base.org', 8453, { batchMaxCount: 1 });
    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
    
    const REGISTRY_ADDR = '0xb9996de05fD514A0cB2B81fa25448EECD4559Aaa';
    const REPUTATION_ADDR = '0xe4D78A509daa8dc8bFB453cb76d61f1Cb1c4C3fF';
    const USDC_ADDR = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
    
    console.log('Deployer:', wallet.address);
    console.log('Registry:', REGISTRY_ADDR);
    console.log('Reputation:', REPUTATION_ADDR);
    console.log('\n');
    
    // Load marketplace artifact
    const Marketplace = JSON.parse(
        fs.readFileSync('/Users/peterschroeder/Specular/artifacts/contracts/core/AgentLiquidityMarketplace.sol/AgentLiquidityMarketplace.json')
    );
    
    // Deploy marketplace
    console.log('Deploying AgentLiquidityMarketplace...');
    const Factory = new ethers.ContractFactory(Marketplace.abi, Marketplace.bytecode, wallet);
    const marketplace = await Factory.deploy(REGISTRY_ADDR, REPUTATION_ADDR, USDC_ADDR);
    await marketplace.waitForDeployment();
    const marketplaceAddr = await marketplace.getAddress();
    console.log('✅ Deployed at:', marketplaceAddr);
    
    // Authorize marketplace
    console.log('\nAuthorizing marketplace...');
    const reputation = new ethers.Contract(
        REPUTATION_ADDR,
        ['function authorizeContract(address) external'],
        wallet
    );
    const authTx = await reputation.authorizeContract(marketplaceAddr);
    await authTx.wait();
    console.log('✅ Authorized');
    
    // Save addresses
    const addresses = {
        agentRegistryV2: REGISTRY_ADDR,
        reputationManagerV3: REPUTATION_ADDR,
        usdc: USDC_ADDR,
        agentLiquidityMarketplace: marketplaceAddr,
        deployer: wallet.address,
        deployedAt: new Date().toISOString(),
        network: 'base-mainnet',
        chainId: 8453
    };
    
    fs.writeFileSync(
        '/Users/peterschroeder/Specular/src/config/base-addresses.json',
        JSON.stringify(addresses, null, 2)
    );
    
    console.log('\n✅ DEPLOYMENT COMPLETE!');
    console.log('\nAll contracts owned by:', wallet.address);
    console.log('All fees accrue to:', wallet.address);
    console.log('\nSaved to: src/config/base-addresses.json');
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
