const { ethers } = require('ethers');
const fs = require('fs');

async function main() {
    const provider = new ethers.JsonRpcProvider('https://arc-testnet.drpc.org', undefined, { batchMaxCount: 1 });
    const addresses = JSON.parse(fs.readFileSync('./src/config/arc-testnet-addresses.json', 'utf8'));
    const config = JSON.parse(fs.readFileSync('./fresh-agents-config.json', 'utf8'));

    const rmAbi = JSON.parse(fs.readFileSync('./artifacts/contracts/core/ReputationManagerV3.sol/ReputationManagerV3.json', 'utf8')).abi;
    const rm = new ethers.Contract(addresses.reputationManagerV3, rmAbi, provider);

    console.log('\n🔍 CHECKING FRESH AGENT REPUTATIONS\n');

    for (const agent of config.agents) {
        console.log(agent.name + ' (ID ' + agent.id + '):');
        console.log('  Address: ' + agent.address);

        try {
            const score = await rm['getReputationScore(address)'](agent.address);
            console.log('  Reputation Score: ' + score.toString());

            const creditLimit = await rm.calculateCreditLimit(agent.address);
            console.log('  Credit Limit: ' + ethers.formatUnits(creditLimit, 6) + ' USDC');

            const collateralReq = await rm.calculateCollateralRequirement(agent.address);
            console.log('  Collateral Requirement: ' + collateralReq.toString() + '%');

            const interestRate = await rm.calculateInterestRate(agent.address);
            console.log('  Interest Rate: ' + (Number(interestRate) / 100).toFixed(2) + '%\n');
        } catch (error) {
            console.log('  Error: ' + error.message + '\n');
        }
    }

    // Also check the main agent for comparison
    console.log('═'.repeat(70));
    console.log('COMPARISON: Main Agent (0x656086A21073272533c8A3f56A94c1f3D8BCFcE2)');
    console.log('═'.repeat(70) + '\n');

    try {
        const mainAgent = '0x656086A21073272533c8A3f56A94c1f3D8BCFcE2';
        const score = await rm['getReputationScore(address)'](mainAgent);
        console.log('Reputation Score: ' + score.toString());

        const creditLimit = await rm.calculateCreditLimit(mainAgent);
        console.log('Credit Limit: ' + ethers.formatUnits(creditLimit, 6) + ' USDC');

        const collateralReq = await rm.calculateCollateralRequirement(mainAgent);
        console.log('Collateral Requirement: ' + collateralReq.toString() + '%');

        const interestRate = await rm.calculateInterestRate(mainAgent);
        console.log('Interest Rate: ' + (Number(interestRate) / 100).toFixed(2) + '%\n');
    } catch (error) {
        console.log('Error: ' + error.message + '\n');
    }
}

main().catch(console.error);
