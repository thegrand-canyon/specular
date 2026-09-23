/**
 * Shared helpers for the 2026-09-20 end-to-end staging scenarios.
 *
 * HARD RULE: this module only ever talks to Arc TESTNET staging (chainId 5042002).
 * The provider is pinned to that chainId and every script asserts it at start.
 *
 * Throwaway wallets are generated on demand and persisted (keys!) ONLY to
 * forensics/output/testing-2026-09-20/e2e-wallets.json (gitignored).
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });
const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT_DIR = path.join(ROOT, 'forensics', 'output', 'testing-2026-09-20');
const WALLETS_FILE = path.join(OUT_DIR, 'e2e-wallets.json');
const TXLOG_FILE = path.join(OUT_DIR, 'txlog.json');
const RESULTS_DIR = path.join(OUT_DIR, 'results');

const CHAIN_ID = 5042002;
// RPC: the public drpc endpoint rate-limits (429) under sustained e2e load, so prefer the
// Arc-operated testnet RPC; override with E2E_ARC_RPC_URL. Both serve chainId 5042002 only.
const RPC_URL = process.env.E2E_ARC_RPC_URL || 'https://rpc.testnet.arc.network';
const RPC_FALLBACKS = [process.env.ARC_TESTNET_RPC_URL, 'https://arc-testnet.drpc.org'].filter(Boolean);
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/config/arc-testnet-v6-addresses.json'), 'utf8'));
if (cfg.chainId !== CHAIN_ID) throw new Error('address file is not arc-staging');

const abi = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, 'artifacts/contracts', rel), 'utf8')).abi;
const ABI = {
    mp: abi('core/AgentLiquidityMarketplaceV6.sol/AgentLiquidityMarketplaceV6.json'),
    reg: abi('core/AgentRegistryV2.sol/AgentRegistryV2.json'),
    rep: abi('core/ReputationManagerV3.sol/ReputationManagerV3.json'),
    usdc: abi('tokens/MockUSDC.sol/MockUSDC.json'),
    faucet: abi('core/AgentCreditFaucet.sol/AgentCreditFaucet.json')
};

fs.mkdirSync(RESULTS_DIR, { recursive: true });

const provider = new ethers.JsonRpcProvider(RPC_URL, CHAIN_ID, { batchMaxCount: 1, staticNetwork: true });
const deployer = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
if (deployer.address.toLowerCase() !== cfg.deployer.toLowerCase()) throw new Error('PRIVATE_KEY is not the staging deployer');

const USDC = (n) => ethers.parseUnits(String(n), 6);
const fmt = (x) => ethers.formatUnits(x, 6);

function contracts(signerOrProvider) {
    const s = signerOrProvider || provider;
    return {
        mp: new ethers.Contract(cfg.agentLiquidityMarketplace_v6, ABI.mp, s),
        reg: new ethers.Contract(cfg.agentRegistryV2, ABI.reg, s),
        rep: new ethers.Contract(cfg.reputationManagerV3, ABI.rep, s),
        usdc: new ethers.Contract(cfg.usdc, ABI.usdc, s),
        faucet: new ethers.Contract(cfg.agentCreditFaucet, ABI.faucet, s)
    };
}

// ---------------------------------------------------------------- wallets
function loadWallets() {
    if (!fs.existsSync(WALLETS_FILE)) return { network: 'arc-staging', chainId: CHAIN_ID, createdAt: new Date().toISOString(), roles: {} };
    return JSON.parse(fs.readFileSync(WALLETS_FILE, 'utf8'));
}
function saveWallets(w) { fs.writeFileSync(WALLETS_FILE, JSON.stringify(w, null, 2)); }

/** Get (or create+persist) the throwaway wallet for `role`. */
function roleWallet(role) {
    const w = loadWallets();
    if (!w.roles[role]) {
        const fresh = ethers.Wallet.createRandom();
        w.roles[role] = { address: fresh.address, privateKey: fresh.privateKey, createdAt: new Date().toISOString() };
        saveWallets(w);
    }
    return new ethers.Wallet(w.roles[role].privateKey, provider);
}

/** Brand-new wallet that is NOT reused across runs (persisted under a suffixed role name). */
function freshRoleWallet(role) {
    const w = loadWallets();
    const fresh = ethers.Wallet.createRandom();
    const name = `${role}-${Date.now()}`;
    w.roles[name] = { address: fresh.address, privateKey: fresh.privateKey, createdAt: new Date().toISOString(), role };
    saveWallets(w);
    return new ethers.Wallet(fresh.privateKey, provider);
}

