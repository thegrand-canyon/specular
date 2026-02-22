/**
 * Verify Base Mainnet Contracts on BaseScan
 */

const { execSync } = require('child_process');

const contracts = [
    {
        name: 'AgentRegistryV2',
        address: '0xbd8210061bF24917Ca2F8098A1F3A4f76adA31fb',
        args: []
    },
    {
        name: 'ReputationManagerV3',
        address: '0xe4D78A509daa8dc8bFB453cb76d61f1Cb1c4C3fF',
        args: ['0xbd8210061bF24917Ca2F8098A1F3A4f76adA31fb']  // agentRegistry
    },
    {
        name: 'AgentLiquidityMarketplace',
        address: '0x77f8D49C706A566Eecc9a2C3DD6556D5be54CACE',
        args: [
            '0xbd8210061bF24917Ca2F8098A1F3A4f76adA31fb',  // agentRegistry
            '0xe4D78A509daa8dc8bFB453cb76d61f1Cb1c4C3fF',  // reputationManager
            '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'   // usdc
        ]
    },
    {
        name: 'DepositRouter',
        address: '0x771c293167AeD146EC4f56479056645Be46a0275',
        args: [
            '0x77f8D49C706A566Eecc9a2C3DD6556D5be54CACE',  // marketplace
            '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'   // usdc
        ]
    },
    {
        name: 'ValidationRegistry',
        address: '0x5194D976F2f1B59C0500cDe1e54A362d9BB9124B',
        args: ['0xbd8210061bF24917Ca2F8098A1F3A4f76adA31fb']  // agentRegistry
    }
];

console.log('\n╔══════════════════════════════════════════════════╗');
console.log('║  VERIFY BASE MAINNET CONTRACTS                   ║');
console.log('╚══════════════════════════════════════════════════╝\n');

let verified = 0;
let failed = 0;

for (const contract of contracts) {
    console.log(`📝 Verifying ${contract.name}...`);
    console.log(`   Address: ${contract.address}`);

    const argsString = contract.args.length > 0
        ? contract.args.map(a => `"${a}"`).join(' ')
        : '';

    const cmd = argsString
        ? `npx hardhat verify --network base ${contract.address} ${argsString}`
        : `npx hardhat verify --network base ${contract.address}`;

    try {
        const output = execSync(cmd, { encoding: 'utf8', stdio: 'pipe' });

        if (output.includes('Already Verified') || output.includes('Successfully verified')) {
            console.log('   ✅ Verified\n');
            verified++;
        } else {
            console.log('   ⚠️  Unknown response\n');
            console.log(output);
        }
    } catch (error) {
        if (error.stdout && error.stdout.includes('Already Verified')) {
            console.log('   ✅ Already Verified\n');
            verified++;
        } else {
            console.log('   ❌ Failed\n');
            console.log(error.stdout || error.message);
            failed++;
        }
    }

    // Wait between verifications
    if (contract !== contracts[contracts.length - 1]) {
        console.log('   Waiting 5 seconds...\n');
        execSync('sleep 5');
    }
}

console.log('╔══════════════════════════════════════════════════╗');
console.log('║  VERIFICATION COMPLETE                           ║');
console.log('╚══════════════════════════════════════════════════╝\n');

console.log(`✅ Verified: ${verified}/${contracts.length}`);
if (failed > 0) {
    console.log(`❌ Failed: ${failed}/${contracts.length}`);
}

console.log('\n📋 View on BaseScan:\n');
contracts.forEach(c => {
    console.log(`   ${c.name}:`);
    console.log(`   https://basescan.org/address/${c.address}#code\n`);
});
