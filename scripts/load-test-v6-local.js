/**
 * Comprehensive local load / gas / scale test for the FIXED V6 stack.
 * Run: npx hardhat run scripts/load-test-v6-local.js
 *
 * Deploys a fresh stack on the in-process hardhat network (unlimited funded
 * accounts, precise gas) and stress-tests the fixed contracts at scale:
 *   S1  loan gas flatness over 100 sequential loans (§S5 O(1) DoS fix)
 *   S2  MAX_LENDERS boundary + interest-distribution gas at 50 lenders
 *   S3  socialized-loss (D4) liquidation gas at 50 lenders
 *   S4  resetPoolAccounting gas at 50 lenders
 *   S5  high-op-count invariant stress (exact solvency holds)
 *   S6  lever overhead (rate-limit / minSupply) marginal cost
 */
const { ethers } = require("hardhat");

const USDC = (n) => ethers.parseUnits(String(n), 6);
const fmt = (g) => Number(g).toLocaleString();
let failures = 0;
const assert = (label, cond, detail = "") => {
    console.log(`  ${cond ? "✅" : "❌"} ${label} ${detail}`);
    if (!cond) failures++;
};

async function gasOf(txPromise) {
    const r = await (await txPromise).wait();
    return r.gasUsed;
}

async function loanIdFrom(txPromise, mp) {
    const r = await (await txPromise).wait();
    for (const lg of r.logs) {
        try { const p = mp.interface.parseLog(lg); if (p?.name === "LoanRequested") return { id: p.args.loanId, gas: r.gasUsed }; } catch {}
    }
    return { id: null, gas: r.gasUsed };
}

async function deployStack() {
    const signers = await ethers.getSigners();
    const owner = signers[0];
    const registry = await (await ethers.getContractFactory("AgentRegistryV2")).deploy();
    const reputation = await (await ethers.getContractFactory("ReputationManagerV3")).deploy(await registry.getAddress());
    const usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
    const v6 = await (await ethers.getContractFactory("AgentLiquidityMarketplaceV6")).deploy(
        await registry.getAddress(), await reputation.getAddress(), await usdc.getAddress());
    await reputation.authorizePool(await v6.getAddress());
    return { owner, registry, reputation, usdc, v6, signers };
}

async function pumpTier(reputation, owner, agentAddr, targetScore) {
    // Owner-authorized direct rep pump to reach a 0%-collateral tier fast (rate
    // limit off during this helper). Each 100-USDC completion = +10.
    await reputation.authorizePool(owner.address);
    for (let i = 0; i < Math.ceil(targetScore / 10) + 1; i++) {
        await reputation.recordLoanCompletion(agentAddr, USDC(100), true);
    }
}

