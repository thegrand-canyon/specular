// SCENARIO 1 — the money doesn't add up.
//
// Two DIFFERENT incidents hide behind the same alert codes, and the existing
// runbook treats them as one. This drill separates them:
//
//   1A  PHANTOM LIQUIDITY — the books claim more than they should, the USDC is
//       all still there. (The §S1 bug shape; V6.2 cannot produce it, so it is
//       engineered with a storage poke, slot-verified first.)
//   1B  REAL SHORTFALL — the books are right, the USDC has LEFT the contract.
//       Modelled by impersonating the marketplace and moving USDC out, i.e.
//       exactly what any future token-path bug or hostile withdrawal looks like.
//
// For each: does the monitor catch it, what levers exist, and can lenders be made
// whole? Every candidate remedy is actually executed and measured.
//
// Usage: npx hardhat run --network localhost scripts/incident-drill/s1-insolvency.js

const { ethers } = require('hardhat');
const L = require('./lib');
const S = require('../op-resilience/storage');
const { USDC, u, DAY, advance, attempt } = L;

async function main() {
    const a = L.addr();
    const signers = await ethers.getSigners();
    const owner = signers[0];
    const agentG = signers[6];
    const lenderP = signers[7];
    const lenderQ = signers[8];
    const sink = signers[19];

    const v6 = await ethers.getContractAt('AgentLiquidityMarketplaceV62', a.agentLiquidityMarketplace_v6);
    const rep = await ethers.getContractAt('ReputationManagerV4', a.reputationManagerV4);
    const reg = await ethers.getContractAt('AgentRegistryV2', a.agentRegistryV2);
    const usdc = await ethers.getContractAt('MockUSDC', a.usdc);
    const V6ADDR = a.agentLiquidityMarketplace_v6;

    const outer = await L.snap();

    for (const w of [agentG, lenderP, lenderQ]) {
        await (await usdc.mint(w.address, USDC(100000))).wait();
        await (await usdc.connect(w).approve(V6ADDR, ethers.MaxUint256)).wait();
    }
    await (await reg.connect(agentG).register('ipfs://g', [])).wait();
    const idG = await reg.addressToAgentId(agentG.address);
    await (await rep.connect(agentG)['initializeReputation()']()).wait();
    await (await v6.connect(agentG).createAgentPool()).wait();
    await (await v6.connect(lenderP).supplyLiquidity(idG, USDC(1000))).wait();
    await (await v6.connect(lenderQ).supplyLiquidity(idG, USDC(1000))).wait();
    await (await v6.connect(agentG).requestLoan(USDC(100), 7)).wait();   // one ACTIVE, 100 % collateral
    const base = await L.snap();

    // Prove the slot map before poking anything.
    const slotCheck = await S.verifySlots(v6, idG, lenderP.address);
    const poolBaseSlot = BigInt(S.mapSlot(idG, S.SLOT.agentPools));
    const AVAIL_SLOT = poolBaseSlot + 3n;

    const out = { scenario: 'S1 — insolvency / phantom liquidity', slotMapVerified: slotCheck.length, cases: {} };

    // ================================================================ 1A phantom
    // NOTE on snapshots: hardhat CONSUMES a snapshot id when you revert to it, and
    // invalidates every id taken after it. Each case therefore takes its own id and
    // re-takes one immediately after reverting.
    {
        const caseSnap = await L.snap();
        const before = await L.poolSnapshot(v6, idG);
        const bal0 = await usdc.balanceOf(V6ADDR);
        const inflate = USDC(500);
        await S.setStorage(V6ADDR, AVAIL_SLOT, before.availableLiquidity + inflate);

        L.clearAlerts();
        const det = L.runMonitor();
        const alerts = L.alertState();

        // Candidate remedy 1: resetPoolAccounting — the emergency repair tool.
        const fixSnap = await L.snap();
        const fix = await attempt('resetPoolAccounting', () => v6.connect(owner).resetPoolAccounting(idG));
        const afterFix = await L.poolSnapshot(v6, idG);
        const postFix = L.runMonitor();
        // Can lenders actually get their money out afterwards?
        const exitP = await attempt('lenderP full exit', async () => {
            const p = (await v6.positions(idG, lenderP.address)).amount;
            return v6.connect(lenderP).withdrawLiquidity(idG, p);
        });
        await L.revert(fixSnap);

        out.cases['1A_phantom_liquidity'] = {
            engineered: `pool.availableLiquidity inflated by ${u(inflate)} USDC (books wrong, USDC intact)`,
            usdcBalanceUnchanged: u(bal0) === u(await usdc.balanceOf(V6ADDR)),
            detection: {
                exitCode: det.exitCode, codes: det.codes, criticals: det.criticals,
                monitorRuntimeMs: det.ms, alertLatched: alerts.latchExists,
                alertSeverity: alerts.latch ? alerts.latch.severity : null,
            },
            remedy_resetPoolAccounting: {
                worked: fix.ok, revert: fix.revert,
                availableLiquidityBefore: u(before.availableLiquidity),
                availableLiquidityAfter: u(afterFix.availableLiquidity),
                restoredExactly: afterFix.availableLiquidity === before.availableLiquidity,
                monitorAfter: { exitCode: postFix.exitCode, codes: postFix.codes },
                lenderCanStillExit: exitP.ok,
            },
            verdict: 'RECOVERABLE. The USDC never left; resetPoolAccounting rebuilds availableLiquidity from Σ positions + Σ unclaimed interest − totalLoaned and the monitor goes clean. Lenders lose nothing.',
        };
        await L.revert(caseSnap);
    }

    // ============================================================= 1B real shortfall
    {
        const caseSnap = await L.snap();
        const before = await L.poolSnapshot(v6, idG);
        const bal0 = await usdc.balanceOf(V6ADDR);

        // The USDC leaves. Books untouched. This is what a token-path bug, a
        // malicious upgrade of the token, or a hostile withdrawal all look like.
        // Leave exactly 1,000 USDC in the contract. Pool G's two lenders claim 1,000
        // each, so the first exit clears and the second finds an empty pot — the
        // race, made visible. Note the marketplace is ONE USDC pot shared by every
        // pool: pool G's lenders are paid out of the other pools' liquidity.
        const steal = bal0 - USDC(1000);
        await ethers.provider.send('hardhat_impersonateAccount', [V6ADDR]);
        await ethers.provider.send('hardhat_setBalance', [V6ADDR, '0x56BC75E2D63100000']);
        const mpSigner = await ethers.getSigner(V6ADDR);
        await (await usdc.connect(mpSigner).transfer(sink.address, steal)).wait();
        await ethers.provider.send('hardhat_stopImpersonatingAccount', [V6ADDR]);

        L.clearAlerts();
        const det = L.runMonitor();
        const alerts = L.alertState();

        const shortfall = {
            usdcBalanceBefore: u(bal0), usdcBalanceAfter: u(await usdc.balanceOf(V6ADDR)),
            lenderClaims: u(before.lenders.reduce((s, l) => s + l.amount + l.earnedInterest, 0n)),
            poolAvailable: u(before.availableLiquidity),
        };

        // ---- candidate remedies, each tried in its own snapshot
        const remedies = [];

        // (i) resetPoolAccounting — does the emergency repair tool help here?
        {
            const s = await L.snap();
            const r = await attempt('resetPoolAccounting', () => v6.connect(owner).resetPoolAccounting(idG));
            const after = await L.poolSnapshot(v6, idG);
            const m = L.runMonitor();
            remedies.push({
                lever: 'resetPoolAccounting(agentId)', executed: r.ok, revert: r.revert,
                availableLiquidityAfter: u(after.availableLiquidity),
                usdcBalanceAfter: u(await usdc.balanceOf(V6ADDR)),
                stillInsolvent: m.criticals.includes('SOLV') || m.criticals.includes('S1'),
                monitorAfter: { exitCode: m.exitCode, codes: m.codes },
                verdict: 'Does NOT help. It rebuilds the books from the lender POSITIONS — i.e. from the claims — so it re-asserts liquidity the contract does not hold. It repairs bookkeeping, never a shortfall.',
            });
            await L.revert(s);
        }

        // (ii) the withdrawal race — first come, first served
        {
            const s = await L.snap();
            const race = [];
            for (const [name, w] of [['lenderP', lenderP], ['lenderQ', lenderQ]]) {
                const pos = (await v6.positions(idG, w.address)).amount;
                const avail = (await v6.getAgentPool(idG))[2];
                const want = pos < avail ? pos : avail;
                const bal = await usdc.balanceOf(w.address);
                const r = await attempt(`${name} exits`, () => v6.connect(w).withdrawLiquidity(idG, want));
                race.push({ lender: name, requested: u(want), got: r.ok ? u((await usdc.balanceOf(w.address)) - bal) : 0, ok: r.ok, revert: r.revert });
            }
            remedies.push({
                lever: 'do nothing — let lenders withdraw', executed: true,
                race,
                verdict: 'First-come-first-served. The early lender is paid in full out of the remaining USDC; the late one reverts on the ERC-20 transfer. The socialisation logic only runs on LIQUIDATION, not on a bare shortfall, so the loss is NOT shared.',
            });
            await L.revert(s);
        }

        // (iii) pause — stop the race
        {
            const s = await L.snap();
            await (await v6.connect(owner).pause()).wait();
            const exit = await attempt('lenderP exits while paused', () => v6.connect(lenderP).withdrawLiquidity(idG, USDC(10)));
            const fees = await attempt('OWNER withdrawFees while paused', () => v6.connect(owner).withdrawFees(1n));
            const m = L.runMonitor({ expectPaused: false });
            remedies.push({
                lever: 'pause()', executed: true,
                lenderExitBlocked: !exit.ok, lenderExitRevert: exit.revert,
                ownerCanStillTakeFees: fees.ok,
                monitorAfter: { exitCode: m.exitCode, codes: m.codes },
                verdict: 'Stops the race by freezing EVERYONE, including repayment and your own liquidateLoan. It converts a race into a total freeze; it recovers nothing. Note the owner can still withdrawFees out of a pool that cannot pay its lenders.',
            });
            await L.revert(s);
        }

        // (iv) targeted containment that does NOT freeze exits
        {
            const s = await L.snap();
            const mn = await attempt('setMinSupplyAmount(100 USDC)', () => v6.connect(owner).setMinSupplyAmount(USDC(100)));
            const da = await attempt('registry.deactivateAgent', () => reg.connect(owner).deactivateAgent(idG));
            const newLender = await attempt('a NEW lender supplies 50 USDC', () => v6.connect(sink).supplyLiquidity(idG, USDC(50)));
            const newBorrow = await attempt('the agent opens a new loan', () => v6.connect(agentG).requestLoan(USDC(50), 7));
            const stillExit = await attempt('an existing lender still exits', () => v6.connect(lenderP).withdrawLiquidity(idG, USDC(10)));
            const openLoanId = (await v6.nextLoanId()) - 1n;
            const stillRepay = await attempt('the borrower still repays', () => v6.connect(agentG).repayLoan(openLoanId));
            remedies.push({
                lever: 'setMinSupplyAmount(max) + registry.deactivateAgent(agentId)', executed: mn.ok && da.ok,
                newLenderBlocked: !newLender.ok, newLenderRevert: newLender.revert,
                newBorrowBlocked: !newBorrow.ok, newBorrowRevert: newBorrow.revert,
                existingLenderCanStillExit: stillExit.ok,
                borrowerCanStillRepay: stillRepay.ok,
                verdict: 'STOPS THE BLEEDING WITHOUT FREEZING ANYONE. New money is gated and the agent can take no more credit, while exits and repayments stay open. This is the correct first move; it still recovers nothing.',
            });
            await L.revert(s);
        }

        out.cases['1B_real_shortfall'] = {
            engineered: `${u(steal)} USDC moved OUT of the marketplace; every storage figure left untouched`,
            shortfall,
            detection: {
                exitCode: det.exitCode, codes: det.codes, criticals: det.criticals,
                monitorRuntimeMs: det.ms, alertLatched: alerts.latchExists,
                alertSeverity: alerts.latch ? alerts.latch.severity : null,
            },
            remedies,
            verdict: 'NOT RECOVERABLE ON-CHAIN. V6.2 has no lever that puts USDC back: withdrawFees only moves money OUT, seedPool/seedPosition are dead (migration finalized), resetPoolAccounting rewrites the books rather than the balance, and socialisation only runs inside liquidateLoan on a specific defaulted loan. The only way to make lenders whole is an off-chain top-up: send USDC to the contract. The honest answer is "you cannot repair it, you can only stop the bleeding and then decide who is paid".',
        };

        // (v) prove the off-chain top-up actually is a repair path
        {
            const s = await L.snap();
            await (await usdc.mint(owner.address, steal)).wait();
            await (await usdc.connect(owner).transfer(V6ADDR, steal)).wait();
            const m = L.runMonitor();
            const exitP = await attempt('lenderP full exit after the top-up', async () => {
                const p = (await v6.positions(idG, lenderP.address)).amount;
                const avail = (await v6.getAgentPool(idG))[2];
                return v6.connect(lenderP).withdrawLiquidity(idG, p < avail ? p : avail);
            });
            out.cases['1B_real_shortfall'].offChainTopUp = {
                lever: 'send USDC to the marketplace address from treasury',
                amount: u(steal),
                monitorAfter: { exitCode: m.exitCode, codes: m.codes },
                lendersWholeAgain: exitP.ok,
                verdict: 'The ONLY path that makes lenders whole. It is a plain ERC-20 transfer to the contract; no contract function is involved. Note the monitor then reads the restored balance as normal, not as a surplus, because the shortfall is exactly cancelled.',
            };
            await L.revert(s);
        }
    }

    console.log(JSON.stringify(out, null, 2));
    L.writeResult('s1-insolvency.json', out);
    await L.revert(outer);
}

main().catch(e => { console.error(e); process.exit(1); });
