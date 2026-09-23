// PAUSE BLAST RADIUS — exactly what still works and what breaks when the owner
// hits the marketplace's main emergency lever.
//
// `pause()` is the only global response to a detected incident, so the operator
// has to know its true cost before using it. Every call below is attempted twice,
// once UNPAUSED (control) and once PAUSED, from the correct caller.
//
// Usage: npx hardhat run --network localhost scripts/op-resilience/pause-blast-radius.js

const { ethers } = require('hardhat');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, 'forensics/output/testing-2026-09-20');
const USDC = n => ethers.parseUnits(n.toString(), 6);
const DAY = 24 * 60 * 60;

async function attempt(label, fn) {
    try { await fn(); return { label, ok: true, revert: null }; }
    catch (e) {
        const m = e.shortMessage || e.message || '';
        const r = /reverted with custom error '([^']+)'/.exec(m) || /reverted with reason string '([^']+)'/.exec(m);
        return { label, ok: false, revert: r ? r[1] : m.slice(0, 90) };
    }
}

async function main() {
    fs.mkdirSync(OUT, { recursive: true });
    const addr = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/config/local-addresses.json')));
    const signers = await ethers.getSigners();
    const [owner] = signers;
    const v6 = await ethers.getContractAt('AgentLiquidityMarketplaceV6', addr.agentLiquidityMarketplace_v6);
    const registry = await ethers.getContractAt('AgentRegistryV2', addr.agentRegistryV2);
    const usdc = await ethers.getContractAt('MockUSDC', addr.usdc);
    const faucet = await ethers.getContractAt('AgentCreditFaucet', addr.agentCreditFaucet);

    const agentA = await ethers.getSigner(addr._testAccounts.agentA);
    const agentB = await ethers.getSigner(addr._testAccounts.agentB);
    const lender1 = await ethers.getSigner(addr._testAccounts.lender1);
    const lender3 = await ethers.getSigner(addr._testAccounts.lender3);
    const newLender = signers[9];
    const idA = BigInt(addr._testAccounts.agentAId);
    const idB = BigInt(addr._testAccounts.agentBId);

    // Every operation a real participant might need during an incident.
    const ops = ctx => ([
        ['lender: withdrawLiquidity (exit their principal)', () => v6.connect(lender1).withdrawLiquidity(idA, USDC(10))],
        ['lender: claimInterest (take earned interest)', () => v6.connect(lender1).claimInterest(idA)],
        ['lender: supplyLiquidity (add more)', () => v6.connect(newLender).supplyLiquidity(idB, USDC(100))],
        ['borrower: repayLoan (clear their debt)', () => v6.connect(agentA).repayLoan(ctx.repayLoanId)],
        ['borrower: requestLoan (new credit)', () => v6.connect(agentB).requestLoan(USDC(50), 7)],
        ['agent: createAgentPool', () => v6.connect(signers[10]).createAgentPool()],
        ['OWNER: liquidateLoan (default an overdue loan)', () => v6.liquidateLoan(ctx.liquidateLoanId)],
        ['OWNER: withdrawFees', () => v6.withdrawFees(1n)],
        ['OWNER: setPlatformFeeRate', () => v6.setPlatformFeeRate(150)],
        ['OWNER: setMinSupplyAmount', () => v6.setMinSupplyAmount(USDC(1))],
        ['OWNER: setBindBorrowToPoolCreator', () => v6.setBindBorrowToPoolCreator(true)],
        ['OWNER: setMinHoldForReputationReward', () => v6.setMinHoldForReputationReward(DAY)],
        ['OWNER: compactPoolLenders', () => v6.compactPoolLenders(idA)],
        ['OWNER: resetPoolAccounting', () => v6.resetPoolAccounting(idB)],
        ['OWNER: transferOwnership', () => v6.transferOwnership(owner.address)],
        ['registry: register a new agent', () => registry.connect(signers[11]).register('ipfs://x', [])],
        ['registry: transfer agent NFT', () => registry.connect(agentB).transferFrom(agentB.address, signers[12].address, idB)],
        ['faucet: claim', () => faucet.connect(agentB).claim()],
    ]);

    const results = { unpaused: [], paused: [] };

    for (const phase of ['unpaused', 'paused']) {
        const snap = await ethers.provider.send('evm_snapshot', []);

        // Set up two fresh loans per phase: one repayable, one overdue for liquidation.
        await usdc.mint(newLender.address, USDC(10000));
        await usdc.connect(newLender).approve(await v6.getAddress(), ethers.MaxUint256);
        await usdc.mint(signers[10].address, USDC(10000));
        await usdc.connect(signers[10]).approve(await v6.getAddress(), ethers.MaxUint256);
        await usdc.mint(signers[11].address, USDC(10000));
        await usdc.mint(signers[12].address, USDC(10000));

        // Loan #2 (agent A) is already ACTIVE from the baseline deploy. Push time
        // past its endTime so the same loan is both repayable and liquidatable.
        const ctx = { repayLoanId: 2, liquidateLoanId: 3 };
        await ethers.provider.send('evm_increaseTime', [20 * DAY]);
        await ethers.provider.send('evm_mine', []);
        // lender3 must have some interest to claim for the claimInterest probe
        await v6.connect(lender3);

        if (phase === 'paused') await v6.pause();

        for (const [label, fn] of ops(ctx)) {
            const inner = await ethers.provider.send('evm_snapshot', []);
            results[phase].push(await attempt(label, fn));
            await ethers.provider.send('evm_revert', [inner]);
        }
        await ethers.provider.send('evm_revert', [snap]);
    }

    const rows = results.unpaused.map((u, i) => {
        const p = results.paused[i];
        return {
            operation: u.label,
            unpaused: u.ok ? 'works' : `blocked: ${u.revert}`,
            paused: p.ok ? 'works' : `BLOCKED: ${p.revert}`,
            brokenByPause: u.ok && !p.ok,
        };
    });
    fs.writeFileSync(path.join(OUT, 'pause-blast-radius.json'), JSON.stringify(rows, null, 2));

    const w = 52;
    console.log('operation'.padEnd(w) + '| unpaused           | paused');
    console.log('-'.repeat(w) + '+--------------------+' + '-'.repeat(40));
    for (const r of rows) {
        console.log(r.operation.padEnd(w) + '| ' + r.unpaused.slice(0, 18).padEnd(18) + ' | ' + r.paused + (r.brokenByPause ? '   <-- BROKEN BY PAUSE' : ''));
    }
    console.log(`\noperations broken by pause: ${rows.filter(r => r.brokenByPause).length}/${rows.length}`);
}

main().catch(e => { console.error(e); process.exit(1); });
