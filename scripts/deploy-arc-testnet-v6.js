/**
 * Deploy the FIXED V6 stack to Arc TESTNET as a mainnet-rehearsal staging deploy.
 *
 * Deploys a fresh mintable MockUSDC + AgentRegistryV2 + ReputationManagerV3 +
 * AgentLiquidityMarketplaceV6 (the 2026-07/08 fixed marketplace) + AgentCreditFaucet,
 * then applies the EXACT Arc-mainnet launch levers. Writes to a NEW config file
 * (src/config/arc-testnet-v6-addresses.json) — it does NOT touch the mainnet
 * config or the old arc-testnet-addresses.json.
 *
 * This is TESTNET. A fresh mintable MockUSDC is used so the smoke test is fully
 * controllable; the real Arc mainnet deploy (scripts/deploy-arc-mainnet.js) uses
 * the canonical 6-decimal USDC ERC-20 instead — the marketplace logic is
 * token-agnostic, so this faithfully rehearses the deploy + config sequence.
 *
 * Safety: DRY RUN by default. Set DEPLOY_CONFIRM=YES to broadcast.
 *
 * Env: PRIVATE_KEY (deployer, should be the secure wallet), ARC_TESTNET_RPC_URL.
 * Launch levers (applied if set): SPECULAR_BIND_BORROW, SPECULAR_MIN_HOLD_SECONDS,
 *   SPECULAR_MIN_SUPPLY, SPECULAR_REP_RATE_MAX/_WINDOW, SPECULAR_PLATFORM_FEE_BPS,
 *   FAUCET_MAX_ELIGIBLE_AGENT_ID.
 */
require('dotenv').config();
const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

const RPC_URL = process.env.ARC_TESTNET_RPC_URL || 'https://arc-testnet.drpc.org';
const CHAIN_ID = 5042002;

function loadArtifact(rel) {
    return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'artifacts', 'contracts', rel), 'utf8'));
}

