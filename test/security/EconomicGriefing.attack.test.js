// SECURITY TEST — economic / game-theory / griefing attacks. For fully-defended
// vectors we assert a revert/block; for the DISCLOSED RESIDUALS (D1 farming, D2,
// D4, D6, faucet Sybil) we assert the mitigation BOUNDS the attacker (asserting a
// revert would be wrong — the point is the bound holds).

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("SECURITY: economic + griefing", function () {
    let v6, registry, reputation, faucet, usdc, owner, agent, attacker, l1, l2;
    const USDC = (n) => ethers.parseUnits(String(n), 6);

    beforeEach(async () => {
        [owner, agent, attacker, l1, l2] = await ethers.getSigners();
        registry = await (await ethers.getContractFactory("AgentRegistryV2")).deploy();
        reputation = await (await ethers.getContractFactory("ReputationManagerV3")).deploy(await registry.getAddress());
        usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
        v6 = await (await ethers.getContractFactory("AgentLiquidityMarketplaceV6")).deploy(
            await registry.getAddress(), await reputation.getAddress(), await usdc.getAddress());
        faucet = await (await ethers.getContractFactory("AgentCreditFaucet")).deploy(await registry.getAddress(), await usdc.getAddress());
        await reputation.authorizePool(await v6.getAddress());
        for (const w of [agent, attacker, l1, l2]) { await usdc.mint(w.address, USDC(1_000_000)); await usdc.connect(w).approve(await v6.getAddress(), ethers.MaxUint256); }
        await registry.connect(agent).register("ipfs://a", []);
        await v6.connect(agent).createAgentPool();
    });

    async function pump(addr, score) { await reputation.authorizePool(owner.address); for (let i = 0; i < Math.ceil(score / 10) + 1; i++) await reputation.recordLoanCompletion(addr, USDC(100), true); }

    describe("credit-limit bypass (H-3) — BLOCKED", () => {
        it("cannot exceed credit limit in aggregate across concurrent loans", async () => {
            await v6.connect(l1).supplyLiquidity(1, USDC(50000));
            const limit = await reputation.calculateCreditLimit(agent.address); // 1000 at score 0
            // First loan uses 70% of limit; a second 40% loan must exceed the aggregate.
            await v6.connect(agent).requestLoan((limit * 70n) / 100n, 30);
            await expect(v6.connect(agent).requestLoan((limit * 40n) / 100n, 30)).to.be.revertedWith("Exceeds credit limit");
        });
        it("cannot exceed MAX_ACTIVE_LOANS_PER_AGENT", async () => {
            await pump(agent.address, 600); // 0% collateral so many small loans fit under the limit
            await v6.connect(l1).supplyLiquidity(1, USDC(50000));
            for (let i = 0; i < 10; i++) await v6.connect(agent).requestLoan(USDC(1), 7);
            await expect(v6.connect(agent).requestLoan(USDC(1), 7)).to.be.revertedWith("Too many active loans");
        });
    });

    describe("D1 reputation farming — BOUNDED (rate-limit + gates)", () => {
        it("dust loans earn ZERO reputation (interest-gate + principal-scale)", async () => {
            await v6.connect(l1).supplyLiquidity(1, USDC(5000));
            const before = await reputation["getReputationScore(address)"](agent.address);
            // 1e-6 USDC loan → interest rounds to 0 → no reputation.
            const r = await (await v6.connect(agent).requestLoan(USDC("0.000001"), 7)).wait();
            let id; for (const lg of r.logs) { try { const p = v6.interface.parseLog(lg); if (p?.name === "LoanRequested") { id = p.args.loanId; break; } } catch {} }
            await v6.connect(agent).repayLoan(id);
            expect(await reputation["getReputationScore(address)"](agent.address)).to.equal(before);
        });
        it("rate-limit caps reputation gain per window despite 10 concurrent loans", async () => {
            await reputation.setReputationRateLimit(20, 24 * 60 * 60); // 20/day
            await reputation.authorizePool(owner.address);
            const before = await reputation["getReputationScore(address)"](agent.address);
            for (let i = 0; i < 10; i++) await reputation.recordLoanCompletion(agent.address, USDC(100), true);
            const gained = (await reputation["getReputationScore(address)"](agent.address)) - before;
            expect(gained).to.equal(20n); // NOT 100 — concurrency can't beat the window cap
        });
    });

    describe("D2 NFT-transfer credit reset — BLOCKED even with M-1 OFF", () => {
        it("outstandingPrincipal follows agentId across transfer (M-1 off)", async () => {
            // bindBorrowToPoolCreator stays OFF → proves the agentId re-key alone holds.
            await v6.connect(l1).supplyLiquidity(1, USDC(50000));
            await v6.connect(agent).requestLoan(USDC(500), 30);
            expect(await v6.outstandingPrincipal(1)).to.equal(USDC(500));
            await registry.connect(agent).transferFrom(agent.address, attacker.address, 1);
            expect(await v6.outstandingPrincipal(1)).to.equal(USDC(500)); // NOT reset
            const limit = await reputation.calculateCreditLimit(attacker.address);
            await expect(v6.connect(attacker).requestLoan(limit - USDC(500) + 1n, 30)).to.be.revertedWith("Exceeds credit limit");
        });
    });

    describe("F-C lender-slot squatting — BOUNDED (min supply)", () => {
        it("sub-minimum new slot is rejected once the lever is on", async () => {
            await v6.setMinSupplyAmount(USDC(1));
            await expect(v6.connect(attacker).supplyLiquidity(1, USDC("0.000001"))).to.be.revertedWith("Below minimum supply");
        });
    });

    describe("D4 socialized loss — fair pro-rata, no last-withdrawer dump", () => {
        it("a lossy default reduces all lender positions proportionally", async () => {
            await pump(agent.address, 600); // 0% collateral → full loss on default
            await v6.connect(l1).supplyLiquidity(1, USDC(100));
            await v6.connect(l2).supplyLiquidity(1, USDC(100));
            const r = await (await v6.connect(agent).requestLoan(USDC(150), 30)).wait();
            let id; for (const lg of r.logs) { try { const p = v6.interface.parseLog(lg); if (p?.name === "LoanRequested") { id = p.args.loanId; break; } } catch {} }
            await time.increase(31 * 24 * 3600);
            await v6.connect(owner).liquidateLoan(id);
            const p1 = (await v6.positions(1, l1.address)).amount;
            const p2 = (await v6.positions(1, l2.address)).amount;
            expect(p1).to.equal(p2); // equal stakes → equal loss (pro-rata), no FCFS dump
            // solvent
            expect(await usdc.balanceOf(await v6.getAddress())).to.be.gte((await v6.getAgentPool(1)).availableLiquidity);
        });
    });

    describe("faucet Sybil — per-address + per-agent dedup (M-3)", () => {
        it("blocks register→claim→transfer→re-register from one EOA", async () => {
            await faucet.setMaxEligibleAgentId(100);
            await usdc.mint(await faucet.getAddress(), USDC(1000));
            await faucet.connect(agent).claim();
            await registry.connect(agent).transferFrom(agent.address, attacker.address, 1);
            await registry.connect(agent).register("ipfs://again", []); // fresh agentId, same EOA
            await expect(faucet.connect(agent).claim()).to.be.revertedWith("Address already claimed");
        });
    });
});
