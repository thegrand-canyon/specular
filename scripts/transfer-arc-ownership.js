/**
 * Transfer Arc Testnet Contract Ownership
 *
 * This script attempts to transfer ownership of all Arc Testnet contracts
 * from the compromised wallet to the new secure wallet.
 *
 * ⚠️ WARNING: This requires the COMPROMISED private key to work.
 * If the attacker has already changed ownership, this will fail.
 *
 * Usage:
 *   COMPROMISED_KEY=0x... NEW_OWNER=0x800e305A0caDdE6289dFDFEDF38218f45C06F72C \
 *   ARC_TESTNET_RPC_URL=https://arc-testnet.drpc.org \
 *   node scripts/transfer-arc-ownership.js
 */

const { ethers } = require('ethers');
const fs = require('fs');

const NEW_OWNER = process.env.NEW_OWNER || '0x800e305A0caDdE6289dFDFEDF38218f45C06F72C';
const RPC_URL = process.env.ARC_TESTNET_RPC_URL || 'https://arc-testnet.drpc.org';

async function main() {
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('  ARC TESTNET OWNERSHIP TRANSFER');
    console.log('═══════════════════════════════════════════════════════════════\n');

    // Get compromised key from environment
    const compromisedKey = process.env.COMPROMISED_KEY;
    if (!compromisedKey) {
        console.error('❌ ERROR: COMPROMISED_KEY not set in environment');
        console.log('\nUsage:');
        console.log('  COMPROMISED_KEY=0x... NEW_OWNER=0x... node scripts/transfer-arc-ownership.js');
        console.log('\n⚠️  WARNING: Use the COMPROMISED private key, not the new one!');
        process.exit(1);
    }

    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const wallet = new ethers.Wallet(compromisedKey, provider);

    console.log('Compromised Wallet:', wallet.address);
    console.log('New Owner:', NEW_OWNER);
    console.log('Network: Arc Testnet\n');

    // Load contract addresses
    const addresses = JSON.parse(fs.readFileSync('src/config/arc-testnet-addresses.json'));

    const contracts = [
        { name: 'AgentRegistryV2', address: addresses.agentRegistryV2, abi: 'AgentRegistryV2.sol/AgentRegistryV2.json' },
        { name: 'ReputationManagerV3', address: addresses.reputationManagerV3, abi: 'ReputationManagerV3.sol/ReputationManagerV3.json' },
        { name: 'AgentLiquidityMarketplace', address: addresses.agentLiquidityMarketplace, abi: 'AgentLiquidityMarketplace.sol/AgentLiquidityMarketplace.json' },
        { name: 'DepositRouter', address: addresses.depositRouter, abi: 'DepositRouter.sol/DepositRouter.json' },
        { name: 'ValidationRegistry', address: addresses.validationRegistry, abi: 'ValidationRegistry.sol/ValidationRegistry.json' }
    ];

    console.log('═══════════════════════════════════════════════════════════════');
    console.log('STEP 1: Verify Current Ownership');
    console.log('═══════════════════════════════════════════════════════════════\n');

    const ownerAbi = ['function owner() view returns (address)'];
    let allOwned = true;

    for (const contract of contracts) {
        const instance = new ethers.Contract(contract.address, ownerAbi, provider);
        const owner = await instance.owner();
        const isOwner = owner.toLowerCase() === wallet.address.toLowerCase();

        console.log(`${contract.name}:`);
        console.log(`  Current Owner: ${owner}`);
        console.log(`  We Own It: ${isOwner ? '✅ YES' : '❌ NO'}\n`);

        if (!isOwner) {
            allOwned = false;
            console.log(`  ⚠️  WARNING: We don't own ${contract.name}!`);
            console.log(`     Attacker may have already transferred ownership.\n`);
        }
    }

    if (!allOwned) {
        console.log('❌ CRITICAL: Not all contracts are owned by the compromised wallet');
        console.log('   The attacker may have already taken control.');
        console.log('   Continuing anyway to transfer what we can...\n');
    }

    console.log('═══════════════════════════════════════════════════════════════');
    console.log('STEP 2: Transfer Ownership');
    console.log('═══════════════════════════════════════════════════════════════\n');

    let successCount = 0;
    let failCount = 0;
    const results = [];

    for (const contract of contracts) {
        console.log(`Transferring ${contract.name}...`);

        try {
            // Load full ABI
            const artifactPath = `artifacts/contracts/core/${contract.abi}`;
            const artifact = JSON.parse(fs.readFileSync(artifactPath));
            const instance = new ethers.Contract(contract.address, artifact.abi, wallet);

            // Check current owner
            const currentOwner = await instance.owner();
            if (currentOwner.toLowerCase() !== wallet.address.toLowerCase()) {
                console.log(`  ⚠️  Skipping: We don't own this contract\n`);
                results.push({ name: contract.name, status: 'SKIP', reason: 'Not owner' });
                failCount++;
                continue;
            }

            // Transfer ownership
            const tx = await instance.transferOwnership(NEW_OWNER);
            console.log(`  Tx: ${tx.hash}`);
            console.log(`  Waiting for confirmation...`);

            const receipt = await tx.wait();
            console.log(`  ✅ Transferred in block ${receipt.blockNumber}\n`);

            results.push({ name: contract.name, status: 'SUCCESS', tx: tx.hash });
            successCount++;

        } catch (error) {
            console.log(`  ❌ FAILED: ${error.message}\n`);
            results.push({ name: contract.name, status: 'FAILED', error: error.message });
            failCount++;
        }
    }

    console.log('═══════════════════════════════════════════════════════════════');
    console.log('STEP 3: Verify New Ownership');
    console.log('═══════════════════════════════════════════════════════════════\n');

    for (const contract of contracts) {
        const instance = new ethers.Contract(contract.address, ownerAbi, provider);
        const owner = await instance.owner();
        const isNewOwner = owner.toLowerCase() === NEW_OWNER.toLowerCase();

        console.log(`${contract.name}:`);
        console.log(`  Owner: ${owner}`);
        console.log(`  Status: ${isNewOwner ? '✅ Transferred' : '❌ Not transferred'}\n`);
    }

    console.log('═══════════════════════════════════════════════════════════════');
    console.log('SUMMARY');
    console.log('═══════════════════════════════════════════════════════════════\n');

    console.log(`Successful transfers: ${successCount}`);
    console.log(`Failed transfers: ${failCount}\n`);

    console.log('Results:');
    results.forEach(r => {
        const icon = r.status === 'SUCCESS' ? '✅' : r.status === 'SKIP' ? '⚠️' : '❌';
        console.log(`  ${icon} ${r.name}: ${r.status}`);
        if (r.tx) console.log(`     Tx: ${r.tx}`);
        if (r.reason) console.log(`     Reason: ${r.reason}`);
        if (r.error) console.log(`     Error: ${r.error}`);
    });

    console.log('\n═══════════════════════════════════════════════════════════════');

    if (successCount === contracts.length) {
        console.log('✅ SUCCESS: All contracts transferred to new owner!');
        console.log('\nNext steps:');
        console.log('1. Update src/config/arc-testnet-addresses.json');
        console.log('2. Withdraw any remaining funds');
        console.log('3. Test contracts with new owner wallet');
    } else if (successCount > 0) {
        console.log('⚠️  PARTIAL SUCCESS: Some contracts transferred');
        console.log('\nRecommendation: Redeploy failed contracts with new wallet');
    } else {
        console.log('❌ FAILURE: No contracts transferred');
        console.log('\nLikely cause: Attacker has already taken control');
        console.log('Recommendation: Redeploy all contracts with new wallet');
    }

    console.log('═══════════════════════════════════════════════════════════════');
}

main()
    .then(() => process.exit(0))
    .catch(error => {
        console.error('\n❌ Error:', error.message);
        process.exit(1);
    });
