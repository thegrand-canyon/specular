/**
 * Full agent journey on Base mainnet — real money, real txs.
 *
 *   1. Fresh ephemeral agent wallet (no prior history)
 *   2. Fund with 5 USDC + 0.01 ETH
 *   3. SpecularQuickstart.onboard() → register, createPool, approve (3 txs)
 *   4. Make x402 call to a real third-party endpoint (api.x402node.dev/dev/uuid)
 *   5. Self-supply 2 USDC into own pool (so we have liquidity to borrow against)
 *   6. Borrow 0.5 USDC for 7d (rep=0 → 100% collateral; net wallet change = 0)
 *   7. Repay (small interest)
 *   8. Verify reputation went 0 → +10
 *   9. Withdraw position + sweep all funds back
 *
 * Saves buyer key to /tmp before each step for crash recovery.
 */

require('dotenv').config();
const path = require('path');
const fs = require('fs');
const { ethers } = require('ethers');
const { SpecularQuickstart } = require('../SpecularQuickstart');
const { SpecularX402Client } = require('../x402');

// Try multiple Base RPCs — pick the first one that responds within 5s
const BASE_RPCs = [
    process.env.BASE_RPC_URL,
    'https://mainnet.base.org',
    'https://base.publicnode.com',
    'https://1rpc.io/base',
    'https://base.drpc.org',
].filter(Boolean);

async function pickRpc() {
    for (const url of BASE_RPCs) {
        try {
            const p = new ethers.JsonRpcProvider(url, undefined, { batchMaxCount: 1 });
            const n = await Promise.race([
                p.getBlockNumber(),
                new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000)),
            ]);
            console.log(`Using RPC: ${url} (block ${n})`);
            return url;
        } catch (e) {
            console.log(`  rpc fail: ${url} — ${e.message.slice(0, 80)}`);
        }
    }
    throw new Error('No working Base RPC');
}
const FUND_USDC = 5;
const FUND_ETH = '0.005';
const X402_TARGET = 'https://api.x402node.dev/dev/uuid';
const SELF_SUPPLY_USDC = 2;
const BORROW_USDC = 0.5;
const BORROW_DAYS = 7;

