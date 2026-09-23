/**
 * Gas comparison: AgentLiquidityMarketplaceV62 (V7) vs AgentLiquidityMarketplaceV6
 * (V6.1) on the hot paths, plus deployed-bytecode sizes for both stacks.
 * Local hardhat chain only.
 */
const fs = require("fs");
const path = require("path");
const { ethers, artifacts } = require("hardhat");

const USDC = (n) => ethers.parseUnits(n.toString(), 6);
const DAY = 86400;

async function deploy(v7) {
    const [owner, agent, l1, l2] = await ethers.getSigners();
    const registry = await (await ethers.getContractFactory("AgentRegistryV2")).deploy();
    const rep = await (await ethers.getContractFactory(v7 ? "ReputationManagerV4" : "ReputationManagerV3"))
        .deploy(await registry.getAddress());
    const usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
    const mkt = await (await ethers.getContractFactory(v7 ? "AgentLiquidityMarketplaceV62" : "AgentLiquidityMarketplaceV6"))
        .deploy(await registry.getAddress(), await rep.getAddress(), await usdc.getAddress());
    await rep.authorizePool(await mkt.getAddress());
    await rep.authorizePool(owner.address);
    await rep.setReputationRateLimit(0, DAY);
    await mkt.setMinHoldForReputationReward(0);
    if (v7) await rep.setLadderParameters(2, USDC(100), USDC(100), 7 * DAY);

    for (const w of [agent, l1, l2]) {
        await usdc.mint(w.address, USDC(10_000_000));
        await usdc.connect(w).approve(await mkt.getAddress(), ethers.MaxUint256);
    }
    await registry.connect(agent).register("ipfs://gas", []);
    const agentId = await registry.addressToAgentId(agent.address);
    await rep.connect(agent)["initializeReputation()"]();
    await mkt.connect(agent).createAgentPool();

    // Score to the 0%-collateral tier; on V7 also build ladder capacity.
    let synth = 1_000_000;
    while ((await rep["getReputationScore(uint256)"](agentId)) < 800n) {
        if (v7) {
            await rep.recordBorrow(agent.address, synth, USDC(100));
            await ethers.provider.send("evm_increaseTime", [7 * DAY]);
            await ethers.provider.send("evm_mine");
            await rep.recordLoanCompletion(agent.address, synth, USDC(100), true, 0);
            synth++;
        } else {
            await rep.recordLoanCompletion(agent.address, USDC(100), true);
        }
    }
    if (v7) {
        await rep.recordBorrow(agent.address, synth, USDC(5000));
        await ethers.provider.send("evm_increaseTime", [7 * DAY]);
        await ethers.provider.send("evm_mine");
        await rep.recordLoanCompletion(agent.address, synth, USDC(5000), true, 0);
    }
    return { owner, agent, l1, l2, registry, rep, usdc, mkt, agentId, v7 };
}

async function gasOf(p) { return Number((await (await p).wait()).gasUsed); }

async function measure(v7) {
    const c = await deploy(v7);
    const out = {};
    out.supply_newLender = await gasOf(c.mkt.connect(c.l1).supplyLiquidity(c.agentId, USDC(5000)));
    out.supply_selfStake = await gasOf(c.mkt.connect(c.agent).supplyLiquidity(c.agentId, USDC(2500)));
    out.supply_secondLender = await gasOf(c.mkt.connect(c.l2).supplyLiquidity(c.agentId, USDC(2000)));

    const id = await c.mkt.nextLoanId();
    out.requestLoan = await gasOf(c.mkt.connect(c.agent).requestLoan(USDC(5000), 7));
    await ethers.provider.send("evm_increaseTime", [6 * DAY]);
    await ethers.provider.send("evm_mine");
    out.repayLoan = await gasOf(c.mkt.connect(c.agent).repayLoan(id));
    out.claimInterest = await gasOf(c.mkt.connect(c.l1).claimInterest(c.agentId));

    // Lossy liquidation with a mid-loan joiner (the L7 path on V7).
    const id2 = await c.mkt.nextLoanId();
    await c.mkt.connect(c.agent).requestLoan(USDC(5000), 7);
    await ethers.provider.send("evm_increaseTime", [DAY]);
    await ethers.provider.send("evm_mine");
    try { await c.mkt.connect(c.l2).supplyLiquidity(c.agentId, USDC(500)); } catch (e) {}
    await ethers.provider.send("evm_increaseTime", [8 * DAY]);
    await ethers.provider.send("evm_mine");
    out.liquidateLoan_lossy = await gasOf(c.mkt.liquidateLoan(id2));
    return out;
}

async function main() {
    const v61 = await measure(false);
    const v62 = await measure(true);
    const sizes = {};
    for (const [label, name] of [
        ["ReputationManagerV3", "ReputationManagerV3"],
        ["ReputationManagerV4", "ReputationManagerV4"],
        ["AgentLiquidityMarketplaceV6 (V6.1)", "AgentLiquidityMarketplaceV6"],
        ["AgentLiquidityMarketplaceV62 (V6.2)", "AgentLiquidityMarketplaceV62"],
    ]) {
        const a = await artifacts.readArtifact(name);
        sizes[label] = {
            deployedBytes: (a.deployedBytecode.length - 2) / 2,
            initcodeBytes: (a.bytecode.length - 2) / 2,
            headroomToEIP170: 24576 - (a.deployedBytecode.length - 2) / 2,
        };
    }
    const result = { generatedAt: new Date().toISOString(), gas: { v61, v62 }, sizes };
    const p = path.join(__dirname, "out", "gas-and-size.json");
    fs.writeFileSync(p, JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
}
main().catch((e) => { console.error(e); process.exit(1); });
