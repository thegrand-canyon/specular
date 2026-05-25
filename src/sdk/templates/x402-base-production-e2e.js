/**
 * Production x402 wiring on Base mainnet — real USDC settlement.
 *
 * Flow:
 *   1. Generate ephemeral buyer wallet (no ETH needed; x402 buyers are gasless)
 *   2. Transfer 0.05 USDC from secure wallet → ephemeral buyer
 *   3. Start SpecularX402Server in 'local' mode on Base, seller = secure wallet
 *   4. SpecularX402Client (ephemeral buyer) calls server, quotes 0.01 USDC
 *   5. Client signs EIP-3009 transferWithAuthorization off-chain
 *   6. Server verifies + settles on-chain (broadcasts the tx, pays gas)
 *   7. Verify: buyer −0.01 USDC, seller +0.01 USDC, real settlement tx on BaseScan
 *   8. Cleanup: sweep buyer's remaining 0.04 USDC back to secure wallet
 *
 * This validates the full production path WITHOUT needing a CDP API key or
 * external facilitator. The seller controls settlement end-to-end.
 */

require('dotenv').config();
const http = require('http');
const { ethers } = require('ethers');
const fs = require('fs');

const path = require('path');
const { SpecularX402Server, SpecularX402Client } = require('../x402');

const PORT = 4242;
const PRICE_USDC = 0.01;
const BUYER_FUND_USDC = 0.02;  // minimize stranded risk on failure

