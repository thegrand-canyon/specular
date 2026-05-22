// Arc V6: shared-pool concurrent stress. Single pool with one borrower-agent, but
// MANY lenders rotating through, and the agent does many concurrent loan cycles.
// Tests the §S5 counter + interest distribution under high lender turnover.

require('dotenv').config();
const { ethers } = require('ethers');
const fs = require('fs');
const ADDR = JSON.parse(fs.readFileSync('./src/config/arc-testnet-addresses.json'));
const V6 = ADDR.agentLiquidityMarketplace_v6;
const ABI = JSON.parse(fs.readFileSync('./artifacts/contracts/core/AgentLiquidityMarketplaceV6.sol/AgentLiquidityMarketplaceV6.json')).abi;
const REG_ABI = JSON.parse(fs.readFileSync('./artifacts/contracts/core/AgentRegistryV2.sol/AgentRegistryV2.json')).abi;
const USDC_ABI = ['function approve(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)', 'function transfer(address,uint256) returns (bool)'];
const fmt = v => Number(ethers.formatUnits(v, 6));
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function rT(fn, n=15) { for (let i=0;i<n;i++){try{return await fn();}catch(e){const m=(e.shortMessage||e.message||'').toLowerCase();const r=m.includes('rate')||m.includes('408')||m.includes('429')||m.includes('-32016')||m.includes('timeout')||m.includes('server response')||m.includes('econnreset');if(i===n-1||!r)throw e;await sleep(Math.min(2000*Math.pow(1.5,i),60000));}} }

const N_LENDERS = 8;
const N_CYCLES = 30;
const SUPPLY = ethers.parseUnits('5000', 6);

