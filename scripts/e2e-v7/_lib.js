/**
 * Shared helpers for the V7 (ReputationManagerV4 + AgentLiquidityMarketplaceV62)
 * end-to-end scenarios.
 *
 * HARD RULE: this module only ever talks to Arc TESTNET staging (chainId 5042002).
 * The provider is pinned to that chainId and every script asserts it before writing.
 * It refuses to run if the configured marketplace does not report VERSION() == "V6.2".
 *
 * Throwaway wallets (keys!) are persisted ONLY to
 *   forensics/output/v7-model/e2e-v7-wallets.json
 * which is covered by .gitignore rule `forensics/output/**\/*wallets*.json`.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });
const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT_DIR = path.join(ROOT, 'forensics', 'output', 'v7-model');
const WALLETS_FILE = path.join(OUT_DIR, 'e2e-v7-wallets.json');
const TXLOG_FILE = path.join(OUT_DIR, 'e2e-v7-txlog.json');
const RESULTS_DIR = path.join(OUT_DIR, 'e2e-v7-results');
const SPEND_FILE = path.join(OUT_DIR, 'e2e-v7-spend.json');

const CHAIN_ID = 5042002;                   // arc-staging (testnet). 5042 = mainnet: NEVER.
const FORBIDDEN_CHAINS = new Set([5042, 8453, 1]);
const RPC_URL = process.env.E2E_V7_RPC_URL || 'https://rpc.testnet.arc.io';
const RPC_FALLBACK = 'https://arc-testnet-rpc.publicnode.com';

const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/config/arc-testnet-v6-addresses.json'), 'utf8'));
if (cfg.chainId !== CHAIN_ID) throw new Error('address file is not arc-staging');

const MP = cfg.agentLiquidityMarketplace_v62 || cfg.agentLiquidityMarketplace_v6;
const REP = cfg.reputationManagerV4 || cfg.reputationManagerV3;

const abi = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, 'artifacts/contracts', rel), 'utf8')).abi;
const ABI = {
    mp: abi('core/AgentLiquidityMarketplaceV62.sol/AgentLiquidityMarketplaceV62.json'),
    rep: abi('core/ReputationManagerV4.sol/ReputationManagerV4.json'),
    reg: abi('core/AgentRegistryV2.sol/AgentRegistryV2.json'),
    usdc: abi('tokens/MockUSDC.sol/MockUSDC.json')
};

fs.mkdirSync(RESULTS_DIR, { recursive: true });

const provider = new ethers.JsonRpcProvider(RPC_URL, CHAIN_ID, { batchMaxCount: 1, staticNetwork: true });
const deployer = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
if (deployer.address.toLowerCase() !== cfg.deployer.toLowerCase()) {
    throw new Error('PRIVATE_KEY is not the staging deployer — refusing to run');
}

const USDC = (n) => ethers.parseUnits(String(n), 6);
const fmt = (x) => ethers.formatUnits(x, 6);

function contracts(signerOrProvider) {
    const s = signerOrProvider || provider;
    return {
        mp: new ethers.Contract(MP, ABI.mp, s),
        rep: new ethers.Contract(REP, ABI.rep, s),
        reg: new ethers.Contract(cfg.agentRegistryV2, ABI.reg, s),
        usdc: new ethers.Contract(cfg.usdc, ABI.usdc, s)
    };
}

// ---------------------------------------------------------------- wallets
function loadWallets() {
    if (!fs.existsSync(WALLETS_FILE)) {
        return { network: 'arc-staging', chainId: CHAIN_ID, createdAt: new Date().toISOString(), roles: {} };
    }
    return JSON.parse(fs.readFileSync(WALLETS_FILE, 'utf8'));
}
function saveWallets(w) { fs.writeFileSync(WALLETS_FILE, JSON.stringify(w, null, 2)); }

/** Get (or create+persist) the throwaway wallet for `role`. Keys never leave the gitignored file. */
function roleWallet(role) {
    const w = loadWallets();
    if (!w.roles[role]) {
        const fresh = ethers.Wallet.createRandom();
        w.roles[role] = { address: fresh.address, privateKey: fresh.privateKey, createdAt: new Date().toISOString() };
        saveWallets(w);
    }
    return new ethers.Wallet(w.roles[role].privateKey, provider);
}

