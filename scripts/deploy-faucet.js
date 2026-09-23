/**
 * Deploy AgentCreditFaucet to a network. Usage:
 *   npx hardhat run scripts/deploy-faucet.js --network arcTestnet
 *   npx hardhat run scripts/deploy-faucet.js --network base
 */
const { ethers, network } = require('hardhat');
const fs = require('fs');
const path = require('path');

const NET_TO_CFG = { arcTestnet: 'arc-testnet-addresses.json', base: 'base-addresses.json' };

async function main() {
    const [deployer] = await ethers.getSigners();
    const netName = network.name;
    const cfgPath = path.join(__dirname, '..', 'src', 'config', NET_TO_CFG[netName] || `${netName}-addresses.json`);
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));

    console.log('\n=== Deploy AgentCreditFaucet to', netName, '===');
    console.log('Deployer:', deployer.address);
    console.log('Registry:', cfg.agentRegistryV2);
    console.log('USDC:    ', cfg.usdc);

    if (cfg.agentCreditFaucet) {
        const code = await ethers.provider.getCode(cfg.agentCreditFaucet);
        if (code !== '0x') {
            console.log('✓ Faucet already deployed at', cfg.agentCreditFaucet);
            return;
        }
    }

    const Factory = await ethers.getContractFactory('AgentCreditFaucet');
    const faucet = await Factory.deploy(cfg.agentRegistryV2, cfg.usdc);
    await faucet.waitForDeployment();
    const addr = await faucet.getAddress();
    const tx = faucet.deploymentTransaction();
    console.log('✅ Faucet:', addr);
    console.log('   tx:', tx?.hash);

    cfg.agentCreditFaucet = addr;
    cfg.agentCreditFaucet_deployedAt = new Date().toISOString();
    cfg.agentCreditFaucet_note = 'Initial credit boost for new agents — owner must fund + set maxEligibleAgentId';
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
    console.log('✅ Updated', cfgPath);

    console.log('\nNext: owner needs to');
    console.log('  1. Transfer USDC to', addr, '(e.g. 1000 USDC for 100 free claims at default 10/agent)');
    console.log('  2. Call setMaxEligibleAgentId(N) to open faucet to agents 1..N');
}

main().catch(e => { console.error(e); process.exit(1); });
