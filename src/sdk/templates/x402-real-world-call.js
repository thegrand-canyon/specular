/**
 * Real-world x402 e2e — call a third-party x402 API on Base mainnet.
 *
 * Proves SpecularX402Client interoperates with the public x402 ecosystem
 * (not just our own SpecularX402Server). Target: api.x402node.dev which is
 * listed in Coinbase's x402 discovery directory.
 *
 * Flow:
 *   1. Pick a target endpoint and quoted price from the live 402 response
 *   2. Generate ephemeral buyer; fund with slightly more than the price
 *   3. Call the endpoint via SpecularX402Client.fetch()
 *   4. Verify HTTP 200 with real API result
 *   5. Verify on-chain: buyer USDC dropped by ~quoted price
 *   6. Sweep remainder back so funds aren't stranded
 *
 * Cost: ~0.01-0.03 USDC + gas (~$0.10 ETH).
 *
 * Run:
 *   PRIVATE_KEY=0x... node src/sdk/templates/x402-real-world-call.js
 *   PRIVATE_KEY=0x... TARGET=https://api.x402node.dev/text/stats?text=hello \
 *       node src/sdk/templates/x402-real-world-call.js
 */

require('dotenv').config();
const path = require('path');
const fs = require('fs');
const { ethers } = require('ethers');
const { SpecularX402Client } = require('../x402');

const TARGET = process.env.TARGET || 'https://api.x402node.dev/dev/uuid';
const BUYER_FUND_USDC = parseFloat(process.env.FUND_USDC || '0.01');