/**
 * Allocate a throwaway role for a scenario that needs VIRGIN on-chain state — an
 * agent that has never repaid a loan (so `maxRepaidPrincipal == 0` and the M1 ladder
 * starts at the bootstrap rung), or an address that has never held a position in the
 * pool under test. Nothing on chain can undo either: `maxRepaidPrincipal` is only
 * reset by a DEFAULT (which also arms a 180-day lockout), and a lender slot is never
 * un-claimed. Reusing a fixed role therefore makes such a scenario a one-shot that
 * silently fails on the second run.
 *
 * Roles are indexed `prefix-1`, `prefix-2`, …; the first index `isVirgin` still
 * accepts is reused, so a re-run only burns a new wallet once the previous one has
 * actually been consumed. Generating a key is free — only funding costs anything.
 */
async function freshRoleWallet(prefix, isVirgin, max = 50) {
    for (let i = 1; i <= max; i++) {
        const w = roleWallet(`${prefix}-${i}`);
        if (await isVirgin(w)) return { wallet: w, index: i, role: `${prefix}-${i}` };
    }
    throw new Error(`no virgin "${prefix}" role available in ${max} indices`);
}

// ---------------------------------------------------------------- funding
const NATIVE_CAP = ethers.parseEther('30');   // HARD CAP on total native moved out of the deployer
function loadSpend() {
    if (!fs.existsSync(SPEND_FILE)) return { nativeFromDeployer: '0', usdcMinted: '0' };
    return JSON.parse(fs.readFileSync(SPEND_FILE, 'utf8'));
}
function saveSpend(s) { fs.writeFileSync(SPEND_FILE, JSON.stringify(s, null, 2)); }
const spent = {
    get native() { return BigInt(loadSpend().nativeFromDeployer); },
    get usdc() { return BigInt(loadSpend().usdcMinted); }
};

async function fundNative(wallet, targetNative = '0.5', scenario = 'fund') {
    const target = ethers.parseEther(String(targetNative));
    const bal = await provider.getBalance(wallet.address);
    if (bal >= target) return null;
    const amount = target - bal;
    const s = loadSpend();
    const total = BigInt(s.nativeFromDeployer) + amount;
    if (total > NATIVE_CAP) throw new Error(`native funding cap exceeded (${ethers.formatEther(total)} > 30)`);
    const tx = await deployer.sendTransaction({ to: wallet.address, value: amount });
    const r = await tx.wait();
    s.nativeFromDeployer = total.toString();
    saveSpend(s);
    logTx(scenario, `fund ${wallet.address} +${ethers.formatEther(amount)} native`, r);
    return tx.hash;
}

async function mintUsdc(to, amountDisplay, scenario = 'fund') {
    const { usdc } = contracts(deployer);
    const tx = await usdc.mint(to, USDC(amountDisplay));
    const r = await tx.wait();
    const s = loadSpend();
    s.usdcMinted = (BigInt(s.usdcMinted) + USDC(amountDisplay)).toString();
    saveSpend(s);
    logTx(scenario, `mint ${amountDisplay} MockUSDC -> ${to}`, r);
    return tx.hash;
}

/** Ensure `wallet` holds at least `min` USDC, minting up to `target` if not. */
async function ensureUsdc(wallet, min, target, scenario) {
    const { usdc } = contracts();
    const bal = await usdc.balanceOf(wallet.address);
    if (bal >= USDC(min)) return bal;
    await mintUsdc(wallet.address, target, scenario);
    return usdc.balanceOf(wallet.address);
}