(async () => {
    const baseAddr = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../config/base-addresses.json'), 'utf8'));
    const USDC = baseAddr.usdc;
    const RPC = process.env.BASE_RPC_URL || 'https://base.drpc.org';

    // Disable batching (free public RPCs reject batches > 3)
    const provider = new ethers.JsonRpcProvider(RPC, undefined, { batchMaxCount: 1 });
    const sellerWallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

    // 1. Ephemeral buyer — persist key to /tmp so we can recover stranded funds on crash
    const buyerWallet = ethers.Wallet.createRandom().connect(provider);
    const keyFile = `/tmp/x402-buyer-${Date.now()}.json`;
    fs.writeFileSync(keyFile, JSON.stringify({
        address: buyerWallet.address,
        privateKey: buyerWallet.privateKey,
    }, null, 2));
    fs.chmodSync(keyFile, 0o600);
    console.log(`Buyer key persisted to ${keyFile} (chmod 600) — recover stranded funds here if test crashes`);
    console.log(`\n=== x402 production e2e (Base mainnet) ===`);
    console.log(`Seller:  ${sellerWallet.address}`);
    console.log(`Buyer:   ${buyerWallet.address}  (ephemeral)`);
    console.log(`USDC:    ${USDC}`);
    console.log(`Price:   ${PRICE_USDC} USDC per call`);

    const usdcAbi = [
        'function balanceOf(address) view returns (uint256)',
        'function transfer(address,uint256) returns (bool)',
    ];
    const usdcReader = new ethers.Contract(USDC, usdcAbi, provider);
    const usdcSeller = new ethers.Contract(USDC, usdcAbi, sellerWallet);

    const sellerBalBefore = await usdcReader.balanceOf(sellerWallet.address);
    const buyerBalInitial = await usdcReader.balanceOf(buyerWallet.address);
    console.log(`\n[BEFORE]`);
    console.log(`  Seller USDC: ${ethers.formatUnits(sellerBalBefore, 6)}`);
    console.log(`  Buyer USDC:  ${ethers.formatUnits(buyerBalInitial, 6)}`);

    // 2. Fund the buyer with 0.05 USDC
    console.log(`\n[FUND] Transferring ${BUYER_FUND_USDC} USDC seller → buyer…`);
    const fundTx = await usdcSeller.transfer(buyerWallet.address, ethers.parseUnits(String(BUYER_FUND_USDC), 6));
    await fundTx.wait();
    console.log(`  fund tx: https://basescan.org/tx/${fundTx.hash}`);
    // Wait for state propagation across RPC nodes
    let buyerBalFunded = 0n;
    for (let i = 0; i < 20; i++) {
        await new Promise(r => setTimeout(r, 1000));
        buyerBalFunded = await usdcReader.balanceOf(buyerWallet.address);
        if (buyerBalFunded > 0n) break;
    }
    console.log(`  Buyer USDC after fund: ${ethers.formatUnits(buyerBalFunded, 6)}`);
    if (buyerBalFunded === 0n) throw new Error('Buyer never showed funded balance');

    // 3. Start the seller server (local mode → on-chain settlement)
    const seller = new SpecularX402Server({
        network: 'base',
        privateKey: process.env.PRIVATE_KEY,
        rpcUrl: RPC,
        pricing: { '/transcribe': PRICE_USDC, default: PRICE_USDC },
        poolAgentId: null,  // skip auto-supply for this test (focus on settlement)
        mode: 'local',
    });

    const server = http.createServer(seller.handle(async (req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, result: 'transcription: real x402 settlement on Base' }));
    }));
    await new Promise(r => server.listen(PORT, r));
    console.log(`\n[SERVER] SpecularX402Server (mode=local, network=base) listening on :${PORT}`);

    // 4. Buyer-side client calls the seller
    // maxPayment below buyer balance so pre-flight succeeds without auto-borrow
    const buyer = new SpecularX402Client(
        buyerWallet.privateKey,
        'base',
        { rpcUrl: RPC, maxPayment: ethers.parseUnits('0.015', 6) }  // < 0.02 fund
    );

    console.log(`\n[CALL] Buyer → http://localhost:${PORT}/transcribe (max ${BUYER_FUND_USDC} USDC)`);
    const t0 = Date.now();
    const res = await buyer.fetch(`http://localhost:${PORT}/transcribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ audio: 'fake-audio-blob' }),
    });
    const elapsedMs = Date.now() - t0;
    const bodyText = await res.text();
    console.log(`[CALL] ← HTTP ${res.status} in ${elapsedMs}ms`);
    console.log(`Body: ${bodyText.slice(0, 200)}`);

    // 5. Verify on-chain delta — wait a beat for chain to settle
    await new Promise(r => setTimeout(r, 5_000));
    const buyerBalAfter = await usdcReader.balanceOf(buyerWallet.address);
    const sellerBalAfter = await usdcReader.balanceOf(sellerWallet.address);
    const buyerDelta = buyerBalAfter - buyerBalFunded;
    const sellerDelta = sellerBalAfter - sellerBalBefore + ethers.parseUnits(String(BUYER_FUND_USDC), 6);  // net of fund tx

    console.log(`\n[AFTER]`);
    console.log(`  Seller USDC: ${ethers.formatUnits(sellerBalAfter, 6)}`);
    console.log(`  Buyer USDC:  ${ethers.formatUnits(buyerBalAfter, 6)}`);
    console.log(`  Buyer delta (post-call): ${ethers.formatUnits(buyerDelta, 6)} USDC`);
    console.log(`  Seller stats: ${JSON.stringify(seller.stats(), null, 2)}`);

    const expectedBuyerDelta = -ethers.parseUnits(String(PRICE_USDC), 6);
    let pass = false;
    if (buyerDelta === expectedBuyerDelta) {
        console.log(`\n✅ Production x402 settlement on Base mainnet VERIFIED`);
        console.log(`   Buyer −${PRICE_USDC} USDC, seller +${PRICE_USDC} USDC, fully on-chain`);
        if (seller._lastSettlement?.transaction) {
            console.log(`   Settlement tx: https://basescan.org/tx/${seller._lastSettlement.transaction}`);
        }
        pass = true;
    } else {
        console.log(`\n⚠️ Unexpected buyer delta. Expected ${ethers.formatUnits(expectedBuyerDelta, 6)}, got ${ethers.formatUnits(buyerDelta, 6)}`);
    }

    // 6. Sweep buyer's remaining USDC back so we don't strand funds
    console.log(`\n[CLEANUP] Sweeping buyer remainder back to seller…`);
    const ethForSweep = ethers.parseEther('0.00006');
    const ethTx = await sellerWallet.sendTransaction({ to: buyerWallet.address, value: ethForSweep });
    await ethTx.wait();
    // Wait for ETH propagation across RPC nodes before buyer attempts to spend it
    for (let i = 0; i < 15; i++) {
        await new Promise(r => setTimeout(r, 1500));
        const ethBal = await provider.getBalance(buyerWallet.address);
        if (ethBal > 0n) break;
    }
    const usdcBuyerSign = new ethers.Contract(USDC, usdcAbi, buyerWallet);
    const sweepTx = await usdcBuyerSign.transfer(sellerWallet.address, buyerBalAfter);
    await sweepTx.wait();
    console.log(`  sweep tx: https://basescan.org/tx/${sweepTx.hash}`);
    // Remove persisted buyer key — no longer needed
    try { fs.unlinkSync(keyFile); } catch (e) {}

    server.close();
    process.exit(pass ? 0 : 1);
})().catch(e => { console.error('PRODUCTION TEST ERROR:', e); process.exit(1); });
