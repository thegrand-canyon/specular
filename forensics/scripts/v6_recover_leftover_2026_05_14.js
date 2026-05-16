// V6 leftover cleanup — drains residual positions + balances from EVERY persisted-key
// wallet file across the session. Uses the same loader as v6_orphan_probe but withdraws
// for each address that has a non-zero position.

require('dotenv').config();
const { ethers } = require('ethers');
const fs = require('fs');

const RPC = process.env.ARC_TESTNET_RPC_URL || 'https://arc-testnet.drpc.org';
const ADDR = JSON.parse(fs.readFileSync('./src/config/arc-testnet-addresses.json'));
const V6 = ADDR.agentLiquidityMarketplace_v6;
const ABI = JSON.parse(fs.readFileSync('./artifacts/contracts/core/AgentLiquidityMarketplaceV6.sol/AgentLiquidityMarketplaceV6.json')).abi;
const USDC_ABI = ['function balanceOf(address) view returns (uint256)', 'function transfer(address,uint256) returns (bool)'];
const fmt = v => Number(ethers.formatUnits(v, 6));
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function withRetry(fn, attempts = 20) {
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
const log = (...a) => console.log(...a);

function loadKnownWallets() {
    const known = new Map(); // address → privateKey
    const candidates = [
        './forensics/output/regression-2026-05-07/52-mega-stress-wallets.json',
        './forensics/output/regression-2026-05-07/52-mega-stress-extras.json',
        './forensics/output/regression-2026-05-07/52-mega-stress-extras-51st.json',
        './forensics/output/regression-2026-05-07/56-migration-helpers-agent.json',
        './forensics/output/regression-2026-05-07/56-migration-helpers-lender.json',
        './forensics/output/regression-2026-05-07/59-s5-extreme-wallets.json',
        './forensics/output/regression-2026-05-07/60-concurrent-wallets.json',
        './forensics/output/regression-2026-05-07/58-b1-differential-wallets.json',
        './forensics/output/regression-2026-05-07/64-rep-wallets.json',
        './forensics/output/regression-2026-05-07/65-multiborrower-wallets.json',
        './forensics/output/regression-2026-05-07/66-pause-wallets.json',
        './forensics/output/regression-2026-05-07/69-edge-wallets.json',
        './forensics/output/regression-2026-05-07/70-cap-wallets.json',
        './forensics/output/regression-2026-05-07/72-api-wallet.json',
        './forensics/output/regression-2026-05-07/73-mega-v2-wallets.json',
        './forensics/output/regression-2026-05-07/73-mega-v2-extras.json'
    ];
    for (const f of candidates) {
        if (!fs.existsSync(f)) continue;
        try {
            const txt = fs.readFileSync(f, 'utf8');
            try {
                const j = JSON.parse(txt);
                for (const arr of [j.lenders, j.borrowers, j.extras]) {
                    if (Array.isArray(arr)) for (const item of arr) {
                        const addr = item.address || item.addr || item.a;
                        const key = item.privateKey || item.key || item.k;
                        if (addr && key) known.set(addr.toLowerCase(), key);
                    }
                }
                // Single-object shape (migration helpers)
                if (j.address && j.privateKey) known.set(j.address.toLowerCase(), j.privateKey);
            } catch (e) {
                // Line-delimited (b1-differential)
                for (const line of txt.split('\n')) {
                    if (!line.trim()) continue;
                    try {
                        const j = JSON.parse(line);
                        for (const sub of [j, j.lender, j.borrower]) {
                            if (sub && (sub.address || sub.addr)) {
                                const addr = (sub.address || sub.addr).toLowerCase();
                                const key = sub.privateKey || sub.key;
                                if (addr && key) known.set(addr, key);
                            }
                        }
                    } catch (e2) {}
                }
            }
        } catch (e) {}
    }
    return known;
}

(async () => {
    const provider = new ethers.JsonRpcProvider(RPC, undefined, { batchMaxCount: 1 });
    const owner = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
    const v6 = new ethers.Contract(V6, ABI, provider);
    const usdc = new ethers.Contract(ADDR.usdc, USDC_ABI, provider);

    const known = loadKnownWallets();
    log(`Loaded ${known.size} known wallets`);

    const startMaster = await usdc.balanceOf(owner.address);
    log('Master USDC before:', fmt(startMaster));

    const totalPools = Number(await v6.totalPools());
    log(`Scanning ${totalPools} pools...`);

    let recoveredViaWithdraw = 0n;
    let recoveredViaBalance = 0n;
    let recoveredViaEth = 0n;
    let withdrawCount = 0;

    // Phase 1: For each (knownWallet, pool), check position and withdraw
    for (const [addr, key] of known) {
        const wallet = new ethers.Wallet(key, provider);
        const v6w = new ethers.Contract(V6, ABI, wallet);
        const u = new ethers.Contract(ADDR.usdc, USDC_ABI, wallet);
        let walletHad = false;

        // Iterate all pools, check positions
        for (let i = 0; i < totalPools; i++) {
            try {
                const aid = await withRetry(() => v6.agentPoolIds(i));
                const pos = await withRetry(() => v6.positions(aid, addr));
                if (pos.amount > 0n) {
                    const pool = await withRetry(() => v6.getAgentPool(aid));
                    const withdrawable = pos.amount < pool[2] ? pos.amount : pool[2];
                    if (withdrawable > 0n) {
                        await withRetry(() => v6w.withdrawLiquidity(aid, withdrawable).then(t => t.wait()));
                        recoveredViaWithdraw += withdrawable;
                        withdrawCount++;
                        walletHad = true;
                        log(`  ${addr.slice(0, 10)}... pool ${aid}: withdrew ${fmt(withdrawable)}`);
                    }
                }
            } catch (e) {}
        }

        // Drain wallet balance
        try {
            const bal = await withRetry(() => usdc.balanceOf(addr));
            if (bal > 0n) {
                await withRetry(() => u.transfer(owner.address, bal).then(t => t.wait()));
                recoveredViaBalance += bal;
                walletHad = true;
            }
        } catch (e) {}

        // Drain ETH (keep dust)
        try {
            const eth = await provider.getBalance(addr);
            const dust = ethers.parseEther('0.003');
            if (eth > dust) {
                await withRetry(() => wallet.sendTransaction({ to: owner.address, value: eth - dust }).then(t => t.wait()));
                recoveredViaEth += eth - dust;
                walletHad = true;
            }
        } catch (e) {}
        if (walletHad) await sleep(100);
    }

    const endMaster = await usdc.balanceOf(owner.address);
    log('\n=== LEFTOVER CLEANUP DONE ===');
    log(`Withdraws: ${withdrawCount}, total: ${fmt(recoveredViaWithdraw)} USDC`);
    log(`From wallet balances: ${fmt(recoveredViaBalance)} USDC`);
    log(`From ETH: ${ethers.formatEther(recoveredViaEth)} ETH`);
    log(`Master USDC delta: +${fmt(endMaster - startMaster)}`);
    log(`Master final USDC: ${fmt(endMaster)}`);
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