// ---------------------------------------------------------------- logging / asserts
function logTx(scenario, label, receipt) {
    const entry = {
        scenario, label, hash: receipt.hash, block: receipt.blockNumber,
        gasUsed: receipt.gasUsed.toString(), status: receipt.status, at: new Date().toISOString()
    };
    let log = [];
    if (fs.existsSync(TXLOG_FILE)) log = JSON.parse(fs.readFileSync(TXLOG_FILE, 'utf8'));
    log.push(entry);
    fs.writeFileSync(TXLOG_FILE, JSON.stringify(log, null, 2));
    console.log(`    tx ${label}: ${receipt.hash} (gas ${receipt.gasUsed})`);
    return entry;
}

async function send(scenario, label, promise) {
    const tx = await promise;
    const r = await tx.wait();
    if (r.status !== 1) throw new Error(`${label} reverted on-chain: ${tx.hash}`);
    logTx(scenario, label, r);
    return r;
}

class Results {
    constructor(scenario, title) {
        this.scenario = scenario;
        this.title = title || scenario;
        this.checks = [];
        this.txs = [];
        this.startedAt = new Date().toISOString();
        console.log(`\n=== ${scenario}: ${this.title} ===`);
    }
    check(label, cond, detail = '') {
        const ok = Boolean(cond);
        this.checks.push({ label, ok, detail: String(detail) });
        console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  -- ' + detail : ''}`);
        return ok;
    }
    note(label, detail) {
        this.checks.push({ label, ok: null, detail: String(detail) });
        console.log(`  NOTE  ${label}  -- ${detail}`);
    }
    blocked(label, reason) {
        this.checks.push({ label, ok: null, blocked: true, detail: String(reason) });
        console.log(`  BLOCKED  ${label}  -- ${reason}`);
    }
    tx(label, receipt) { this.txs.push({ label, hash: receipt.hash, gasUsed: receipt.gasUsed.toString() }); return receipt; }
    finish(extra = {}) {
        const failed = this.checks.filter(c => c.ok === false).length;
        const passed = this.checks.filter(c => c.ok === true).length;
        const blocked = this.checks.filter(c => c.blocked).length;
        const s = loadSpend();
        const out = {
            scenario: this.scenario, title: this.title, chainId: CHAIN_ID, marketplace: MP, reputation: REP,
            startedAt: this.startedAt, finishedAt: new Date().toISOString(),
            passed, failed, blocked, checks: this.checks, txs: this.txs,
            cumulativeSpend: { nativeFromDeployer: ethers.formatEther(BigInt(s.nativeFromDeployer)), usdcMinted: fmt(BigInt(s.usdcMinted)) },
            ...extra
        };
        fs.writeFileSync(path.join(RESULTS_DIR, `${this.scenario}.json`),
            JSON.stringify(out, (k, v) => typeof v === 'bigint' ? v.toString() : v, 2));
        console.log(`--- ${this.scenario}: ${passed} passed, ${failed} failed, ${blocked} blocked ---`);
        return out;
    }
}

/** Await a tx-sending promise expecting a revert containing `reason`. */
async function expectRevert(promise, reason) {
    try {
        const tx = await promise;
        if (tx && tx.wait) await tx.wait();
        return { reverted: false, matched: false, message: 'NO REVERT' };
    } catch (e) {
        const msg = [e.reason, e.shortMessage, e.message, e.info && JSON.stringify(e.info)]
            .filter(Boolean).join(' | ');
        return { reverted: true, matched: reason ? msg.includes(reason) : true, message: msg.slice(0, 300) };
    }
}

function eventFromReceipt(iface, receipt, name) {
    for (const lg of receipt.logs) {
        try { const p = iface.parseLog(lg); if (p && p.name === name) return p; } catch (e) { /* not ours */ }
    }
    return null;
}
function loanIdFromReceipt(mp, receipt) {
    const p = eventFromReceipt(mp.interface, receipt, 'LoanRequested');
    if (!p) throw new Error('LoanRequested not found');
    return Number(p.args.loanId);
}

