/**
 * S8 — Reputation progression under the D1 rate limit (staging levers read live).
 *
 * The M-2 lever (minHoldForReputationReward = 86400 s) makes an in-session on-time
 * bonus impossible, so the OWNER temporarily sets minHold = 0 for this scenario and
 * restores it at the end (verified). With that, agent A runs N = (limit/10)+1
 * on-time 7-day loans of ≥ bonusReferenceAmount in one window and the score must rise
 * by exactly min(10×n, limit) per loan and stop at the limit. Collateral tier is read
 * before/after (it cannot change within one window at 20 pts/day; see report).
 *
 * Optional stretch (env S8_TIER_WALK=1): the owner also lifts the rate limit (0 =
 * unlimited) so A can be walked across the tier boundaries 200/400/500/600 and the
 * tier-derived collateral/APR/limit are asserted at each crossing; levers restored after.
 */
const L = require('./_lib');
const { SpecularQuickstart } = require('../../src/sdk/SpecularQuickstart');
const { USDC, fmt } = L;
const S = 'S8';

async function main() {
    await L.assertStaging();
    const R = new L.Results(S);
    const { mp, rep, usdc } = L.contracts();
    const cOwner = L.contracts(L.deployer);
    const A = L.roleWallet('A');
    await L.fundNative(A, process.env.S8_TIER_WALK === '1' ? '5.0' : '2.0', S);
    const sdkA = new SpecularQuickstart(A, 'arc-staging');
    const aId = (await sdkA.onboard()).agentId;

    const limit = await rep.maxReputationGainPerWindow();
    const window = await rep.reputationGainWindow();
    const bonus = await rep.onTimeRepaymentBonus();
    const ref = await rep.bonusReferenceAmount();
    const minHold0 = await mp.minHoldForReputationReward();
    R.note('levers', `maxReputationGainPerWindow=${limit} reputationGainWindow=${window}s onTimeRepaymentBonus=${bonus} bonusReferenceAmount=${fmt(ref)} USDC minHold=${minHold0}s`);
    const per = Number(bonus), lim = Number(limit);
    const loanAmt = Number(fmt(ref)); // ≥ reference → full bonus

    // pool must have ≥ loanAmt available; A needs collateral (100%) + interest
    if ((await mp.agentPools(aId)).availableLiquidity < USDC(loanAmt)) throw new Error('A pool needs ≥ ref USDC available (run S1/S2)');
    if ((await usdc.balanceOf(A.address)) < USDC(loanAmt + 10)) await L.mintUsdc(A.address, loanAmt + 50, S);

    // window state: if a window is mid-flight with gains, wait/skip
    const ws = await rep.windowStart(aId), gained = await rep.gainedInWindow(aId);
    const now = BigInt((await L.provider.getBlock('latest')).timestamp);
    const windowFresh = now >= ws + window;
    const budget = windowFresh ? lim : Math.max(0, lim - Number(gained));
    R.note('window state', `windowStart=${ws} gainedInWindow=${gained} fresh=${windowFresh} budget=${budget}`);

    let restored = true;
    try {
        await L.send(S, 'owner setMinHoldForReputationReward(0) [temporary]', cOwner.mp.setMinHoldForReputationReward(0));
        restored = false;
        const s0 = Number(await rep['getReputationScore(uint256)'](aId));
        const c0 = await sdkA.creditInfo();
        R.note('A start', `score ${s0} collateral ${c0.collateralPct}% APR ${c0.interestRateBps}bps limit ${c0.creditLimit}`);
        const n = Math.floor(budget / per) + 1; // one more than the budget allows → must be clamped
        let expected = s0, gainedSoFar = Number(windowFresh ? 0 : gained);
        const cycles = [];
        for (let i = 0; i < n; i++) {
            const before = Number(await rep['getReputationScore(uint256)'](aId));
            const { loanId, tx } = await sdkA.borrow(loanAmt, 7);
            L.logTx(S, `A borrow ${loanAmt} (loan ${loanId}) cycle ${i + 1}/${n}`, await L.provider.getTransactionReceipt(tx));
            const rp = await sdkA.repay(loanId);
            const rc = await L.provider.getTransactionReceipt(rp);
            L.logTx(S, `A repay loan ${loanId}`, rc);
            const after = Number(await rep['getReputationScore(uint256)'](aId));
            const expGain = Math.min(per, Math.max(0, lim - gainedSoFar));
            gainedSoFar += expGain; expected += expGain;
            const ru = rc.logs.map(lg => { try { return rep.interface.parseLog(lg); } catch (e) { return null; } }).find(p => p && p.name === 'ReputationUpdated');
            cycles.push({ loanId, before, after, expGain, gainedInWindow: Number(await rep.gainedInWindow(aId)) });
            R.check(`cycle ${i + 1}: score ${before} → ${after} (expected +${expGain})`, after === before + expGain && after === expected, ru ? `ReputationUpdated ${ru.args.oldScore}→${ru.args.newScore}` : 'no ReputationUpdated (clamped to 0)');
        }
        R.check(`score stopped exactly at the window limit (gainedInWindow == ${lim})`, Number(await rep.gainedInWindow(aId)) === lim);
        const c1 = await sdkA.creditInfo();
        const sc = Number(await rep['getReputationScore(uint256)'](aId));
        const tier = (s) => s >= 800 ? { coll: 0, apr: 500, lim: '50000.0' } : s >= 600 ? { coll: 0, apr: 700, lim: '25000.0' } : s >= 500 ? { coll: 25, apr: 1000, lim: '10000.0' } : s >= 400 ? { coll: 100, apr: 1000, lim: '10000.0' } : s >= 200 ? { coll: 100, apr: 1500, lim: '5000.0' } : { coll: 100, apr: 1500, lim: '1000.0' };
        const t = tier(sc);
        R.check(`tier-derived terms at score ${sc}: collateral ${t.coll}% APR ${t.apr} limit ${t.lim}`, c1.collateralPct === t.coll && c1.interestRateBps === t.apr && c1.creditLimit === t.lim, JSON.stringify(c1));
        if (tier(s0).coll === t.coll) R.note('collateral tier crossing', `not reachable in one window (score ${s0}→${sc}, next boundary needs ≥ 200/500 → ${Math.ceil((200 - sc) / lim)}+ days at ${lim}/day)`);

        // ---------- optional tier walk ----------
        if (process.env.S8_TIER_WALK === '1') {
            const target = Number(process.env.S8_TIER_TARGET || 600);
            await L.send(S, 'owner setReputationRateLimit(0, window) [temporary: unlimited]', cOwner.rep.setReputationRateLimit(0, window));
            const walk = [];
            let cur = Number(await rep['getReputationScore(uint256)'](aId));
            const boundaries = [200, 400, 500, 600, 800].filter(b => b > cur && b <= target);
            while (cur < target) {
                const ci = await sdkA.creditInfo();
                // keep the pool solvent: at 0% collateral the pool lends its own liquidity; at 100% A posts collateral
                const { loanId, tx } = await sdkA.borrow(loanAmt, 7);
                const rp = await sdkA.repay(loanId);
                const after = Number(await rep['getReputationScore(uint256)'](aId));
                if (after !== cur + per) { R.check(`tier walk: +${per} per cycle at score ${cur}`, false, `got ${after}`); break; }
                cur = after;
                if (boundaries.includes(cur)) {
                    const cj = await sdkA.creditInfo();
                    const tt = tier(cur);
                    walk.push({ score: cur, ...cj, borrowTx: tx, repayTx: rp });
                    R.check(`tier walk: crossing ${cur} → collateral ${tt.coll}% APR ${tt.apr} limit ${tt.lim}`, cj.collateralPct === tt.coll && cj.interestRateBps === tt.apr && cj.creditLimit === tt.lim, JSON.stringify(cj));
                    const cjPrev = tier(cur - per);
                    if (cjPrev.coll !== tt.coll) R.check(`tier walk: collateral requirement CHANGED at ${cur} (${cjPrev.coll}% → ${tt.coll}%)`, ci.collateralPct === cjPrev.coll && cj.collateralPct === tt.coll);
                }
                if (walk.length && cur % 100 === 0) console.log(`  … score ${cur}`);
            }
            // verify a real loan at the new tier posts the tier's collateral
            const { loanId: lz, tx: tz } = await sdkA.borrow(loanAmt, 7);
            const lnz = await mp.loans(lz);
            const tt = tier(cur);
            R.check(`loan at score ${cur}: collateralAmount == ${tt.coll}% of principal, rate ${tt.apr}`, lnz.collateralAmount === (USDC(loanAmt) * BigInt(tt.coll)) / 100n && Number(lnz.interestRate) === tt.apr, `collateral ${fmt(lnz.collateralAmount)} tx ${tz}`);
            await sdkA.repay(lz);
            await L.send(S, `owner setReputationRateLimit(${lim}, ${window}) [restore]`, cOwner.rep.setReputationRateLimit(lim, window));
            R.check('rate limit lever restored', (await rep.maxReputationGainPerWindow()) === limit && (await rep.reputationGainWindow()) === window);
            R.finish({ agentId: aId, cycles, walk, finalScore: cur });
            return;
        }
        R.finish({ agentId: aId, cycles, finalScore: sc });
    } finally {
        if (!restored) {
            await L.send(S, `owner setMinHoldForReputationReward(${minHold0}) [restore]`, cOwner.mp.setMinHoldForReputationReward(minHold0));
            const mh = await mp.minHoldForReputationReward();
            console.log(`  minHold restored: ${mh} (expected ${minHold0}) ${mh === minHold0 ? 'OK' : 'MISMATCH'}`);
            if ((await rep.maxReputationGainPerWindow()) !== limit) {
                await L.send(S, 'owner setReputationRateLimit restore [finally]', cOwner.rep.setReputationRateLimit(lim, window));
            }
        }
    }
}
main().catch((e) => { console.error(e); process.exit(1); });
