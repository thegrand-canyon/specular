require('dotenv').config();
const { ethers } = require('ethers');
const fs = require('fs');
const ADDR = JSON.parse(fs.readFileSync('./src/config/base-addresses.json'));
const FAUCET = ADDR.agentCreditFaucet;
const FAUCET_ABI = JSON.parse(fs.readFileSync('./artifacts/contracts/core/AgentCreditFaucet.sol/AgentCreditFaucet.json')).abi;
const USDC_ABI = ['function transfer(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)'];

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function rT(fn, n=8) { for (let i=0;i<n;i++){try{return await fn();}catch(e){if(i===n-1)throw e; await sleep(3000*(i+1));}} }

(async () => {
    const provider = new ethers.JsonRpcProvider(process.env.BASE_RPC_URL || 'https://mainnet.base.org', undefined, { batchMaxCount: 1 });
    const owner = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
    const faucet = new ethers.Contract(FAUCET, FAUCET_ABI, owner);
    const usdc = new ethers.Contract(ADDR.usdc, USDC_ABI, owner);

    console.log('=== Activating Base mainnet faucet ===');
    console.log('Faucet:', FAUCET);
    const ownerUsdc = await rT(() => usdc.balanceOf(owner.address));
    console.log('Owner USDC:', ethers.formatUnits(ownerUsdc, 6));
    if (ownerUsdc < ethers.parseUnits('100', 6)) {
        console.error('Insufficient USDC to fund faucet (need 100)');
        process.exit(1);
    }
    await sleep(3000);

    const faucetUsdc = await rT(() => usdc.balanceOf(FAUCET));
    console.log('Faucet USDC pre-fund:', ethers.formatUnits(faucetUsdc, 6));
    await sleep(3000);

    if (faucetUsdc < ethers.parseUnits('100', 6)) {
        console.log('\n[1] Transfer 100 USDC to faucet...');
        const tx = await usdc.transfer(FAUCET, ethers.parseUnits('100', 6));
        console.log('  tx:', tx.hash);
        await rT(() => tx.wait());
        console.log('  ✓ funded');
    }
    await sleep(3000);

    const currentMax = await rT(() => faucet.maxEligibleAgentId());
    console.log('\n[2] Current maxEligibleAgentId:', currentMax.toString());
    if (currentMax < 200n) {
        const tx = await faucet.setMaxEligibleAgentId(200);
        console.log('  setMaxEligibleAgentId(200) tx:', tx.hash);
        await rT(() => tx.wait());
    }
    await sleep(3000);

    console.log('\n[3] isEligible() checks');
    for (const aid of [1, 50, 100, 201]) {
        console.log('  agentId', aid + ':', await rT(() => faucet.isEligible(aid)));
        await sleep(1000);
    }
    console.log('\n✅ Base mainnet faucet activated. Agents 1-200 can claim 10 USDC each.');
})().catch(e => { console.error(e); process.exit(1); });