// ---------------------------------------------------------------- domain helpers
/** Register (if needed), initialize reputation on V4 (if needed) and create the agent pool. */
async function ensureAgent(wallet, scenario, label) {
    const { reg, rep, mp } = contracts(wallet);
    let id = await reg.addressToAgentId(wallet.address);
    if (id === 0n) {
        await send(scenario, `register agent ${label} (${wallet.address})`, reg.register(`ipfs://e2e-v7-${label}`, []));
        id = await reg.addressToAgentId(wallet.address);
    }
    if (!(await rep.initialized(id))) {
        await send(scenario, `initializeReputation agent ${id}`, rep['initializeReputation()']());
    }
    const pool = await mp.agentPools(id);
    if (!pool.isActive) await send(scenario, `createAgentPool agent ${id}`, mp.createAgentPool());
    return Number(id);
}

/** One-shot large allowance for the marketplace (direct ethers; not the SDK's exact-approval policy). */
async function approveMax(wallet, amountDisplay, scenario, label) {
    const { usdc } = contracts(wallet);
    const cur = await usdc.allowance(wallet.address, MP);
    if (cur >= USDC(amountDisplay)) return null;
    return send(scenario, `${label || 'approve'} ${amountDisplay} USDC -> marketplace`, usdc.approve(MP, USDC(amountDisplay)));
}

async function creditState(agentId, agentAddr) {
    const { mp, rep } = contracts();
    const [score, ladder, limit, maxRepaid, ss, outstanding] = await Promise.all([
        rep['getReputationScore(uint256)'](agentId), rep.ladderLimit(agentId), rep.creditLimitOf(agentId),
        rep.maxRepaidPrincipal(agentId), mp.selfStake(agentId), mp.outstandingPrincipal(agentId)
    ]);
    const tierLimit = await rep.tierLimit(score);
    const collPct = await rep.calculateCollateralRequirement(agentAddr);
    return {
        score, ladder, limit, maxRepaid, tierLimit, collPct, outstanding,
        selfStake: ss.amount, selfStakeLocked: ss.locked
    };
}

