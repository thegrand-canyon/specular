/**
 * Economic-attack simulation harness for Specular V6.1 + ReputationManagerV3.
 *
 * Deploys the REAL contracts on a local hardhat chain, drives them with
 * parameterised actor strategies and time-travel, and instruments:
 *   - reputation score over time
 *   - credit limit unlocked
 *   - attacker capital locked (USDC held by the protocol on the actor's behalf)
 *   - cumulative platform fees + gas
 *   - realised net cost after a full unwind (repay/withdraw/claim everything)
 *
 * No network broadcast: hardhat in-process chain only.
 */
const { ethers, network } = require("hardhat");

const DAY = 86400;
const U = (n) => BigInt(Math.round(Number(n) * 1e6)); // USDC (6 dec)
const f6 = (x) => Number(x) / 1e6;

async function advance(seconds) {
  if (seconds <= 0) return;
  await network.provider.send("evm_increaseTime", [Math.floor(seconds)]);
  await network.provider.send("evm_mine");
}

async function now() {
  const b = await ethers.provider.getBlock("latest");
  return b.timestamp;
}

/** Default levers = Arc mainnet post-audit (2026-09) config. */
const LEVERS_NEW = {
  name: "NEW (Arc mainnet post-audit)",
  maxGainPerWindow: 5,
  gainWindow: DAY,
  minSupply: U(10),
  platformFeeRate: 100, // bps
  minHold: DAY,
  bindM1: true,
  bonusRef: U(100),
  onTimeBonus: 10,
  penaltyBase: 50,
  penaltyLarge: 100,
  largeThreshold: U(10000),
};

/** Levers as they were before the tightening (the state the prior audit measured). */
const LEVERS_OLD = {
  ...LEVERS_NEW,
  name: "OLD (pre-tightening)",
  maxGainPerWindow: 20,
  minSupply: U(1),
};

let _accIdx = 0;
/** Fresh funded EOA (hardhat only exposes 20 default signers; we need many). */
async function newActor(ctx, label, usdcAmount) {
  const w = ethers.Wallet.createRandom().connect(ethers.provider);
  await ctx.owner.sendTransaction({ to: w.address, value: ethers.parseEther("5") });
  if (usdcAmount && usdcAmount > 0n) await ctx.usdc.mint(w.address, usdcAmount);
  const a = {
    label: label || `actor${_accIdx++}`,
    signer: w,
    address: w.address,
    gas: 0n,
    startUsdc: usdcAmount || 0n,
    agentId: 0n,
  };
  // blanket approval (sim convenience; production SDK uses exact approvals)
  await track(a, ctx.usdc.connect(w).approve(await ctx.mkt.getAddress(), ethers.MaxUint256));
  return a;
}

async function track(actor, txPromise) {
  const tx = await txPromise;
  const r = await tx.wait();
  actor.gas += r.gasUsed;
  return r;
}

