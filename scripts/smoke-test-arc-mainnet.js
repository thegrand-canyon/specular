/**
 * Arc MAINNET smoke test for the deployed V6 stack — REAL USDC, tiny amounts.
 * Reads src/config/arc-mainnet-addresses.json. Flow: lever read-back → register
 * → pool → F-C sub-min supply reverts → supply 1 USDC → borrow 0.5 (100% collateral)
 * → repay → claim interest → withdraw. No faucet claim (would need 10 USDC funding).
 * Net cost ≈ gas + 7-day interest on 0.5 USDC + 1% fee.
 */
require('dotenv').config();
const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'config', 'arc-mainnet-addresses.json'), 'utf8'));
const load = (rel) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'artifacts', 'contracts', rel), 'utf8')).abi;
const USDC = (n) => ethers.parseUnits(String(n), 6);
let pass = 0, fail = 0;
const check = (label, ok, extra = '') => { ok ? pass++ : fail++; console.log(`  ${ok ? '✅' : '❌'} ${label} ${extra}`); };

async function main() {
    const provider = new ethers.JsonRpcProvider(cfg.rpcUrl, cfg.chainId, { batchMaxCount: 1 });
    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
    const usdc = new ethers.Contract(cfg.usdc, ['function approve(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)'], wallet);
    const registry = new ethers.Contract(cfg.agentRegistryV2, load('core/AgentRegistryV2.sol/AgentRegistryV2.json'), wallet);
    const reputation = new ethers.Contract(cfg.reputationManagerV3, load('core/ReputationManagerV3.sol/ReputationManagerV3.json'), wallet);
    const mp = new ethers.Contract(cfg.agentLiquidityMarketplace_v6, load('core/AgentLiquidityMarketplaceV6.sol/AgentLiquidityMarketplaceV6.json'), wallet);
    const faucet = new ethers.Contract(cfg.agentCreditFaucet, load('core/AgentCreditFaucet.sol/AgentCreditFaucet.json'), wallet);

    const startBal = await usdc.balanceOf(wallet.address);
    console.log(`Arc Mainnet ${cfg.chainId} · wallet ${wallet.address} · start balance ${ethers.formatUnits(startBal, 6)} USDC\n`);

    console.log('=== 1. Config / levers read-back ===');
    check('marketplace owner = secure wallet', (await mp.owner()) === wallet.address);
    check('reputation authorized marketplace', await reputation.authorizedPools(cfg.agentLiquidityMarketplace_v6));
    check('M-1 bindBorrowToPoolCreator', (await mp.bindBorrowToPoolCreator()) === true);
    check('M-2 minHold = 86400', (await mp.minHoldForReputationReward()) === 86400n);
    // Levers tightened 2026-09-19 after the internal audit (F-04 / F-06): 5 pts/day, 10 USDC min supply.
    check('F-C minSupplyAmount = 10 USDC', (await mp.minSupplyAmount()) === USDC(10));
    check('D1 platformFeeRate = 100 bps', (await mp.platformFeeRate()) === 100n);
    check('D1 rate limit = 5', (await reputation.maxReputationGainPerWindow()) === 5n);
    check('faucet maxEligibleAgentId = 100', (await faucet.maxEligibleAgentId()) === 100n);
    check('not paused', (await mp.paused()) === false);

    console.log('\n=== 2. Onboard (exact approval, no MaxUint256) ===');
    // Budget: 10 supply + 0.5 collateral + ~0.51 repay (principal+interest+fee), plus the
    // 5 USDC probe in section 3 on a V6.2 deployment where the creator is exempt from the
    // minimum and that supply SUCCEEDS. Approve per-step instead of one flat figure, so a
    // step that legitimately consumes allowance cannot starve a later one. Reset to 0 at the end.
    const V62 = (await mp.VERSION().catch(() => 'V6')) === 'V6.2';
    const approveAtLeast = async (need) => {
        if ((await usdc.allowance(wallet.address, cfg.agentLiquidityMarketplace_v6)) >= need) return;
        await (await usdc.approve(cfg.agentLiquidityMarketplace_v6, need)).wait();
    };
    await approveAtLeast(USDC(V62 ? 18 : 12));
    check('allowance covers the run', (await usdc.allowance(wallet.address, cfg.agentLiquidityMarketplace_v6)) >= USDC(V62 ? 18 : 12));
    let agentId = await registry.addressToAgentId(wallet.address);
    if (agentId === 0n) {
        await (await registry.register('ipfs://specular-arc-mainnet-smoke', [])).wait();
        agentId = await registry.addressToAgentId(wallet.address);
    }
    check('registered, agentId != 0', agentId !== 0n, `(agentId ${agentId})`);
    if (!(await mp.agentPools(agentId)).isActive) await (await mp.createAgentPool()).wait();
    check('pool active', (await mp.agentPools(agentId)).isActive);

    console.log('\n=== 3. F-C minimum-supply lever ===');
    // V6.2 changed this deliberately: the POOL CREATOR is exempt from minSupplyAmount,
    // because the agent's own M2 first-loss stake lives in a lender slot and a 10 USDC
    // floor on it would price small honest borrowing out. Third parties are still gated —
    // that half needs a second wallet and is covered by the staging e2e suite (V6), not here.
    // The wallet running this smoke test IS the creator, so asserting a revert would assert
    // the OLD behaviour and fail on a correct deployment.
    if (await mp.isInPoolLenders(agentId, wallet.address)) {
        console.log('  (skipped: wallet already holds a lender slot; the floor only gates a NEW slot)');
    } else if (V62) {
        const before = (await mp.positions(agentId, wallet.address)).amount;
        await (await mp.supplyLiquidity(agentId, USDC('5'))).wait();
        check('V6.2: creator may seed BELOW minSupplyAmount (exempt)',
            ((await mp.positions(agentId, wallet.address)).amount) === before + USDC('5'));
    } else {
        let reverted = false;
        try { await (await mp.supplyLiquidity(agentId, USDC('5'))).wait(); } catch { reverted = true; }
        check('supply < 10 USDC reverts on-chain', reverted);
    }

    console.log('\n=== 4. supply → borrow → repay → claim → withdraw ===');
    // Resumable: reuse an ACTIVE loan left by an earlier interrupted run.
    let loanId;
    const next = await mp.nextLoanId();
    for (let id = 1n; id < next; id++) { const l = await mp.loans(id); if (l.borrower === wallet.address && Number(l.state) === 1) { loanId = id; break; } }
    if (loanId != null) {
        console.log(`  (resuming: loan ${loanId} already ACTIVE)`);
    } else {
        await (await mp.supplyLiquidity(agentId, USDC(10))).wait();
        check('supplied 10 USDC', ((await mp.positions(agentId, wallet.address)).amount) >= USDC(10));
        const r = await (await mp.requestLoan(USDC('0.5'), 7)).wait(); // score 0 → 100% collateral pulled
        for (const lg of r.logs) { try { const p = mp.interface.parseLog(lg); if (p?.name === 'LoanRequested') { loanId = p.args.loanId; break; } } catch {} }
    }
    check('loan created', loanId != null, `(loanId ${loanId})`);
    check('loan ACTIVE', Number((await mp.loans(loanId)).state) === 1);

    await (await mp.repayLoan(loanId)).wait();
    check('loan REPAID', Number((await mp.loans(loanId)).state) === 2);

    // Interest is charged on the loan's full term (0.5 USDC × 15% × 7d ≈ 0.001438),
    // but only lenders whose depositTimestamp <= loanStartTime qualify; a top-up after
    // the loan opened forfeits that loan's interest to protocol fees. So a resumed run
    // can legitimately see 0 here — assert the claim path either way.
    const earned = (await mp.positions(agentId, wallet.address)).earnedInterest;
    console.log(`  lender earnedInterest = ${ethers.formatUnits(earned, 6)} USDC`);
    if (earned > 0n) {
        await (await mp.claimInterest(agentId)).wait();
        check('interest claimed (earnedInterest → 0)', ((await mp.positions(agentId, wallet.address)).earnedInterest) === 0n);
    } else {
        let claimReverted = false;
        try { await (await mp.claimInterest(agentId)).wait(); } catch { claimReverted = true; }
        check('claimInterest with 0 earned reverts ("No interest to claim")', claimReverted);
    }

    const pos = await mp.positions(agentId, wallet.address);
    await (await mp.withdrawLiquidity(agentId, pos.amount)).wait();
    check('withdrew full position', ((await mp.positions(agentId, wallet.address)).amount) === 0n);
    const pool = await mp.agentPools(agentId);
    check('pool availableLiquidity = 0 after withdraw (§S1 holds)', pool.availableLiquidity === 0n, `(${ethers.formatUnits(pool.availableLiquidity, 6)})`);
    // Solvency: after full withdraw the only USDC the marketplace may hold is
    // owner-withdrawable protocol fees (accumulatedFees). Anything else = stuck funds.
    const mpBal = await usdc.balanceOf(cfg.agentLiquidityMarketplace_v6);
    const fees = await mp.accumulatedFees();
    check('marketplace USDC balance == accumulatedFees (no stuck funds)', mpBal === fees, `(balance ${ethers.formatUnits(mpBal, 6)}, fees ${ethers.formatUnits(fees, 6)})`);

    await (await usdc.approve(cfg.agentLiquidityMarketplace_v6, 0n)).wait();
    check('allowance reset to 0', (await usdc.allowance(wallet.address, cfg.agentLiquidityMarketplace_v6)) === 0n);

    const endBal = await usdc.balanceOf(wallet.address);
    console.log(`\nend balance ${ethers.formatUnits(endBal, 6)} USDC · net cost ${ethers.formatUnits(startBal - endBal, 6)} USDC (gas + interest + fee)`);
    console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
    if (fail > 0) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
