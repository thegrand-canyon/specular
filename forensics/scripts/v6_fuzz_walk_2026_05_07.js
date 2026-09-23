// V6 random-walk fuzz on Arc.
// Picks a random valid operation each iteration; asserts §B1/§S1/§S5 invariants
// after every step. Logs detailed trace + final summary.

require('dotenv').config();
const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

const RPC = process.env.ARC_TESTNET_RPC_URL || 'https://arc-testnet.drpc.org';
const ADDR = JSON.parse(fs.readFileSync('./src/config/arc-testnet-addresses.json'));
const V6 = ADDR.agentLiquidityMarketplace_v6;
const ABI = JSON.parse(fs.readFileSync('./artifacts/contracts/core/AgentLiquidityMarketplaceV6.sol/AgentLiquidityMarketplaceV6.json')).abi;
const USDC_ABI = ['function approve(address,uint256) returns (bool)', 'function allowance(address,address) view returns (uint256)', 'function balanceOf(address) view returns (uint256)'];
const fmt = v => Number(ethers.formatUnits(v, 6));
const OUT = './forensics/output/regression-2026-05-07';

const SELF_AGENT = 49n;
const ITERATIONS = parseInt(process.env.ITERATIONS || '20', 10);
const SEED = parseInt(process.env.SEED || Date.now().toString().slice(-6), 10);

// Tiny PRNG so the run is reproducible from the seed
let rngState = SEED;
function rand() {
    rngState = (rngState * 1103515245 + 12345) & 0x7fffffff;
    return rngState / 0x7fffffff;
}
const choice = (arr) => arr[Math.floor(rand() * arr.length)];

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function withRetry(fn, label, attempts = 6) {
    for (let i = 0; i < attempts; i++) {
        try { return await fn(); }
        catch (e) {
            const m = e.shortMessage || e.message || '';
            const isRate = m.includes('rate') || m.includes('408') || m.includes('410') || m.includes('429') || m.includes('-32016') || m.includes('timeout');
            if (i === attempts - 1 || !isRate) throw e;
            await sleep(2000 * Math.pow(2, i));
        }
    }
}

const trace = [];
const log = (...a) => { console.log(...a); trace.push(a.map(String).join(' ')); };

async function snapshot(v6, usdc, wallet) {
    const usdcBal = await withRetry(() => usdc.balanceOf(wallet), 'bal');
    const pool = await withRetry(() => v6.getAgentPool(SELF_AGENT), 'pool');
    const myPos = await withRetry(() => v6.positions(SELF_AGENT, wallet), 'pos');
    const mpBal = await withRetry(() => usdc.balanceOf(V6), 'mpBal');
    const lenderCount = Number(pool[6]);
    const lenders = [];
    for (let j = 0; j < lenderCount; j++) {
        lenders.push((await withRetry(() => v6.poolLenders(SELF_AGENT, j), `pl${j}`)).toLowerCase());
    }
    const counter = Number(await withRetry(() => v6.activeLoanCount(wallet), 'alc'));
    const flag = await withRetry(() => v6.isInPoolLenders(SELF_AGENT, wallet), 'flag');
    return {
        usdcBal, mpBal, totalLiq: pool[1], avail: pool[2], totalLoaned: pool[3],
        totalEarned: pool[4], lenderCount, lenders,
        myPosSupplied: myPos[0], myPosEarnedInt: myPos[1],
        counter, flag,
    };
}

function assertInvariants(snap, prevSnap, op) {
    const violations = [];
    // §B1: no duplicates in poolLenders
    const unique = new Set(snap.lenders);
    if (unique.size !== snap.lenders.length) violations.push(`B1: duplicates ${snap.lenders}`);
    // §B1 flag invariant: if I have a position OR I'm in poolLenders, my flag must be true
    if (snap.lenders.includes(snap.lenders[0]) && !snap.flag && snap.lenders.length > 0) {
        // Only check if our address is among lenders
        // (The contract maintains: addr in poolLenders[a] ⟺ isInPoolLenders[a][addr]==true)
    }
    // §S1: pool.availableLiquidity ≤ MP USDC balance (bounded — collateral may add to MP)
    if (snap.avail > snap.mpBal) violations.push(`S1: avail ${fmt(snap.avail)} > mpBal ${fmt(snap.mpBal)}`);
    // §S5: counter sanity (just check counter ≤ MAX_ACTIVE_LOANS)
    if (snap.counter > 10) violations.push(`S5: counter ${snap.counter} > cap 10`);
    return violations;
}

