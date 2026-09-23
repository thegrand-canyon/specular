/**
 * Contract Ownership & Security Verification
 * Verifies ownership and security configurations across both networks
 */

require('dotenv').config();
const { ethers } = require('ethers');
const fs = require('fs');

const SECURE_WALLET = '0x800e305A0caDdE6289dFDFEDF38218f45C06F72C';

async function verifyNetwork(networkName, rpcUrl, addressFile) {
    console.log(`\n${'═'.repeat(70)}`);
    console.log(`  ${networkName.toUpperCase()} OWNERSHIP & SECURITY`);
    console.log(`${'═'.repeat(70)}\n`);

    const provider = new ethers.JsonRpcProvider(rpcUrl, undefined, { batchMaxCount: 1 });
    const addresses = JSON.parse(fs.readFileSync(addressFile));

    const registryAbi = JSON.parse(fs.readFileSync('./artifacts/contracts/core/AgentRegistryV2.sol/AgentRegistryV2.json')).abi;
    const reputationAbi = JSON.parse(fs.readFileSync('./artifacts/contracts/core/ReputationManagerV3.sol/ReputationManagerV3.json')).abi;
    const marketplaceAbi = JSON.parse(fs.readFileSync('./artifacts/contracts/core/AgentLiquidityMarketplace.sol/AgentLiquidityMarketplace.json')).abi;

    const registry = new ethers.Contract(addresses.agentRegistryV2 || addresses.agentRegistry, registryAbi, provider);
    const reputation = new ethers.Contract(addresses.reputationManagerV3 || addresses.reputationManager, reputationAbi, provider);
    const marketplace = new ethers.Contract(addresses.agentLiquidityMarketplace, marketplaceAbi, provider);

    let checks = 0;
    let passed = 0;

    // Ownership checks
    console.log('1️⃣  CONTRACT OWNERSHIP\n');

    try {
        const regOwner = await registry.owner();
        checks++;
        if (regOwner === SECURE_WALLET) {
            console.log(`  ✅ AgentRegistry owned by secure wallet`);
            console.log(`     ${regOwner}`);
            passed++;
        } else {
            console.log(`  ❌ AgentRegistry owned by different address`);
            console.log(`     Expected: ${SECURE_WALLET}`);
            console.log(`     Actual:   ${regOwner}`);
        }
    } catch (e) {
        console.log(`  ❌ Failed to check AgentRegistry owner: ${e.message}`);
        checks++;
    }

    try {
        const repOwner = await reputation.owner();
        checks++;
        if (repOwner === SECURE_WALLET) {
            console.log(`  ✅ ReputationManager owned by secure wallet`);
            console.log(`     ${repOwner}`);
            passed++;
        } else {
            console.log(`  ❌ ReputationManager owned by different address`);
            console.log(`     Expected: ${SECURE_WALLET}`);
            console.log(`     Actual:   ${repOwner}`);
        }
    } catch (e) {
        console.log(`  ❌ Failed to check ReputationManager owner: ${e.message}`);
        checks++;
    }

    try {
        const mktOwner = await marketplace.owner();
        checks++;
        if (mktOwner === SECURE_WALLET) {
            console.log(`  ✅ Marketplace owned by secure wallet`);
            console.log(`     ${mktOwner}`);
            passed++;
        } else {
            console.log(`  ❌ Marketplace owned by different address`);
            console.log(`     Expected: ${SECURE_WALLET}`);
            console.log(`     Actual:   ${mktOwner}`);
        }
    } catch (e) {
        console.log(`  ❌ Failed to check Marketplace owner: ${e.message}`);
        checks++;
    }

    console.log('');

    // Authorization checks
    console.log('2️⃣  AUTHORIZATION STATUS\n');

    try {
        const authorized = await reputation.authorizedPools(addresses.agentLiquidityMarketplace);
        checks++;
        if (authorized) {
            console.log(`  ✅ Marketplace authorized in ReputationManager`);
            passed++;
        } else {
            console.log(`  ❌ Marketplace NOT authorized in ReputationManager`);
        }
    } catch (e) {
        console.log(`  ❌ Failed to check authorization: ${e.message}`);
        checks++;
    }

    console.log('');

    // Pause state checks
    console.log('3️⃣  PAUSE STATE\n');

    try {
        const regPaused = await registry.paused();
        checks++;
        if (!regPaused) {
            console.log(`  ✅ AgentRegistry is NOT paused (operational)`);
            passed++;
        } else {
            console.log(`  ❌ AgentRegistry is PAUSED`);
        }
    } catch (e) {
        console.log(`  ⚠️  AgentRegistry pause check skipped: ${e.message}`);
    }

    try {
        const mktPaused = await marketplace.paused();
        checks++;
        if (!mktPaused) {
            console.log(`  ✅ Marketplace is NOT paused (operational)`);
            passed++;
        } else {
            console.log(`  ❌ Marketplace is PAUSED`);
        }
    } catch (e) {
        console.log(`  ⚠️  Marketplace pause check skipped: ${e.message}`);
    }

    console.log('');

    // Critical addresses check
    console.log('4️⃣  CRITICAL ADDRESSES\n');

    try {
        const regAddr = await marketplace.agentRegistry();
        checks++;
        if (regAddr === (addresses.agentRegistryV2 || addresses.agentRegistry)) {
            console.log(`  ✅ Marketplace correctly references AgentRegistry`);
            console.log(`     ${regAddr}`);
            passed++;
        } else {
            console.log(`  ❌ Marketplace references wrong AgentRegistry`);
            console.log(`     Expected: ${addresses.agentRegistryV2 || addresses.agentRegistry}`);
            console.log(`     Actual:   ${regAddr}`);
        }
    } catch (e) {
        console.log(`  ❌ Failed to check registry reference: ${e.message}`);
        checks++;
    }

    try {
        const repAddr = await marketplace.reputationManager();
        checks++;
        if (repAddr === (addresses.reputationManagerV3 || addresses.reputationManager)) {
            console.log(`  ✅ Marketplace correctly references ReputationManager`);
            console.log(`     ${repAddr}`);
            passed++;
        } else {
            console.log(`  ❌ Marketplace references wrong ReputationManager`);
            console.log(`     Expected: ${addresses.reputationManagerV3 || addresses.reputationManager}`);
            console.log(`     Actual:   ${repAddr}`);
        }
    } catch (e) {
        console.log(`  ❌ Failed to check reputation reference: ${e.message}`);
        checks++;
    }

    console.log('');

    return { checks, passed };
}