async function main() {
    console.log("=== Specular V6 fixed-stack local load test ===\n");

    // ── S1: loan gas flatness over 100 sequential loans (§S5) ──────────────
    {
        console.log("S1 — loan gas flatness over 100 sequential loans (§S5 O(1))");
        const { owner, registry, reputation, usdc, v6, signers } = await deployStack();
        const agent = signers[1], lender = signers[2];
        await registry.connect(agent).register("ipfs://a", []);
        await v6.connect(agent).createAgentPool();
        await pumpTier(reputation, owner, agent.address, 600); // 0% collateral tier
        for (const w of [agent, lender]) { await usdc.mint(w.address, USDC(1_000_000)); await usdc.connect(w).approve(await v6.getAddress(), ethers.MaxUint256); }
        await v6.connect(lender).supplyLiquidity(1, USDC(500_000));

        const reqGas = [], repGas = [];
        const N = 100;
        for (let i = 0; i < N; i++) {
            const { id, gas } = await loanIdFrom(v6.connect(agent).requestLoan(USDC(10), 30), v6);
            reqGas.push(Number(gas));
            repGas.push(Number(await gasOf(v6.connect(agent).repayLoan(id))));
        }
        const avgFirst = (reqGas.slice(0, 5).reduce((a, b) => a + b) / 5);
        const avgLast = (reqGas.slice(-5).reduce((a, b) => a + b) / 5);
        const ratio = avgLast / avgFirst;
        console.log(`     requestLoan gas: loan 1-5 avg ${fmt(Math.round(avgFirst))}, loan 96-100 avg ${fmt(Math.round(avgLast))}, ratio ${ratio.toFixed(3)}`);
        console.log(`     repayLoan   gas: first ${fmt(repGas[0])}, last ${fmt(repGas[N - 1])}`);
        assert("requestLoan gas FLAT over 100 loans (ratio < 1.10)", ratio < 1.10, `(ratio ${ratio.toFixed(3)})`);
    }

    // ── S2: MAX_LENDERS boundary + interest-distribution gas at 50 lenders ──
    {
        console.log("\nS2 — MAX_LENDERS (50) boundary + interest-distribution gas");
        const { owner, registry, reputation, usdc, v6, signers } = await deployStack();
        const agent = signers[1];
        await registry.connect(agent).register("ipfs://a", []);
        await v6.connect(agent).createAgentPool();
        await pumpTier(reputation, owner, agent.address, 600);
        await usdc.mint(agent.address, USDC(1_000_000)); await usdc.connect(agent).approve(await v6.getAddress(), ethers.MaxUint256);

        // 50 distinct lenders each supply.
        for (let i = 0; i < 50; i++) {
            const l = signers[i + 2] || ethers.Wallet.createRandom().connect(ethers.provider);
            if (!signers[i + 2]) { await owner.sendTransaction({ to: l.address, value: ethers.parseEther("1") }); }
            await usdc.mint(l.address, USDC(1000)); await usdc.connect(l).approve(await v6.getAddress(), ethers.MaxUint256);
            await v6.connect(l).supplyLiquidity(1, USDC(100));
        }
        const pool = await v6.getAgentPool(1);
        assert("pool has exactly 50 lenders", pool.lenderCount === 50n, `(${pool.lenderCount})`);
        // 51st lender must be rejected.
        const l51 = ethers.Wallet.createRandom().connect(ethers.provider);
        await owner.sendTransaction({ to: l51.address, value: ethers.parseEther("1") });
        await usdc.mint(l51.address, USDC(1000)); await usdc.connect(l51).approve(await v6.getAddress(), ethers.MaxUint256);
        let capped = false;
        try { await v6.connect(l51).supplyLiquidity(1, USDC(100)); } catch { capped = true; }
        assert("51st lender rejected (cap enforced)", capped);

        // Loan + repay → repayLoan runs _distributeInterest over all 50 lenders.
        const { id } = await loanIdFrom(v6.connect(agent).requestLoan(USDC(1000), 30), v6);
        const repayGas = await gasOf(v6.connect(agent).repayLoan(id));
        console.log(`     repayLoan gas @ 50 lenders (distributes interest): ${fmt(repayGas)}`);
        assert("repay @ 50 lenders well under block limit (< 3M gas)", repayGas < 3_000_000n);
    }

    // ── S3: socialized-loss (D4) liquidation gas at 50 lenders ─────────────
    {
        console.log("\nS3 — socialized-loss liquidation gas at 50 lenders (D4)");
        const { owner, registry, reputation, usdc, v6, signers } = await deployStack();
        const agent = signers[1];
        await registry.connect(agent).register("ipfs://a", []);
        await v6.connect(agent).createAgentPool();
        await pumpTier(reputation, owner, agent.address, 600);
        await usdc.mint(agent.address, USDC(1_000_000)); await usdc.connect(agent).approve(await v6.getAddress(), ethers.MaxUint256);
        for (let i = 0; i < 50; i++) {
            const l = signers[i + 2] || ethers.Wallet.createRandom().connect(ethers.provider);
            if (!signers[i + 2]) await owner.sendTransaction({ to: l.address, value: ethers.parseEther("1") });
            await usdc.mint(l.address, USDC(1000)); await usdc.connect(l).approve(await v6.getAddress(), ethers.MaxUint256);
            await v6.connect(l).supplyLiquidity(1, USDC(100));
        }
        // 0-collateral loan → full loss on default.
        const { id } = await loanIdFrom(v6.connect(agent).requestLoan(USDC(2000), 30), v6);
        const loan = await v6.loans(id);
        await ethers.provider.send("evm_increaseTime", [Number(loan.endTime) - (await ethers.provider.getBlock("latest")).timestamp + 1]);
        await ethers.provider.send("evm_mine", []);
        const liqGas = await gasOf(v6.connect(owner).liquidateLoan(id));
        console.log(`     liquidateLoan gas @ 50 lenders (_socializeLoss): ${fmt(liqGas)}`);
        assert("socialized liquidation @ 50 lenders < 3M gas", liqGas < 3_000_000n);
        // Solvency after socialized loss.
        const p = await v6.getAgentPool(1);
        const bal = await usdc.balanceOf(await v6.getAddress());
        assert("solvent after socialized default", bal >= p.availableLiquidity + (await v6.accumulatedFees()));
    }

    // ── S4: resetPoolAccounting gas at 50 lenders ──────────────────────────
    {
        console.log("\nS4 — resetPoolAccounting gas at 50 lenders");
        const { owner, registry, reputation, usdc, v6, signers } = await deployStack();
        const agent = signers[1];
        await registry.connect(agent).register("ipfs://a", []);
        await v6.connect(agent).createAgentPool();
        for (let i = 0; i < 50; i++) {
            const l = signers[i + 2] || ethers.Wallet.createRandom().connect(ethers.provider);
            if (!signers[i + 2]) await owner.sendTransaction({ to: l.address, value: ethers.parseEther("1") });
            await usdc.mint(l.address, USDC(1000)); await usdc.connect(l).approve(await v6.getAddress(), ethers.MaxUint256);
            await v6.connect(l).supplyLiquidity(1, USDC(100));
        }
        const g = await gasOf(v6.connect(owner).resetPoolAccounting(1));
        console.log(`     resetPoolAccounting gas @ 50 lenders: ${fmt(g)}`);
        assert("resetPoolAccounting @ 50 lenders < 2M gas", g < 2_000_000n);
    }

    // ── S5: high-op-count invariant stress ─────────────────────────────────
    {
        console.log("\nS5 — high-op-count invariant stress (exact solvency)");
        const { owner, registry, reputation, usdc, v6, signers } = await deployStack();
        const agents = [signers[1], signers[2], signers[3]];
        const lenders = [signers[4], signers[5], signers[6], signers[7]];
        for (let i = 0; i < agents.length; i++) { await registry.connect(agents[i]).register(`ipfs://a${i}`, []); await v6.connect(agents[i]).createAgentPool(); await pumpTier(reputation, owner, agents[i].address, 600); }
        for (const w of [...agents, ...lenders]) { await usdc.mint(w.address, USDC(1_000_000)); await usdc.connect(w).approve(await v6.getAddress(), ethers.MaxUint256); }

        let ops = 0, violations = 0;
        const checkSolvency = async () => {
            let avail = 0n, coll = 0n;
            for (const aid of [1, 2, 3]) avail += (await v6.getAgentPool(aid)).availableLiquidity;
            const n = await v6.nextLoanId();
            for (let id = 1n; id < n; id++) { const l = await v6.loans(id); if (Number(l.state) === 1) coll += l.collateralAmount; }
            const bal = await usdc.balanceOf(await v6.getAddress());
            if (bal !== avail + (await v6.accumulatedFees()) + coll) violations++;
        };
        const active = [];
        for (let round = 0; round < 250; round++) {
            const aid = 1 + (round % 3), agent = agents[aid - 1], lender = lenders[round % 4];
            try {
                const r = round % 5;
                if (r === 0) { await v6.connect(lender).supplyLiquidity(aid, USDC(50)); ops++; }
                else if (r === 1) { const pool = await v6.getAgentPool(aid); if (pool.availableLiquidity > USDC(10) && (await v6.activeLoanCount(aid)) < 10n) { const { id } = await loanIdFrom(v6.connect(agent).requestLoan(USDC(5), 30), v6); if (id != null) active.push({ id, agent }); ops++; } }
                else if (r === 2 && active.length) { const l = active.shift(); await v6.connect(l.agent).repayLoan(l.id); ops++; }
                else if (r === 3) { const pos = await v6.positions(aid, lender.address); const pool = await v6.getAgentPool(aid); const max = pos.amount < pool.availableLiquidity ? pos.amount : pool.availableLiquidity; if (max > 0n) { await v6.connect(lender).withdrawLiquidity(aid, max / 2n > 0n ? max / 2n : max); ops++; } }
                else if (r === 4) { const pos = await v6.positions(aid, lender.address); if (pos.earnedInterest > 0n) { await v6.connect(lender).claimInterest(aid); ops++; } }
            } catch {}
            if (round % 10 === 0) await checkSolvency();
        }
        await checkSolvency();
        console.log(`     ${ops} successful ops across 3 agents / 4 lenders`);
        assert("exact solvency held across all checkpoints", violations === 0, `(${violations} violations)`);
    }

    // ── S6: lever overhead ─────────────────────────────────────────────────
    {
        console.log("\nS6 — lever overhead (rate-limit / minSupply marginal cost)");
        const base = await deployStack();
        const lev = await deployStack();
        // levers ON on `lev`
        await lev.v6.setMinSupplyAmount(USDC(1));
        await lev.reputation.setReputationRateLimit(20, 86400);
        await lev.v6.setMinHoldForReputationReward(86400);
        for (const s of [base, lev]) {
            const agent = s.signers[1], lender = s.signers[2];
            await s.registry.connect(agent).register("ipfs://a", []);
            await s.v6.connect(agent).createAgentPool();
            await pumpTier(s.reputation, s.owner, agent.address, 600);
            for (const w of [agent, lender]) { await s.usdc.mint(w.address, USDC(100_000)); await s.usdc.connect(w).approve(await s.v6.getAddress(), ethers.MaxUint256); }
        }
        const gBaseSupply = await gasOf(base.v6.connect(base.signers[2]).supplyLiquidity(1, USDC(100)));
        const gLevSupply = await gasOf(lev.v6.connect(lev.signers[2]).supplyLiquidity(1, USDC(100)));
        console.log(`     supply gas: baseline ${fmt(gBaseSupply)}, levers ON ${fmt(gLevSupply)}, overhead ${fmt(gLevSupply - gBaseSupply)}`);
        assert("minSupply lever overhead negligible (< 5k gas)", (gLevSupply - gBaseSupply) < 5000n);
    }

    console.log(`\n=== LOAD TEST: ${failures === 0 ? "ALL PASS" : failures + " FAILURES"} ===`);
    if (failures) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
