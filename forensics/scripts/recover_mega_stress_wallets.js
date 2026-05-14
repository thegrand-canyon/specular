// Recover residual positions + balances from mega stress wallets.
// Reads persisted keys, withdraws every wallet's positions across all 5 pools,
// then drains USDC + ETH back to master.

require('dotenv').config();
const { ethers } = require('ethers');
const fs = require('fs');

const RPC = process.env.ARC_TESTNET_RPC_URL || 'https://arc-testnet.drpc.org';
const ADDR = JSON.parse(fs.readFileSync('./src/config/arc-testnet-addresses.json'));
const V6 = ADDR.agentLiquidityMarketplace_v6;
const ABI = JSON.parse(fs.readFileSync('./artifacts/contracts/core/AgentLiquidityMarketplaceV6.sol/AgentLiquidityMarketplaceV6.json')).abi;
const USDC_ABI = ['function balanceOf(address) view returns (uint256)', 'function transfer(address,uint256) returns (bool)', 'function approve(address,uint256) returns (bool)'];
const fmt = v => Number(ethers.formatUnits(v, 6));

const POOL_IDS = [129, 130, 131, 132, 133]; // mega stress borrowers
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function withRetry(fn, attempts = 15) {
    for (let i = 0; i < attempts; i++) {
        try { return await fn(); }
        catch (e) {
            const m = (e.shortMessage || e.message || '').toLowerCase();
            const isRate = m.includes('rate') || m.includes('408') || m.includes('429') || m.includes('-32016') || m.includes('timeout') || m.includes('server response') || m.includes('econnreset');
            if (i === attempts - 1 || !isRate) throw e;
            await sleep(Math.min(2000 * Math.pow(1.5, i), 30000));
        }
    }
}

(async () => {
    const provider = new ethers.JsonRpcProvider(RPC, undefined, { batchMaxCount: 1 });
    const owner = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
    const usdc = new ethers.Contract(ADDR.usdc, USDC_ABI, provider);
    const v6 = new ethers.Contract(V6, ABI, provider);

    const main = JSON.parse(fs.readFileSync('./forensics/output/regression-2026-05-07/52-mega-stress-wallets.json'));
    const extras = JSON.parse(fs.readFileSync('./forensics/output/regression-2026-05-07/52-mega-stress-extras.json'));
    const wallets = [...main.lenders, ...main.borrowers, ...extras.extras];
    console.log('Loaded', wallets.length, 'wallets to scan');

    const startMaster = await usdc.balanceOf(owner.address);
    console.log('Master USDC before:', fmt(startMaster));
    let recovered = 0n;
    let drainedEth = 0n;
    let withdrawCount = 0;

    for (const [i, w] of wallets.entries()) {
        const wallet = new ethers.Wallet(w.privateKey, provider);
        let walletHadActivity = false;
        for (const aid of POOL_IDS) {
            try {
                const pos = await withRetry(() => v6.positions(aid, wallet.address));
                if (pos.amount > 0n) {
                    const v6w = new ethers.Contract(V6, ABI, wallet);
                    await withRetry(() => v6w.withdrawLiquidity(aid, pos.amount).then(t => t.wait()));
                    withdrawCount++;
                    walletHadActivity = true;
                    console.log(`  [${i + 1}/${wallets.length}] ${wallet.address.slice(0, 10)}... withdrew ${fmt(pos.amount)} from pool ${aid}`);
                }
            } catch (e) { /* no position or other tx failure */ }
        }
        // Drain USDC balance
        try {
            const bal = await withRetry(() => usdc.balanceOf(wallet.address));
            if (bal > 0n) {
                const u = new ethers.Contract(ADDR.usdc, USDC_ABI, wallet);
                await withRetry(() => u.transfer(owner.address, bal).then(t => t.wait()));
                recovered += bal;
                walletHadActivity = true;
            }
        } catch (e) {}
        // Drain ETH (keep dust for any final tx)
        try {
            const eth = await provider.getBalance(wallet.address);
            const dust = ethers.parseEther('0.005');
            if (eth > dust) {
                await withRetry(() => wallet.sendTransaction({ to: owner.address, value: eth - dust }).then(t => t.wait()));
                drainedEth += eth - dust;
                walletHadActivity = true;
            }
        } catch (e) {}
        if (walletHadActivity) await sleep(200);
    }

    const endMaster = await usdc.balanceOf(owner.address);
    console.log('\n=== RECOVERY DONE ===');
    console.log(`Position withdraws: ${withdrawCount}`);
    console.log(`USDC drained from wallet balances: ${fmt(recovered)}`);
    console.log(`ETH drained: ${ethers.formatEther(drainedEth)}`);
    console.log(`Master USDC delta: ${fmt(endMaster - startMaster)} (after: ${fmt(endMaster)})`);
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