async function checkCodeVulnerabilities() {
    console.log(`\n${'═'.repeat(70)}`);
    console.log(`  CODE VULNERABILITY SCAN`);
    console.log(`${'═'.repeat(70)}\n`);

    const vulnerabilities = [];

    // Check for exposed private keys in .env
    try {
        const envContent = fs.readFileSync('./.env', 'utf-8');
        if (envContent.includes('PRIVATE_KEY=0x') && envContent.includes('# Private Keys')) {
            console.log('  ✅ .env contains private keys (expected)');
        }

        // Check if .env is in .gitignore
        const gitignore = fs.readFileSync('./.gitignore', 'utf-8');
        if (gitignore.includes('.env')) {
            console.log('  ✅ .env is in .gitignore');
        } else {
            vulnerabilities.push('.env is NOT in .gitignore - CRITICAL');
        }
    } catch (e) {
        console.log('  ⚠️  Could not check .env security');
    }

    // Check for hardcoded API keys in code
    const filesToCheck = [
        'src/agents/demo-borrower-agent.js',
        'src/moltbook/post-api-announcement.js',
        'src/moltbook/post-daily-stats.js',
        'src/moltbook/post-first-10-incentive.js',
        'src/moltbook/post-first-borrower-offer.js',
        'src/moltbook/post-launch-announcement.js',
        'src/moltbook/post-success-story.js',
        'src/moltbook/post-technical-integration.js'
    ];

    let hardcodedApiKeys = 0;
    for (const file of filesToCheck) {
        try {
            const content = fs.readFileSync(file, 'utf-8');
            if (content.includes('moltbook_sk_') && !content.includes('process.env.MOLTBOOK_API_KEY')) {
                hardcodedApiKeys++;
            }
        } catch (e) {
            // File doesn't exist, skip
        }
    }

    if (hardcodedApiKeys === 0) {
        console.log('  ✅ No hardcoded API keys in source files');
    } else {
        vulnerabilities.push(`${hardcodedApiKeys} files contain hardcoded API keys`);
    }

    // Check if node_modules is in .gitignore
    try {
        const gitignore = fs.readFileSync('./.gitignore', 'utf-8');
        if (gitignore.includes('node_modules')) {
            console.log('  ✅ node_modules in .gitignore');
        } else {
            vulnerabilities.push('node_modules not in .gitignore');
        }
    } catch (e) {
        console.log('  ⚠️  Could not check .gitignore');
    }

    // Check contract artifacts are built
    try {
        const registryAbi = fs.existsSync('./artifacts/contracts/core/AgentRegistryV2.sol/AgentRegistryV2.json');
        const reputationAbi = fs.existsSync('./artifacts/contracts/core/ReputationManagerV3.sol/ReputationManagerV3.json');
        const marketplaceAbi = fs.existsSync('./artifacts/contracts/core/AgentLiquidityMarketplace.sol/AgentLiquidityMarketplace.json');

        if (registryAbi && reputationAbi && marketplaceAbi) {
            console.log('  ✅ All contract ABIs compiled');
        } else {
            console.log('  ❌ Missing contract ABIs - run: npx hardhat compile');
        }
    } catch (e) {
        console.log('  ⚠️  Could not check contract artifacts');
    }

    console.log('');

    if (vulnerabilities.length > 0) {
        console.log('⚠️  VULNERABILITIES FOUND:\n');
        vulnerabilities.forEach(v => console.log(`  ❌ ${v}`));
        console.log('');
        return false;
    } else {
        console.log('  ✅ NO CRITICAL VULNERABILITIES FOUND\n');
        return true;
    }
}

