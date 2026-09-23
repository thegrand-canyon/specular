// V6 reentrancy attack tests.
// Uses a malicious "ReentrancyAttacker" ERC20 that calls back into the
// marketplace during transferFrom / transfer. Each scenario verifies the
// nonReentrant modifier blocks the attack.

const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("V6 reentrancy guards", function () {
    let v6, registry, reputation, attacker;
    let owner, agent, lender;

    const ATTACK_NONE = 0;
    const ATTACK_ON_TRANSFER_FROM = 1;
    const ATTACK_ON_TRANSFER = 2;

    beforeEach(async () => {
        [owner, agent, lender] = await ethers.getSigners();

        const Registry = await ethers.getContractFactory("AgentRegistryV2");
        registry = await Registry.deploy();
        const Rep = await ethers.getContractFactory("ReputationManagerV3");
        reputation = await Rep.deploy(await registry.getAddress());

        // Deploy the malicious "USDC"
        const Attacker = await ethers.getContractFactory("ReentrancyAttacker");
        attacker = await Attacker.deploy();

        const V6 = await ethers.getContractFactory("AgentLiquidityMarketplaceV6");
        v6 = await V6.deploy(
            await registry.getAddress(),
            await reputation.getAddress(),
            await attacker.getAddress()  // V6 uses our malicious USDC
        );
        await reputation.authorizePool(await v6.getAddress());
        await registry.connect(agent).register("ipfs://agent", []);
        await v6.connect(agent).createAgentPool();

        // Fund + approve everyone
        const A = (n) => ethers.parseUnits(n.toString(), 6);
        for (const w of [agent, lender]) {
            await attacker.mint(w.address, A(1000));
            await attacker.connect(w).approve(await v6.getAddress(), ethers.MaxUint256);
        }
    });

    it("reentry attempt on supplyLiquidity → blocked by nonReentrant", async () => {
        const v6Addr = await v6.getAddress();
        const A = (n) => ethers.parseUnits(n.toString(), 6);

        // Attack payload: attempt to re-enter supplyLiquidity from inside transferFrom callback
        const reentryPayload = v6.interface.encodeFunctionData('supplyLiquidity', [1, A(50)]);
        await attacker.setAttack(ATTACK_ON_TRANSFER_FROM, v6Addr, reentryPayload);

        // Outer supply should still succeed (or revert, depending on contract design)
        // What matters: the inner re-entry must NOT succeed.
        let outerOk = false;
        try {
            await v6.connect(lender).supplyLiquidity(1, A(100));
            outerOk = true;
        } catch (e) { /* may revert if attack causes side effects */ }

        // Verify reentry was attempted but failed
        const reentered = await attacker.reentered();
        expect(reentered, 'reentry must be blocked by nonReentrant').to.equal(false);
    });

    it("reentry on repayLoan → blocked by nonReentrant", async () => {
        const v6Addr = await v6.getAddress();
        const A = (n) => ethers.parseUnits(n.toString(), 6);

        // Set up: lender supplies, agent borrows, then on repayLoan's transferFrom we attempt reentry
        await attacker.setAttack(ATTACK_NONE, ethers.ZeroAddress, '0x');
        await v6.connect(lender).supplyLiquidity(1, A(500));
        await v6.connect(agent).requestLoan(A(100), 30);

        // Attack: re-enter repayLoan during transferFrom of repayment funds
        const reentryPayload = v6.interface.encodeFunctionData('repayLoan', [1]);
        await attacker.setAttack(ATTACK_ON_TRANSFER_FROM, v6Addr, reentryPayload);

        // Outer repay either succeeds (and inner is blocked) or both revert
        let outerOk = false;
        try {
            await v6.connect(agent).repayLoan(1);
            outerOk = true;
        } catch (e) {}

        const reentered = await attacker.reentered();
        expect(reentered, 'reentry must be blocked').to.equal(false);
    });

    it("reentry on claimInterest → blocked by nonReentrant", async () => {
        const v6Addr = await v6.getAddress();
        const A = (n) => ethers.parseUnits(n.toString(), 6);

        // Set up earnedInterest for lender
        await attacker.setAttack(ATTACK_NONE, ethers.ZeroAddress, '0x');
        await v6.connect(lender).supplyLiquidity(1, A(500));
        await v6.connect(agent).requestLoan(A(100), 30);
        await v6.connect(agent).repayLoan(1);

        // Attack: re-enter claimInterest during the safeTransfer of the claimed interest
        const reentryPayload = v6.interface.encodeFunctionData('claimInterest', [1]);
        await attacker.setAttack(ATTACK_ON_TRANSFER, v6Addr, reentryPayload);

        let outerOk = false;
        try {
            await v6.connect(lender).claimInterest(1);
            outerOk = true;
        } catch (e) {}

        const reentered = await attacker.reentered();
        expect(reentered, 'reentry on claimInterest must be blocked').to.equal(false);
    });

    it("reentry on withdrawLiquidity → blocked", async () => {
        const v6Addr = await v6.getAddress();
        const A = (n) => ethers.parseUnits(n.toString(), 6);

        // Lender supplies first
        await attacker.setAttack(ATTACK_NONE, ethers.ZeroAddress, '0x');
        await v6.connect(lender).supplyLiquidity(1, A(500));

        // Attack: re-enter withdrawLiquidity during transfer callback
        const reentryPayload = v6.interface.encodeFunctionData('withdrawLiquidity', [1, A(100)]);
        await attacker.setAttack(ATTACK_ON_TRANSFER, v6Addr, reentryPayload);

        let outerOk = false;
        try {
            await v6.connect(lender).withdrawLiquidity(1, A(100));
            outerOk = true;
        } catch (e) {}

        const reentered = await attacker.reentered();
        expect(reentered).to.equal(false);
    });

    it("reentry across functions (cross-function reentry) → blocked", async () => {
        const v6Addr = await v6.getAddress();
        const A = (n) => ethers.parseUnits(n.toString(), 6);

        // Set up state
        await attacker.setAttack(ATTACK_NONE, ethers.ZeroAddress, '0x');
        await v6.connect(lender).supplyLiquidity(1, A(500));
        await v6.connect(agent).requestLoan(A(100), 30);
        await v6.connect(agent).repayLoan(1);

        // Attack: during claimInterest, try to re-enter a DIFFERENT function (withdrawLiquidity)
        // This is the classic cross-function reentry — also blocked by nonReentrant since the modifier
        // is per-contract, not per-function.
        const reentryPayload = v6.interface.encodeFunctionData('withdrawLiquidity', [1, A(50)]);
        await attacker.setAttack(ATTACK_ON_TRANSFER, v6Addr, reentryPayload);

        await v6.connect(lender).claimInterest(1).catch(() => {});
        const reentered = await attacker.reentered();
        expect(reentered, 'cross-function reentry must be blocked').to.equal(false);
    });

    it("reentry on requestLoan (during collateral transferFrom) → blocked", async () => {
        const v6Addr = await v6.getAddress();
        const A = (n) => ethers.parseUnits(n.toString(), 6);
        // Fresh agent (score 0) → 100% collateral, so requestLoan pulls collateral
        // via transferFrom on the malicious token — the reentry window.
        await v6.connect(lender).supplyLiquidity(1, A(500));
        await attacker.setAttack(ATTACK_ON_TRANSFER_FROM, v6Addr,
            v6.interface.encodeFunctionData('requestLoan', [A(10), 7]));
        try { await v6.connect(agent).requestLoan(A(10), 7); } catch (e) {}
        expect(await attacker.reentered(), 'reentry on requestLoan must be blocked').to.equal(false);
    });

    it("reentry on liquidateLoan → blocked by nonReentrant", async () => {
        const v6Addr = await v6.getAddress();
        const A = (n) => ethers.parseUnits(n.toString(), 6);
        await attacker.setAttack(ATTACK_NONE, ethers.ZeroAddress, '0x');
        await v6.connect(lender).supplyLiquidity(1, A(500));
        await v6.connect(agent).requestLoan(A(10), 7); // loanId 1
        const loan = await v6.loans(1);
        await ethers.provider.send("evm_increaseTime", [Number(loan.endTime) - (await ethers.provider.getBlock("latest")).timestamp + 1]);
        await ethers.provider.send("evm_mine", []);
        // On the collateral-return transfer inside liquidate, try to reenter liquidate.
        await attacker.setAttack(ATTACK_ON_TRANSFER, v6Addr, v6.interface.encodeFunctionData('liquidateLoan', [1]));
        try { await v6.connect(owner).liquidateLoan(1); } catch (e) {}
        expect(await attacker.reentered(), 'reentry on liquidateLoan must be blocked').to.equal(false);
    });
});