// ---------------------------------------------------------------- funding
const spent = { nativeFromDeployer: 0n, usdcMinted: 0n };

/** Top the wallet up to `targetNative` native (gas) from the deployer. Returns tx hash or null. */
async function fundNative(wallet, targetNative = '1.0', scenario = 'fund') {
    const target = ethers.parseEther(String(targetNative));
    const bal = await provider.getBalance(wallet.address);
    if (bal >= target) return null;
    const amount = target - bal;
    const tx = await deployer.sendTransaction({ to: wallet.address, value: amount });
    const r = await tx.wait();
    spent.nativeFromDeployer += amount;
    logTx(scenario, `fund ${wallet.address} +${ethers.formatEther(amount)} native`, r);
    return tx.hash;
}

/** Mint MockUSDC to a wallet from the deployer (MockUSDC.mint is deployer-callable on staging). */
async function mintUsdc(to, amountDisplay, scenario = 'fund') {
    const { usdc } = contracts(deployer);
    const tx = await usdc.mint(to, USDC(amountDisplay));
    const r = await tx.wait();
    spent.usdcMinted += USDC(amountDisplay);
    logTx(scenario, `mint ${amountDisplay} MockUSDC -> ${to}`, r);
    return tx.hash;
}

// ---------------------------------------------------------------- logging/asserts
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

/** send a contract call, wait, log. Returns receipt. */
async function send(scenario, label, promise) {
    const tx = await promise;
    const r = await tx.wait();
    if (r.status !== 1) throw new Error(`${label} reverted on-chain: ${tx.hash}`);
    logTx(scenario, label, r);
    return r;
}

