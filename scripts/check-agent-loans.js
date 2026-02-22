/**
 * Check All Loans for an Agent
 */

const { ethers } = require('ethers');
const fs = require('fs');

const RPC_URL = 'https://sepolia.base.org';
const AGENT_ADDR = '0x656086A21073272533c8A3f56A94c1f3D8BCFcE2';

async function main() {
    console.log('\n📋 CHECKING ALL LOANS FOR AGENT\n');

    const provider = new ethers.JsonRpcProvider(RPC_URL);

    const addresses = JSON.parse(
        fs.readFileSync('./src/config/base-sepolia-addresses.json', 'utf8')
    );

    const marketplaceAbi = JSON.parse(
        fs.readFileSync('./artifacts/contracts/core/AgentLiquidityMarketplace.sol/AgentLiquidityMarketplace.json', 'utf8')
    ).abi;

    const reputationAbi = JSON.parse(
        fs.readFileSync('./artifacts/contracts/core/ReputationManagerV3.sol/ReputationManagerV3.json', 'utf8')
    ).abi;

    const marketplace = new ethers.Contract(addresses.AgentLiquidityMarketplace, marketplaceAbi, provider);
    const reputation = new ethers.Contract(addresses.ReputationManagerV3, reputationAbi, provider);

    console.log(`Agent: ${AGENT_ADDR}\n`);

    // Check reputation stats
    const score = await reputation['getReputationScore(address)'](AGENT_ADDR);
    const totalBorrowed = await reputation.totalBorrowed(await reputation.agentRegistry().then(r => new ethers.Contract(r, ['function addressToAgentId(address) view returns (uint256)'], provider).addressToAgentId(AGENT_ADDR)));

    console.log(`Reputation Score: ${score}`);
    console.log(`Total Borrowed: ${totalBorrowed}\n`);

    // Check loans 1-5
    console.log('Checking recent loans:\n');

    for (let i = 1; i <= 5; i++) {
        try {
            const loan = await marketplace.loans(i);

            if (loan.borrower.toLowerCase() === AGENT_ADDR.toLowerCase()) {
                const states = ['REQUESTED', 'ACTIVE', 'REPAID', 'DEFAULTED'];

                console.log(`Loan #${i}:`);
                console.log(`  Amount: ${ethers.formatUnits(loan.amount, 6)} USDC`);
                console.log(`  State: ${states[loan.state]}`);
                console.log(`  Interest Rate: ${Number(loan.interestRate) / 100}% APR`);
                console.log(`  Duration: ${Number(loan.duration) / 86400} days`);

                if (loan.state === 1) { // ACTIVE
                    const now = Math.floor(Date.now() / 1000);
                    const endTime = Number(loan.endTime);
                    const isOverdue = now > endTime;
                    console.log(`  Status: ${isOverdue ? '⚠️ OVERDUE' : '✅ Current'}`);
                }

                console.log('');
            }
        } catch (e) {
            break; // No more loans
        }
    }
}

main().catch(console.error);