async function main() {
    console.log('═'.repeat(70));
    console.log('  OWNERSHIP & SECURITY VERIFICATION');
    console.log('═'.repeat(70));

    // Verify Base Mainnet
    const baseResults = await verifyNetwork(
        'Base Mainnet',
        'https://mainnet.base.org',
        './src/config/base-addresses.json'
    );

    // Verify Arc Testnet
    const arcResults = await verifyNetwork(
        'Arc Testnet',
        process.env.ARC_TESTNET_RPC_URL || 'https://arc-testnet.drpc.org',
        './src/config/arc-testnet-addresses.json'
    );

    // Check code vulnerabilities
    const noVulnerabilities = await checkCodeVulnerabilities();

    // Summary
    console.log('═'.repeat(70));
    console.log('  VERIFICATION SUMMARY');
    console.log('═'.repeat(70));
    console.log('');
    console.log(`Base Mainnet:  ${baseResults.passed}/${baseResults.checks} checks passed`);
    console.log(`Arc Testnet:   ${arcResults.passed}/${arcResults.checks} checks passed`);
    console.log(`Code Security: ${noVulnerabilities ? 'PASS' : 'FAIL'}`);
    console.log('');

    const totalPassed = baseResults.passed + arcResults.passed;
    const totalChecks = baseResults.checks + arcResults.checks;

    if (totalPassed === totalChecks && noVulnerabilities) {
        console.log('  ✅ ALL VERIFICATION CHECKS PASSED\n');
        console.log('═'.repeat(70));
        console.log('');
        process.exit(0);
    } else {
        console.log(`  ⚠️  ${totalChecks - totalPassed} CHECKS FAILED\n`);
        console.log('═'.repeat(70));
        console.log('');
        process.exit(1);
    }
}

main().catch((e) => { console.error(e); process.exit(1); });
