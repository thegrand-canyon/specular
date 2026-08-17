// Property-based fuzz on V6: 200+ randomized state sequences.
// After every operation, asserts §B1, §S1, and §S5 invariants.

const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("V6 property-based fuzz", function () {
    this.timeout(180000);
    let v6, registry, reputation, usdc;
    let owner, agents, lenders;
    const USDC = (n) => ethers.parseUnits(n.toString(), 6);

    // Mulberry32 PRNG with fixed seed for reproducibility
    let rngState;
    function mkRng(seed) { rngState = seed; }
    function rand() {
        rngState |= 0; rngState = (rngState + 0x6D2B79F5) | 0;
        let t = rngState;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }
    const randInt = (n) => Math.floor(rand() * n);
    const choice = (arr) => arr[randInt(arr.length)];

    beforeEach(async () => {
        const signers = await ethers.getSigners();
        owner = signers[0];
        agents = [signers[1], signers[2], signers[3]];        // 3 agents
        lenders = [signers[4], signers[5], signers[6], signers[7]];  // 4 distinct lenders

        const Registry = await ethers.getContractFactory("AgentRegistryV2");
        registry = await Registry.deploy();
        await registry.waitForDeployment();
        const Rep = await ethers.getContractFactory("ReputationManagerV3");
        reputation = await Rep.deploy(await registry.getAddress());
        await reputation.waitForDeployment();
        const Mock = await ethers.getContractFactory("MockUSDC");
        usdc = await Mock.deploy();
        await usdc.waitForDeployment();

        const V6 = await ethers.getContractFactory("AgentLiquidityMarketplaceV6");
        v6 = await V6.deploy(
            await registry.getAddress(),
            await reputation.getAddress(),
            await usdc.getAddress()
        );
        await v6.waitForDeployment();
        await reputation.authorizePool(await v6.getAddress());

        // Register each agent + create their pool
        for (let i = 0; i < agents.length; i++) {
            await registry.connect(agents[i]).register(`ipfs://agent${i}`, []);
            await v6.connect(agents[i]).createAgentPool();
            await usdc.mint(agents[i].address, USDC(100));
            await usdc.connect(agents[i]).approve(await v6.getAddress(), ethers.MaxUint256);
        }
        // Mint to lenders
        for (const l of lenders) {
            await usdc.mint(l.address, USDC(100));
            await usdc.connect(l).approve(await v6.getAddress(), ethers.MaxUint256);
        }
    });

    // ============================================================================
    // Invariant assertions — called after every operation
    // ============================================================================

    async function getPoolLenders(agentId) {
        const pool = await v6.getAgentPool(agentId);
        const lc = Number(pool.lenderCount);
        const list = [];
        for (let j = 0; j < lc; j++) list.push((await v6.poolLenders(agentId, j)).toLowerCase());
        return list;
    }

    async function assertInvariants(agentIds) {
        // §B1: poolLenders has no duplicates
        for (const aid of agentIds) {
            const list = await getPoolLenders(aid);
            const unique = new Set(list);
            expect(list.length, `agentId=${aid} poolLenders must have no duplicates`).to.equal(unique.size);

            // §B1 flag invariant: addr in poolLenders ⟺ isInPoolLenders[addr]==true
            for (const addr of list) {
                expect(await v6.isInPoolLenders(aid, addr), `flag must be true for ${addr}`).to.equal(true);
            }
        }

        // §S1: Σ pool.availableLiquidity + accumulatedFees ≤ usdc.balanceOf(MP)
        // [audit 2026-08] fees MUST be in this sum — omitting it is exactly what
        // let the H-1 phantom-liquidity bug hide from the fuzz originally.
        let sumAvail = 0n, sumLoaned = 0n;
        for (const aid of agentIds) {
            const p = await v6.getAgentPool(aid);
            sumAvail += p.availableLiquidity;
            sumLoaned += p.totalLoaned;
        }
        const fees = await v6.accumulatedFees();
        const mpBal = await usdc.balanceOf(await v6.getAddress());
        expect(sumAvail + fees, `Σ avail ${sumAvail} + fees ${fees} must be ≤ mpBal ${mpBal}`).to.be.lte(mpBal);

        // §S5: every agent's activeLoanCount must equal the live count of ACTIVE loans
        for (let i = 0; i < agents.length; i++) {
            const counter = await v6.activeLoanCount(agents[i].address);
            // walk agentLoans to count
            let actual = 0;
            for (let j = 0; j < 100; j++) {
                try {
                    const lid = await v6.agentLoans(agents[i].address, j);
                    const loan = await v6.loans(lid);
                    if (Number(loan.state) === 1) actual++;
                } catch { break; }
            }
            expect(Number(counter), `agent ${i} counter mismatch`).to.equal(actual);
            expect(Number(counter), `agent ${i} counter ≤ 10`).to.be.at.most(10);
        }
    }

    // ============================================================================
    // Operation generators
    // ============================================================================

    async function tryOp(agentIds, activeLoans) {
        const op = choice(['supply', 'withdraw', 'requestLoan', 'repayLoan', 'claimInterest']);
        const aid = choice(agentIds);
        const agentSigner = agents[aid - 1]; // agentIds are 1-indexed
        try {
            if (op === 'supply') {
                const lender = choice(lenders);
                const amt = USDC((0.1 + rand() * 5).toFixed(6));
                await v6.connect(lender).supplyLiquidity(aid, amt);
                return `supply(${aid}, ${ethers.formatUnits(amt, 6)}) by ${lender.address.slice(0,8)}`;
            }
            if (op === 'withdraw') {
                const lender = choice(lenders);
                const pos = await v6.positions(aid, lender.address);
                if (pos.amount === 0n) return null;
                const pool = await v6.getAgentPool(aid);
                const max = pos.amount < pool.availableLiquidity ? pos.amount : pool.availableLiquidity;
                if (max === 0n) return null;
                const amt = BigInt(Math.floor(rand() * Number(max))) + 1n;
                if (amt > max) return null;
                await v6.connect(lender).withdrawLiquidity(aid, amt);
                return `withdraw(${aid}, ${ethers.formatUnits(amt, 6)}) by ${lender.address.slice(0,8)}`;
            }
            if (op === 'requestLoan') {
                const pool = await v6.getAgentPool(aid);
                if (pool.availableLiquidity === 0n) return null;
                const counter = await v6.activeLoanCount(agentSigner.address);
                if (counter >= 10n) return null;
                let amt = USDC((0.1 + rand() * 1).toFixed(6));
                if (amt > pool.availableLiquidity) amt = pool.availableLiquidity / 2n;
                if (amt < USDC('0.01')) return null;
                const dur = 7 + randInt(30);
                const tx = await v6.connect(agentSigner).requestLoan(amt, dur);
                const r = await tx.wait();
                const iface = new ethers.Interface(v6.interface.fragments.map(f => f.format('full')));
                for (const lg of r.logs) {
                    try {
                        const p = iface.parseLog(lg);
                        if (p && p.name === 'LoanRequested') {
                            activeLoans.push({ id: p.args.loanId, agent: aid, borrower: agentSigner.address });
                            return `requestLoan(${aid}, ${ethers.formatUnits(amt, 6)}, ${dur}d) → loan ${p.args.loanId}`;
                        }
                    } catch {}
                }
                return `requestLoan(${aid}, ${ethers.formatUnits(amt, 6)}, ${dur}d)`;
            }
            if (op === 'repayLoan') {
                if (activeLoans.length === 0) return null;
                const idx = randInt(activeLoans.length);
                const l = activeLoans[idx];
                const signer = agents.find(a => a.address.toLowerCase() === l.borrower.toLowerCase());
                if (!signer) return null;
                await v6.connect(signer).repayLoan(l.id);
                activeLoans.splice(idx, 1);
                return `repayLoan(${l.id})`;
            }
            if (op === 'claimInterest') {
                const lender = choice(lenders);
                const pos = await v6.positions(aid, lender.address);
                if (pos.earnedInterest === 0n) return null;
                await v6.connect(lender).claimInterest(aid);
                return `claimInterest(${aid}) by ${lender.address.slice(0,8)}`;
            }
        } catch (e) {
            // Operation reverted — that's OK, it just means the op wasn't valid in current state
            return null;
        }
        return null;
    }

    // ============================================================================
    // Main fuzz test
    // ============================================================================

    it('200 random operations: invariants hold throughout', async function () {
        mkRng(42);
        const agentIds = [1, 2, 3];
        const activeLoans = [];

        let opsExecuted = 0, opsAttempted = 0;
        for (let i = 0; i < 200; i++) {
            opsAttempted++;
            const result = await tryOp(agentIds, activeLoans);
            if (result) {
                opsExecuted++;
                await assertInvariants(agentIds);
            }
        }

        console.log(`      → ${opsExecuted} ops executed (${opsAttempted - opsExecuted} skipped due to preconditions)`);
        console.log(`      → ${activeLoans.length} active loans remaining`);
        expect(opsExecuted, 'expected at least 50 successful ops').to.be.at.least(50);
    });

    it('different seed (seed=137) produces different walk, invariants still hold', async function () {
        mkRng(137);
        const agentIds = [1, 2, 3];
        const activeLoans = [];

        let opsExecuted = 0;
        for (let i = 0; i < 100; i++) {
            const r = await tryOp(agentIds, activeLoans);
            if (r) {
                opsExecuted++;
                await assertInvariants(agentIds);
            }
        }
        console.log(`      → ${opsExecuted} ops executed`);
        expect(opsExecuted).to.be.at.least(20);
    });

    it('§B1 stress: repeated supply→withdraw→supply cycles never create duplicates', async function () {
        const lender = lenders[0];
        const aid = 1;
        for (let i = 0; i < 25; i++) {
            await v6.connect(lender).supplyLiquidity(aid, USDC(1));
            // After each supply the lender must appear exactly once — never a
            // duplicate (the §B1 guarantee).
            let list = await getPoolLenders(aid);
            expect(list.length, 'no duplicate entry after supply').to.equal(1);
            expect(list[0]).to.equal(lender.address.toLowerCase());
            expect(await v6.isInPoolLenders(aid, lender.address)).to.equal(true);

            await v6.connect(lender).withdrawLiquidity(aid, USDC(1));
            // [H-2] Full withdrawal frees the slot: entry removed, flag cleared.
            list = await getPoolLenders(aid);
            expect(list.length, 'slot freed on full withdrawal').to.equal(0);
            expect(await v6.isInPoolLenders(aid, lender.address)).to.equal(false);
        }
    });

    it('§S5 stress: 50+ lifetime loans, gas stays flat', async function () {
        const aid = 1;
        const agentSigner = agents[0];
        await v6.connect(lenders[0]).supplyLiquidity(aid, USDC(50));

        // Take + repay 50 loans (under the cap of 10 active at any time)
        const gasReadings = [];
        for (let i = 0; i < 50; i++) {
            const est = await v6.connect(agentSigner).requestLoan.estimateGas(USDC(0.1), 7);
            gasReadings.push(Number(est));
            const tx = await v6.connect(agentSigner).requestLoan(USDC(0.1), 7);
            const r = await tx.wait();
            // Find loanId
            const iface = v6.interface;
            for (const lg of r.logs) {
                try {
                    const p = iface.parseLog(lg);
                    if (p && p.name === 'LoanRequested') {
                        await v6.connect(agentSigner).repayLoan(p.args.loanId);
                        break;
                    }
                } catch {}
            }
        }
        const first = gasReadings[0];
        const last = gasReadings[gasReadings.length - 1];
        const ratio = last / first;
        console.log(`      → loan 1 gas: ${first}, loan 50 gas: ${last}, ratio: ${ratio.toFixed(3)}`);
        expect(ratio, 'gas should not scale with loan history').to.be.lt(1.3);
    });

    it('§S1 invariant under multi-lender + repeated claim/repay cycles', async function () {
        const aid = 1;
        const agentSigner = agents[0];
        // 4 lenders supply
        for (let i = 0; i < 4; i++) {
            await v6.connect(lenders[i]).supplyLiquidity(aid, USDC(1 + i));  // 1, 2, 3, 4 USDC
        }
        // 5 loan cycles
        for (let i = 0; i < 5; i++) {
            const tx = await v6.connect(agentSigner).requestLoan(USDC(0.5), 30);
            const r = await tx.wait();
            for (const lg of r.logs) {
                try {
                    const p = v6.interface.parseLog(lg);
                    if (p && p.name === 'LoanRequested') {
                        await v6.connect(agentSigner).repayLoan(p.args.loanId);
                        break;
                    }
                } catch {}
            }
            // Each lender claims after every loan
            for (const lender of lenders.slice(0, 4)) {
                const pos = await v6.positions(aid, lender.address);
                if (pos.earnedInterest > 0n) {
                    await v6.connect(lender).claimInterest(aid);
                }
            }
            // §S1 invariant
            const pool = await v6.getAgentPool(aid);
            const mpBal = await usdc.balanceOf(await v6.getAddress());
            expect(pool.availableLiquidity).to.be.lte(mpBal);
        }
    });
});
