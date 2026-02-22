const { ethers } = require('ethers');
const fs = require('fs');

const RPC_URL = 'https://arc-testnet.drpc.org';
const OWNER_KEY = '0x4fd4d9c9340c0dcd1f4845483e488afde4c69685f9ff5deec756fbfc1afb02ac';

async function main() {
    console.log('\nAuthorizing marketplace in ReputationManager\n');

    const provider = new ethers.JsonRpcProvider(RPC_URL, undefined, { batchMaxCount: 1 });
    const owner = new ethers.Wallet(OWNER_KEY, provider);

    console.log(`Owner: ${owner.address}\n`);

    const addresses = JSON.parse(
        fs.readFileSync('./src/config/arc-testnet-addresses.json', 'utf8')
    );

    function loadAbi(name) {
        const paths = [
            `./artifacts/contracts/${name}.sol/${name}.json`,
            `./artifacts/contracts/core/${name}.sol/${name}.json`,
        ];
        for (const p of paths) {
            try {
                return JSON.parse(fs.readFileSync(p, 'utf8')).abi;
            } catch {}
        }
        throw new Error(`Cannot find ABI for ${name}`);
    }

    const reputationAbi = loadAbi('ReputationManagerV3');
    const reputation = new ethers.Contract(addresses.reputationManagerV3, reputationAbi, owner);

    console.log(`Marketplace: ${addresses.agentLiquidityMarketplace}`);
    console.log(`ReputationManager: ${addresses.reputationManagerV3}\n`);

    const isAuthorized = await reputation.authorizedPools(addresses.agentLiquidityMarketplace);
    console.log(`Currently authorized: ${isAuthorized}\n`);

    if (isAuthorized) {
        console.log('Already authorized!\n');
        return;
    }

    console.log('Authorizing marketplace...\n');

    const nonce = await provider.getTransactionCount(owner.address);
    const tx = await reputation.authorizePool(addresses.agentLiquidityMarketplace, { nonce });

    console.log(`Transaction: ${tx.hash}`);
    await tx.wait();

    console.log('Marketplace authorized!\n');

    const isAuthorizedNow = await reputation.authorizedPools(addresses.agentLiquidityMarketplace);
    console.log(`Verification: ${isAuthorizedNow}\n`);
}

main().catch(console.error);
