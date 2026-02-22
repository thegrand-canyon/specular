/**
 * Check if agents have ETH for gas
 */

const { ethers } = require('hardhat');
const fs = require('fs');
const path = require('path');

async function main() {
    console.log('\n⛽ CHECKING AGENT ETH BALANCES\n');

    const testAgentsPath = path.join(__dirname, '..', 'test-agents.json');
    const testAgents = JSON.parse(fs.readFileSync(testAgentsPath, 'utf8'));

    for (const agent of testAgents) {
        const balance = await ethers.provider.getBalance(agent.address);
        console.log(`${agent.name}:`);
        console.log(`  Address: ${agent.address}`);
        console.log(`  ETH Balance: ${ethers.formatEther(balance)} ETH`);
        console.log(`  Has Gas: ${balance > 0n ? '✅ Yes' : '❌ No'}\n`);
    }
}

main().catch(console.error);