(async () => {
    const baseAddr = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../config/base-addresses.json'), 'utf8'));
    const USDC = baseAddr.usdc;
    const RPC = await pickRpc();
    const provider = new ethers.JsonRpcProvider(RPC, undefined, { batchMaxCount: 1 });
    const funder = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

    // === STEP 1: spawn fresh agent ===
    const agent = ethers.Wallet.createRandom().connect(provider);
    const keyFile = `/tmp/agent-journey-${Date.now()}.json`;
    fs.writeFileSync(keyFile, JSON.stringify({ address: agent.address, privateKey: agent.privateKey }, null, 2));
    fs.chmodSync(keyFile, 0o600);
    console.log(`\n=== FULL AGENT JOURNEY (Base mainnet) ===`);
    console.log(`Fresh agent wallet: ${agent.address}`);
    console.log(`Funder wallet:      ${funder.address}`);
    console.log(`Key saved:          ${keyFile} (chmod 600, sweep stranded funds here)\n`);

    const usdcAbi = [
        'function balanceOf(address) view returns (uint256)',
        'function transfer(address,uint256) returns (bool)',
    ];
    const usdcReader = new ethers.Contract(USDC, usdcAbi, provider);

    // === STEP 2: fund ===
    console.log(`[STEP 2] Funding agent: ${FUND_USDC} USDC + ${FUND_ETH} ETH...`);
    const usdcFunder = new ethers.Contract(USDC, usdcAbi, funder);
    const usdcTx = await usdcFunder.transfer(agent.address, ethers.parseUnits(String(FUND_USDC), 6));
    await usdcTx.wait();
    console.log(`  USDC fund tx: https://basescan.org/tx/${usdcTx.hash}`);
    const ethTx = await funder.sendTransaction({ to: agent.address, value: ethers.parseEther(FUND_ETH) });
    await ethTx.wait();
    console.log(`  ETH  fund tx: https://basescan.org/tx/${ethTx.hash}`);
    // Wait for propagation
    let usdcBal = 0n, ethBal = 0n;
    for (let i = 0; i < 20; i++) {
        await new Promise(r => setTimeout(r, 1500));
        usdcBal = await usdcReader.balanceOf(agent.address);
        ethBal = await provider.getBalance(agent.address);
        if (usdcBal > 0n && ethBal > 0n) break;
    }
    console.log(`  Agent state: ${ethers.formatUnits(usdcBal, 6)} USDC, ${ethers.formatEther(ethBal)} ETH`);
    if (usdcBal === 0n || ethBal === 0n) throw new Error('Funding never confirmed in balance view');

    // === STEP 3: onboard ===
    console.log(`\n[STEP 3] SDK.onboard() → register + createPool + approve…`);
    const sdk = new SpecularQuickstart(agent, 'base');
    const t0 = Date.now();
    const onb = await sdk.onboard();
    console.log(`  Agent ID:     ${onb.agentId}`);
    console.log(`  register tx:  ${onb.registerTx || '(already)'}`);
    console.log(`  pool tx:      ${onb.poolTx || '(already)'}`);
    console.log(`  approve tx:   ${onb.approveTx || '(already)'}`);
    console.log(`  elapsed: ${Date.now() - t0}ms`);

    // === STEP 4: x402 call ===
    console.log(`\n[STEP 4] x402 call to ${X402_TARGET}…`);
    const usdcBeforeX402 = await usdcReader.balanceOf(agent.address);
    const x402 = new SpecularX402Client(agent.privateKey, 'base', {
        rpcUrl: RPC,
        maxPayment: ethers.parseUnits('0.01', 6),
    });
    const x402Res = await x402.fetch(X402_TARGET, { method: 'GET' });
    const x402Body = await x402Res.text();
    console.log(`  HTTP ${x402Res.status}: ${x402Body.slice(0, 150)}`);
    await new Promise(r => setTimeout(r, 6000));
    const usdcAfterX402 = await usdcReader.balanceOf(agent.address);
    const x402Cost = usdcBeforeX402 - usdcAfterX402;
    console.log(`  x402 cost: ${ethers.formatUnits(x402Cost, 6)} USDC`);

    // === STEP 5: self-supply ===
    console.log(`\n[STEP 5] Self-supply ${SELF_SUPPLY_USDC} USDC to own pool…`);
    const supplyTx = await sdk.supply(onb.agentId, SELF_SUPPLY_USDC);
    console.log(`  supply tx: https://basescan.org/tx/${supplyTx}`);

    // === STEP 6: check rep before borrow + borrow ===
    const creditBefore = await sdk.creditInfo();
    console.log(`\n[STEP 6] Credit before borrow: score=${creditBefore.score}, limit=${creditBefore.creditLimit} USDC, ` +
                `collateral=${creditBefore.collateralPct}%, rate=${creditBefore.interestRateAPR}% APR`);
    console.log(`         Borrowing ${BORROW_USDC} USDC for ${BORROW_DAYS} days…`);
    const usdcBeforeBorrow = await usdcReader.balanceOf(agent.address);
    const loan = await sdk.borrow(BORROW_USDC, BORROW_DAYS);
    console.log(`  loanId: ${loan.loanId}`);
    console.log(`  tx:     https://basescan.org/tx/${loan.tx}`);
    const usdcAfterBorrow = await usdcReader.balanceOf(agent.address);
    console.log(`  USDC delta from borrow: ${ethers.formatUnits(usdcAfterBorrow - usdcBeforeBorrow, 6)} (collateral pulled, principal credited)`);

    // === STEP 7: repay ===
    console.log(`\n[STEP 7] Repay loan ${loan.loanId}…`);
    const usdcBeforeRepay = await usdcReader.balanceOf(agent.address);
    const repayHash = await sdk.repay(loan.loanId);
    console.log(`  repay tx: https://basescan.org/tx/${repayHash}`);
    const usdcAfterRepay = await usdcReader.balanceOf(agent.address);
    const repayCost = usdcBeforeRepay - usdcAfterRepay;
    console.log(`  Net USDC change at repay: ${ethers.formatUnits(usdcAfterRepay - usdcBeforeRepay, 6)} (collateral returned − interest)`);

    // === STEP 8: reputation check ===
    const creditAfter = await sdk.creditInfo();
    console.log(`\n[STEP 8] Credit after repay: score=${creditAfter.score} (delta: +${creditAfter.score - creditBefore.score}), ` +
                `limit=${creditAfter.creditLimit} USDC, rate=${creditAfter.interestRateAPR}% APR`);

    // === STEP 9: cleanup ===
    console.log(`\n[STEP 9] Withdraw + sweep all funds back to funder…`);
    try {
        const wTx = await sdk.withdraw(onb.agentId, SELF_SUPPLY_USDC);
        console.log(`  withdraw tx: https://basescan.org/tx/${wTx}`);
    } catch (e) {
        console.log(`  withdraw skipped: ${e.shortMessage || e.message}`);
    }
    const finalUsdcBal = await usdcReader.balanceOf(agent.address);
    if (finalUsdcBal > 0n) {
        const usdcAgent = new ethers.Contract(USDC, usdcAbi, agent);
        const sweepTx = await usdcAgent.transfer(funder.address, finalUsdcBal);
        await sweepTx.wait();
        console.log(`  USDC sweep tx (${ethers.formatUnits(finalUsdcBal, 6)} USDC): https://basescan.org/tx/${sweepTx.hash}`);
    }
    try { fs.unlinkSync(keyFile); } catch (e) {}

    const pass = creditAfter.score > creditBefore.score;
    console.log(`\n${pass ? '✅' : '❌'} Agent journey complete. Reputation: ${creditBefore.score} → ${creditAfter.score}`);
    process.exit(pass ? 0 : 1);
})().catch(e => { console.error('JOURNEY ERROR:', e); process.exit(1); });