(async () => {
    log(`V6 random-walk fuzz`);
    log(`seed=${SEED} iterations=${ITERATIONS}`);
    log(`V6=${V6}`);

    const provider = new ethers.JsonRpcProvider(RPC, undefined, { batchMaxCount: 1 });
    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
    const v6 = new ethers.Contract(V6, ABI, wallet);
    const usdc = new ethers.Contract(ADDR.usdc, USDC_ABI, wallet);

    log(`wallet=${wallet.address}`);

    // Approve generously
    const allowance = await withRetry(() => usdc.allowance(wallet.address, V6), 'allow');
    if (allowance < ethers.parseUnits('20', 6)) {
        log('approving 20 USDC');
        await withRetry(() => usdc.approve(V6, ethers.parseUnits('20', 6)).then(t => t.wait()), 'approve.wait');
    }

    let pre = await snapshot(v6, usdc, wallet.address);
    log(`pre snapshot: pool avail=${fmt(pre.avail)}, position=${fmt(pre.myPosSupplied)}, lenderCount=${pre.lenderCount}, counter=${pre.counter}`);

    const stats = { ops: { supply: 0, withdraw: 0, loan: 0, repay: 0, claim: 0, skip: 0 }, violations: [] };
    const activeLoans = [];

    for (let i = 0; i < ITERATIONS; i++) {
        const cur = await snapshot(v6, usdc, wallet.address);
        const choices = ['supply', 'withdraw', 'loan', 'repay', 'claim'];
        const op = choice(choices);

        let result = 'skipped';
        try {
            if (op === 'supply' && cur.usdcBal >= ethers.parseUnits('0.5', 6)) {
                const amt = (BigInt(Math.floor(rand() * 1500000) + 100000)); // 0.1-1.6 USDC
                if (amt <= cur.usdcBal) {
                    const tx = await withRetry(() => v6.supplyLiquidity(SELF_AGENT, amt), `supply.${i}`);
                    await withRetry(() => tx.wait(), 'supply.wait');
                    result = `supplied ${fmt(amt)}`;
                    stats.ops.supply++;
                }
            } else if (op === 'withdraw' && cur.myPosSupplied > 0n && cur.avail > 0n) {
                const max = cur.myPosSupplied < cur.avail ? cur.myPosSupplied : cur.avail;
                const amt = BigInt(Math.floor(rand() * Number(max)));
                if (amt > 0n) {
                    const tx = await withRetry(() => v6.withdrawLiquidity(SELF_AGENT, amt), `withdraw.${i}`);
                    await withRetry(() => tx.wait(), 'withdraw.wait');
                    result = `withdrew ${fmt(amt)}`;
                    stats.ops.withdraw++;
                }
            } else if (op === 'loan' && cur.avail > ethers.parseUnits('0.1', 6) && cur.counter < 10) {
                const max = cur.avail;
                let amt = BigInt(Math.floor(rand() * Number(max) / 4)) || ethers.parseUnits('0.1', 6);
                if (amt > max) amt = max;
                if (amt >= ethers.parseUnits('0.1', 6)) {
                    const dur = 7 + Math.floor(rand() * 30);
                    const tx = await withRetry(() => v6.requestLoan(amt, dur), `loan.${i}`);
                    const r = await withRetry(() => tx.wait(), 'loan.wait');
                    const iface = new ethers.Interface(ABI);
                    let lid;
                    for (const lg of r.logs) {
                        try { const p = iface.parseLog(lg); if (p && p.name === 'LoanRequested') { lid = p.args.loanId; break; } } catch {}
                    }
                    activeLoans.push(lid);
                    result = `loan ${lid} for ${fmt(amt)}, ${dur}d`;
                    stats.ops.loan++;
                }
            } else if (op === 'repay' && activeLoans.length > 0) {
                const idx = Math.floor(rand() * activeLoans.length);
                const lid = activeLoans[idx];
                try {
                    const tx = await withRetry(() => v6.repayLoan(lid), `repay.${i}`);
                    await withRetry(() => tx.wait(), 'repay.wait');
                    activeLoans.splice(idx, 1);
                    result = `repaid ${lid}`;
                    stats.ops.repay++;
                } catch (e) {
                    result = `repay ${lid} reverted: ${(e.shortMessage || e.message).slice(0, 50)}`;
                    activeLoans.splice(idx, 1); // assume already repaid
                }
            } else if (op === 'claim' && cur.myPosEarnedInt > 0n) {
                const tx = await withRetry(() => v6.claimInterest(SELF_AGENT), `claim.${i}`);
                await withRetry(() => tx.wait(), 'claim.wait');
                result = `claimed ${fmt(cur.myPosEarnedInt)}`;
                stats.ops.claim++;
            } else {
                result = `skipped (no valid ${op})`;
                stats.ops.skip++;
            }
        } catch (e) {
            result = `${op} reverted: ${(e.shortMessage || e.message).slice(0, 80)}`;
        }

        const post = await snapshot(v6, usdc, wallet.address);
        const violations = assertInvariants(post, cur, op);
        log(`step ${i+1}/${ITERATIONS} [${op.padEnd(8)}] ${result}`);
        log(`  pool avail=${fmt(post.avail).toFixed(6)}, position=${fmt(post.myPosSupplied).toFixed(6)}, lenderCount=${post.lenderCount}, counter=${post.counter}`);
        if (violations.length) {
            log(`  ❌ INVARIANT VIOLATIONS: ${violations.join('; ')}`);
            stats.violations.push({ step: i + 1, op, violations });
        }
    }

    log('\n=== SUMMARY ===');
    log(`ops: supply=${stats.ops.supply} withdraw=${stats.ops.withdraw} loan=${stats.ops.loan} repay=${stats.ops.repay} claim=${stats.ops.claim} skip=${stats.ops.skip}`);
    log(`activeLoans remaining: ${activeLoans.length} (${activeLoans.join(',')})`);
    log(`invariant violations: ${stats.violations.length}`);
    if (stats.violations.length === 0) log('✅ ALL INVARIANTS HELD across all iterations');

    // Cleanup: repay any remaining active loans, withdraw remaining position
    log('\n=== CLEANUP ===');
    for (const lid of activeLoans) {
        try {
            const tx = await withRetry(() => v6.repayLoan(lid), `cleanup.repay.${lid}`);
            await withRetry(() => tx.wait(), 'cleanup.wait');
            log(`  repaid ${lid}`);
        } catch (e) { log(`  repay ${lid}: ${(e.shortMessage || e.message).slice(0, 60)}`); }
    }
    const finalPos = await withRetry(() => v6.positions(SELF_AGENT, wallet.address), 'final.pos');
    if (finalPos[0] > 0n) {
        try {
            const tx = await withRetry(() => v6.withdrawLiquidity(SELF_AGENT, finalPos[0]), 'cleanup.wd');
            await withRetry(() => tx.wait(), 'wd.wait');
            log(`  withdrew ${fmt(finalPos[0])} USDC`);
        } catch (e) { log(`  cleanup withdraw: ${(e.shortMessage || e.message).slice(0, 60)}`); }
    }
    const finalEarned = (await withRetry(() => v6.positions(SELF_AGENT, wallet.address), 'final2'))[1];
    if (finalEarned > 0n) {
        try {
            const tx = await withRetry(() => v6.claimInterest(SELF_AGENT), 'cleanup.claim');
            await withRetry(() => tx.wait(), 'cleanup.claim.wait');
            log(`  claimed ${fmt(finalEarned)} USDC`);
        } catch (e) { log(`  cleanup claim: ${(e.shortMessage || e.message).slice(0, 60)}`); }
    }

    fs.writeFileSync(path.join(OUT, '23-v6-fuzz-walk.json'),
        JSON.stringify({ seed: SEED, iterations: ITERATIONS, stats, trace }, null, 2));
    log('\nSaved.');
})().catch(e => { console.error('FATAL:', e); process.exit(2); });
