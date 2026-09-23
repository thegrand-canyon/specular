/**
 * Local V6.1 deployment + SpecularQuickstart wiring for robustness tests.
 *
 * Mirrors the arc-mainnet launch levers so the SDK is exercised against the
 * same contract configuration a third-party agent will actually meet.
 */

const { ethers: hhEthers } = require('hardhat');
const { ethers } = require('ethers');
const { SpecularQuickstart } = require('../../../src/sdk/SpecularQuickstart.js');

const USDC = (n) => ethers.parseUnits(n.toString(), 6);
const DAY = 86400;

async function deployV61(opts = {}) {
    const signers = await hhEthers.getSigners();
    const [owner, borrower, lender, other] = signers;
    const registry = await (await hhEthers.getContractFactory('AgentRegistryV2')).deploy();
    const reputation = await (await hhEthers.getContractFactory('ReputationManagerV3')).deploy(await registry.getAddress());
    const usdc = await (await hhEthers.getContractFactory('MockUSDC')).deploy();
    const v6 = await (await hhEthers.getContractFactory('AgentLiquidityMarketplaceV6')).deploy(
        await registry.getAddress(), await reputation.getAddress(), await usdc.getAddress());
    await reputation.authorizePool(await v6.getAddress());
    await reputation.setReputationRateLimit(20, DAY);
    await v6.setMinHoldForReputationReward(DAY);
    await v6.setPlatformFeeRate(100);
    await v6.setBindBorrowToPoolCreator(opts.bindBorrow !== false);
    await v6.setMinSupplyAmount(USDC(1));

    await usdc.mint(lender.address, USDC(1_000_000));
    await usdc.connect(lender).approve(await v6.getAddress(), ethers.MaxUint256);
    await usdc.mint(borrower.address, USDC(50_000));
    await usdc.mint(other.address, USDC(50_000));

    return { owner, borrower, lender, other, signers, registry, reputation, usdc, v6 };
}

/** Register + pool + funded liquidity for `signer`. Returns agentId. */
async function onboardOnChain(d, signer, liquidity = 10_000) {
    await d.registry.connect(signer).register('ipfs://agent', []);
    const agentId = await d.registry.addressToAgentId(signer.address);
    await d.reputation.connect(signer)['initializeReputation()']();
    await d.v6.connect(signer).createAgentPool();
    if (liquidity > 0) await d.v6.connect(d.lender).supplyLiquidity(agentId, USDC(liquidity));
    return agentId;
}

/**
 * SpecularQuickstart wired to a local deployment, optionally through a
 * fault-injecting provider. `signerOrWallet` must already be connected to the
 * provider the SDK should speak to.
 *
 * Returns { sdk, approvals } where `approvals` records every amount passed to
 * usdc.approve() — the exact-approval audit reads this.
 */
function makeSdk(signer, d, { marketplaceAbi, usdcAddress, marketplaceAddress } = {}) {
    const sdk = Object.create(SpecularQuickstart.prototype);
    sdk.wallet = signer;
    sdk.network = 'local-v61';
    sdk.cfg = { decimals: 6, explorer: 'https://example.invalid/tx/' };
    const mpAddr = marketplaceAddress || d.v6.target;
    sdk.addresses = {
        marketplace: mpAddr,
        registry: d.registry.target,
        reputation: d.reputation.target,
        usdc: usdcAddress || d.usdc.target,
    };
    const mpAbi = marketplaceAbi || d.v6.interface.fragments;
    sdk.marketplace = new ethers.Contract(mpAddr, mpAbi, signer);
    sdk.registry = new ethers.Contract(d.registry.target, d.registry.interface.fragments, signer);
    sdk.reputation = new ethers.Contract(d.reputation.target, d.reputation.interface.fragments, signer);

    const usdc = new ethers.Contract(sdk.addresses.usdc, d.usdc.interface.fragments, signer);
    const approvals = [];
    sdk.usdc = {
        allowance: (o, s) => usdc.allowance(o, s),
        balanceOf: (a) => usdc.balanceOf(a),
        approve: async (spender, amount) => { approvals.push(amount); return usdc.approve(spender, amount); },
    };
    sdk._rawUsdc = usdc;
    return { sdk, approvals };
}

/** An ABI with the V6.1-only selectors stripped — a genuine V6.0 deployment. */
function v60Abi(v6) {
    const gone = ['VERSION', 'previewRepayment', 'canTopUp', 'getActiveLoanIds', 'LATE_INTEREST_CAP', 'repayments'];
    return v6.interface.fragments.filter((f) => !(f.type === 'function' && gone.includes(f.name)));
}

/**
 * Drive `addr`'s reputation up to `target` by booking on-time completions
 * through an owner-authorized "pool". Used to reach the 0%-collateral tier.
 */
async function raiseScoreTo(d, addr, target) {
    await d.reputation.connect(d.owner).authorizePool(d.owner.address);
    await d.reputation.connect(d.owner).setReputationRateLimit(1_000_000, 1);
    for (let i = 0; i < 400; i++) {
        const s = Number(await d.reputation['getReputationScore(address)'](addr));
        if (s >= target) break;
        await d.reputation.connect(d.owner).recordLoanCompletion(addr, USDC(1000), true);
    }
    await d.reputation.connect(d.owner).revokePool(d.owner.address);
    return Number(await d.reputation['getReputationScore(address)'](addr));
}

module.exports = { deployV61, onboardOnChain, makeSdk, v60Abi, raiseScoreTo, USDC, DAY };
