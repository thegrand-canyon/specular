// SCENARIO 4 — the owner key is hostile for one hour.
//
// Enumerates EVERY state-changing call the owner key can make across the four
// contracts of the V7 stack, EXECUTES each one against a local replica, and records
// what the invariant monitor would see. Then proves the things the key provably
// cannot do, and measures what containment is actually available to a single EOA
// with no timelock and no multisig.
//
// Usage: npx hardhat run --network localhost scripts/incident-drill/s4-hostile-owner.js

const { ethers } = require('hardhat');
const fs = require('fs');
const path = require('path');
const L = require('./lib');
const { USDC, u, DAY, advance, attempt } = L;

async function main() {
    const a = L.addr();
    const signers = await ethers.getSigners();
    const owner = signers[0];
    const agentH = signers[6];
    const lenderR = signers[7];
    const attackerEOA = signers[19];

    const v6 = await ethers.getContractAt('AgentLiquidityMarketplaceV62', a.agentLiquidityMarketplace_v6);
    const rep = await ethers.getContractAt('ReputationManagerV4', a.reputationManagerV4);
    const reg = await ethers.getContractAt('AgentRegistryV2', a.agentRegistryV2);
    const usdc = await ethers.getContractAt('MockUSDC', a.usdc);
    const faucet = await ethers.getContractAt('AgentCreditFaucet', a.agentCreditFaucet);

    const outer = await L.snap();

    // ------------------------------------------------------------------- setup
    for (const w of [agentH, lenderR, attackerEOA]) {
        await (await usdc.mint(w.address, USDC(200000))).wait();
        await (await usdc.connect(w).approve(await v6.getAddress(), ethers.MaxUint256)).wait();
    }
    await (await reg.connect(agentH).register('ipfs://h', [])).wait();
    const idH = await reg.addressToAgentId(agentH.address);
    await (await rep.connect(agentH)['initializeReputation()']()).wait();
    await (await v6.connect(agentH).createAgentPool()).wait();
    await (await v6.connect(lenderR).supplyLiquidity(idH, USDC(5000))).wait();
    await (await v6.connect(agentH).requestLoan(USDC(100), 7)).wait();
    const openLoan = (await v6.nextLoanId()) - 1n;

    // A clean monitor run, so we have an authentic "previous run" state file for
    // the change-detection checks (CP-CHANGED only fires with history).
    L.clearAlerts();
    L.runMonitor();
    const cleanState = JSON.parse(fs.readFileSync(path.join(L.ROOT, 'forensics/monitor/state-local.json'), 'utf8'));

    const base = await L.snap();

    // Run one hostile action, then ask the monitor what it sees.
    async function hostile(entry) {
        const s = await L.snap();
        const r = await attempt(entry.call, entry.fn);
        let mon = { exitCode: null, codes: [] };
        if (r.ok && entry.monitor !== false) {
            const m = L.runMonitor({ priorState: cleanState, freshState: false });
            mon = { exitCode: m.exitCode, codes: m.codes };
        }
        const extra = r.ok && entry.after ? await entry.after() : null;
        await L.revert(s);
        return {
            contract: entry.contract, call: entry.call, bound: entry.bound || null,
            succeeded: r.ok, revert: r.revert,
            monitorExit: mon.exitCode, monitorCodes: mon.codes,
            detected: mon.exitCode !== null && mon.exitCode !== 0,
            impact: entry.impact, extra,
        };
    }

    const actions = [
        // ---------------------------------------------------- marketplace V6.2
        { contract: 'MarketplaceV6.2', call: 'pause()', fn: () => v6.connect(owner).pause(),
          impact: 'Freezes 9 of 35 operations including every lender exit, every repayment and liquidateLoan.' },
        { contract: 'MarketplaceV6.2', call: 'setPlatformFeeRate(500)', bound: '<= 500 bps',
          fn: () => v6.connect(owner).setPlatformFeeRate(500),
          impact: 'Takes 5 % of ALL interest, retroactively — the fee is computed at repay, so live loans pay the new rate.' },
        { contract: 'MarketplaceV6.2', call: 'setMinSupplyAmount(100 USDC)', bound: '<= 100 USDC',
          fn: () => v6.connect(owner).setMinSupplyAmount(USDC(100)),
          impact: 'Locks small lenders out of new slots. Also raises the floor a PARTIAL withdrawal must leave.' },
        { contract: 'MarketplaceV6.2', call: 'setMinHoldForReputationReward(7d)', bound: '<= MIN_LOAN_DURATION (7d)',
          fn: () => v6.connect(owner).setMinHoldForReputationReward(7 * DAY),
          impact: 'Denies reputation to most repayments. Slows every honest agent; no direct money effect.' },
        { contract: 'MarketplaceV6.2', call: 'setBindBorrowToPoolCreator(false)', bound: 'none',
          fn: () => v6.connect(owner).setBindBorrowToPoolCreator(false),
          impact: 'Turns M-1 OFF. A bought/stolen agent NFT can then borrow against the SELLER\'s locked self-stake and the pool\'s lenders. This is the single most damaging silent flag flip.' },
        { contract: 'MarketplaceV6.2', call: 'withdrawFees(all)', bound: '<= accumulatedFees',
          fn: async () => v6.connect(owner).withdrawFees(await v6.accumulatedFees()),
          impact: 'Moves accrued protocol fees to the owner. Bounded by accumulatedFees — cannot touch lender principal.',
          after: async () => ({ accumulatedFeesTaken: u(await v6.accumulatedFees()) }) },
        { contract: 'MarketplaceV6.2', call: 'resetPoolAccounting(agentId)', bound: 'none',
          fn: () => v6.connect(owner).resetPoolAccounting(idH),
          impact: 'Rewrites totalLoaned/totalLiquidity/availableLiquidity from positions. On a healthy pool it is a no-op; on an under-recovered one it re-asserts liquidity that is not there.' },
        { contract: 'MarketplaceV6.2', call: 'compactPoolLenders(agentId)', bound: 'none',
          fn: () => v6.connect(owner).compactPoolLenders(idH), impact: 'Dedups the lender array. Harmless.' },
        { contract: 'MarketplaceV6.2', call: 'transferOwnership(hostile) [step 1 of 2]', bound: 'Ownable2Step',
          fn: () => v6.connect(owner).transferOwnership(attackerEOA.address),
          impact: 'Sets pendingOwner. Control does NOT move until the recipient calls acceptOwnership.' },
        { contract: 'MarketplaceV6.2', call: 'transferOwnership + acceptOwnership [both steps]', bound: 'Ownable2Step',
          fn: async () => { await (await v6.connect(owner).transferOwnership(attackerEOA.address)).wait(); return v6.connect(attackerEOA).acceptOwnership(); },
          impact: 'Control is gone. Irreversible without the new key.' },
        { contract: 'MarketplaceV6.2', call: 'renounceOwnership()', bound: 'OVERRIDDEN — reverts',
          fn: () => v6.connect(owner).renounceOwnership(), impact: 'Blocked by design (audit D5).' },
        { contract: 'MarketplaceV6.2', call: 'seedPool(...) [F-08]', bound: 'migrationFinalized',
          fn: () => v6.connect(owner).seedPool(idH, agentH.address, USDC(1e6), USDC(1e6), 0),
          impact: 'The owner-drain shape. Provably dead on a finalized deployment.' },
        { contract: 'MarketplaceV6.2', call: 'seedPosition(...) [F-08]', bound: 'migrationFinalized',
          fn: () => v6.connect(owner).seedPosition(idH, attackerEOA.address, USDC(1e6), 0, 0),
          impact: 'Would mint a lender position from nothing. Provably dead.' },

        // ------------------------------------------------- reputation manager V4
        { contract: 'ReputationManagerV4', call: 'setTierLimits(all at MAX_TIER_LIMIT)', bound: '<= MAX_TIER_LIMIT (10,000 USDC), immutable',
          fn: () => rep.connect(owner).setTierLimits([USDC(10000), USDC(10000), USDC(10000), USDC(10000), USDC(10000), USDC(10000)]),
          impact: 'Raises every tier to the hard ceiling. The ceiling itself is immutable, so the prize is bounded at 10,000 USDC of unsecured exposure per agent.' },
        { contract: 'ReputationManagerV4', call: 'setTierLimits(above MAX_TIER_LIMIT)', bound: 'REVERTS',
          fn: () => rep.connect(owner).setTierLimits([USDC(10001), USDC(10001), USDC(10001), USDC(10001), USDC(10001), USDC(10001)]),
          impact: 'The immutable ceiling holds.' },
        { contract: 'ReputationManagerV4', call: 'setLadderParameters(k=10, step=MAX, bootstrap=MAX, refDur=1s)', bound: 'k <= 10, step/bootstrap <= MAX_TIER_LIMIT',
          fn: () => rep.connect(owner).setLadderParameters(10, USDC(10000), USDC(10000), 1),
          impact: 'Hands every agent the full tier limit on day one AND shrinks the M2-c self-stake requirement to exposure/10. This is the lever that guts M2, and its only bound is k <= 10.' },
        { contract: 'ReputationManagerV4', call: 'setReputationRateLimit(0, 1)', bound: 'window > 0 only',
          fn: () => rep.connect(owner).setReputationRateLimit(0, 1),
          impact: 'Disables the D1 rate limit entirely — unbounded reputation gain per window.' },
        { contract: 'ReputationManagerV4', call: 'setScoringParameters(50, 0, 0, 1 wei)', bound: 'bonus<=50, penalties<=200/300, threshold>0',
          fn: () => rep.connect(owner).setScoringParameters(50, 0, 0, 1),
          impact: 'Maximum bonus, ZERO default penalty. Defaulting becomes free; a bust-out costs no reputation.' },
        { contract: 'ReputationManagerV4', call: 'setDefaultLockout(0)', bound: '<= 730 days',
          fn: () => rep.connect(owner).setDefaultLockout(0),
          impact: 'Removes the 180-day post-default freeze. A defaulted agent can borrow again immediately.' },
        { contract: 'ReputationManagerV4', call: 'setLatePenaltyParameters(0,0,0)', bound: 'max <= 300',
          fn: () => rep.connect(owner).setLatePenaltyParameters(0, 0, 0), impact: 'Removes the late-repayment penalty.' },
        { contract: 'ReputationManagerV4', call: 'setBonusReferenceAmount(1 wei)', bound: '> 0',
          fn: () => rep.connect(owner).setBonusReferenceAmount(1),
          impact: 'Every dust loan earns the full reputation bonus.' },
        { contract: 'ReputationManagerV4', call: 'authorizePool(ATTACKER EOA)', bound: 'NONE — any address',
          fn: () => rep.connect(owner).authorizePool(attackerEOA.address),
          impact: 'THE BIG ONE. An arbitrary address becomes able to call recordBorrow / recordLoanCompletion / recordDefault, i.e. to write reputation and credit capacity for ANY agent, directly.' },
        { contract: 'ReputationManagerV4', call: 'revokePool(the live marketplace)', bound: 'none',
          fn: () => rep.connect(owner).revokePool(a.agentLiquidityMarketplace_v6),
          impact: 'Bricks repayLoan AND liquidateLoan protocol-wide — both call into the manager — with NO pause flag to show for it.',
          after: async () => {
              const r1 = await attempt('repay', () => v6.connect(agentH).repayLoan(openLoan));
              await advance(9 * DAY);   // make the loan genuinely overdue first
              const r2 = await attempt('liquidate', () => v6.connect(owner).liquidateLoan(openLoan));
              return { repayBricked: !r1.ok, repayRevert: r1.revert, liquidateBricked: !r2.ok, liquidateRevert: r2.revert };
          } },
        { contract: 'ReputationManagerV4', call: 'setValidationRegistry(hostile contract)', bound: 'none',
          fn: () => rep.connect(owner).setValidationRegistry(attackerEOA.address),
          impact: 'creditLimitOf() calls into it. A reverting/hostile registry can brick EVERY credit-limit read, hence requestLoan, for every agent.',
          after: async () => {
              const r = await attempt('requestLoan after hostile validation registry', () => v6.connect(agentH).requestLoan(USDC(10), 7));
              return { requestLoanBricked: !r.ok, revert: r.revert };
          } },
        { contract: 'ReputationManagerV4', call: 'renounceOwnership()', bound: 'OVERRIDDEN — reverts',
          fn: () => rep.connect(owner).renounceOwnership(), impact: 'Blocked by design.' },

        // ------------------------------------------------------ registry (Ownable)
        { contract: 'AgentRegistryV2', call: 'deactivateAgent(agentId)', bound: 'none',
          fn: () => reg.connect(owner).deactivateAgent(idH),
          impact: 'Per-agent kill switch. Blocks createAgentPool/requestLoan for that agent; repayment stays open.' },
        { contract: 'AgentRegistryV2', call: 'pause()', bound: 'none',
          fn: () => reg.connect(owner).pause(),
          impact: 'Blocks NEW registrations. Does NOT block NFT transfers or anything on the marketplace.' },
        { contract: 'AgentRegistryV2', call: 'transferOwnership(hostile) — ONE STEP', bound: 'plain Ownable',
          fn: () => reg.connect(owner).transferOwnership(attackerEOA.address),
          impact: 'Registry control moves IMMEDIATELY, in one transaction, with no acceptance step and no way back.',
          after: async () => ({ newOwner: await reg.owner() }) },
        { contract: 'AgentRegistryV2', call: 'renounceOwnership()', bound: 'NOT OVERRIDDEN',
          fn: () => reg.connect(owner).renounceOwnership(),
          impact: 'PERMANENTLY orphans the registry. deactivateAgent — the runbook\'s recommended per-agent kill switch — and registry pause are gone for ever. Nothing can restore them.',
          after: async () => ({ ownerAfter: await reg.owner(), deactivateStillPossible: (await attempt('deactivate', () => reg.connect(owner).deactivateAgent(idH))).ok }) },

        // -------------------------------------------------------- faucet (Ownable)
        { contract: 'AgentCreditFaucet', call: 'drain(full balance)', bound: '<= faucet balance',
          fn: async () => faucet.connect(owner).drain(await faucet.balance()),
          impact: 'Empties the faucet to the owner. Bounded by the faucet balance (19 USDC on mainnet today).' },
        { contract: 'AgentCreditFaucet', call: 'setClaimAmount(100 USDC)', bound: '<= 100 USDC',
          fn: () => faucet.connect(owner).setClaimAmount(USDC(100)), impact: 'Drains the faucet faster through claims.' },
        { contract: 'AgentCreditFaucet', call: 'setMaxEligibleAgentId(max)', bound: 'NONE',
          fn: () => faucet.connect(owner).setMaxEligibleAgentId(ethers.MaxUint256), impact: 'Opens the faucet to every agent, present and future.' },
        { contract: 'AgentCreditFaucet', call: 'transferOwnership(hostile) — ONE STEP', bound: 'plain Ownable',
          fn: () => faucet.connect(owner).transferOwnership(attackerEOA.address), impact: 'Immediate, one transaction.' },
        { contract: 'AgentCreditFaucet', call: 'renounceOwnership()', bound: 'NOT OVERRIDDEN',
          fn: () => faucet.connect(owner).renounceOwnership(), impact: 'Permanently strands whatever USDC the faucet holds.' },
    ];

    const results = [];
    for (const e of actions) { const r = await hostile(e); results.push(r); console.log(`  ${r.succeeded ? 'OK  ' : 'REVT'} ${r.contract.padEnd(20)} ${r.call.padEnd(56)} monitor=${r.monitorExit === null ? '-' : 'exit' + r.monitorExit} ${r.monitorCodes.join(',')}`); }

    // ============================================================ the full chain
    // The worst thing the key can actually do, executed end to end: authorize
    // itself on the reputation manager, manufacture credit for an agent it
    // controls, and draw a real pool down.
    console.log('\nrunning the full hostile chain...');
    let chain = null;
    {
        const s = await L.snap();
        const txs = [];
        const attackerAgent = attackerEOA;
        await (await reg.connect(attackerAgent).register('ipfs://x', [])).wait();
        const idX = await reg.addressToAgentId(attackerAgent.address);
        await (await rep.connect(attackerAgent)['initializeReputation()']()).wait();
        await (await v6.connect(attackerAgent).createAgentPool()).wait();
        // an innocent third party lends into that pool
        await (await v6.connect(lenderR).supplyLiquidity(idX, USDC(5000))).wait();
        const victimBefore = (await v6.positions(idX, lenderR.address)).amount;

        const t0 = await v6.connect(owner);
        // 1. authorize the hostile EOA on the reputation manager
        txs.push('rep.authorizePool(attacker)');      await (await rep.connect(owner).authorizePool(attackerAgent.address)).wait();
        // 2. remove every brake
        txs.push('rep.setReputationRateLimit(0,1)');  await (await rep.connect(owner).setReputationRateLimit(0, 1)).wait();
        txs.push('rep.setScoringParameters(50,0,0,1)'); await (await rep.connect(owner).setScoringParameters(50, 0, 0, 1)).wait();
        txs.push('rep.setBonusReferenceAmount(1 wei)'); await (await rep.connect(owner).setBonusReferenceAmount(1)).wait();
        txs.push('rep.setDefaultLockout(0)');         await (await rep.connect(owner).setDefaultLockout(0)).wait();
        txs.push('rep.setTierLimits(all MAX)');       await (await rep.connect(owner).setTierLimits([USDC(10000), USDC(10000), USDC(10000), USDC(10000), USDC(10000), USDC(10000)])).wait();
        // k = 10 both accelerates the ladder and shrinks the M2-c self-stake to exposure/10
        txs.push('rep.setLadderParameters(10, MAX, MAX, 1s)'); await (await rep.connect(owner).setLadderParameters(10, USDC(10000), USDC(10000), 1)).wait();
        // 3. write reputation directly from the authorized EOA
        // recordBorrow then recordLoanCompletion for the SAME id: the pair is what
        // gives V4 a non-zero hold time, and hold time is what pays the bonus.
        // Both are onlyAuthorizedPool, and the hostile EOA is now authorized.
        txs.push('rep.recordBorrow + rep.recordLoanCompletion x N (forged, from the authorized EOA)');
        let calls = 0;
        while (Number(await rep['getReputationScore(uint256)'](idX)) < 800 && calls < 60) {
            await (await rep.connect(attackerAgent).recordBorrow(attackerAgent.address, 900000 + calls, USDC(10000))).wait();
            await advance(2);
            await (await rep.connect(attackerAgent).recordLoanCompletion(attackerAgent.address, 900000 + calls, USDC(10000), true, 0)).wait();
            calls++;
        }
        const forged = {
            ownerTxCount: txs.length - 1 + calls * 2,
            forgedRecordCallPairs: calls,
            score: Number(await rep['getReputationScore(uint256)'](idX)),
            maxRepaidPrincipal: u(await rep.maxRepaidPrincipal(idX)),
            creditLimit: u(await rep.calculateCreditLimit(attackerAgent.address)),
            collateralPct: Number(await rep.calculateCollateralRequirement(attackerAgent.address)),
            requiredSelfStake: u(await v6.requiredSelfStake(idX, USDC(5000))),
        };
        // 4. draw the pool down. The attacker's own stake also counts as pool
        //    liquidity, so the needed stake is a fixed point: iterate it.
        let need = 0n;
        for (let i = 0; i < 4; i++) {
            const av = (await v6.getAgentPool(idX))[2] + need;
            const lim = await rep.calculateCreditLimit(attackerAgent.address);
            const d = av < lim ? av : lim;
            const want = await v6.requiredSelfStake(idX, d);
            if (want <= need) break;
            need = want + USDC(10);
        }
        await (await usdc.mint(attackerAgent.address, need + USDC(10))).wait();
        if (need > 0n) await (await v6.connect(attackerAgent).supplyLiquidity(idX, need)).wait();
        const avail = (await v6.getAgentPool(idX))[2];
        const limit = await rep.calculateCreditLimit(attackerAgent.address);
        const draw = avail < limit ? avail : limit;
        const balBefore = await usdc.balanceOf(attackerAgent.address);
        const drawTx = await attempt('draw the pool', () => v6.connect(attackerAgent).requestLoan(draw, 7));
        const balAfter = await usdc.balanceOf(attackerAgent.address);

        const mon = L.runMonitor({ priorState: cleanState, freshState: false });
        chain = {
            transactionsFromTheOwnerKey: txs,
            forged,
            drawAttempted: u(draw), drawSucceeded: drawTx.ok, drawRevert: drawTx.revert,
            attackerCashOut: u(balAfter - balBefore),
            attackerOwnCapitalAtRisk: u(need),
            victimLenderPrincipal: u(victimBefore),
            monitorAfterTheWholeChain: { exitCode: mon.exitCode, codes: mon.codes },
            timeToDetect: 'the next scheduled 30-minute monitor run, and only via CP-CHANGED (WARN) on the tier/ladder fields. authorizePool, the scoring parameters and the forged reputation writes are NOT checked at all.',
        };
        await L.revert(s);
    }

    // ============================================== what the key provably CANNOT do
    const cannot = [];
    {
        const s = await L.snap();
        const probes = [
            ['raise a tier limit above the immutable MAX_TIER_LIMIT', () => rep.connect(owner).setTierLimits([USDC(10001), USDC(1000), USDC(1000), USDC(1000), USDC(1000), USDC(1000)])],
            ['set creditMultiple above 10', () => rep.connect(owner).setLadderParameters(11, USDC(100), USDC(100), DAY)],
            ['set growthStep above MAX_TIER_LIMIT', () => rep.connect(owner).setLadderParameters(2, USDC(10001), USDC(100), DAY)],
            ['set the platform fee above 5 %', () => v6.connect(owner).setPlatformFeeRate(501)],
            ['set minSupplyAmount above 100 USDC', () => v6.connect(owner).setMinSupplyAmount(USDC(101))],
            ['set the default lockout beyond 2 years', () => rep.connect(owner).setDefaultLockout(731 * DAY)],
            ['re-open migration (setMigrationFinalized)', () => v6.connect(owner).setMigrationFinalized()],
            ['mint a lender position (seedPosition)', () => v6.connect(owner).seedPosition(idH, attackerEOA.address, USDC(1000), 0, 0)],
            ['mint pool liquidity (seedPool)', () => v6.connect(owner).seedPool(idH, agentH.address, USDC(1e6), USDC(1e6), 0)],
            ['withdraw more than accumulatedFees', async () => v6.connect(owner).withdrawFees((await v6.accumulatedFees()) + 1n)],
            ['renounce marketplace ownership', () => v6.connect(owner).renounceOwnership()],
            ['renounce reputation-manager ownership', () => rep.connect(owner).renounceOwnership()],
            ['liquidate a loan that is not overdue', () => v6.connect(owner).liquidateLoan(openLoan)],
            ['liquidate while paused', async () => { await (await v6.connect(owner).pause()).wait(); return v6.connect(owner).liquidateLoan(openLoan); }],
            ['transfer an agent NFT it does not hold', () => reg.connect(owner).transferFrom(agentH.address, attackerEOA.address, idH)],
            ['set a reputation score directly (no such function)', async () => { if (rep.interface.hasFunction && rep.interface.getFunction('setReputationScore')) return Promise.reject(new Error('exists')); throw new Error('no such function on ReputationManagerV4'); }],
        ];
        for (const [label, fn] of probes) {
            const inner = await L.snap();
            const r = await attempt(label, fn);
            cannot.push({ attempt: label, blocked: !r.ok, revert: r.revert });
            await L.revert(inner);
        }
        await L.revert(s);
    }

    // ==================================================== containment with one EOA
    const containment = [];
    {
        const s = await L.snap();
        const cold = signers[18];
        // full key rotation, counted
        const rot = [];
        rot.push({ step: 'marketplace.transferOwnership(cold)', ...(await attempt('x', () => v6.connect(owner).transferOwnership(cold.address))) });
        rot.push({ step: 'marketplace.acceptOwnership() FROM COLD', ...(await attempt('x', () => v6.connect(cold).acceptOwnership())) });
        rot.push({ step: 'reputation.transferOwnership(cold)', ...(await attempt('x', () => rep.connect(owner).transferOwnership(cold.address))) });
        rot.push({ step: 'reputation.acceptOwnership() FROM COLD', ...(await attempt('x', () => rep.connect(cold).acceptOwnership())) });
        rot.push({ step: 'registry.transferOwnership(cold) [ONE STEP]', ...(await attempt('x', () => reg.connect(owner).transferOwnership(cold.address))) });
        rot.push({ step: 'faucet.transferOwnership(cold) [ONE STEP]', ...(await attempt('x', () => faucet.connect(owner).transferOwnership(cold.address))) });
        const oldKeyStillWorks = [];
        oldKeyStillWorks.push({ call: 'marketplace.pause() from the OLD key', ...(await attempt('x', () => v6.connect(owner).pause())) });
        oldKeyStillWorks.push({ call: 'reputation.authorizePool from the OLD key', ...(await attempt('x', () => rep.connect(owner).authorizePool(attackerEOA.address))) });
        oldKeyStillWorks.push({ call: 'registry.deactivateAgent from the OLD key', ...(await attempt('x', () => reg.connect(owner).deactivateAgent(idH))) });
        containment.push({
            option: 'rotate every owner to a fresh cold wallet',
            transactionsRequired: rot.length,
            steps: rot.map(r => ({ step: r.step, ok: r.ok, revert: r.revert })),
            oldKeyNeutralisedImmediately: oldKeyStillWorks.every(o => !o.ok),
            oldKeyProbes: oldKeyStillWorks.map(o => ({ call: o.call, stillWorks: o.ok, revert: o.revert })),
            note: 'Only possible while you STILL control the key. Six transactions, two of which must be signed by the new wallet (Ownable2Step). The registry and faucet move in one step each, so a typo there is unrecoverable.',
        });
        await L.revert(s);
    }

    const result = {
        scenario: 'S4 — owner key hostile for one hour',
        stack: { marketplace: await v6.VERSION(), reputation: await rep.VERSION(), registryOwnership: 'Ownable (ONE-STEP, renounceable)', faucetOwnership: 'Ownable (ONE-STEP, renounceable)' },
        ownerSurface: results,
        summary: {
            stateChangingOwnerCallsEnumerated: results.length,
            succeeded: results.filter(r => r.succeeded).length,
            blockedByDesign: results.filter(r => !r.succeeded).length,
            detectedByTheMonitor: results.filter(r => r.detected).length,
            invisibleToTheMonitor: results.filter(r => r.succeeded && !r.detected).map(r => `${r.contract}: ${r.call}`),
        },
        fullHostileChain: chain,
        provablyCannot: cannot,
        containment,
    };
    console.log('\n' + JSON.stringify({ summary: result.summary, fullHostileChain: chain, containment: containment[0] }, null, 2));
    L.writeResult('s4-hostile-owner.json', result);
    await L.revert(outer);
}

main().catch(e => { console.error(e); process.exit(1); });