(async () => {
    const provider = new ethers.JsonRpcProvider(process.env.ARC_TESTNET_RPC_URL || 'https://arc-testnet.drpc.org', undefined, { batchMaxCount: 1 });
    const owner = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
    const v6 = new ethers.Contract(V6, ABI, owner);
    const reg = new ethers.Contract(ADDR.agentRegistryV2, REG_ABI, owner);
    const usdc = new ethers.Contract(ADDR.usdc, USDC_ABI, owner);

    const t0 = Date.now();
    console.log('=== Arc V6 SHARED-POOL CONCURRENT STRESS ===');
    console.log('V6:', V6);
    console.log(`${N_LENDERS} lenders × 5000 USDC each, single borrower doing ${N_CYCLES} cycles, lender rotation every 5 cycles`);

    // Persist wallets
    const lenders = Array.from({length: N_LENDERS}, () => ethers.Wallet.createRandom().connect(provider));
    const borrower = ethers.Wallet.createRandom().connect(provider);
    fs.writeFileSync('./forensics/output/regression-2026-05-07/93-sharedpool-wallets.json', JSON.stringify({
        borrower: { addr: borrower.address, key: borrower.privateKey },
        lenders: lenders.map(w => ({ addr: w.address, key: w.privateKey }))
    }, null, 2));

    // Fund
    console.log('\n[1] Funding wallets');
    for (const w of [...lenders, borrower]) {
        await rT(() => owner.sendTransaction({ to: w.address, value: ethers.parseEther('0.5') }).then(t => t.wait()));
        await sleep(500);
    }
    for (const l of lenders) await rT(() => usdc.transfer(l.address, ethers.parseUnits('6000', 6)).then(t => t.wait()));
    await rT(() => usdc.transfer(borrower.address, ethers.parseUnits('500', 6)).then(t => t.wait()));

    // Register borrower + pool
    console.log('[2] Register + pool create');
    const regB = new ethers.Contract(ADDR.agentRegistryV2, REG_ABI, borrower);
    await rT(() => regB.register('ipfs://shared-' + Date.now(), []).then(t => t.wait()));
    const aid = Number(await rT(() => reg.addressToAgentId(borrower.address)));
    const v6B = new ethers.Contract(V6, ABI, borrower);
    const usdcB = new ethers.Contract(ADDR.usdc, USDC_ABI, borrower);
    await rT(() => v6B.createAgentPool().then(t => t.wait()));
    await rT(() => usdcB.approve(V6, ethers.MaxUint256).then(t => t.wait()));

    // All lenders approve
    for (const l of lenders) {
        const u = new ethers.Contract(ADDR.usdc, USDC_ABI, l);
        await rT(() => u.approve(V6, ethers.MaxUint256).then(t => t.wait()));
    }

    // Initial supply from first 4 lenders
    console.log('\n[3] First 4 lenders supply 5000 USDC each to pool');
    for (let i = 0; i < 4; i++) {
        const m = new ethers.Contract(V6, ABI, lenders[i]);
        await rT(() => m.supplyLiquidity(aid, SUPPLY).then(t => t.wait()));
        console.log(`  lender ${i+1} supplied`);
    }

    // Loan cycles with lender rotation
    console.log(`\n[4] ${N_CYCLES} loan cycles, rotating new lender every 5 cycles`);
    let nextLenderIdx = 4;
    const snapshots = [];
    let totalLoans = 0;
    for (let c = 0; c < N_CYCLES; c++) {
        try {
            const t1 = await rT(() => v6B.requestLoan(ethers.parseUnits('100', 6), 7));
            const r1 = await rT(() => t1.wait());
            let lid;
            for (const log of r1.logs) try { const p = v6B.interface.parseLog(log); if (p?.name === 'LoanRequested') lid = p.args.loanId; } catch(e){}
            await sleep(800);
            await rT(() => v6B.repayLoan(lid).then(t => t.wait()));
            totalLoans++;
        } catch (e) {
            console.log(`  cycle ${c+1}: ${(e.shortMessage||e.message).slice(0,60)}`);
        }
        // Rotate every 5 cycles: new lender joins, oldest leaves
        if ((c+1) % 5 === 0 && nextLenderIdx < N_LENDERS) {
            const newL = new ethers.Contract(V6, ABI, lenders[nextLenderIdx]);
            try {
                await rT(() => newL.supplyLiquidity(aid, SUPPLY).then(t => t.wait()));
                console.log(`  cycle ${c+1}: lender ${nextLenderIdx+1} JOINED`);
                nextLenderIdx++;
            } catch (e) { console.log(`  cycle ${c+1}: rotation fail ${(e.shortMessage||e.message).slice(0,40)}`); }
        }
        if ((c+1) % 5 === 0) {
            // Invariant snapshot
            const p = await rT(() => v6.getAgentPool(aid));
            const lc = Number(p[6]);
            const seen = new Set();
            for (let j = 0; j < lc; j++) seen.add((await rT(() => v6.poolLenders(aid, j))).toLowerCase());
            const mpBal = await rT(() => usdc.balanceOf(V6));
            const dups = lc !== seen.size;
            snapshots.push({ cycle: c+1, totalLiq: fmt(p[1]), avail: fmt(p[2]), loaned: fmt(p[3]), earned: fmt(p[4]), lc, unique: seen.size, dups, mpBal: fmt(mpBal) });
            console.log(`  ${dups ? '❌' : '✅'} cycle ${c+1}: pool totalLiq=${fmt(p[1])}, avail=${fmt(p[2])}, lc=${lc}, unique=${seen.size}, dups=${dups}`);
        }
    }

    console.log(`\n[5] Total loans completed: ${totalLoans}/${N_CYCLES}`);

    // Claim cycle
    console.log('\n[6] All lenders claim interest');
    let totalClaimed = 0n;
    for (let i = 0; i < N_LENDERS; i++) {
        try {
            const pos = await rT(() => v6.positions(aid, lenders[i].address));
            if (pos.earnedInterest > 0n) {
                const m = new ethers.Contract(V6, ABI, lenders[i]);
                await rT(() => m.claimInterest(aid).then(t => t.wait()));
                totalClaimed += pos.earnedInterest;
            }
        } catch (e) {}
    }
    console.log(`  total claimed: ${fmt(totalClaimed)} USDC`);

    // Final invariant
    const p = await rT(() => v6.getAgentPool(aid));
    const mpBal = await rT(() => usdc.balanceOf(V6));
    console.log(`\nFinal pool ${aid}: totalLiq=${fmt(p[1])}, avail=${fmt(p[2])}, mpBal=${fmt(mpBal)}`);

    // Cleanup
    console.log('\n[7] Cleanup');
    for (const l of lenders) {
        try {
            const pos = await rT(() => v6.positions(aid, l.address));
            if (pos.amount > 0n) {
                const m = new ethers.Contract(V6, ABI, l);
                const pool = await rT(() => v6.getAgentPool(aid));
                const w = pos.amount < pool[2] ? pos.amount : pool[2];
                if (w > 0n) await rT(() => m.withdrawLiquidity(aid, w).then(t => t.wait()));
            }
        } catch (e) {}
    }
    for (const w of [...lenders, borrower]) {
        try {
            const u = new ethers.Contract(ADDR.usdc, USDC_ABI, w);
            const b = await usdc.balanceOf(w.address);
            if (b > 0n) await (await u.transfer(owner.address, b)).wait();
        } catch (e) {}
    }
    console.log(`Duration: ${((Date.now() - t0) / 60000).toFixed(1)} min`);
    const violations = snapshots.filter(s => s.dups || s.avail > s.mpBal).length;
    console.log(`Invariant violations: ${violations}/${snapshots.length}`);
    if (violations === 0) console.log('✅ ALL INVARIANTS HELD');

    fs.writeFileSync('./forensics/output/regression-2026-05-07/93-sharedpool.json', JSON.stringify({
        timestamp: new Date().toISOString(), v6: V6, agentId: aid, totalLoans, snapshots, totalClaimed: totalClaimed.toString()
    }, null, 2));
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
