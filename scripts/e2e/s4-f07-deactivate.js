/**
 * S4 — F-07: registry deactivation is a marketplace kill switch for NEW credit only.
 *
 *  L2 supplies to B's pool; B borrows; owner deactivateAgent(B); B's requestLoan reverts
 *  "Agent deactivated"; B can still repay; L2 can still withdraw; owner reactivateAgent(B);
 *  B can borrow again. A fresh agent D: register → deactivate → createAgentPool reverts
 *  "Agent deactivated" → reactivate → pool created.
 */
const L = require('./_lib');
const { SpecularQuickstart } = require('../../src/sdk/SpecularQuickstart');
const { USDC, fmt } = L;
const S = 'S4';

async function main() {
    await L.assertStaging();
    const R = new L.Results(S);
    const { mp, reg, usdc } = L.contracts();
    const mpAddr = L.cfg.agentLiquidityMarketplace_v6;
    const B = L.roleWallet('B'), L2 = L.roleWallet('L2'), D = L.roleWallet('D');
    for (const w of [B, L2, D]) await L.fundNative(w, '1.0', S);
    if ((await usdc.balanceOf(B.address)) < USDC(30)) await L.mintUsdc(B.address, 50, S);
    if ((await usdc.balanceOf(L2.address)) < USDC(30)) await L.mintUsdc(L2.address, 50, S);
    const cB = L.contracts(B), cOwner = L.contracts(L.deployer), cD = L.contracts(D);
    const sdkB = new SpecularQuickstart(B, 'arc-staging');
    const bId = (await sdkB.onboard('ipfs://e2e-B')).agentId;
    R.check('B active at start', (await reg.isAgentActive(B.address)) === true);

    let reactivated = true;
    try {
        if ((await mp.positions(bId, L2.address)).amount < USDC(20)) {
            const h = await new SpecularQuickstart(L2, 'arc-staging').supply(bId, 20);
            L.logTx(S, 'L2 supply 20 to B pool', await L.provider.getTransactionReceipt(h));
        }
        const { loanId: l1, tx: b1 } = await sdkB.borrow(10, 7);
        L.logTx(S, `B borrow 10 (loan ${l1})`, await L.provider.getTransactionReceipt(b1));
        R.check('B loan ACTIVE while active', Number((await mp.loans(l1)).state) === 1);

        await L.send(S, 'owner deactivateAgent(B)', cOwner.reg.deactivateAgent(bId));
        reactivated = false;
        R.check('registry isAgentActive(B) == false', (await reg.isAgentActive(B.address)) === false);
        await L.approve(B, USDC(5), S, 'B approve collateral (probe)');
        const rv = await L.expectRevert(cB.mp.requestLoan(USDC(5), 7), 'Agent deactivated');
        R.check('B requestLoan reverts "Agent deactivated"', rv.reverted && rv.matched, rv.message.slice(0, 90));
        let sdkErr = null; try { await sdkB.borrow(5, 7); } catch (e) { sdkErr = e.message || ''; }
        R.check('SDK borrow surfaces the same revert', /Agent deactivated/.test(sdkErr || ''));

        // repay while deactivated
        const pv = await mp.previewRepayment(l1);
        const rp = await sdkB.repay(l1);
        L.logTx(S, `B repay loan ${l1} while deactivated`, await L.provider.getTransactionReceipt(rp));
        R.check('B repaid while deactivated (closing path live)', Number((await mp.loans(l1)).state) === 2, `paid ${fmt(pv.total)}`);
        // lender exit while deactivated
        const l2Bal0 = await usdc.balanceOf(L2.address);
        const wd = await new SpecularQuickstart(L2, 'arc-staging').withdraw(bId, 5);
        L.logTx(S, 'L2 withdraw 5 from B pool while deactivated', await L.provider.getTransactionReceipt(wd));
        R.check('L2 withdrew 5 while agent deactivated', (await usdc.balanceOf(L2.address)) - l2Bal0 === USDC(5));
        const earned = (await mp.positions(bId, L2.address)).earnedInterest;
        if (earned > 0n) {
            const cl = await new SpecularQuickstart(L2, 'arc-staging').claim(bId);
            L.logTx(S, 'L2 claim from B pool while deactivated', await L.provider.getTransactionReceipt(cl));
            R.check('L2 claimed interest while agent deactivated', (await mp.positions(bId, L2.address)).earnedInterest === 0n, `${earned}`);
        }
        // supply into a deactivated agent's pool is NOT gated (documented design)
        // probe from the deployer (has USDC); approve first so the only possible gate is the agent's status
        await L.approve(L.deployer, USDC(1), S, 'deployer approve (probe)');
        let supplyMsg; try { await cOwner.mp.supplyLiquidity.staticCall(bId, USDC(1)); supplyMsg = 'allowed'; } catch (e) { supplyMsg = 'reverts: ' + (e.reason || e.shortMessage || e.message).slice(0, 80); }
        R.note('supplyLiquidity into deactivated agent pool (staticCall, existing pool)', supplyMsg + (supplyMsg === 'allowed' ? ' (per FIX_NOTES design: lenders\' choice; agent cannot borrow it)' : ''));
        await L.send(S, 'deployer revoke approval', cOwner.usdc.approve(mpAddr, 0n));

        await L.send(S, 'owner reactivateAgent(B)', cOwner.reg.reactivateAgent(bId));
        reactivated = true;
        R.check('registry isAgentActive(B) == true', (await reg.isAgentActive(B.address)) === true);
        const { loanId: l2, tx: b2 } = await sdkB.borrow(5, 7);
        L.logTx(S, `B borrow 5 after reactivation (loan ${l2})`, await L.provider.getTransactionReceipt(b2));
        R.check('B can borrow again after reactivation', Number((await mp.loans(l2)).state) === 1);
        const rp2 = await sdkB.repay(l2);
        L.logTx(S, `B repay loan ${l2}`, await L.provider.getTransactionReceipt(rp2));
        R.check('cleanup: loan repaid', Number((await mp.loans(l2)).state) === 2);
        await L.send(S, 'B revoke leftover approval', cB.usdc.approve(mpAddr, 0n));

        // fresh agent D: createAgentPool gated
        let dId = Number(await reg.addressToAgentId(D.address));
        if (dId === 0) { await L.send(S, 'D register', cD.reg.register('ipfs://e2e-D', [])); dId = Number(await reg.addressToAgentId(D.address)); }
        if ((await mp.agentPools(dId)).isActive) {
            R.note('D pool already exists (re-run) — createAgentPool gate not re-testable', `agentId ${dId}`);
        } else {
            await L.send(S, 'owner deactivateAgent(D)', cOwner.reg.deactivateAgent(dId));
            const rvD = await L.expectRevert(cD.mp.createAgentPool(), 'Agent deactivated');
            R.check('D createAgentPool reverts "Agent deactivated"', rvD.reverted && rvD.matched, rvD.message.slice(0, 90));
            await L.send(S, 'owner reactivateAgent(D)', cOwner.reg.reactivateAgent(dId));
            await L.send(S, 'D createAgentPool', cD.mp.createAgentPool());
            R.check('D pool created after reactivation', (await mp.agentPools(dId)).isActive);
        }
        const g = await L.globalSolvency();
        R.check('GLOBAL solvency exact', g.exact, `surplus ${g.surplus}`);
    } finally {
        if (!reactivated) await L.send(S, 'owner reactivateAgent(B) [finally]', cOwner.reg.reactivateAgent(bId));
    }
    R.finish({ agentId: bId });
}
main().catch((e) => { console.error(e); process.exit(1); });
