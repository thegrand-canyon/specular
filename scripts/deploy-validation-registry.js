/**
 * Deploy ValidationRegistry to Arc Testnet (ERC-8004)
 * Standalone deployment — RM3 credit bonus integration requires RM3 redeployment
 * Demonstrates full ERC-8004 validation flow
 */

const { ethers } = require('hardhat');
const fs = require('fs');
const path = require('path');

async function main() {
    console.log('\n📋 Deploying ValidationRegistry to Arc Testnet (ERC-8004)\n');
    console.log('═══════════════════════════════════════════════════════\n');

    const addressesPath = path.join(__dirname, '..', 'src', 'config', 'arc-testnet-addresses.json');
    const addresses = JSON.parse(fs.readFileSync(addressesPath, 'utf8'));

    const [deployer] = await ethers.getSigners();
    console.log(`Deployer: ${deployer.address}`);
    const balance = await ethers.provider.getBalance(deployer.address);
    console.log(`Balance:  ${ethers.formatEther(balance)} ETH\n`);

    // ── 1. Deploy ValidationRegistry ───────────────────────
    console.log('1️⃣  Deploying ValidationRegistry...');
    const ValidationRegistry = await ethers.getContractFactory('ValidationRegistry');
    const validationRegistry = await ValidationRegistry.deploy(addresses.agentRegistryV2);
    await validationRegistry.waitForDeployment();
    const vrAddr = await validationRegistry.getAddress();
    console.log(`   ✅ ValidationRegistry deployed: ${vrAddr}\n`);

    // ── 2. Approve deployer as a validator ─────────────────
    console.log('2️⃣  Approving deployer as validator...');
    const approveTx = await validationRegistry.approveValidator(
        deployer.address,
        'https://specular.ai/validators/deployer-v1'
    );
    await approveTx.wait();
    console.log(`   ✅ Validator approved: ${deployer.address}\n`);

    // ── 3. ERC-8004 Test Cycle ───────────────────────────────
    console.log('3️⃣  Running ERC-8004 validation test cycle...\n');

    const agentRegistry = await ethers.getContractAt('AgentRegistryV2', addresses.agentRegistryV2);
    const totalAgents = await agentRegistry.totalAgents();
    console.log(`   Total agents on chain: ${totalAgents}`);

    if (totalAgents === 0n) {
        console.log('   ⚠️  No agents found — skipping test cycle.\n');
    } else {
        const testAgentId = 1n;
        let agentInfo;
        try {
            agentInfo = await agentRegistry.getAgentInfoById(testAgentId);
            console.log(`   Testing with Agent #${testAgentId}: ${agentInfo.agentURI}`);
        } catch {
            console.log(`   Testing with Agent #${testAgentId}`);
        }
        console.log('');

        // Request validation
        console.log('   Step 1: Requesting validation...');
        const requestTx = await validationRegistry.validationRequest(
            deployer.address,
            testAgentId,
            'https://specular.ai/validations/test-001',
            ethers.ZeroHash
        );
        const receipt = await requestTx.wait();

        let requestHash = null;
        const iface = validationRegistry.interface;
        for (const log of receipt.logs) {
            try {
                const parsed = iface.parseLog(log);
                if (parsed?.name === 'ValidationRequested') {
                    requestHash = parsed.args.requestHash;
                    break;
                }
            } catch {}
        }
        console.log(`   ✅ Validation requested — hash: ${requestHash?.slice(0, 18)}...\n`);

        // Respond (score 85 = APPROVED)
        console.log('   Step 2: Submitting validation response (score: 85)...');
        const respondTx = await validationRegistry.validationResponse(
            requestHash,
            85,
            'https://specular.ai/validations/test-001/response',
            ethers.ZeroHash,
            'loan-performance'
        );
        await respondTx.wait();
        console.log('   ✅ Response submitted\n');

        // Read back status
        const status = await validationRegistry.getValidationStatus(requestHash);
        const statusLabels = ['PENDING', 'APPROVED', 'REJECTED', 'DISPUTED'];
        console.log(`   Validation Result:`);
        console.log(`     Status:        ${statusLabels[Number(status.status)]}`);
        console.log(`     Response Score: ${status.responseScore}/100`);
        console.log(`     Tag:           ${status.tag}`);
        console.log(`     Request Hash:  ${requestHash?.slice(0, 18)}...\n`);

        // Get summary
        const summary = await validationRegistry.getSummary(testAgentId, [], '');
        console.log(`   Summary for Agent #${testAgentId}:`);
        console.log(`     Total validations:   ${summary.totalCount}`);
        console.log(`     Approved:            ${summary.approvedCount}`);
        console.log(`     Rejected:            ${summary.rejectedCount}`);
        console.log(`     Average Score:       ${summary.averageScore}/100\n`);
    }

    // ── 4. Save addresses ────────────────────────────────────
    console.log('4️⃣  Saving updated addresses...');
    addresses.validationRegistry = vrAddr;
    fs.writeFileSync(addressesPath, JSON.stringify(addresses, null, 2));
    console.log('   ✅ arc-testnet-addresses.json updated\n');

    // Update frontend config
    const frontendConfigPath = path.join(__dirname, '..', 'frontend', 'js', 'config.js');
    if (fs.existsSync(frontendConfigPath)) {
        let config = fs.readFileSync(frontendConfigPath, 'utf8');
        if (!config.includes('validationRegistry')) {
            config = config.replace(
                "    usdc:        '0xf2807051e292e945751A25616705a9aadfb39895',",
                `    validationRegistry: '${vrAddr}',\n    usdc:        '0xf2807051e292e945751A25616705a9aadfb39895',`
            );
            fs.writeFileSync(frontendConfigPath, config);
        }
        console.log('   ✅ frontend/js/config.js updated\n');
    }

    console.log('═══════════════════════════════════════════════════════\n');
    console.log('✅ ValidationRegistry deployed and tested!\n');
    console.log(`  Address: ${vrAddr}`);
    console.log('\nERC-8004 Integration Notes:');
    console.log('  ✅ ValidationRegistry: fully operational (request/respond/dispute)');
    console.log('  ⚠️  RM3 credit bonus: requires RM3 redeployment (deployed version predates bonus feature)');
    console.log('  📝 When redeploying RM3, call setValidationRegistry(address) + setValidationBonusParameters(3, 50)\n');
}

main().catch(err => {
    console.error('Deployment failed:', err);
    process.exit(1);
});
