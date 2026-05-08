/**
 * Deploy AgentLiquidityMarketplaceV6 to Arc Testnet.
 *
 * Reuses the existing AgentRegistryV2 + ReputationManagerV3 + MockUSDC from
 * src/config/arc-testnet-addresses.json. Only deploys the new marketplace.
 *
 * After deploy:
 *   1. Authorizes V6 with reputationManagerV3 (so V6 can record borrows/defaults)
 *   2. Writes the new address back to arc-testnet-addresses.json under
 *      `agentLiquidityMarketplace_v6` (does NOT replace canonical key — manual swap later)
 *   3. Idempotent: if `agentLiquidityMarketplace_v6` is already set and the contract
 *      has code, skips deployment.
 */

const { ethers } = require('hardhat');
const fs = require('fs');
const path = require('path');

async function main() {
    console.log('\n🚀 DEPLOY V6 TO ARC TESTNET\n');
    console.log('═══════════════════════════════════════════════════════\n');

    const [deployer] = await ethers.getSigners();
    console.log('Deployer:', deployer.address);
    const network = await ethers.provider.getNetwork();
    console.log('Network chainId:', network.chainId.toString());

    const balance = await ethers.provider.getBalance(deployer.address);
    console.log('Native balance:', ethers.formatEther(balance));

    const cfgPath = path.join(__dirname, '..', 'src', 'config', 'arc-testnet-addresses.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));

    // Idempotency check
    if (cfg.agentLiquidityMarketplace_v6) {
        const existing = cfg.agentLiquidityMarketplace_v6;
        const code = await ethers.provider.getCode(existing);
        if (code !== '0x') {
            console.log(`✓ V6 already deployed at ${existing} — skipping deploy.`);
            console.log('  Re-run with `--force` to redeploy (not implemented; remove the key from JSON to redeploy).');
            return;
        }
        console.log(`⚠ Address ${existing} stored but no code — will redeploy.`);
    }

    console.log('\nDependencies (existing):');
    console.log('  AgentRegistryV2:    ', cfg.agentRegistryV2);
    console.log('  ReputationManagerV3:', cfg.reputationManagerV3);
    console.log('  USDC:               ', cfg.usdc);

    // Deploy V6
    console.log('\nDeploying AgentLiquidityMarketplaceV6...');
    const Factory = await ethers.getContractFactory('AgentLiquidityMarketplaceV6');
    const v6 = await Factory.deploy(cfg.agentRegistryV2, cfg.reputationManagerV3, cfg.usdc);
    await v6.waitForDeployment();
    const v6Addr = await v6.getAddress();
    const tx = v6.deploymentTransaction();
    console.log('  ✅ V6:', v6Addr);
    console.log('  tx:', tx?.hash);

    // Authorize V6 with reputation manager
    console.log('\nAuthorizing V6 with ReputationManagerV3...');
    const repAbi = JSON.parse(fs.readFileSync(
        path.join(__dirname, '..', 'artifacts', 'contracts', 'core', 'ReputationManagerV3.sol', 'ReputationManagerV3.json')
    )).abi;
    const reputation = new ethers.Contract(cfg.reputationManagerV3, repAbi, deployer);

    const repOwner = await reputation.owner();
    if (repOwner.toLowerCase() === deployer.address.toLowerCase()) {
        const isAlready = await reputation.authorizedPools(v6Addr).catch(() => false);
        if (!isAlready) {
            const authTx = await reputation.authorizePool(v6Addr);
            console.log('  authorizePool tx:', authTx.hash);
            await authTx.wait();
            console.log('  ✅ authorized');
        } else {
            console.log('  ✓ already authorized');
        }
    } else {
        console.log(`  ⚠ Deployer is NOT the ReputationManager owner (owner: ${repOwner}).`);
        console.log('    Owner must call: reputation.authorizePool(' + v6Addr + ')');
    }

    // Update config file
    cfg.agentLiquidityMarketplace_v6 = v6Addr;
    cfg.agentLiquidityMarketplace_v6_deployedAt = new Date().toISOString();
    cfg.agentLiquidityMarketplace_v6_note =
        'V6 with §B1 + §S1 + §S5 fixes. Migration not started. Not yet canonical.';
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
    console.log('\n✅ Updated', cfgPath);

    console.log('\nNext steps:');
    console.log('  1. Verify on https://testnet.arcscan.app/address/' + v6Addr);
    console.log('  2. Run migration: scripts/migrate-arc-to-v6.js (write next)');
    console.log('  3. After migration: call setMigrationFinalized()');
    console.log('  4. Update src/sdk/* to point at agentLiquidityMarketplace_v6');
    console.log('  5. Pause v4 marketplace to prevent new state divergence');
}

main().catch(e => { console.error(e); process.exit(1); });
