// End-to-end onboarding test: generate fresh wallet, sponsor funds gas only
// (NOT USDC), agent uses faucet to bootstrap USDC, then borrows.
require('dotenv').config();
const { ethers } = require('ethers');
const fs = require('fs');
const { SpecularQuickstart } = require('../src/sdk/SpecularQuickstart');
const ADDR = JSON.parse(fs.readFileSync('./src/config/arc-testnet-addresses.json'));

(async () => {
    const provider = new ethers.JsonRpcProvider(process.env.ARC_TESTNET_RPC_URL || 'https://arc-testnet.drpc.org');
    const sponsor = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
    const agent = ethers.Wallet.createRandom().connect(provider);
    console.log('Fresh agent address:', agent.address);

    // Sponsor sends ETH only (no USDC) — agent will get USDC from the faucet
    await (await sponsor.sendTransaction({ to: agent.address, value: ethers.parseEther('0.3') })).wait();
    console.log('Funded agent with 0.3 ETH for gas');

    const sdk = new SpecularQuickstart(agent, 'arc');

    // Onboard
    console.log('\n[1] Onboard');
    const onb = await sdk.onboard('ipfs://full-onboarding-test');
    console.log('  agentId:', onb.agentId);

    // Claim from faucet via direct contract call
    const FAUCET_ABI = JSON.parse(fs.readFileSync('./artifacts/contracts/core/AgentCreditFaucet.sol/AgentCreditFaucet.json')).abi;
    const faucet = new ethers.Contract(ADDR.agentCreditFaucet, FAUCET_ABI, agent);
    const USDC_ABI = ['function balanceOf(address) view returns (uint256)'];
    const usdc = new ethers.Contract(ADDR.usdc, USDC_ABI, provider);

    console.log('\n[2] Claim initial credit from faucet');
    const eligible = await faucet.isEligible(onb.agentId);
    console.log('  eligible:', eligible);
    if (eligible) {
        const claimTx = await faucet.claim();
        await claimTx.wait();
        console.log('  claim tx:', claimTx.hash);
        const bal = await usdc.balanceOf(agent.address);
        console.log('  agent USDC after claim:', ethers.formatUnits(bal, 6));
    }

    console.log('\n[3] Credit info');
    console.log('  ', JSON.stringify(await sdk.creditInfo(), null, 2));

    // Sponsor still needs to supply liquidity to agent's pool so they can actually borrow
    console.log('\n[4] (Sponsor) supplies 50 USDC liquidity to agent pool so a loan can be drawn');
    const sponsorSdk = new SpecularQuickstart(sponsor, 'arc');
    await sponsorSdk.supply(onb.agentId, 50);

    console.log('\n[5] Agent borrows 5 USDC for 7 days');
    const loan = await sdk.borrow(5, 7);
    console.log('  loanId:', loan.loanId);
    console.log('  tx:', sdk.explorerUrl(loan.tx));

    console.log('\n[6] Agent repays');
    const repayHash = await sdk.repay(loan.loanId);
    console.log('  tx:', sdk.explorerUrl(repayHash));

    const finalBal = await usdc.balanceOf(agent.address);
    const finalInfo = await sdk.creditInfo();
    console.log('\n=== Final ===');
    console.log('Agent USDC balance:', ethers.formatUnits(finalBal, 6));
    console.log('Agent reputation:', finalInfo.score);
    console.log('Agent credit limit:', finalInfo.creditLimit, 'USDC');

    // Cleanup
    try { await sponsorSdk.withdraw(onb.agentId, 50); } catch (e) {}
    try {
        const u = new ethers.Contract(ADDR.usdc, ['function balanceOf(address) view returns (uint256)', 'function transfer(address,uint256) returns (bool)'], agent);
        const b = await usdc.balanceOf(agent.address);
        if (b > 0n) await (await u.transfer(sponsor.address, b)).wait();
    } catch (e) {}

    console.log('\n✅ End-to-end onboarding with faucet works');
})().catch(e => { console.error(e); process.exit(1); });