async function main() {
    const DRY_RUN = process.env.DEPLOY_CONFIRM !== 'YES';
    console.log('╔══════════════════════════════════════════════════════════╗');
    console.log(`║  Specular FIXED V6 → Arc TESTNET staging  ${DRY_RUN ? '[DRY RUN]     ' : '[BROADCAST]   '}   ║`);
    console.log('╚══════════════════════════════════════════════════════════╝\n');

    if (!process.env.PRIVATE_KEY) { console.error('❌ Missing PRIVATE_KEY'); process.exit(1); }
    const provider = new ethers.JsonRpcProvider(RPC_URL, CHAIN_ID, { batchMaxCount: 1 });
    const net = await provider.getNetwork();
    if (Number(net.chainId) !== CHAIN_ID) {
        console.error(`❌ RPC chainId ${net.chainId} != Arc testnet ${CHAIN_ID}`); process.exit(1);
    }
    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
    const bal = await provider.getBalance(wallet.address);
    console.log(`Network:  Arc Testnet (chainId ${CHAIN_ID})`);
    console.log(`Deployer: ${wallet.address}`);
    console.log(`Balance:  ${ethers.formatEther(bal)} native (= USDC gas on Arc)\n`);
    if (bal < ethers.parseEther('0.05')) { console.error('❌ Deployer native balance too low for the full stack'); process.exit(1); }

    const MockUSDC = loadArtifact('tokens/MockUSDC.sol/MockUSDC.json');
    const Registry = loadArtifact('core/AgentRegistryV2.sol/AgentRegistryV2.json');
    const Reputation = loadArtifact('core/ReputationManagerV3.sol/ReputationManagerV3.json');
    const Marketplace = loadArtifact('core/AgentLiquidityMarketplaceV6.sol/AgentLiquidityMarketplaceV6.json');
    const Faucet = loadArtifact('core/AgentCreditFaucet.sol/AgentCreditFaucet.json');

    console.log('Plan: MockUSDC → AgentRegistryV2 → ReputationManagerV3 → V6(fixed) → AgentCreditFaucet');
    console.log('      + authorizePool + launch levers, → src/config/arc-testnet-v6-addresses.json\n');

    if (DRY_RUN) {
        console.log('DRY RUN — no broadcast. Config valid, chain matches, deployer funded.');
        console.log('To broadcast: DEPLOY_CONFIRM=YES node scripts/deploy-arc-testnet-v6.js');
        return;
    }

    console.log('⚠️  BROADCAST in 5s. Ctrl+C to abort.\n');
    await new Promise(r => setTimeout(r, 5000));

    const deploy = async (name, art, args) => {
        console.log(`Deploying ${name}...`);
        const c = await new ethers.ContractFactory(art.abi, art.bytecode, wallet).deploy(...args);
        await c.waitForDeployment();
        const addr = await c.getAddress();
        console.log(`  ✅ ${name}: ${addr}`);
        return c;
    };

    const usdc = await deploy('MockUSDC', MockUSDC, []);
    const usdcAddr = await usdc.getAddress();
    const registry = await deploy('AgentRegistryV2', Registry, []);
    const registryAddr = await registry.getAddress();
    const reputation = await deploy('ReputationManagerV3', Reputation, [registryAddr]);
    const reputationAddr = await reputation.getAddress();
    const marketplace = await deploy('AgentLiquidityMarketplaceV6', Marketplace, [registryAddr, reputationAddr, usdcAddr]);
    const marketplaceAddr = await marketplace.getAddress();
    const faucet = await deploy('AgentCreditFaucet', Faucet, [registryAddr, usdcAddr]);
    const faucetAddr = await faucet.getAddress();

    console.log('\nWiring...');
    await (await reputation.authorizePool(marketplaceAddr)).wait();
    console.log('  ✅ reputation.authorizePool(marketplace)');

    if (process.env.SPECULAR_BIND_BORROW === '1') {
        await (await marketplace.setBindBorrowToPoolCreator(true)).wait();
        console.log('  ✅ M-1: bindBorrowToPoolCreator = true');
    }
    if (process.env.SPECULAR_MIN_HOLD_SECONDS) {
        await (await marketplace.setMinHoldForReputationReward(BigInt(process.env.SPECULAR_MIN_HOLD_SECONDS))).wait();
        console.log(`  ✅ M-2: minHoldForReputationReward = ${process.env.SPECULAR_MIN_HOLD_SECONDS}s`);
    }
    if (process.env.SPECULAR_MIN_SUPPLY) {
        await (await marketplace.setMinSupplyAmount(BigInt(process.env.SPECULAR_MIN_SUPPLY))).wait();
        console.log(`  ✅ F-C: minSupplyAmount = ${process.env.SPECULAR_MIN_SUPPLY}`);
    }
    if (process.env.SPECULAR_REP_RATE_MAX) {
        const win = BigInt(process.env.SPECULAR_REP_RATE_WINDOW || 86400);
        await (await reputation.setReputationRateLimit(BigInt(process.env.SPECULAR_REP_RATE_MAX), win)).wait();
        console.log(`  ✅ D1 rate limit: ${process.env.SPECULAR_REP_RATE_MAX} / ${win}s`);
    }
    if (process.env.SPECULAR_PLATFORM_FEE_BPS) {
        await (await marketplace.setPlatformFeeRate(BigInt(process.env.SPECULAR_PLATFORM_FEE_BPS))).wait();
        console.log(`  ✅ D1: platformFeeRate = ${process.env.SPECULAR_PLATFORM_FEE_BPS} bps`);
    }
    if (process.env.FAUCET_MAX_ELIGIBLE_AGENT_ID) {
        await (await faucet.setMaxEligibleAgentId(BigInt(process.env.FAUCET_MAX_ELIGIBLE_AGENT_ID))).wait();
        console.log(`  ✅ faucet.setMaxEligibleAgentId(${process.env.FAUCET_MAX_ELIGIBLE_AGENT_ID})`);
    }

    const addresses = {
        network: 'arc-testnet-v6-staging',
        chainId: CHAIN_ID,
        rpcUrl: RPC_URL,
        note: 'FIXED V6 stack (2026-07/08 audit fixes + levers) — TESTNET STAGING / mainnet rehearsal. Fresh MockUSDC.',
        mockUSDC: usdcAddr,
        usdc: usdcAddr,
        agentRegistryV2: registryAddr,
        reputationManagerV3: reputationAddr,
        agentLiquidityMarketplace_v6: marketplaceAddr,
        agentCreditFaucet: faucetAddr,
        deployer: wallet.address,
        deployedAt: new Date().toISOString(),
    };
    const outPath = path.join(__dirname, '..', 'src', 'config', 'arc-testnet-v6-addresses.json');
    fs.writeFileSync(outPath, JSON.stringify(addresses, null, 2));
    console.log(`\n✅ Deployed. Addresses → ${outPath}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