async function deployStack(levers) {
  const [owner] = await ethers.getSigners();

  const USDCf = await ethers.getContractFactory("MockUSDC");
  const usdc = await USDCf.deploy();
  await usdc.waitForDeployment();

  const Regf = await ethers.getContractFactory("AgentRegistryV2");
  const registry = await Regf.deploy();
  await registry.waitForDeployment();

  const repName = levers.repContract || "ReputationManagerV3";
  const Repf = await ethers.getContractFactory(repName);
  const rep = await Repf.deploy(await registry.getAddress());
  await rep.waitForDeployment();

  const Mktf = await ethers.getContractFactory(levers.mktContract || "AgentLiquidityMarketplaceV6");
  const mkt = await Mktf.deploy(
    await registry.getAddress(),
    await rep.getAddress(),
    await usdc.getAddress()
  );
  await mkt.waitForDeployment();

  await (await rep.authorizePool(await mkt.getAddress())).wait();

  // Levers
  await (await rep.setReputationRateLimit(levers.maxGainPerWindow, levers.gainWindow)).wait();
  await (await rep.setBonusReferenceAmount(levers.bonusRef)).wait();
  await (await rep.setScoringParameters(
    levers.onTimeBonus, levers.penaltyBase, levers.penaltyLarge, levers.largeThreshold
  )).wait();

  // [V7] ReputationManagerV4 extras. `setM1Parameters` is the scratch contract's
  // combined setter; the production V4 splits it into setLadderParameters /
  // setDefaultLockout / setLatePenaltyParameters / setTierLimits.
  if (repName === "ReputationManagerV4Sim" && levers.m1) {
    await (await rep.setM1Parameters(
      levers.m1.refDuration ?? 7 * DAY,
      levers.m1.creditMultiple ?? 2,
      levers.m1.bootstrapLimit ?? U(100),
      levers.m1.lockout ?? 180 * DAY
    )).wait();
  }
  if (repName === "ReputationManagerV4" && levers.m1) {
    await (await rep.setLadderParameters(
      levers.m1.creditMultiple ?? 2,
      levers.m1.growthStep ?? U(100),
      levers.m1.bootstrapLimit ?? U(100),
      levers.m1.refDuration ?? 7 * DAY
    )).wait();
    await (await rep.setDefaultLockout(levers.m1.lockout ?? 180 * DAY)).wait();
    if (levers.m1.tierLimits) await (await rep.setTierLimits(levers.m1.tierLimits)).wait();
  }
  await (await mkt.setMinSupplyAmount(levers.minSupply)).wait();
  await (await mkt.setPlatformFeeRate(levers.platformFeeRate)).wait();
  await (await mkt.setMinHoldForReputationReward(levers.minHold)).wait();
  await (await mkt.setBindBorrowToPoolCreator(levers.bindM1)).wait();
  await (await mkt.setMigrationFinalized()).wait();

  return { owner, usdc, registry, rep, mkt, levers };
}

/** Register an agent, init reputation (score 100), create its pool. */
async function makeAgent(ctx, actor, uri) {
  await track(actor, ctx.registry.connect(actor.signer).register(uri || `ipfs://${actor.label}`, []));
  actor.agentId = await ctx.registry.addressToAgentId(actor.address);
  await track(actor, ctx.rep.connect(actor.signer)["initializeReputation()"]());
  await track(actor, ctx.mkt.connect(actor.signer).createAgentPool());
  return actor;
}

async function score(ctx, actor) {
  return Number(await ctx.rep["getReputationScore(uint256)"](actor.agentId));
}
async function creditLimit(ctx, actor) {
  return await ctx.rep["calculateCreditLimit(address)"](actor.address);
}
async function collateralPct(ctx, actor) {
  return Number(await ctx.rep.calculateCollateralRequirement(actor.address));
}

/** USDC the protocol currently holds on this actor's behalf (principal + collateral + earned). */
async function lockedCapital(ctx, actor) {
  return actor.startUsdc - (await ctx.usdc.balanceOf(actor.address));
}

/** Levers for the shipped V7 stack (ReputationManagerV4 + AgentLiquidityMarketplaceV62). */
const LEVERS_V7 = {
  ...LEVERS_NEW,
  name: "V7 (ReputationManagerV4 + V6.2)",
  repContract: "ReputationManagerV4",
  mktContract: "AgentLiquidityMarketplaceV62",
  // V7 ships largeLoanThreshold = 1,000 USDC: with the tier cap at 5,000 a
  // 10,000 threshold would put every reachable default back on the flat floor.
  largeThreshold: U(1000),
  m1: { creditMultiple: 2, growthStep: U(100), bootstrapLimit: U(100), refDuration: 7 * DAY, lockout: 180 * DAY },
};

/** Levers for M1-only ablation (scratch V4Sim + the unchanged V6.1 marketplace). */
const LEVERS_M1 = {
  ...LEVERS_NEW,
  name: "M1 only (ReputationManagerV4Sim + V6.1)",
  repContract: "ReputationManagerV4Sim",
  m1: { creditMultiple: 2, bootstrapLimit: U(100), refDuration: 7 * DAY, lockout: 180 * DAY },
};

module.exports = {
  DAY, U, f6, advance, now, track, newActor, deployStack, makeAgent,
  score, creditLimit, collateralPct, lockedCapital,
  LEVERS_NEW, LEVERS_OLD, LEVERS_V7, LEVERS_M1, ethers,
};
