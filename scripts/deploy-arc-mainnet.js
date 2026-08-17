/**
 * Deploy the Specular protocol (FIXED V6 stack) to Arc Mainnet.
 *
 * Deploys: AgentRegistryV2 → ReputationManagerV3 → AgentLiquidityMarketplaceV6
 *          (the audited/fixed marketplace) → AgentCreditFaucet, then wires
 *          authorizePool and (optionally) the M-1/M-2 protective levers.
 *
 * SAFETY: this touches real money. By default it runs a DRY RUN (validates
 * config, checks chain + balance, estimates gas, prints the plan) and does NOT
 * broadcast. To actually deploy, set DEPLOY_CONFIRM=YES.
 *
 * Required env:
 *   PRIVATE_KEY             deployer key (should be the secure wallet)
 *   ARC_MAINNET_RPC_URL     Arc mainnet RPC endpoint
 *   ARC_MAINNET_CHAIN_ID    Arc mainnet chain id (numeric)
 *   ARC_MAINNET_USDC        REAL USDC token address on Arc mainnet (6 decimals)
 * Optional env:
 *   DEPLOY_CONFIRM=YES              broadcast for real (else dry run)
 *   ARC_MAINNET_MIN_GAS            min native-token balance required (default 0.01)
 *   SPECULAR_BIND_BORROW=1         enable M-1 lever (bindBorrowToPoolCreator) post-deploy
 *   SPECULAR_MIN_HOLD_SECONDS=N    enable M-2 lever (minHoldForReputationReward)
 *   FAUCET_MAX_ELIGIBLE_AGENT_ID=N enable faucet claims up to this agentId (default 0 = off)
 *
 * Usage:
 *   node scripts/deploy-arc-mainnet.js              # dry run
 *   DEPLOY_CONFIRM=YES node scripts/deploy-arc-mainnet.js
 */
require('dotenv').config();
const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

// The known Arc TESTNET mock USDC — refuse to deploy mainnet against it.
const ARC_TESTNET_MOCK_USDC = '0xf2807051e292e945751A25616705a9aadfb39895';

function req(name) {
    const v = process.env[name];
    if (!v) { console.error(`❌ Missing required env: ${name}`); process.exit(1); }
    return v;
}

function loadArtifact(rel) {
    const p = path.join(__dirname, '..', 'artifacts', 'contracts', 'core', rel);
    return JSON.parse(fs.readFileSync(p, 'utf8'));
}

