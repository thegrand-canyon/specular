/**
 * V6 — the pool creator's own stake is EXEMPT from `minSupplyAmount`.
 *
 * ON-CHAIN (arc-staging), live lever `minSupplyAmount = 10 USDC`.
 *   - the creator can seed its own pool BELOW the minimum (that slot is locked
 *     first-loss capital, and M2-c can legitimately require less than 10 USDC)
 *   - a third party opening a NEW slot in the same pool cannot
 *   - once a third party holds a position it may top up by any amount (F-C only
 *     gates a new slot)
 *   - the exemption is scoped to the creator's OWN pool
 */
const L = require('./_lib');
const { USDC, fmt } = L;
const S = 'v6-minsupply-creator-exempt';

async function main() {
    await L.assertStaging();
    const R = new L.Results(S, 'creator exemption from minSupplyAmount (on-chain)');
    const { mp, reg } = L.contracts();

    // The scenario turns on a creator opening a NEW lender slot in its own pool, and on
    // a third party being refused a new slot in that same pool. A lender slot is never
    // un-claimed on chain, so both preconditions are one-shot: allocate a VIRGIN
    // creator each run (its pool is then new, which makes any third party new in it
    // too, and makes the "not exempt in a foreign pool" leg honest as well).
    const { wallet: C, role: cRole } = await L.freshRoleWallet('V6CREATOR', async (w) => {
        const id = await reg.addressToAgentId(w.address);
        if (id === 0n) return true;
        return (await mp.positions(id, w.address)).amount === 0n && !(await mp.isInPoolLenders(id, w.address));
    });
    const T2 = L.roleWallet('T2'), A = L.roleWallet('A');
    const mpC = L.contracts(C).mp, mpT2 = L.contracts(T2).mp;

    const minSupply = await mp.minSupplyAmount();
    R.check('live lever minSupplyAmount == 10 USDC', minSupply === USDC(10), fmt(minSupply));

    await L.fundNative(C, '0.4', S);
    await L.ensureUsdc(C, 40, 120, S);
    await L.approveMax(C, 100000, S, `${cRole} approve`);
    await L.ensureUsdc(T2, 30, 120, S);
    await L.approveMax(T2, 100000, S, 'T2 approve');
    const cId = await L.ensureAgent(C, S, cRole);
    const aId = Number(await reg.addressToAgentId(A.address));
    R.note('agents', `creator ${cRole} = #${cId} (${C.address}), third party T2 = ${T2.address}, foreign pool A = #${aId}`);

    const cPos = (await mp.positions(cId, C.address)).amount;
    R.check('precondition: creator has no position yet in its own pool (a NEW slot)', cPos === 0n, fmt(cPos));

    // ------------------------------------------------- creator seeds below the minimum
    const SEED = USDC(5);
    R.check('the seed is genuinely below the minimum', SEED < minSupply, `${fmt(SEED)} < ${fmt(minSupply)}`);
    R.tx('creator seed below minSupply', await L.send(S, `C supply ${fmt(SEED)} USDC into its OWN pool #${cId}`, mpC.supplyLiquidity(cId, SEED)));
    const ss = await mp.selfStake(cId);
    R.check('creator CAN seed below minSupplyAmount, and it registers as the self-stake',
        ss.amount === SEED && ss.locked === false, `selfStake ${fmt(ss.amount)}`);

    // ------------------------------------------------- a third party cannot
    const rvT2 = await L.expectRevert(mpT2.supplyLiquidity(cId, SEED), 'Below minimum supply');
    R.check('a THIRD PARTY opening a new slot with the same 5 USDC REVERTS "Below minimum supply"', rvT2.reverted && rvT2.matched, rvT2.message.slice(0, 130));
    R.check('the refused supply created no position', (await mp.positions(cId, T2.address)).amount === 0n);

    R.tx('third party at the minimum', await L.send(S, `T2 supply ${fmt(minSupply)} USDC (exactly the minimum)`, mpT2.supplyLiquidity(cId, minSupply)));
    R.check('the third party succeeds at exactly minSupplyAmount', (await mp.positions(cId, T2.address)).amount === minSupply, fmt(minSupply));

    R.tx('third-party top-up below minimum', await L.send(S, 'T2 top up 1 USDC (existing slot, F-C gates only NEW slots)', mpT2.supplyLiquidity(cId, USDC(1))));
    R.check('an EXISTING third-party lender may top up below the minimum', (await mp.positions(cId, T2.address)).amount === minSupply + USDC(1), fmt(await (async () => (await mp.positions(cId, T2.address)).amount)()));

    // ------------------------------------------------- the creator may also top up small
    R.tx('creator top-up below minimum', await L.send(S, 'C top up 2 USDC into its own pool', mpC.supplyLiquidity(cId, USDC(2))));
    R.check('creator may keep topping its stake below the minimum', (await mp.selfStake(cId)).amount === SEED + USDC(2), fmt((await mp.selfStake(cId)).amount));

    // ------------------------------------------------- the exemption is pool-scoped
    const rvForeign = await L.expectRevert(mpC.supplyLiquidity(aId, SEED), 'Below minimum supply');
    R.check('C is NOT exempt in a pool it does not own (agent A\'s pool) — "Below minimum supply"', rvForeign.reverted && rvForeign.matched, rvForeign.message.slice(0, 130));

    const cons = await L.poolConservation(cId);
    R.check('per-pool conservation exact', cons.conserved, `avail ${fmt(cons.availableLiquidity)} Σamt ${fmt(cons.sumAmt)}`);

    R.finish({ agentId: cId, minSupplyAmount: minSupply.toString(), creatorSeed: SEED.toString() });
}
main().catch(e => { console.error(e); process.exit(1); });
