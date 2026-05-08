// Differential test: run identical operations on v4 and V6, document divergences.
// Expected divergences: ONLY at §B1, §S1, §S5 fix sites.
// Anything else diverging is a regression risk.

const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("v4 ↔ V6 differential", function () {
    this.timeout(60000);
    let v4, v6, registry, reputation, usdc;
    let owner, agent, lender1, lender2;
    const USDC = (n) => ethers.parseUnits(n.toString(), 6);

    async function captureState(contract, agentId, lenders) {
        const pool = await contract.getAgentPool(agentId);
        const lc = Number(pool.lenderCount);
        const poolLenders = [];
        for (let j = 0; j < lc; j++) poolLenders.push((await contract.poolLenders(agentId, j)).toLowerCase());

        const positions = {};
        for (const l of lenders) {
            const p = await contract.positions(agentId, l.address);
            positions[l.address.toLowerCase()] = {
                amount: p.amount,
                earnedInterest: p.earnedInterest,
            };
        }

        const usdcBal = await usdc.balanceOf(await contract.getAddress());
        return {
            pool: {
                totalLiquidity: pool.totalLiquidity,
                availableLiquidity: pool.availableLiquidity,
                totalLoaned: pool.totalLoaned,
                totalEarned: pool.totalEarned,
                lenderCount: lc,
            },
            poolLenders,
            positions,
            mpUsdcBalance: usdcBal,
        };
    }

    function diff(s1, s2, label) {
        const divergences = [];
        for (const k of ['totalLiquidity', 'availableLiquidity', 'totalLoaned', 'totalEarned', 'lenderCount']) {
            if (s1.pool[k] !== s2.pool[k]) {
                divergences.push(`pool.${k}: v4=${s1.pool[k]} V6=${s2.pool[k]}`);
            }
        }
        if (s1.poolLenders.length !== s2.poolLenders.length || s1.poolLenders.some((a, i) => a !== s2.poolLenders[i])) {
            divergences.push(`poolLenders: v4=${JSON.stringify(s1.poolLenders)} V6=${JSON.stringify(s2.poolLenders)}`);
        }
        for (const addr of Object.keys(s1.positions)) {
            const p1 = s1.positions[addr], p2 = s2.positions[addr];
            if (!p2) continue;
            for (const k of ['amount', 'earnedInterest']) {
                if (p1[k] !== p2[k]) divergences.push(`pos[${addr.slice(0,10)}].${k}: v4=${p1[k]} V6=${p2[k]}`);
            }
        }
        if (s1.mpUsdcBalance !== s2.mpUsdcBalance) {
            divergences.push(`mpUsdcBalance: v4=${s1.mpUsdcBalance} V6=${s2.mpUsdcBalance}`);
        }
        return divergences;
    }

    beforeEach(async () => {
        [owner, agent, lender1, lender2] = await ethers.getSigners();
        const Registry = await ethers.getContractFactory("AgentRegistryV2");
        registry = await Registry.deploy();
        const Rep = await ethers.getContractFactory("ReputationManagerV3");
        reputation = await Rep.deploy(await registry.getAddress());
        const Mock = await ethers.getContractFactory("MockUSDC");
        usdc = await Mock.deploy();

        const V4 = await ethers.getContractFactory("AgentLiquidityMarketplace");
        v4 = await V4.deploy(await registry.getAddress(), await reputation.getAddress(), await usdc.getAddress());
        const V6 = await ethers.getContractFactory("AgentLiquidityMarketplaceV6");
        v6 = await V6.deploy(await registry.getAddress(), await reputation.getAddress(), await usdc.getAddress());

        await reputation.authorizePool(await v4.getAddress());
        await reputation.authorizePool(await v6.getAddress());

        await registry.connect(agent).register("ipfs://agent", []);

        // Each contract gets its own pool created
        await v4.connect(agent).createAgentPool();
        await v6.connect(agent).createAgentPool();

        // Mint + approve for all participants on both contracts
        for (const w of [agent, lender1, lender2]) {
            await usdc.mint(w.address, USDC(1000));
            await usdc.connect(w).approve(await v4.getAddress(), ethers.MaxUint256);
            await usdc.connect(w).approve(await v6.getAddress(), ethers.MaxUint256);
        }
    });

    it('basic supply on both contracts produces identical state', async () => {
        await v4.connect(lender1).supplyLiquidity(1, USDC(100));
        await v6.connect(lender1).supplyLiquidity(1, USDC(100));

        const s4 = await captureState(v4, 1, [lender1, lender2]);
        const s6 = await captureState(v6, 1, [lender1, lender2]);
        const div = diff(s4, s6);
        expect(div, `unexpected divergence: ${div.join(', ')}`).to.have.lengthOf(0);
    });

    it('§B1 DIVERGENCE: supply→withdraw→supply produces different poolLenders', async () => {
        await v4.connect(lender1).supplyLiquidity(1, USDC(100));
        await v6.connect(lender1).supplyLiquidity(1, USDC(100));
        await v4.connect(lender1).withdrawLiquidity(1, USDC(100));
        await v6.connect(lender1).withdrawLiquidity(1, USDC(100));
        await v4.connect(lender1).supplyLiquidity(1, USDC(50));
        await v6.connect(lender1).supplyLiquidity(1, USDC(50));

        const s4 = await captureState(v4, 1, [lender1]);
        const s6 = await captureState(v6, 1, [lender1]);
        const div = diff(s4, s6);

        // Expected divergence: v4 has 2 poolLenders entries, V6 has 1
        expect(s4.pool.lenderCount).to.equal(2, 'v4 should show §B1 duplicate');
        expect(s6.pool.lenderCount).to.equal(1, 'V6 should have NO duplicate');
        expect(div.some(d => d.includes('lenderCount'))).to.equal(true);
        expect(div.some(d => d.includes('poolLenders'))).to.equal(true);
        // Position state should match (both lenders have the same supplied amount)
        expect(s4.positions[lender1.address.toLowerCase()].amount)
            .to.equal(s6.positions[lender1.address.toLowerCase()].amount);
    });

    it('§S1 DIVERGENCE: claimInterest leaves availableLiquidity inflated on v4 only', async () => {
        // Set up a loan with interest on both
        await v4.connect(lender1).supplyLiquidity(1, USDC(100));
        await v6.connect(lender1).supplyLiquidity(1, USDC(100));
        await v4.connect(agent).requestLoan(USDC(50), 30);
        await v6.connect(agent).requestLoan(USDC(50), 30);
        await v4.connect(agent).repayLoan(1);
        await v6.connect(agent).repayLoan(1);

        // Pre-claim states should match
        const sBefore4 = await captureState(v4, 1, [lender1]);
        const sBefore6 = await captureState(v6, 1, [lender1]);
        expect(sBefore4.pool.availableLiquidity).to.equal(sBefore6.pool.availableLiquidity, 'pre-claim avail should match');
        const interest = sBefore4.positions[lender1.address.toLowerCase()].earnedInterest;
        expect(interest).to.be.gt(0n);

        // Both lenders claim
        await v4.connect(lender1).claimInterest(1);
        await v6.connect(lender1).claimInterest(1);

        const s4 = await captureState(v4, 1, [lender1]);
        const s6 = await captureState(v6, 1, [lender1]);

        // §S1 divergence: v4's availableLiquidity stayed at pre-claim level (NOT decremented)
        //                   V6's availableLiquidity decremented by the claimed amount
        expect(s4.pool.availableLiquidity).to.equal(sBefore4.pool.availableLiquidity,
            'v4 should NOT decrement avail (this is the §S1 bug)');
        expect(s6.pool.availableLiquidity).to.equal(sBefore6.pool.availableLiquidity - interest,
            'V6 should decrement avail by claimed amount');

        // Solvency check: V6's avail ≤ MP balance (correct), v4's avail > MP balance (bug)
        expect(s6.pool.availableLiquidity).to.be.lte(s6.mpUsdcBalance, 'V6 maintains solvency invariant');
        // v4 should have a §S1 leak; the exact size is `lenderInterest − platformFee`
        // because accumulatedFees sits in the MP balance separately from pool.availableLiquidity.
        const leak = s4.pool.availableLiquidity - s4.mpUsdcBalance;
        console.log(`      → §S1 leak on v4: ${ethers.formatUnits(leak, 6)} USDC of phantom liquidity`);
        expect(leak, 'v4 should leak a positive amount').to.be.gt(0n);
        expect(leak, 'leak should be ≤ claimed interest').to.be.lte(interest);
    });

    it('§S5 DIVERGENCE: lifetime loan history affects requestLoan gas on v4 only', async () => {
        // Seed both pools
        await v4.connect(lender1).supplyLiquidity(1, USDC(100));
        await v6.connect(lender1).supplyLiquidity(1, USDC(100));

        // Take + repay 20 loans
        for (let i = 0; i < 20; i++) {
            await v4.connect(agent).requestLoan(USDC(0.1), 7);
            await v4.connect(agent).repayLoan(i + 1);
            await v6.connect(agent).requestLoan(USDC(0.1), 7);
            await v6.connect(agent).repayLoan(i + 1);
        }

        // Measure gas for the 21st loan
        const gasV4 = await v4.connect(agent).requestLoan.estimateGas(USDC(0.1), 7);
        const gasV6 = await v6.connect(agent).requestLoan.estimateGas(USDC(0.1), 7);
        console.log(`      → after 20 lifetime loans: v4 gas=${gasV4}, V6 gas=${gasV6}, ratio=${(Number(gasV4)/Number(gasV6)).toFixed(3)}`);
        expect(gasV4 > gasV6, '§S5: v4 should be slower than V6 with loan history').to.equal(true);
    });

    it('non-fix paths: identical state across many operations', async () => {
        // Run a sequence that doesn't trigger the 3 fix sites — state should match
        await v4.connect(lender1).supplyLiquidity(1, USDC(50));
        await v6.connect(lender1).supplyLiquidity(1, USDC(50));
        await v4.connect(lender2).supplyLiquidity(1, USDC(30));
        await v6.connect(lender2).supplyLiquidity(1, USDC(30));
        await v4.connect(agent).requestLoan(USDC(20), 7);
        await v6.connect(agent).requestLoan(USDC(20), 7);

        const s4 = await captureState(v4, 1, [lender1, lender2]);
        const s6 = await captureState(v6, 1, [lender1, lender2]);
        const div = diff(s4, s6);
        expect(div, `non-fix paths should produce identical state: ${div.join('; ')}`).to.have.lengthOf(0);
    });

    it('liquidateLoan produces identical state on both', async () => {
        await v4.connect(lender1).supplyLiquidity(1, USDC(100));
        await v6.connect(lender1).supplyLiquidity(1, USDC(100));
        await v4.connect(agent).requestLoan(USDC(50), 7);
        await v6.connect(agent).requestLoan(USDC(50), 7);
        // Fast-forward past endTime
        await ethers.provider.send('evm_increaseTime', [8 * 24 * 3600]);
        await ethers.provider.send('evm_mine');

        await v4.liquidateLoan(1);
        await v6.liquidateLoan(1);

        const s4 = await captureState(v4, 1, [lender1]);
        const s6 = await captureState(v6, 1, [lender1]);
        const div = diff(s4, s6);
        expect(div, `liquidateLoan should produce identical state: ${div.join('; ')}`).to.have.lengthOf(0);
    });
});
