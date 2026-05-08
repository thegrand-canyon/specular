// New scenarios beyond phases 1-14.
// Read-only on both networks (no broadcasts).
//
// A. Live §S5 gas measurement: estimateGas requestLoan for high-volume agents on Arc
// B. §S1 cumulative leak projection: simulate every claimInterest, project drain
// C. §B1 panic threshold confirmation via static-call repayLoan on Arc loans w/ interest
// D. Duration footgun verification (seconds vs days)
// E. Function selector intersection: Arc vs Base bytecode-derived selectors

require('dotenv').config();
const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

const ARC_RPC = process.env.ARC_TESTNET_RPC_URL || 'https://arc-testnet.drpc.org';
const BASE_RPC = process.env.BASE_RPC_URL || 'https://base.publicnode.com';
const ARC_ADDR = JSON.parse(fs.readFileSync('./src/config/arc-testnet-addresses.json'));
const BASE_ADDR = JSON.parse(fs.readFileSync('./src/config/base-addresses.json'));
const MP_ABI = JSON.parse(fs.readFileSync('./artifacts/contracts/core/AgentLiquidityMarketplace.sol/AgentLiquidityMarketplace.json')).abi;
const REG_ABI = JSON.parse(fs.readFileSync('./artifacts/contracts/core/AgentRegistryV2.sol/AgentRegistryV2.json')).abi;

const OUT_DIR = './forensics/output/regression-2026-05-07';
const fmt = (v) => Number(ethers.formatUnits(v, 6));

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function withRetry(fn, label, attempts = 5) {
    for (let i = 0; i < attempts; i++) {
        try { return await fn(); }
        catch (e) {
            const msg = (e.shortMessage || e.message || '');
            const isRate = msg.includes('rate') || msg.includes('408') || msg.includes('410') || msg.includes('429') || msg.includes('-32016') || msg.includes('timeout');
            if (i === attempts - 1 || !isRate) throw e;
            await sleep(2000 * Math.pow(2, i));
        }
    }
}

const out = { generatedAt: new Date().toISOString() };