(async () => {
    const baseAddr = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../config/base-addresses.json'), 'utf8'));
    const USDC = baseAddr.usdc;
    const RPC = process.env.BASE_RPC_URL || 'https://base.drpc.org';
    const provider = new ethers.JsonRpcProvider(RPC, undefined, { batchMaxCount: 1 });
    const sellerWallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);  // funder

    // 1. Probe the live 402 to learn the price + payTo
    const probe = await fetch(TARGET, { method: 'GET' });
    if (probe.status !== 402) {
        console.error(`Target returned HTTP ${probe.status}, not 402. Cannot test x402 flow.`);
        process.exit(1);
    }
    const req = await probe.json();
    const accept = req.accepts?.[0];
    const priceBase = BigInt(accept.maxAmountRequired);
    const priceUsdc = Number(ethers.formatUnits(priceBase, 6));
    console.log(`\n=== Real-world x402 e2e ===`);
    console.log(`Target:        ${TARGET}`);
    console.log(`Price:         ${priceBase} base units (${priceUsdc} USDC)`);
    console.log(`Network:       ${accept.network}`);
    console.log(`Asset:         ${accept.asset}`);
    console.log(`Pay to:        ${accept.payTo}`);
    if (accept.asset.toLowerCase() !== USDC.toLowerCase()) {
        console.warn(`⚠️  Target uses a different asset than our configured USDC — abort`);
        process.exit(1);
    }
    if (BUYER_FUND_USDC * 1e6 < Number(priceBase) + 1000) {
        console.warn(`⚠️  Fund amount (${BUYER_FUND_USDC} USDC) too small for price + margin — abort`);
        process.exit(1);
    }

    // 2. Ephemeral buyer + persisted key
    const buyerWallet = ethers.Wallet.createRandom().connect(provider);
    const keyFile = `/tmp/x402-buyer-realworld-${Date.now()}.json`;
    fs.writeFileSync(keyFile, JSON.stringify({ address: buyerWallet.address, privateKey: buyerWallet.privateKey }, null, 2));
    fs.chmodSync(keyFile, 0o600);
    console.log(`Buyer (ephemeral): ${buyerWallet.address}`);
    console.log(`Key saved:    ${keyFile}`);

    const usdcAbi = [
        'function balanceOf(address) view returns (uint256)',
        'function transfer(address,uint256) returns (bool)',
    ];
    const usdcReader = new ethers.Contract(USDC, usdcAbi, provider);
    const usdcSeller = new ethers.Contract(USDC, usdcAbi, sellerWallet);

    // 3. Fund buyer
    console.log(`\n[FUND] Transferring ${BUYER_FUND_USDC} USDC to buyer...`);
    const fundTx = await usdcSeller.transfer(buyerWallet.address, ethers.parseUnits(String(BUYER_FUND_USDC), 6));
    await fundTx.wait();
    console.log(`  tx: https://basescan.org/tx/${fundTx.hash}`);
    let buyerBalFunded = 0n;
    for (let i = 0; i < 20; i++) {
        await new Promise(r => setTimeout(r, 1000));
        buyerBalFunded = await usdcReader.balanceOf(buyerWallet.address);
        if (buyerBalFunded > 0n) break;
    }
    console.log(`  Buyer USDC: ${ethers.formatUnits(buyerBalFunded, 6)}`);
    if (buyerBalFunded === 0n) throw new Error('Buyer never showed funded balance');

    const sellerOnchainBefore = await usdcReader.balanceOf(accept.payTo);
    console.log(`  Seller onchain (before): ${ethers.formatUnits(sellerOnchainBefore, 6)} USDC`);

    // 4. Build SpecularX402Client. maxPayment slightly above the quoted price
    const maxPayment = priceBase + 1000n;  // +0.001 USDC margin
    const buyer = new SpecularX402Client(buyerWallet.privateKey, 'base', { rpcUrl: RPC, maxPayment });

    console.log(`\n[CALL] Buyer → ${TARGET}`);
    const t0 = Date.now();
    const res = await buyer.fetch(TARGET, { method: 'GET' });
    const elapsedMs = Date.now() - t0;
    const bodyText = await res.text();
    console.log(`[CALL] ← HTTP ${res.status} in ${elapsedMs}ms`);
    console.log(`Body: ${bodyText.slice(0, 400)}`);

    // 5. Verify on-chain delta
    console.log('\nWaiting 6s for settlement to propagate...');
    await new Promise(r => setTimeout(r, 6_000));
    const buyerBalAfter = await usdcReader.balanceOf(buyerWallet.address);
    const sellerOnchainAfter = await usdcReader.balanceOf(accept.payTo);
    const buyerDelta = buyerBalAfter - buyerBalFunded;
    const sellerDelta = sellerOnchainAfter - sellerOnchainBefore;
    console.log(`\n[AFTER]`);
    console.log(`  Buyer USDC:  ${ethers.formatUnits(buyerBalAfter, 6)} (delta ${ethers.formatUnits(buyerDelta, 6)})`);
    console.log(`  Seller USDC: ${ethers.formatUnits(sellerOnchainAfter, 6)} (delta +${ethers.formatUnits(sellerDelta, 6)})`);

    const pass = res.status === 200 && buyerDelta === -priceBase && sellerDelta === priceBase;
    if (pass) {
        console.log(`\n✅ Real-world x402 call SUCCEEDED end-to-end`);
        console.log(`   Settled ${priceUsdc} USDC on Base mainnet to a third-party seller`);
    } else {
        console.log(`\n⚠️  Mismatch: status=${res.status}, expected buyerDelta=-${priceBase}, got ${buyerDelta}`);
    }

    // 6. Sweep remainder
    console.log(`\n[CLEANUP] Sweeping buyer remainder...`);
    const ethForSweep = ethers.parseEther('0.00006');
    const ethTx = await sellerWallet.sendTransaction({ to: buyerWallet.address, value: ethForSweep });
    await ethTx.wait();
    for (let i = 0; i < 15; i++) {
        await new Promise(r => setTimeout(r, 1500));
        const ethBal = await provider.getBalance(buyerWallet.address);
        if (ethBal > 0n) break;
    }
    const usdcBuyer = new ethers.Contract(USDC, usdcAbi, buyerWallet);
    const sweepTx = await usdcBuyer.transfer(sellerWallet.address, buyerBalAfter);
    await sweepTx.wait();
    console.log(`  sweep: https://basescan.org/tx/${sweepTx.hash}`);
    try { fs.unlinkSync(keyFile); } catch (e) {}

    process.exit(pass ? 0 : 1);
})().catch(e => { console.error('REALWORLD ERROR:', e); process.exit(1); });
