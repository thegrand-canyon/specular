/**
 * SpecularQuickstart SDK live example on Arc Testnet.
 *
 * Demonstrates the developer experience: generate a fresh wallet, onboard,
 * borrow, repay, check credit info.
 *
 * Run: node src/sdk/examples/quickstart-arc.js
 */

require('dotenv').config();
const { ethers } = require('ethers');
const { SpecularQuickstart } = require('../SpecularQuickstart');

(async () => {
    const provider = new ethers.JsonRpcProvider(process.env.ARC_TESTNET_RPC_URL || 'https://arc-testnet.drpc.org');
    const sponsor = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

    // Simulate a brand-new agent: generate a fresh wallet, fund it minimally
    const agent = ethers.Wallet.createRandom().connect(provider);
    console.log('Agent address:', agent.address);

    // Fund the agent for gas + a tiny bit of USDC for collateral
    const usdc = new ethers.Contract(
        JSON.parse(require('fs').readFileSync('./src/config/arc-testnet-addresses.json')).usdc,
        ['function transfer(address,uint256) returns (bool)'],
        sponsor
    );
    await (await sponsor.sendTransaction({ to: agent.address, value: ethers.parseEther('0.5') })).wait();
    await (await usdc.transfer(agent.address, ethers.parseUnits('100', 6))).wait();
    console.log('Agent funded (0.5 ETH + 100 USDC for collateral)');

    // === Now use the SDK as if we WERE the agent ===
    const sdk = new SpecularQuickstart(agent, 'arc');

    console.log('\n[1] Onboarding…');
    const onb = await sdk.onboard('ipfs://quickstart-example');
    console.log('  agentId:', onb.agentId);
    console.log('  registerTx:', onb.registerTx);
    console.log('  poolTx:', onb.poolTx);
    console.log('  approveTx:', onb.approveTx);

    console.log('\n[2] Credit info:');
    const info = await sdk.creditInfo();
    console.log('  ', JSON.stringify(info, null, 2));

    // A fresh agent gets 1k USDC limit at 100% collateral, 15% APR.
    // We need a LENDER for the pool. Sponsor will supply.
    console.log('\n[3] Sponsor supplies 100 USDC liquidity to the agent\'s pool (so the agent can borrow)');
    const SpecularLender = new SpecularQuickstart(sponsor, 'arc');
    await SpecularLender.supply(onb.agentId, 100);
    console.log('  supplied 100 USDC');

    console.log('\n[4] Agent borrows 10 USDC for 7 days…');
    const loan = await sdk.borrow(10, 7);
    console.log('  loanId:', loan.loanId);
    console.log('  tx:', sdk.explorerUrl(loan.tx));

    console.log('\n[5] Active loans:');
    console.log('  ', JSON.stringify(await sdk.loans(), null, 2));

    console.log('\n[6] Agent repays loan…');
    const repayHash = await sdk.repay(loan.loanId);
    console.log('  tx:', sdk.explorerUrl(repayHash));

    console.log('\n[7] Credit info after repayment:');
    const info2 = await sdk.creditInfo();
    console.log('  score:', info2.score, '(was', info.score + ')', '— +' + (info2.score - info.score) + ' from on-time repayment');

    console.log('\n✅ Quickstart complete');

    // Cleanup
    try {
        await SpecularLender.withdraw(onb.agentId, 100);
    } catch (e) {}
    // Drain agent's USDC + ETH
    try {
        const u = new ethers.Contract(
            JSON.parse(require('fs').readFileSync('./src/config/arc-testnet-addresses.json')).usdc,
            ['function balanceOf(address) view returns (uint256)', 'function transfer(address,uint256) returns (bool)'],
            agent
        );
        const bal = await u.balanceOf(agent.address);
        if (bal > 0n) await (await u.transfer(sponsor.address, bal)).wait();
    } catch (e) {}
})().catch(e => { console.error(e); process.exit(1); });