(async () => {
    // ===================== A: §S5 live gas =====================
    console.log('\n===== A. §S5 LIVE GAS MEASUREMENT (Arc) =====');
    const arcProv = new ethers.JsonRpcProvider(ARC_RPC, undefined, { batchMaxCount: 1 });
    const arcMp = new ethers.Contract(ARC_ADDR.agentLiquidityMarketplace, MP_ABI, arcProv);

    // High-volume wallets from baseline (top 5)
    const HIGH_VOL = [
        { wallet: '0x656086A21073272533c8A3f56A94c1f3D8BCFcE2', label: 'agent 43 (777 loans)' },
        { wallet: '0x6df560f9DffB9bd97c4ac208ffa5a162d4c03035', label: 'agent ?? (279 loans)' },
        { wallet: '0xd0a1761bD207c12ef63253943417e64A78D3895A', label: 'agent ?? (268 loans)' },
        { wallet: '0xa0983956484d74af695aae4Fb5b1B90914415F37', label: 'agent ?? (268 loans)' },
        { wallet: '0xd673e66BF1C3bf696D88a147CFddc17Aab7C9F8a', label: 'agent ?? (140 loans)' },
    ];
    out.s5_liveGas = [];
    const LOAN_AMT = ethers.parseUnits('1', 6); // 1 USDC, must be ≤ pool.availableLiquidity
    const DUR_DAYS = 7;
    for (const { wallet, label } of HIGH_VOL) {
        try {
            const gas = await withRetry(() =>
                arcMp.requestLoan.estimateGas(LOAN_AMT, DUR_DAYS, { from: wallet }), 'estimateGas');
            out.s5_liveGas.push({ wallet, label, gas: gas.toString() });
            console.log(`  ${label}: ${gas.toString()} gas`);
        } catch (e) {
            const msg = (e.shortMessage || e.message).slice(0, 80);
            out.s5_liveGas.push({ wallet, label, error: msg });
            console.log(`  ${label}: estimate failed — ${msg}`);
        }
    }
    // DoS-threshold projection
    const arcGasLimit = 30_000_000;
    const top = out.s5_liveGas.find(r => r.gas);
    if (top) {
        const remainingHeadroom = arcGasLimit - Number(top.gas);
        const perLoan = 4600;
        const remainingLoans = Math.floor(remainingHeadroom / perLoan);
        out.s5_dosProjection = {
            currentGas: top.gas, gasLimit: arcGasLimit,
            remainingLoansToDoS: remainingLoans,
        };
        console.log(`  → top agent has ${remainingHeadroom} gas headroom = ${remainingLoans} more loans before DoS`);
    }

    // ===================== B: §S1 cumulative drain projection =====================
    console.log('\n===== B. §S1 CUMULATIVE LEAK PROJECTION (Arc) =====');
    const totalPools = Number(await withRetry(() => arcMp.totalPools(), 'totalPools'));
    let totalUnclaimed = 0n;
    let lendersExposed = [];
    for (let i = 0; i < totalPools; i++) {
        try {
            const aid = await withRetry(() => arcMp.agentPoolIds(i), `agentPoolIds[${i}]`);
            const v = await withRetry(() => arcMp.getAgentPool(aid), `getAgentPool[${aid}]`);
            const lenderCount = Number(v[6]);
            for (let j = 0; j < lenderCount; j++) {
                const lender = await withRetry(() => arcMp.poolLenders(aid, j), `poolLenders[${aid}][${j}]`);
                const pos = await withRetry(() => arcMp.positions(aid, lender), `positions[${aid}][${lender}]`);
                if (pos[1] > 0n) {
                    totalUnclaimed += pos[1];
                    lendersExposed.push({ agentId: aid.toString(), lender, earnedInt: fmt(pos[1]) });
                }
            }
        } catch (e) { /* skip */ }
    }
    out.s1_projection = {
        totalUnclaimedUsdc: fmt(totalUnclaimed),
        lenderCount: lendersExposed.length,
        topLenders: lendersExposed.sort((a, b) => b.earnedInt - a.earnedInt).slice(0, 10),
    };
    console.log(`  Σ unclaimed interest: ${fmt(totalUnclaimed).toFixed(6)} USDC across ${lendersExposed.length} lenders`);
    console.log(`  if all claimInterest: pool.availableLiquidity overstated by ${fmt(totalUnclaimed).toFixed(6)} USDC`);
    console.log(`  Top 5 by exposure:`);
    for (const l of out.s1_projection.topLenders.slice(0, 5)) {
        console.log(`    pool ${l.agentId} / ${l.lender.slice(0,10)}... → ${l.earnedInt.toFixed(6)} USDC`);
    }

    // ===================== C: §B1 panic-threshold confirmation =====================
    console.log('\n===== C. §B1 PANIC EVIDENCE — Base loans 2/3/4 already proven =====');
    out.b1_evidence = {
        base: { loans: [2, 3, 4], result: 'Panic(0x11) on staticCall — captured in 10-base-e2e-safe.json' },
        arc: { note: 'arc agent 43 pool has duplicate; no live active loans with interest currently to staticCall' },
    };

    // ===================== D: duration footgun verification =====================
    console.log('\n===== D. DURATION FOOTGUN VERIFICATION (Arc) =====');
    const SECURE = '0x800e305A0caDdE6289dFDFEDF38218f45C06F72C';
    out.duration_footgun = [];
    for (const dur of [7, 6, 366, 604800, 86400, 30]) {
        try {
            await withRetry(() =>
                arcMp.requestLoan.staticCall(ethers.parseUnits('0.5', 6), dur, { from: SECURE }), `dur=${dur}`);
            out.duration_footgun.push({ durationDays: dur, result: 'would_succeed' });
            console.log(`  durationDays=${dur}: would succeed`);
        } catch (e) {
            const msg = (e.shortMessage || e.message).slice(0, 100);
            out.duration_footgun.push({ durationDays: dur, result: 'revert', message: msg });
            console.log(`  durationDays=${dur}: revert — ${msg}`);
        }
    }

    // ===================== E: function selector diff =====================
    console.log('\n===== E. FUNCTION SELECTOR DIFF (Arc vs Base bytecode) =====');
    const arcCode = await withRetry(() => arcProv.getCode(ARC_ADDR.agentLiquidityMarketplace), 'arc.code');
    const baseProv = new ethers.JsonRpcProvider(BASE_RPC);
    const baseCode = await withRetry(() => baseProv.getCode(BASE_ADDR.agentLiquidityMarketplace), 'base.code');
    // Extract 4-byte selectors that appear in PUSH4 form (0x63XXXXXXXX) — heuristic
    const selectorsFromCode = (code) => {
        const out = new Set();
        const re = /63([0-9a-f]{8})/g;
        let m;
        while ((m = re.exec(code)) !== null) out.add('0x' + m[1]);
        return out;
    };
    const arcSels = selectorsFromCode(arcCode);
    const baseSels = selectorsFromCode(baseCode);
    const onlyArc = [...arcSels].filter(s => !baseSels.has(s));
    const onlyBase = [...baseSels].filter(s => !arcSels.has(s));
    out.selector_diff = {
        arcCount: arcSels.size, baseCount: baseSels.size,
        intersection: [...arcSels].filter(s => baseSels.has(s)).length,
        onlyArc, onlyBase,
        bytecodeKeccakArc: ethers.keccak256(arcCode),
        bytecodeKeccakBase: ethers.keccak256(baseCode),
    };
    console.log(`  Arc PUSH4 selectors: ${arcSels.size}, Base: ${baseSels.size}`);
    console.log(`  Intersection: ${out.selector_diff.intersection}`);
    console.log(`  Only-Arc selectors (${onlyArc.length}):`, onlyArc.slice(0, 8));
    console.log(`  Only-Base selectors (${onlyBase.length}):`, onlyBase.slice(0, 8));
    // Map onlyArc/onlyBase against ABI to identify named functions
    const ifaceFns = MP_ABI.filter(f => f.type === 'function');
    const sigToName = {};
    for (const f of ifaceFns) {
        const sig = f.name + '(' + f.inputs.map(i => i.type).join(',') + ')';
        sigToName[ethers.id(sig).slice(0, 10)] = f.name;
    }
    out.selector_diff.onlyArc_named = onlyArc.filter(s => sigToName[s]).map(s => `${s}=${sigToName[s]}`);
    out.selector_diff.onlyBase_named = onlyBase.filter(s => sigToName[s]).map(s => `${s}=${sigToName[s]}`);
    console.log(`  Only-Arc named:  ${out.selector_diff.onlyArc_named.join(', ') || '(none in ABI)'}`);
    console.log(`  Only-Base named: ${out.selector_diff.onlyBase_named.join(', ') || '(none in ABI)'}`);

    fs.writeFileSync(path.join(OUT_DIR, '11-new-scenarios.json'), JSON.stringify(out, null, 2));
    console.log(`\nSaved: ${OUT_DIR}/11-new-scenarios.json`);
})().catch(e => { console.error('FATAL:', e); process.exit(2); });