async function main() {
    const DRY_RUN = process.env.DEPLOY_CONFIRM !== 'YES';
    const RPC_URL = req('ARC_MAINNET_RPC_URL');
    const CHAIN_ID = Number(req('ARC_MAINNET_CHAIN_ID'));
    const USDC = ethers.getAddress(req('ARC_MAINNET_USDC')); // throws on bad checksum
    const MIN_GAS = ethers.parseEther(process.env.ARC_MAINNET_MIN_GAS || '0.01');

    console.log('╔════════════════════════════════════════════════════════╗');
    console.log(`║  Specular → Arc Mainnet   ${DRY_RUN ? '[DRY RUN]        ' : '[LIVE BROADCAST] '}          ║`);
    console.log('╚════════════════════════════════════════════════════════╝\n');

    // ── Guard: never deploy mainnet against the testnet mock USDC ──────────
    if (USDC.toLowerCase() === ARC_TESTNET_MOCK_USDC.toLowerCase()) {
        console.error('❌ ARC_MAINNET_USDC is the Arc TESTNET mock USDC. Set the real mainnet USDC.');
        process.exit(1);
    }

    const provider = new ethers.JsonRpcProvider(RPC_URL, CHAIN_ID, { batchMaxCount: 1 });

    // ── Guard: connected chain must match the declared chain id ────────────
    const net = await provider.getNetwork();
    if (Number(net.chainId) !== CHAIN_ID) {
        console.error(`❌ RPC chainId ${net.chainId} != ARC_MAINNET_CHAIN_ID ${CHAIN_ID}. Refusing.`);
        process.exit(1);
    }

    // ── Guard: USDC sanity — must be a contract with 6 decimals ────────────
    const usdc = new ethers.Contract(USDC, [
        'function decimals() view returns (uint8)',
        'function symbol() view returns (string)',
    ], provider);
    let decimals, symbol;
    try {
        decimals = await usdc.decimals();
        symbol = await usdc.symbol();
    } catch (e) {
        console.error(`❌ ARC_MAINNET_USDC ${USDC} does not look like an ERC-20 (decimals()/symbol() failed): ${e.message}`);
        process.exit(1);
    }
    if (Number(decimals) !== 6) {
        console.error(`❌ USDC decimals = ${decimals}, expected 6. Refusing (unit mismatch would misprice everything).`);
        process.exit(1);
    }

    const wallet = new ethers.Wallet(req('PRIVATE_KEY'), provider);
    const balance = await provider.getBalance(wallet.address);

    console.log(`Network:   Arc Mainnet (chainId ${CHAIN_ID})`);
    console.log(`RPC:       ${RPC_URL}`);
    console.log(`USDC:      ${USDC}  (${symbol}, ${decimals} dec)`);
    console.log(`Deployer:  ${wallet.address}`);
    console.log(`Balance:   ${ethers.formatEther(balance)} (native)`);
    console.log(`Min gas:   ${ethers.formatEther(MIN_GAS)}\n`);

    if (balance < MIN_GAS) {
        console.error(`❌ Deployer balance below ${ethers.formatEther(MIN_GAS)} — fund it before deploying.`);
        process.exit(1);
    }

    const Registry = loadArtifact('AgentRegistryV2.sol/AgentRegistryV2.json');
    const Reputation = loadArtifact('ReputationManagerV3.sol/ReputationManagerV3.json');
    const Marketplace = loadArtifact('AgentLiquidityMarketplaceV6.sol/AgentLiquidityMarketplaceV6.json');
    const Faucet = loadArtifact('AgentCreditFaucet.sol/AgentCreditFaucet.json');

    console.log('Deployment plan (all owned by deployer; transfer to secure wallet after):');
    console.log('  1. AgentRegistryV2()');
    console.log('  2. ReputationManagerV3(registry)');
    console.log('  3. AgentLiquidityMarketplaceV6(registry, reputation, usdc)   ← FIXED (H-1/H-2/H-3/M-3 + levers)');
    console.log('  4. AgentCreditFaucet(registry, usdc)');
    console.log('  5. reputation.authorizePool(marketplace)');
    if (process.env.SPECULAR_BIND_BORROW === '1') console.log('  6. marketplace.setBindBorrowToPoolCreator(true)   [M-1 lever]');
    if (process.env.SPECULAR_MIN_HOLD_SECONDS) console.log(`  7. marketplace.setMinHoldForReputationReward(${process.env.SPECULAR_MIN_HOLD_SECONDS})   [M-2 lever]`);
    if (process.env.FAUCET_MAX_ELIGIBLE_AGENT_ID) console.log(`  8. faucet.setMaxEligibleAgentId(${process.env.FAUCET_MAX_ELIGIBLE_AGENT_ID})`);
    console.log('');

    if (DRY_RUN) {
        // Estimate deployment gas for the marketplace (the big one) to sanity-check cost.
        const mpFactory = new ethers.ContractFactory(Marketplace.abi, Marketplace.bytecode, wallet);
        const deployTx = await mpFactory.getDeployTransaction(
            ethers.ZeroAddress, ethers.ZeroAddress, USDC // placeholder addrs for estimate only
        );
        let gas;
        try { gas = await provider.estimateGas({ ...deployTx, from: wallet.address }); }
        catch { gas = null; }
        const feeData = await provider.getFeeData();
        console.log('DRY RUN — no transactions broadcast.');
        if (gas) {
            const price = feeData.gasPrice || feeData.maxFeePerGas || 0n;
            console.log(`  Marketplace deploy gas est: ~${gas.toString()} @ ${ethers.formatUnits(price, 'gwei')} gwei`);
            console.log(`  ≈ ${ethers.formatEther(gas * price)} native (marketplace only; total ~2-3× for full stack)`);
        }
        console.log('\n✅ Config valid, chain matches, USDC sane, deployer funded.');
        console.log('   To broadcast: DEPLOY_CONFIRM=YES node scripts/deploy-arc-mainnet.js');
        return;
    }

    // ── LIVE BROADCAST ─────────────────────────────────────────────────────
    console.log('⚠️  LIVE — broadcasting in 5s. Ctrl+C to abort.\n');
    await new Promise(r => setTimeout(r, 5000));

    const deploy = async (name, artifact, args) => {
        console.log(`Deploying ${name}...`);
        const f = new ethers.ContractFactory(artifact.abi, artifact.bytecode, wallet);
        const c = await f.deploy(...args);
        await c.waitForDeployment();
        const addr = await c.getAddress();
        console.log(`  ✅ ${name}: ${addr}`);
        return c;
    };

    const registry = await deploy('AgentRegistryV2', Registry, []);
    const registryAddr = await registry.getAddress();
    const reputation = await deploy('ReputationManagerV3', Reputation, [registryAddr]);
    const reputationAddr = await reputation.getAddress();
    const marketplace = await deploy('AgentLiquidityMarketplaceV6', Marketplace, [registryAddr, reputationAddr, USDC]);
    const marketplaceAddr = await marketplace.getAddress();
    const faucet = await deploy('AgentCreditFaucet', Faucet, [registryAddr, USDC]);
    const faucetAddr = await faucet.getAddress();

    console.log('\nWiring...');
    await (await reputation.authorizePool(marketplaceAddr)).wait();
    console.log('  ✅ reputation.authorizePool(marketplace)');

    if (process.env.SPECULAR_BIND_BORROW === '1') {
        await (await marketplace.setBindBorrowToPoolCreator(true)).wait();
        console.log('  ✅ M-1 lever: bindBorrowToPoolCreator = true');
    }
    if (process.env.SPECULAR_MIN_HOLD_SECONDS) {
        await (await marketplace.setMinHoldForReputationReward(BigInt(process.env.SPECULAR_MIN_HOLD_SECONDS))).wait();
        console.log(`  ✅ M-2 lever: minHoldForReputationReward = ${process.env.SPECULAR_MIN_HOLD_SECONDS}s`);
    }
    if (process.env.FAUCET_MAX_ELIGIBLE_AGENT_ID) {
        await (await faucet.setMaxEligibleAgentId(BigInt(process.env.FAUCET_MAX_ELIGIBLE_AGENT_ID))).wait();
        console.log(`  ✅ faucet.setMaxEligibleAgentId(${process.env.FAUCET_MAX_ELIGIBLE_AGENT_ID})`);
    }

    const addresses = {
        network: 'arc-mainnet',
        chainId: CHAIN_ID,
        rpcUrl: RPC_URL,
        agentRegistryV2: registryAddr,
        reputationManagerV3: reputationAddr,
        agentLiquidityMarketplace_v6: marketplaceAddr,
        agentCreditFaucet: faucetAddr,
        usdc: USDC,
        deployer: wallet.address,
        deployedAt: new Date().toISOString(),
        marketplaceVersion: 'V6 (2026-07 audit fixes: H-1/H-2/H-3/M-3 + M-1/M-2 levers)',
    };
    const outPath = path.join(__dirname, '..', 'src', 'config', 'arc-mainnet-addresses.json');
    fs.writeFileSync(outPath, JSON.stringify(addresses, null, 2));
    console.log(`\n✅ Deployed. Addresses written to ${outPath}`);
    console.log('\nNEXT STEPS (see forensics/output/security-audit-2026-07/ARC_MAINNET_DEPLOY_PREP.md):');
    console.log('  • Verify contracts on the Arc explorer.');
    console.log('  • Transfer ownership of all 4 contracts to the secure wallet (if deployer != secure).');
    console.log('  • Fund the faucet with USDC if enabling grants.');
}

main().catch((e) => { console.error(e); process.exit(1); });
