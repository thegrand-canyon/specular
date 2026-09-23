require('dotenv').config();
const { ethers } = require('ethers');
const fs = require('fs');
const ADDR = JSON.parse(fs.readFileSync('./src/config/arc-testnet-addresses.json'));
const FAUCET = ADDR.agentCreditFaucet;
const USDC_ADDR = ADDR.usdc;

const FAUCET_ABI = JSON.parse(fs.readFileSync('./artifacts/contracts/core/AgentCreditFaucet.sol/AgentCreditFaucet.json')).abi;
const USDC_ABI = ['function transfer(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)'];

(async () => {
    const provider = new ethers.JsonRpcProvider(process.env.ARC_TESTNET_RPC_URL || 'https://arc-testnet.drpc.org');
    const owner = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
    const faucet = new ethers.Contract(FAUCET, FAUCET_ABI, owner);
    const usdc = new ethers.Contract(USDC_ADDR, USDC_ABI, owner);

    console.log('=== Activating Arc faucet ===');
    console.log('Faucet:', FAUCET);
    console.log('Owner:', owner.address);

    const faucetUsdc = await usdc.balanceOf(FAUCET);
    console.log('Faucet USDC balance pre-fund:', ethers.formatUnits(faucetUsdc, 6));

    // Fund the faucet with 100 USDC (enough for 10 free 10-USDC claims)
    if (faucetUsdc < ethers.parseUnits('100', 6)) {
        console.log('\n[1] Transferring 100 USDC to faucet...');
        const tx = await usdc.transfer(FAUCET, ethers.parseUnits('100', 6));
        await tx.wait();
        console.log('  tx:', tx.hash);
        console.log('  new faucet balance:', ethers.formatUnits(await usdc.balanceOf(FAUCET), 6));
    } else {
        console.log('  faucet already has ≥100 USDC');
    }

    // Set maxEligibleAgentId to 200 — opens faucet to agents 1..200
    const currentMax = await faucet.maxEligibleAgentId();
    console.log('\n[2] Current maxEligibleAgentId:', currentMax.toString());
    if (currentMax < 200n) {
        const tx = await faucet.setMaxEligibleAgentId(200);
        await tx.wait();
        console.log('  setMaxEligibleAgentId(200) tx:', tx.hash);
        console.log('  new maxEligibleAgentId:', (await faucet.maxEligibleAgentId()).toString());
    }

    // Verify eligibility check works for a known agent (agent 188 from earlier SDK demo)
    console.log('\n[3] Verify isEligible() for known agentIds');
    for (const aid of [1, 50, 188, 201]) {
        const e = await faucet.isEligible(aid);
        console.log(`  agentId ${aid}: eligible=${e}`);
    }

    console.log('\n✅ Arc faucet activated. Agents 1-200 can now claim 10 USDC each.');
})().catch(e => { console.error(e); process.exit(1); });
