// SCENARIO 5 — pause blast radius on V6.2, re-measured.
//
// The V6.1 figure in the runbook was "6 of 18". V6.2 adds M2 (the locked
// first-loss self-stake) and a V4 reputation manager with its own owner surface,
// so the table has to be rebuilt rather than assumed.
//
// Every operation is attempted from the correct caller, twice: once UNPAUSED
// (control) and once PAUSED, each inside its own snapshot so probes cannot
// contaminate each other. A probe that fails in BOTH columns is a setup problem,
// not a pause effect, and is reported as such.
//
// Also measures the recommended alternative lever — registry.deactivateAgent —
// against the same operation set, so the runbook can compare blast radii.
//
// Usage: npx hardhat run --network localhost scripts/incident-drill/s5-pause-blast-radius.js

const { ethers } = require('hardhat');
const L = require('./lib');
const { USDC, u, DAY, advance, attempt } = L;

async function main() {
    const a = L.addr();
    const signers = await ethers.getSigners();
    const owner = signers[0];
    const agentE = signers[14];
    const lenderX = signers[15];
    const newLender = signers[16];
    const freshAgent = signers[17];
    const buyer = signers[18];

    const v6 = await ethers.getContractAt('AgentLiquidityMarketplaceV62', a.agentLiquidityMarketplace_v6);
    const rep = await ethers.getContractAt('ReputationManagerV4', a.reputationManagerV4);
    const reg = await ethers.getContractAt('AgentRegistryV2', a.agentRegistryV2);
    const usdc = await ethers.getContractAt('MockUSDC', a.usdc);
    const faucet = await ethers.getContractAt('AgentCreditFaucet', a.agentCreditFaucet);

    const outer = await L.snap();

    // ------------------------------------------------------------------- setup
    for (const w of [agentE, lenderX, newLender, freshAgent, buyer]) {
        await (await usdc.mint(w.address, USDC(100000))).wait();
        await (await usdc.connect(w).approve(await v6.getAddress(), ethers.MaxUint256)).wait();
    }
    await (await reg.connect(agentE).register('ipfs://e', [])).wait();
    const idE = await reg.addressToAgentId(agentE.address);
    await (await rep.connect(agentE)['initializeReputation()']()).wait();
    await (await v6.connect(agentE).createAgentPool()).wait();
    await (await v6.connect(lenderX).supplyLiquidity(idE, USDC(1000))).wait();
    // The agent's own M2 first-loss position, so the self-stake lock can be probed.
    await (await v6.connect(agentE).supplyLiquidity(idE, USDC(50))).wait();
    await (await reg.connect(freshAgent).register('ipfs://fresh', [])).wait();
    const idFresh = await reg.addressToAgentId(freshAgent.address);

    // One completed cycle so lenderX has unclaimed interest and the contract has fees.
    await (await v6.connect(agentE).requestLoan(USDC(100), 7)).wait();
    await advance(7 * DAY - 900);
    await (await v6.connect(agentE).repayLoan((await v6.nextLoanId()) - 1n)).wait();

    // Two live loans: one to repay, one to liquidate. Both pushed past endTime so a
    // single time-advance makes the liquidate probe legal.
    await (await v6.connect(agentE).requestLoan(USDC(100), 7)).wait();
    const repayId = (await v6.nextLoanId()) - 1n;
    await (await v6.connect(agentE).requestLoan(USDC(100), 7)).wait();
    const liqId = (await v6.nextLoanId()) - 1n;
    await advance(9 * DAY);

    const baseState = await L.snap();

    const ops = () => ([
        // --- money-moving participant operations on the marketplace
        ['LENDER', 'withdrawLiquidity (FULL position, loans outstanding)', () => v6.connect(lenderX).withdrawLiquidity(idE, 0n)],
        ['LENDER', 'withdrawLiquidity (max the pool can honour)', () => v6.connect(lenderX).withdrawLiquidity(idE, 0n)],
        ['LENDER', 'withdrawLiquidity (partial)', () => v6.connect(lenderX).withdrawLiquidity(idE, USDC(10))],
        ['AGENT-CREATOR', 'withdrawLiquidity of its own M2 self-stake', () => v6.connect(agentE).withdrawLiquidity(idE, 1n)],
        ['LENDER', 'claimInterest', () => v6.connect(lenderX).claimInterest(idE)],
        ['LENDER', 'supplyLiquidity (new slot)', () => v6.connect(newLender).supplyLiquidity(idE, USDC(50))],
        ['LENDER', 'supplyLiquidity (top-up existing)', () => v6.connect(lenderX).supplyLiquidity(idE, USDC(50))],
        ['BORROWER', 'repayLoan (clear the debt)', () => v6.connect(agentE).repayLoan(repayId)],
        ['BORROWER', 'requestLoan (new credit)', () => v6.connect(agentE).requestLoan(USDC(50), 7)],
        ['AGENT', 'createAgentPool', () => v6.connect(freshAgent).createAgentPool()],
        // --- owner recovery + risk levers on the marketplace
        ['OWNER-MP', 'liquidateLoan (the recovery tool)', () => v6.connect(owner).liquidateLoan(liqId)],
        ['OWNER-MP', 'withdrawFees', () => v6.connect(owner).withdrawFees(1n)],
        ['OWNER-MP', 'setPlatformFeeRate', () => v6.connect(owner).setPlatformFeeRate(150)],
        ['OWNER-MP', 'setMinSupplyAmount', () => v6.connect(owner).setMinSupplyAmount(USDC(100))],
        ['OWNER-MP', 'setMinHoldForReputationReward', () => v6.connect(owner).setMinHoldForReputationReward(0)],
        ['OWNER-MP', 'setBindBorrowToPoolCreator', () => v6.connect(owner).setBindBorrowToPoolCreator(false)],
        ['OWNER-MP', 'compactPoolLenders', () => v6.connect(owner).compactPoolLenders(idE)],
        ['OWNER-MP', 'resetPoolAccounting', () => v6.connect(owner).resetPoolAccounting(idE)],
        ['OWNER-MP', 'transferOwnership', () => v6.connect(owner).transferOwnership(buyer.address)],
        ['OWNER-MP', 'unpause', () => v6.connect(owner).unpause()],
        ['OWNER-MP', 'seedPool (migration finalized)', () => v6.connect(owner).seedPool(idE, agentE.address, USDC(1), USDC(1), 0)],
        ['OWNER-MP', 'setMigrationFinalized (again)', () => v6.connect(owner).setMigrationFinalized()],
        // --- registry (separate contract, separate pause flag)
        ['REGISTRY', 'register a new agent', () => reg.connect(buyer).register('ipfs://b', [])],
        ['REGISTRY', 'transfer agent NFT', () => reg.connect(freshAgent).transferFrom(freshAgent.address, buyer.address, idFresh)],
        ['REGISTRY', 'owner: deactivateAgent (the per-agent kill switch)', () => reg.connect(owner).deactivateAgent(idFresh)],
        ['REGISTRY', 'owner: reactivateAgent (undo the kill switch)', () => (async () => { await (await reg.connect(owner).deactivateAgent(idFresh)).wait(); return reg.connect(owner).reactivateAgent(idFresh); })()],
        ['REGISTRY', 'owner: pause registry', () => reg.connect(owner).pause()],
        ['REGISTRY', 'owner: transferOwnership (ONE-STEP Ownable)', () => reg.connect(owner).transferOwnership(buyer.address)],
        ['REGISTRY', 'owner: renounceOwnership (ONE-STEP Ownable)', () => reg.connect(owner).renounceOwnership()],
        // --- reputation manager V4 (separate contract, NO pause flag at all)
        ['REPUTATION', 'agent: initializeReputation', () => rep.connect(freshAgent)['initializeReputation()']()],
        ['REPUTATION', 'owner: setTierLimits', () => rep.connect(owner).setTierLimits([USDC(1000), USDC(1000), USDC(1000), USDC(1000), USDC(1000), USDC(1000)])],
        ['REPUTATION', 'owner: setLadderParameters', () => rep.connect(owner).setLadderParameters(3, USDC(200), USDC(50), 3 * DAY)],
        ['REPUTATION', 'owner: setReputationRateLimit', () => rep.connect(owner).setReputationRateLimit(1, DAY)],
        ['REPUTATION', 'owner: setScoringParameters', () => rep.connect(owner).setScoringParameters(0, 200, 300, USDC(1))],
        ['REPUTATION', 'owner: setDefaultLockout', () => rep.connect(owner).setDefaultLockout(730 * DAY)],
        ['REPUTATION', 'owner: revokePool (marketplace)', () => rep.connect(owner).revokePool(a.agentLiquidityMarketplace_v6)],
        ['REPUTATION', 'owner: authorizePool (arbitrary)', () => rep.connect(owner).authorizePool(buyer.address)],
        // --- faucet (separate contract, no pause flag)
        ['FAUCET', 'agent: claim', () => faucet.connect(freshAgent).claim()],
        ['FAUCET', 'owner: drain', () => faucet.connect(owner).drain(USDC(1))],
        ['FAUCET', 'owner: setClaimAmount', () => faucet.connect(owner).setClaimAmount(USDC(100))],
    ]);

    const results = { unpaused: [], paused: [], deactivated: [] };

    for (const phase of ['unpaused', 'paused', 'deactivated']) {
        await L.revert(baseState);
        const re = await L.snap();
        if (phase === 'paused') await (await v6.connect(owner).pause()).wait();
        if (phase === 'deactivated') await (await reg.connect(owner).deactivateAgent(idE)).wait();

        for (const [group, label, fn] of ops()) {
            const inner = await L.snap();
            // probes whose amount depends on live state
            let call = fn;
            if (label === 'withdrawLiquidity (FULL position, loans outstanding)') {
                const amt = (await v6.positions(idE, lenderX.address)).amount;
                call = () => v6.connect(lenderX).withdrawLiquidity(idE, amt);
            } else if (label === 'withdrawLiquidity (max the pool can honour)') {
                const avail = (await v6.getAgentPool(idE))[2];
                call = () => v6.connect(lenderX).withdrawLiquidity(idE, avail);
            }
            const r = await attempt(label, call);
            results[phase].push({ group, ...r });
            await L.revert(inner);
        }
        await L.revert(re);
    }

    const rows = results.unpaused.map((un, i) => {
        const p = results.paused[i], d = results.deactivated[i];
        return {
            group: un.group, operation: un.label,
            unpaused: un.ok ? 'works' : `blocked: ${un.revert}`,
            paused: p.ok ? 'works' : `BLOCKED: ${p.revert}`,
            agentDeactivated: d.ok ? 'works' : `BLOCKED: ${d.revert}`,
            brokenByPause: un.ok && !p.ok,
            brokenByDeactivate: un.ok && !d.ok,
            unavailableAnyway: !un.ok,
        };
    });

    const probed = rows.filter(r => !r.unavailableAnyway);
    const result = {
        scenario: 'S5 — pause blast radius on V6.2 (+ the deactivateAgent comparison)',
        marketplaceVersion: await v6.VERSION(), reputationVersion: await rep.VERSION(),
        totals: {
            operationsProbed: rows.length,
            operationsAvailableUnpaused: probed.length,
            brokenByPause: rows.filter(r => r.brokenByPause).length,
            brokenByDeactivateAgent: rows.filter(r => r.brokenByDeactivate).length,
            headline: `${rows.filter(r => r.brokenByPause).length} of ${probed.length} available operations are broken by pause()`,
        },
        brokenByPause: rows.filter(r => r.brokenByPause).map(r => `${r.group}: ${r.operation}`),
        brokenByDeactivateAgent: rows.filter(r => r.brokenByDeactivate).map(r => `${r.group}: ${r.operation}`),
        survivesPause: rows.filter(r => !r.brokenByPause && !r.unavailableAnyway).map(r => `${r.group}: ${r.operation}`),
        blockedEvenUnpaused: rows.filter(r => r.unavailableAnyway).map(r => ({ operation: r.operation, reason: r.unpaused })),
        table: rows,
    };
    console.log(JSON.stringify({ totals: result.totals, brokenByPause: result.brokenByPause, brokenByDeactivateAgent: result.brokenByDeactivateAgent, blockedEvenUnpaused: result.blockedEvenUnpaused }, null, 2));
    L.writeResult('s5-pause-blast-radius.json', result);
    await L.revert(outer);
}

main().catch(e => { console.error(e); process.exit(1); });
