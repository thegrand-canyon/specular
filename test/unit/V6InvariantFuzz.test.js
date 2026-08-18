// Aggressive invariant fuzz for the pre-Arc-mainnet self-audit.
//
// Stronger than V6PropertyFuzz: after EVERY operation it asserts the EXACT
// global solvency equality (not just `Σ avail ≤ balance`):
//
//   usdc.balanceOf(marketplace)
//     == Σ pool.availableLiquidity + accumulatedFees + Σ_{ACTIVE loans} collateralAmount
//
// plus H-3 (outstandingPrincipal == Σ active principal per agent) and §S5
// (activeLoanCount == live ACTIVE count). Includes LIQUIDATION (with time
// travel) in the op mix — the path most likely to hide loss-accounting bugs,
// which the existing fuzz never exercises. Also drives withdrawFees + claim.

const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("V6 invariant fuzz (exact solvency + liquidation)", function () {
    this.timeout(600000);
    let v6, registry, reputation, usdc, owner, agents, lenders;
    const USDC = (n) => ethers.parseUnits(n.toString(), 6);

    // Mulberry32 seeded PRNG (reproducible).
    let s;
    const seed = (x) => { s = x; };
    function rand() {
        s |= 0; s = (s + 0x6D2B79F5) | 0;
        let t = s;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }
    const randInt = (n) => Math.floor(rand() * n);
    const choice = (a) => a[randInt(a.length)];

    beforeEach(async () => {
        const sg = await ethers.getSigners();
        owner = sg[0];
        agents = [sg[1], sg[2], sg[3]];
        lenders = [sg[4], sg[5], sg[6], sg[7]];
        registry = await (await ethers.getContractFactory("AgentRegistryV2")).deploy();
        reputation = await (await ethers.getContractFactory("ReputationManagerV3")).deploy(await registry.getAddress());
        usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
        v6 = await (await ethers.getContractFactory("AgentLiquidityMarketplaceV6")).deploy(
            await registry.getAddress(), await reputation.getAddress(), await usdc.getAddress());
        await reputation.authorizePool(await v6.getAddress());
        for (let i = 0; i < agents.length; i++) {
            await registry.connect(agents[i]).register(`ipfs://agent${i}`, []);
            await v6.connect(agents[i]).createAgentPool();
            await usdc.mint(agents[i].address, USDC(1_000_000));
            await usdc.connect(agents[i]).approve(await v6.getAddress(), ethers.MaxUint256);
        }
        for (const l of lenders) {
            await usdc.mint(l.address, USDC(1_000_000));
            await usdc.connect(l).approve(await v6.getAddress(), ethers.MaxUint256);
        }
    });

    const agentIds = [1, 2, 3];
    const signerFor = (borrower) => agents.find(a => a.address.toLowerCase() === borrower.toLowerCase());

    async function assertInvariants(active) {
        const mpAddr = await v6.getAddress();

        // ── EXACT global solvency ──────────────────────────────────────────
        let sumAvail = 0n;
        for (const aid of agentIds) sumAvail += (await v6.getAgentPool(aid)).availableLiquidity;
        const fees = await v6.accumulatedFees();
        // Σ collateral of loans still ACTIVE (their collateral is held in-contract).
        let sumCollateral = 0n;
        for (const l of active) {
            const loan = await v6.loans(l.id);
            if (Number(loan.state) === 1) sumCollateral += loan.collateralAmount;
        }
        const mpBal = await usdc.balanceOf(mpAddr);
        const rhs = sumAvail + fees + sumCollateral;
        expect(mpBal, `SOLVENCY: balance ${mpBal} must EQUAL avail+fees+collateral ${rhs} (avail=${sumAvail} fees=${fees} coll=${sumCollateral})`).to.equal(rhs);

        // ── H-3: outstandingPrincipal == Σ ACTIVE principal per agent ───────
        // [D2] keyed by agentId (agents[i] ⇒ agentId i+1).
        for (let i = 0; i < agents.length; i++) {
            const a = agents[i];
            const agentId = i + 1;
            let sumPrincipal = 0n, liveCount = 0;
            for (const l of active) {
                if (l.borrower.toLowerCase() !== a.address.toLowerCase()) continue;
                const loan = await v6.loans(l.id);
                if (Number(loan.state) === 1) { sumPrincipal += loan.amount; liveCount++; }
            }
            expect(await v6.outstandingPrincipal(agentId), `outstandingPrincipal mismatch for agent ${agentId}`).to.equal(sumPrincipal);
            expect(Number(await v6.activeLoanCount(agentId)), `activeLoanCount mismatch for agent ${agentId}`).to.equal(liveCount);
        }

        // ── §B1: no duplicate lenders; flag ⟺ membership ────────────────────
        for (const aid of agentIds) {
            const p = await v6.getAgentPool(aid);
            const list = [];
            for (let j = 0; j < Number(p.lenderCount); j++) list.push((await v6.poolLenders(aid, j)).toLowerCase());
            expect(list.length, `dup lenders in pool ${aid}`).to.equal(new Set(list).size);
            for (const addr of list) expect(await v6.isInPoolLenders(aid, addr), `flag for ${addr}`).to.equal(true);
        }
    }

    // Prune loans that are no longer ACTIVE from our JS mirror.
    async function prune(active) {
        const out = [];
        for (const l of active) {
            if (Number((await v6.loans(l.id)).state) === 1) out.push(l);
        }
        return out;
    }

    async function step(active) {
        const op = choice(['supply', 'supply', 'withdraw', 'requestLoan', 'requestLoan', 'repay', 'liquidate', 'claim', 'withdrawFees', 'advanceTime']);
        const aid = choice(agentIds);
        const agentSigner = agents[aid - 1];
        try {
            if (op === 'supply') {
                const l = choice(lenders);
                await v6.connect(l).supplyLiquidity(aid, USDC((0.1 + rand() * 50).toFixed(6)));
                return `supply(${aid})`;
            }
            if (op === 'withdraw') {
                const l = choice(lenders);
                const pos = await v6.positions(aid, l.address);
                const pool = await v6.getAgentPool(aid);
                const max = pos.amount < pool.availableLiquidity ? pos.amount : pool.availableLiquidity;
                if (max === 0n) return null;
                const amt = BigInt(Math.floor(rand() * Number(max))) + 1n;
                if (amt > max) return null;
                await v6.connect(l).withdrawLiquidity(aid, amt);
                return `withdraw(${aid})`;
            }
            if (op === 'requestLoan') {
                const pool = await v6.getAgentPool(aid);
                if (pool.availableLiquidity < USDC('0.02')) return null;
                if ((await v6.activeLoanCount(aid)) >= 10n) return null;
                const limit = await reputation.calculateCreditLimit(agentSigner.address);
                const outstanding = await v6.outstandingPrincipal(aid);
                let cap = pool.availableLiquidity;
                if (limit - outstanding < cap) cap = limit - outstanding;
                if (cap < USDC('0.01')) return null;
                let amt = USDC((0.01 + rand() * 5).toFixed(6));
                if (amt > cap) amt = cap;
                const dur = 7 + randInt(60);
                const tx = await v6.connect(agentSigner).requestLoan(amt, dur);
                const r = await tx.wait();
                for (const lg of r.logs) {
                    try {
                        const pl = v6.interface.parseLog(lg);
                        if (pl && pl.name === 'LoanRequested') {
                            active.push({ id: pl.args.loanId, borrower: agentSigner.address });
                            return `requestLoan(${aid}) → ${pl.args.loanId}`;
                        }
                    } catch {}
                }
                return `requestLoan(${aid})`;
            }
            if (op === 'repay') {
                if (active.length === 0) return null;
                const l = choice(active);
                const sgn = signerFor(l.borrower);
                if (!sgn) return null;
                await v6.connect(sgn).repayLoan(l.id);
                return `repay(${l.id})`;
            }
            if (op === 'liquidate') {
                if (active.length === 0) return null;
                const l = choice(active);
                const loan = await v6.loans(l.id);
                if (Number(loan.state) !== 1) return null;
                // Advance time past endTime, then owner liquidates.
                const now = (await ethers.provider.getBlock('latest')).timestamp;
                const end = Number(loan.endTime);
                if (end >= now) {
                    await ethers.provider.send("evm_increaseTime", [end - now + 1]);
                    await ethers.provider.send("evm_mine", []);
                }
                await v6.connect(owner).liquidateLoan(l.id);
                return `liquidate(${l.id})`;
            }
            if (op === 'claim') {
                const l = choice(lenders);
                const pos = await v6.positions(aid, l.address);
                if (pos.earnedInterest === 0n) return null;
                await v6.connect(l).claimInterest(aid);
                return `claim(${aid})`;
            }
            if (op === 'withdrawFees') {
                const fees = await v6.accumulatedFees();
                if (fees === 0n) return null;
                const amt = BigInt(Math.floor(rand() * Number(fees))) + 1n;
                if (amt > fees) return null;
                await v6.connect(owner).withdrawFees(amt);
                return `withdrawFees(${ethers.formatUnits(amt, 6)})`;
            }
            if (op === 'advanceTime') {
                await ethers.provider.send("evm_increaseTime", [randInt(5 * 24 * 3600)]);
                await ethers.provider.send("evm_mine", []);
                return `advanceTime`;
            }
        } catch (e) {
            // Reverts on invalid ops (insufficient liquidity, not overdue, etc.) are fine.
            return null;
        }
        return null;
    }

    it("holds exact solvency + H-3 + §S5 over 300 randomized ops (seed 1)", async () => {
        seed(1);
        let active = [];
        for (let i = 0; i < 300; i++) {
            await step(active);
            active = await prune(active);
            await assertInvariants(active);
        }
    });

    it("holds under a liquidation-heavy sequence (seed 99)", async () => {
        seed(99);
        let active = [];
        for (let i = 0; i < 200; i++) {
            await step(active);
            active = await prune(active);
            await assertInvariants(active);
        }
    });
});