class Results {
    constructor(scenario) {
        this.scenario = scenario;
        this.checks = [];
        this.startedAt = new Date().toISOString();
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
    finish(extra = {}) {
        const failed = this.checks.filter(c => c.ok === false).length;
        const passed = this.checks.filter(c => c.ok === true).length;
        const blocked = this.checks.filter(c => c.blocked).length;
        const out = { scenario: this.scenario, startedAt: this.startedAt, finishedAt: new Date().toISOString(), passed, failed, blocked, checks: this.checks, spent: { nativeFromDeployer: ethers.formatEther(spent.nativeFromDeployer), usdcMinted: fmt(spent.usdcMinted) }, ...extra };
        fs.writeFileSync(path.join(RESULTS_DIR, `${this.scenario}.json`), JSON.stringify(out, (k, v) => typeof v === 'bigint' ? v.toString() : v, 2));
        console.log(`\n=== ${this.scenario}: ${passed} passed, ${failed} failed, ${blocked} blocked ===`);
        return out;
    }
}

/** Await a tx-sending promise expecting a revert containing `reason`. Returns {reverted, message}. */
async function expectRevert(promise, reason) {
    try {
        const tx = await promise;
        if (tx && tx.wait) await tx.wait();
        return { reverted: false, message: 'no revert' };
    } catch (e) {
        let decoded = null;
        try { const d = e.data || (e.info && e.info.error && e.info.error.data); if (d) { const p = new ethers.Interface(ABI.mp).parseError(d); if (p) decoded = p.name; } } catch (x) {}
        const msg = [decoded, e.reason, e.shortMessage, e.message, e.info && JSON.stringify(e.info)].filter(Boolean).join(' | ');
        return { reverted: true, matched: reason ? msg.includes(reason) : true, message: msg.slice(0, 400) };
    }
}

function loanIdFromReceipt(mp, receipt) {
    for (const lg of receipt.logs) {
        try { const p = mp.interface.parseLog(lg); if (p && p.name === 'LoanRequested') return Number(p.args.loanId); } catch (e) {}
    }
    throw new Error('LoanRequested not found');
}

/** Exact mirror of the contract's calculateInterest (divide-before-multiply). */
function interestFor(principal, rateBps, seconds) {
    const annual = (BigInt(principal) * BigInt(rateBps)) / 10000n;
    return (annual * BigInt(seconds)) / BigInt(365 * 86400);
}

/** Snapshot pool + all named lender positions. */
async function poolSnapshot(agentId, lenders) {
    const { mp, usdc } = contracts();
    const pool = await mp.agentPools(agentId);
    const positions = {};
    for (const [name, addr] of Object.entries(lenders)) {
        const p = await mp.positions(agentId, addr);
        const pt = await mp.pendingTranche(agentId, addr);
        positions[name] = { amount: p.amount, earnedInterest: p.earnedInterest, depositTimestamp: p.depositTimestamp, pendingAmount: pt.amount, pendingTimestamp: pt.timestamp };
    }
    return {
        totalLiquidity: pool.totalLiquidity, availableLiquidity: pool.availableLiquidity, totalLoaned: pool.totalLoaned, totalEarned: pool.totalEarned,
        accumulatedFees: await mp.accumulatedFees(), mpBalance: await usdc.balanceOf(cfg.agentLiquidityMarketplace_v6),
        activeLoanCount: await mp.activeLoanCount(agentId), positions
    };
}

async function ensureAgent(wallet, scenario, uri) {
    const { reg, mp } = contracts(wallet);
    let id = await reg.addressToAgentId(wallet.address);
    if (id === 0n) {
        await send(scenario, `register ${wallet.address}`, reg.register(uri || `ipfs://e2e-${scenario}`, []));
        id = await reg.addressToAgentId(wallet.address);
    }
    const pool = await mp.agentPools(id);
    if (!pool.isActive) await send(scenario, `createAgentPool agent ${id}`, mp.createAgentPool());
    return Number(id);
}

async function approve(wallet, amount, scenario, label = 'approve') {
    const { usdc } = contracts(wallet);
    return send(scenario, `${label} ${fmt(amount)} USDC`, usdc.approve(cfg.agentLiquidityMarketplace_v6, amount));
}

async function assertStaging() {
    const net = await provider.getNetwork();
    if (Number(net.chainId) !== CHAIN_ID) throw new Error(`refusing to run: chainId ${net.chainId} != ${CHAIN_ID}`);
    const { mp } = contracts();
    const v = await mp.VERSION();
    console.log(`arc-staging chainId ${net.chainId}, marketplace ${cfg.agentLiquidityMarketplace_v6} VERSION ${v}`);
    return v;
}

module.exports = {
    RPC_FALLBACKS, ROOT, OUT_DIR, RESULTS_DIR, CHAIN_ID, RPC_URL, cfg, ABI, provider, deployer, USDC, fmt, contracts,
    roleWallet, freshRoleWallet, fundNative, mintUsdc, logTx, send, Results, expectRevert, loanIdFromReceipt,
    interestFor, poolSnapshot, ensureAgent, approve, assertStaging, spent, ethers
};

/**
 * Global solvency read: marketplace USDC balance vs
 *   Σ_pools availableLiquidity + Σ_activeLoans collateral + accumulatedFees.
 * Per-pool: availableLiquidity + totalLoaned == Σ position.amount + Σ earnedInterest (over poolLenders).
 */
async function globalSolvency() {
    const { mp, reg, usdc } = contracts();
    const totalAgents = Number(await reg.totalAgents());
    const nextLoanId = Number(await mp.nextLoanId());
    let sumAvail = 0n, pools = 0;
    const perPool = {};
    for (let id = 1; id <= totalAgents; id++) {
        const p = await mp.agentPools(id);
        if (!p.isActive && p.agentId === 0n) continue;
        pools++;
        sumAvail += p.availableLiquidity;
        // per-pool conservation
        let sumAmt = 0n, sumEarned = 0n;
        for (let i = 0; i < 60; i++) {
            let l; try { l = await mp.poolLenders(id, i); } catch (e) { break; }
            const pos = await mp.positions(id, l);
            sumAmt += pos.amount; sumEarned += pos.earnedInterest;
        }
        perPool[id] = { availableLiquidity: p.availableLiquidity, totalLoaned: p.totalLoaned, sumAmount: sumAmt, sumEarned, conserved: p.availableLiquidity + p.totalLoaned === sumAmt + sumEarned };
    }
    let collateral = 0n;
    for (let lid = 1; lid < nextLoanId; lid++) {
        const l = await mp.loans(lid);
        if (Number(l.state) === 1) collateral += l.collateralAmount;
    }
    const fees = await mp.accumulatedFees();
    const balance = await usdc.balanceOf(cfg.agentLiquidityMarketplace_v6);
    const expected = sumAvail + collateral + fees;
    return { balance, expected, sumAvail, collateral, fees, pools, exact: balance === expected, surplus: balance - expected, perPool };
}
module.exports.globalSolvency = globalSolvency;