/** Run one full collateralised or unsecured loan cycle: request → (hold) → repay. */
async function loanCycle(scenario, agentWallet, agentId, amountDisplay, durationDays = 7, holdSeconds = 0) {
    const { mp } = contracts(agentWallet);
    const rcReq = await send(scenario, `requestLoan ${amountDisplay} USDC (agent ${agentId})`, mp.requestLoan(USDC(amountDisplay), durationDays));
    const loanId = loanIdFromReceipt(mp, rcReq);
    if (holdSeconds > 0) await sleep(holdSeconds * 1000);
    const rcRep = await send(scenario, `repayLoan ${loanId}`, mp.repayLoan(loanId));
    return { loanId, rcReq, rcRep };
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Repay every ACTIVE loan an agent is carrying, so a scenario can be re-run after a
 * crash (and so no loan is ever left open on staging). `signer` must be the address
 * `loan.borrower` recorded — which after an agent-NFT transfer is still the ORIGINAL
 * borrower, not the new holder.
 */
async function clearActiveLoans(scenario, signer, agentId) {
    const view = contracts();
    const mpS = contracts(signer).mp;
    const cleared = [];
    // read the whole list up front: repayLoan swap-and-pops activeLoanIds
    const ids = [];
    for (let i = 0; ; i++) {
        let id; try { id = await view.mp.activeLoanIds(agentId, i); } catch (e) { break; }
        ids.push(Number(id));
    }
    for (const id of ids) {
        const ln = await view.mp.loans(id);
        if (Number(ln.state) !== 1) continue;            // 1 = ACTIVE
        if (ln.borrower.toLowerCase() !== signer.address.toLowerCase()) {
            console.log(`    ! leftover ACTIVE loan #${id} belongs to ${ln.borrower}, not ${signer.address} — skipping`);
            continue;
        }
        await send(scenario, `cleanup: repay leftover ACTIVE loan ${id} (agent ${agentId})`, mpS.repayLoan(id));
        cleared.push(id);
    }
    return cleared;
}

/**
 * Amount an agent can borrow right now, derived entirely from chain state:
 * head-room under `calculateCreditLimit`, the pool's available liquidity, and
 * (when collateral is required) the borrower's own USDC balance.
 * Rounded DOWN to whole USDC so the scenario logs stay readable.
 */
async function borrowableNow(agentId, agentAddr, { slots = 1, reserveUsdc = 0 } = {}) {
    const { mp, rep } = contracts();
    const [limit, outstanding, pool, collPct, usdcBal] = await Promise.all([
        rep.creditLimitOf(agentId), mp.outstandingPrincipal(agentId), mp.agentPools(agentId),
        rep.collateralRequirementOf(agentId), contracts().usdc.balanceOf(agentAddr)
    ]);
    const headroom = limit > outstanding ? limit - outstanding : 0n;
    let per = headroom / BigInt(slots);
    const liqPer = pool.availableLiquidity / BigInt(slots);
    if (liqPer < per) per = liqPer;
    if (collPct > 0n) {
        // collateral is posted up-front for every concurrent loan
        const spendable = usdcBal > USDC(reserveUsdc) ? usdcBal - USDC(reserveUsdc) : 0n;
        const collPer = (spendable * 100n) / (collPct * BigInt(slots));
        if (collPer < per) per = collPer;
    }
    per = (per / 1000000n) * 1000000n;   // whole USDC
    return { per, limit, outstanding, headroom, collPct, availableLiquidity: pool.availableLiquidity };
}

/**
 * [M2-c] Ensure the pool creator already holds the first-loss self-stake the
 * marketplace will demand before it can carry `additionalExposure` more principal.
 * A no-op at the 100 %-collateral tiers (`requiredSelfStake` returns 0 there), which
 * is why a scenario that only ever ran against a low-score agent never needed it —
 * and why it starts reverting "Insufficient self-stake" the run after that agent's
 * score crosses into a 0 %-collateral tier. The creator's own stake is exempt from
 * `minSupplyAmount` (M2-a), so a small top-up is legal.
 */
async function ensureSelfStake(scenario, wallet, agentId, additionalExposure) {
    const { mp } = contracts();
    const need = await mp.requiredSelfStake(agentId, additionalExposure);
    const have = (await mp.positions(agentId, wallet.address)).amount;
    if (need === 0n || have >= need) return 0n;
    const gap = need - have;
    await ensureUsdc(wallet, Number(fmt(gap)) + 5, Number(fmt(gap)) * 2 + 100, scenario);
    await send(scenario, `M2-c self-stake top-up ${fmt(gap)} USDC into own pool #${agentId}`,
        contracts(wallet).mp.supplyLiquidity(agentId, gap));
    return gap;
}

/**
 * Climb the M1 ladder until `creditLimitOf(agentId) >= target`, one on-time repaid
 * loan at a time. Each rung borrows the agent's whole current head-room, which is
 * what advances `maxRepaidPrincipal`. Requires the compressed clock levers
 * (minHoldForReputationReward == 0) — at the live 1-day minHold a rung can never be
 * "on time enough" inside a test run, so this throws rather than spinning.
 */
async function climbLadderTo(scenario, wallet, agentId, target, maxRungs = 6) {
    const { mp, rep } = contracts();
    const mpW = contracts(wallet).mp;
    const minHold = await mp.minHoldForReputationReward();
    const rungs = [];
    for (let i = 0; i < maxRungs; i++) {
        const limit = await rep.creditLimitOf(agentId);
        if (limit >= target) return rungs;
        if (minHold !== 0n) {
            throw new Error(`cannot climb the ladder: minHoldForReputationReward is ${minHold}s — run 00-setup.js first`);
        }
        const { per } = await borrowableNow(agentId, wallet.address, { slots: 1, reserveUsdc: 5 });
        if (per === 0n) throw new Error(`ladder rung ${i + 1}: nothing borrowable (limit ${fmt(limit)})`);
        await ensureSelfStake(scenario, wallet, agentId, per);   // no-op below the 0 %-collateral tiers
        const rc = await send(scenario, `ladder rung ${i + 1}: requestLoan ${fmt(per)} USDC (agent ${agentId})`, mpW.requestLoan(per, 7));
        const id = loanIdFromReceipt(mp, rc);
        await sleep(2500);                                   // non-zero hold -> non-zero principal-TIME bonus
        await send(scenario, `ladder rung ${i + 1}: repayLoan ${id}`, mpW.repayLoan(id));
        const after = await rep.creditLimitOf(agentId);
        rungs.push({ loanId: id, amount: fmt(per), limitAfter: fmt(after) });
        if (after <= limit) throw new Error(`ladder rung ${i + 1} did not advance the limit (${fmt(limit)} -> ${fmt(after)})`);
    }
    throw new Error(`ladder did not reach ${fmt(target)} in ${maxRungs} rungs`);
}

// ---------------------------------------------------------------- levers
const LIVE_LEVERS = {
    rep: { onTimeBonus: 10, defaultPenaltyBase: 50, defaultPenaltyLarge: 100, largeLoanThreshold: USDC(1000),
           bonusReferenceAmount: USDC(100), creditMultiple: 2, growthStep: USDC(100), bootstrapLimit: USDC(100),
           refDuration: 604800, rateMaxGain: 5, rateWindow: 86400, defaultLockout: 180 * 86400 },
    mp: { minHold: 86400, minSupply: USDC(10), feeBps: 100, bind: true }
};

async function readLevers() {
    const { mp, rep } = contracts();
    return {
        rep: {
            onTimeBonus: await rep.onTimeRepaymentBonus(),
            defaultPenaltyBase: await rep.defaultPenaltyBase(),
            defaultPenaltyLarge: await rep.defaultPenaltyLarge(),
            largeLoanThreshold: await rep.largeLoanThreshold(),
            bonusReferenceAmount: await rep.bonusReferenceAmount(),
            creditMultiple: await rep.creditMultiple(),
            growthStep: await rep.growthStep(),
            bootstrapLimit: await rep.bootstrapLimit(),
            refDuration: await rep.refDuration(),
            rateMaxGain: await rep.maxReputationGainPerWindow(),
            rateWindow: await rep.reputationGainWindow(),
            defaultLockout: await rep.defaultLockout()
        },
        mp: {
            minHold: await mp.minHoldForReputationReward(),
            minSupply: await mp.minSupplyAmount(),
            feeBps: await mp.platformFeeRate(),
            bind: await mp.bindBorrowToPoolCreator()
        }
    };
}

/**
 * Owner-only calendar compression. The live staging levers make a single on-chain run
 * impossible (minHold 1 day per loan, 5 reputation points per day, a 7-day bonus
 * reference). These setters compress the CLOCK only; the ladder parameters
 * (k, growthStep, bootstrapLimit), the tier table and the default lockout are the
 * shipped values throughout. `restoreLiveLevers()` puts everything back.
 */
async function setLevers(scenario, { onTimeBonus, bonusRef, refDuration, rateMaxGain, rateWindow, minHold }) {
    const { mp, rep } = contracts(deployer);
    const cur = await readLevers();
    if (onTimeBonus !== undefined && cur.rep.onTimeBonus !== BigInt(onTimeBonus)) {
        await send(scenario, `setScoringParameters(onTimeBonus=${onTimeBonus})`,
            rep.setScoringParameters(onTimeBonus, LIVE_LEVERS.rep.defaultPenaltyBase, LIVE_LEVERS.rep.defaultPenaltyLarge, LIVE_LEVERS.rep.largeLoanThreshold));
    }
    if (bonusRef !== undefined && cur.rep.bonusReferenceAmount !== BigInt(bonusRef)) {
        await send(scenario, `setBonusReferenceAmount(${fmt(bonusRef)})`, rep.setBonusReferenceAmount(bonusRef));
    }
    if (refDuration !== undefined && cur.rep.refDuration !== BigInt(refDuration)) {
        await send(scenario, `setLadderParameters(k=2, step=100, boot=100, refDuration=${refDuration})`,
            rep.setLadderParameters(LIVE_LEVERS.rep.creditMultiple, LIVE_LEVERS.rep.growthStep, LIVE_LEVERS.rep.bootstrapLimit, refDuration));
    }
    if (rateMaxGain !== undefined && (cur.rep.rateMaxGain !== BigInt(rateMaxGain) || cur.rep.rateWindow !== BigInt(rateWindow || LIVE_LEVERS.rep.rateWindow))) {
        await send(scenario, `setReputationRateLimit(${rateMaxGain}, ${rateWindow || LIVE_LEVERS.rep.rateWindow})`,
            rep.setReputationRateLimit(rateMaxGain, rateWindow || LIVE_LEVERS.rep.rateWindow));
    }
    if (minHold !== undefined && cur.mp.minHold !== BigInt(minHold)) {
        await send(scenario, `setMinHoldForReputationReward(${minHold})`, mp.setMinHoldForReputationReward(minHold));
    }
}

async function restoreLiveLevers(scenario) {
    const L = LIVE_LEVERS;
    await setLevers(scenario, {
        onTimeBonus: L.rep.onTimeBonus, bonusRef: L.rep.bonusReferenceAmount, refDuration: L.rep.refDuration,
        rateMaxGain: L.rep.rateMaxGain, rateWindow: L.rep.rateWindow, minHold: L.mp.minHold
    });
}

// ---------------------------------------------------------------- guards
async function assertStaging() {
    const net = await provider.getNetwork();
    const id = Number(net.chainId);
    if (FORBIDDEN_CHAINS.has(id)) throw new Error(`REFUSING: connected to forbidden chain ${id}`);
    if (id !== CHAIN_ID) throw new Error(`REFUSING: chainId ${id} != ${CHAIN_ID} (arc-staging)`);
    const { mp, rep } = contracts();
    const [mv, rv] = [await mp.VERSION(), await rep.VERSION()];
    if (mv !== 'V6.2') throw new Error(`REFUSING: marketplace VERSION ${mv} != V6.2`);
    if (rv !== 'V4') throw new Error(`REFUSING: reputation VERSION ${rv} != V4`);
    console.log(`arc-staging ${id} | marketplace ${MP} ${mv} | reputation ${REP} ${rv}`);
    return { mv, rv };
}

/** Per-pool conservation: availableLiquidity + totalLoaned == Σ position.amount + Σ earnedInterest. */
async function poolConservation(agentId) {
    const { mp } = contracts();
    const p = await mp.agentPools(agentId);
    let sumAmt = 0n, sumEarned = 0n;
    const lenders = [];
    for (let i = 0; i < 60; i++) {
        let l; try { l = await mp.poolLenders(agentId, i); } catch (e) { break; }
        const pos = await mp.positions(agentId, l);
        lenders.push({ lender: l, amount: pos.amount, earnedInterest: pos.earnedInterest });
        sumAmt += pos.amount; sumEarned += pos.earnedInterest;
    }
    return {
        availableLiquidity: p.availableLiquidity, totalLoaned: p.totalLoaned, sumAmt, sumEarned, lenders,
        conserved: p.availableLiquidity + p.totalLoaned === sumAmt + sumEarned
    };
}

module.exports = {
    ROOT, OUT_DIR, RESULTS_DIR, CHAIN_ID, RPC_URL, RPC_FALLBACK, cfg, MP, REP, ABI, provider, deployer,
    USDC, fmt, contracts, roleWallet, fundNative, mintUsdc, ensureUsdc, logTx, send, Results, expectRevert,
    eventFromReceipt, loanIdFromReceipt, ensureAgent, approveMax, creditState, loanCycle, sleep,
    clearActiveLoans, borrowableNow, climbLadderTo, freshRoleWallet, ensureSelfStake,
    LIVE_LEVERS, readLevers, setLevers, restoreLiveLevers, assertStaging, poolConservation, spent, ethers
};
