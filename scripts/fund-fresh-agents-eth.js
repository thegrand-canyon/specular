const { ethers } = require('ethers');
const fs = require('fs');

async function main() {
    console.log('\n⛽ FUNDING FRESH AGENTS WITH ETH\n');

    const provider = new ethers.JsonRpcProvider('https://arc-testnet.drpc.org', undefined, { batchMaxCount: 1 });
    const config = JSON.parse(fs.readFileSync('./fresh-agents-config.json', 'utf8'));

    const funderKey = process.env.PRIVATE_KEY || '0x0000000000000000000000000000000000000000000000000000000000000000';
    const funder = new ethers.Wallet(funderKey, provider);

    console.log('Funder:', funder.address);
    const funderBal = await provider.getBalance(funder.address);
    console.log('Funder ETH:', ethers.formatEther(funderBal), '\n');

    for (const agent of config.agents) {
        const balBefore = await provider.getBalance(agent.address);
        console.log(agent.name + ':');
        console.log('  Balance before:', ethers.formatEther(balBefore), 'ETH');

        const tx = await funder.sendTransaction({
            to: agent.address,
            value: ethers.parseEther('5.0')
        });
        const receipt = await tx.wait();

        const balAfter = await provider.getBalance(agent.address);
        console.log('  Balance after:', ethers.formatEther(balAfter), 'ETH');
        console.log('  Tx:', receipt.hash, '\n');

        await new Promise(resolve => setTimeout(resolve, 1500));
    }

    console.log('✅ All agents funded with ETH!\n');
}

main().catch(err => {
    console.error('\n❌ Funding failed:', err.message);
    process.exit(1);
});
