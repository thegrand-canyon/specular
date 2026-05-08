/**
 * Deploy AgentLiquidityMarketplaceV6 to Base Mainnet.
 *
 * SAFETY GATES:
 *   - Requires DEPLOY_CONFIRM=I_HAVE_AUDITED_V6 env var to broadcast
 *   - Verifies chainId == 8453 before deployment
 *   - Verifies deployer wallet matches expected secure owner
 *   - Idempotent: skips if `agentLiquidityMarketplace_v6` already set in JSON config
 *   - Authorizes V6 with Base ReputationManagerV3 (owner of secure wallet)
 *
 * Run:
 *   DEPLOY_CONFIRM=I_HAVE_AUDITED_V6 npx hardhat run scripts/deploy-v6-base-mainnet.js --network base
 *
 * Without DEPLOY_CONFIRM the script does a dry-run (estimates gas, reports
 * checksums, exits without broadcasting).
 */

const { ethers } = require('hardhat');
const fs = require('fs');
const path = require('path');

const EXPECTED_OWNER = '0x800e305A0caDdE6289dFDFEDF38218f45C06F72C';
const EXPECTED_CHAINID = 8453n;

async function main() {
    console.log('\n🚀 DEPLOY V6 → BASE MAINNET\n');
    console.log('═══════════════════════════════════════════════════════\n');

    const [deployer] = await ethers.getSigners();
    console.log('Deployer:', deployer.address);

    // Network gate
    const network = await ethers.provider.getNetwork();
    console.log('chainId:', network.chainId.toString());
    if (network.chainId !== EXPECTED_CHAINID) {
        console.error(`❌ Expected chainId ${EXPECTED_CHAINID}, got ${network.chainId}. Aborting.`);
        process.exit(1);
    }

    // Owner gate
    if (deployer.address.toLowerCase() !== EXPECTED_OWNER.toLowerCase()) {
        console.error(`❌ Deployer ${deployer.address} is not the expected owner ${EXPECTED_OWNER}.`);
        console.error('   This contract is intentionally only deployable from the secure-owner wallet.');
        process.exit(1);
    }

    // Balance gate
    const ethBal = await ethers.provider.getBalance(deployer.address);
    console.log('Base ETH:', ethers.formatEther(ethBal));
    if (ethBal < ethers.parseEther('0.005')) {
        console.error(`❌ Insufficient Base ETH (have ${ethers.formatEther(ethBal)}, need ≥0.005 for safe deployment).`);
        process.exit(1);
    }

    // Config gate
    const cfgPath = path.join(__dirname, '..', 'src', 'config', 'base-addresses.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    if (cfg.agentLiquidityMarketplace_v6) {
        const code = await ethers.provider.getCode(cfg.agentLiquidityMarketplace_v6);
        if (code !== '0x') {
            console.log(`✓ V6 already deployed at ${cfg.agentLiquidityMarketplace_v6}. Skipping.`);
            console.log('  To redeploy: remove the agentLiquidityMarketplace_v6 key from base-addresses.json');
            return;
        }
    }

    console.log('\nDependencies (existing on Base):');
    console.log('  AgentRegistryV2:    ', cfg.agentRegistryV2);
    console.log('  ReputationManagerV3:', cfg.reputationManagerV3);
    console.log('  USDC:               ', cfg.usdc, '(real USDC)');

    // Estimate deployment gas
    const Factory = await ethers.getContractFactory('AgentLiquidityMarketplaceV6');
    const deployTx = await Factory.getDeployTransaction(cfg.agentRegistryV2, cfg.reputationManagerV3, cfg.usdc);
    const estGas = await ethers.provider.estimateGas({ ...deployTx, from: deployer.address });
    const gasPrice = (await ethers.provider.getFeeData()).gasPrice || ethers.parseUnits('0.05', 'gwei');
    const estCostWei = estGas * gasPrice;
    console.log('\nDeployment estimate:');
    console.log('  gas:      ', estGas.toString());
    console.log('  gasPrice: ', ethers.formatUnits(gasPrice, 'gwei'), 'gwei');
    console.log('  cost:     ', ethers.formatEther(estCostWei), 'ETH (≈ $' + (parseFloat(ethers.formatEther(estCostWei)) * 3000).toFixed(2) + ')');

    // Confirmation gate
    if (process.env.DEPLOY_CONFIRM !== 'I_HAVE_AUDITED_V6') {
        console.log('\n📋 DRY-RUN COMPLETE. To broadcast, re-run with:');
        console.log('   DEPLOY_CONFIRM=I_HAVE_AUDITED_V6 npx hardhat run scripts/deploy-v6-base-mainnet.js --network base');
        console.log('\n⚠️  Before setting DEPLOY_CONFIRM, make sure you have:');
        console.log('   1. External audit of V6 (slither, mythril, manual review) — see V6_MIGRATION_RUNBOOK.md');
        console.log('   2. Verified all 287 hardhat tests + 8 V6Migration tests pass on the deployed bytecode');
        console.log('   3. Decided on the migration sequence with users notified');
        console.log('   4. Liquidated stuck Base loans #2/#3/#4 (post 2026-05-11 19:10 UTC)');
        console.log('   5. Bridged sufficient ETH to deployer wallet');
        return;
    }

    console.log('\n🚨 DEPLOY_CONFIRM SET — BROADCASTING TO BASE MAINNET 🚨\n');

    const v6 = await Factory.deploy(cfg.agentRegistryV2, cfg.reputationManagerV3, cfg.usdc);
    await v6.waitForDeployment();
    const v6Addr = await v6.getAddress();
    const tx = v6.deploymentTransaction();
    console.log('✅ V6:', v6Addr);
    console.log('   tx:', tx?.hash);

    // Authorize with reputation manager
    console.log('\nAuthorizing V6 with Base ReputationManagerV3...');
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
        } else console.log('  ✓ already authorized');
    } else {
        console.log(`  ⚠ Deployer is NOT ReputationManager owner (owner: ${repOwner}). Owner must call:`);
        console.log(`     reputation.authorizePool('${v6Addr}')`);
    }

    cfg.agentLiquidityMarketplace_v6 = v6Addr;
    cfg.agentLiquidityMarketplace_v6_deployedAt = new Date().toISOString();
    cfg.agentLiquidityMarketplace_v6_note =
        'V6 with §B1 + §S1 + §S5 fixes. Migration not started. Not yet canonical.';
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
    console.log('\n✅ Updated', cfgPath);

    console.log('\nNext steps:');
    console.log('  1. Verify on https://basescan.org/address/' + v6Addr);
    console.log('  2. Submit for verification: npx hardhat verify --network base ' + v6Addr +
        ` "${cfg.agentRegistryV2}" "${cfg.reputationManagerV3}" "${cfg.usdc}"`);
    console.log('  3. Smoke-test: read paused(), owner(), MAX_LENDERS_PER_POOL, MAX_ACTIVE_LOANS_PER_AGENT');
    console.log('  4. Notify users of migration window (per V6_MIGRATION_RUNBOOK.md communication template)');
    console.log('  5. Lenders self-migrate from v4 (one Base lender: secure wallet itself, single migration)');
    console.log('  6. Owner: setMigrationFinalized()');
    console.log('  7. Update src/config/base-addresses.json — swap agentLiquidityMarketplace value to V6');
    console.log('  8. Update frontend/js/config.js + frontend/abis/AgentLiquidityMarketplace.json');
    console.log('  9. Redeploy API (Railway) + frontend (Vercel)');
}

main().catch(e => { console.error(e); process.exit(1); });
