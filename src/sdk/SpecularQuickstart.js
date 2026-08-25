/**
 * SpecularQuickstart — minimum-friction SDK for AI agent integration.
 *
 * One-call developer surface that bundles register + createAgentPool +
 * approve + first loan into a single async function. Designed to be the
 * default integration path for LangChain tools, OpenAI Functions, etc.
 *
 * Usage:
 *   const { SpecularQuickstart } = require('@specular/sdk');
 *   const sdk = new SpecularQuickstart(wallet, 'base'); // or 'arc'
 *   await sdk.onboard();                          // 3 tx, one call
 *   const loanId = await sdk.borrow(100, 30);     // borrow 100 USDC for 30 days
 *   await sdk.repay(loanId);                       // repay
 *   const info = await sdk.creditInfo();           // score, limit, rate
 */

const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');
const { assertDurationDays } = require('./duration');

// Resolve everything relative to THIS module, never the process CWD. With
// CWD-relative resolution, an agent framework running the SDK from an untrusted
// workspace could shadow ./src/config/*.json with attacker-chosen marketplace/
// usdc addresses — and onboarding would then approve/transact against them.
const REPO_ROOT = path.resolve(__dirname, '..', '..');

const NETWORK_CONFIGS = {
    base: {
        addresses: path.join(REPO_ROOT, 'src/config/base-addresses.json'),
        explorer: 'https://basescan.org/tx/',
        decimals: 6
    },
    arc: {
        addresses: path.join(REPO_ROOT, 'src/config/arc-testnet-addresses.json'),
        explorer: 'https://testnet.arcscan.app/tx/',
        decimals: 6
    },
    // Arc testnet V6-STAGING — the 2026-08 self-audited/fixed stack (levers ON,
    // fresh MockUSDC). Use this to exercise the SDK against the FIXED contracts.
    'arc-staging': {
        addresses: path.join(REPO_ROOT, 'src/config/arc-testnet-v6-addresses.json'),
        explorer: 'https://testnet.arcscan.app/tx/',
        decimals: 6
    }
};

class SpecularQuickstart {
    /**
     * @param {ethers.Wallet} wallet - signer wallet, must be connected to network
     * @param {'base'|'arc'} network
     */
    constructor(wallet, network = 'base') {
        if (!wallet || !wallet.provider) throw new Error('Wallet must have provider');
        if (!NETWORK_CONFIGS[network]) throw new Error(`Unknown network: ${network}`);

        this.wallet = wallet;
        this.network = network;
        this.cfg = NETWORK_CONFIGS[network];

        const addr = JSON.parse(fs.readFileSync(this.cfg.addresses, 'utf8'));
        this.addresses = {
            // arc/arc-staging expose the V6 marketplace under agentLiquidityMarketplace_v6;
            // base's canonical V6 lives under agentLiquidityMarketplace. Prefer _v6 when present.
            marketplace: addr.agentLiquidityMarketplace_v6 || addr.agentLiquidityMarketplace,
            registry: addr.agentRegistryV2,
            reputation: addr.reputationManagerV3,
            usdc: addr.usdc
        };

        const mpAbi = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'artifacts/contracts/core/AgentLiquidityMarketplaceV6.sol/AgentLiquidityMarketplaceV6.json'))).abi;
        const regAbi = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'artifacts/contracts/core/AgentRegistryV2.sol/AgentRegistryV2.json'))).abi;
        const repAbi = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'artifacts/contracts/core/ReputationManagerV3.sol/ReputationManagerV3.json'))).abi;
        const usdcAbi = [
            'function balanceOf(address) view returns (uint256)',
            'function approve(address,uint256) returns (bool)',
            'function allowance(address,address) view returns (uint256)'
        ];

        this.marketplace = new ethers.Contract(this.addresses.marketplace, mpAbi, wallet);
        this.registry = new ethers.Contract(this.addresses.registry, regAbi, wallet);
        this.reputation = new ethers.Contract(this.addresses.reputation, repAbi, wallet);
        this.usdc = new ethers.Contract(this.addresses.usdc, usdcAbi, wallet);
    }

    /**
     * One-call onboarding: register agent + create pool + approve USDC.
     * Returns { agentId, registerTx, poolTx, approveTx }.
     * If already onboarded, idempotent — skips completed steps.
     * @param {string} ipfsHash - metadata URI (default 'ipfs://agent')
     */
    async onboard(ipfsHash = 'ipfs://agent') {
        // approveTx is retained in the return shape for backward compat but is
        // always null now: we no longer grant a blanket allowance up front.
        // Each USDC-pulling op (borrow collateral, repay, supply) approves the
        // EXACT amount it needs just-in-time. A single marketplace bug can then
        // only ever touch the amount approved for the op in flight, never the
        // agent's whole balance (which an unbounded MaxUint256 allowance exposed
        // — especially dangerous given this contract's own §B1/§S1 history).
        const out = { agentId: null, registerTx: null, poolTx: null, approveTx: null };
        const addr = this.wallet.address;

        // Step 1: register (if not yet)
        let agentId = await this.registry.addressToAgentId(addr);
        if (agentId === 0n) {
            const tx = await this.registry.register(ipfsHash, []);
            await tx.wait();
            out.registerTx = tx.hash;
            // Public-RPC propagation: the registry write may not be visible
            // from every node yet. Poll until the marketplace's view of the
            // registry agrees, so the next call (createAgentPool) doesn't
            // revert with "Not a registered agent".
            for (let i = 0; i < 20; i++) {
                agentId = await this.registry.addressToAgentId(addr);
                if (agentId !== 0n) break;
                await new Promise(r => setTimeout(r, 1000));
            }
            if (agentId === 0n) throw new Error('register() confirmed but addressToAgentId still 0 after 20s');
        }
        out.agentId = Number(agentId);

        // Step 2: createAgentPool (if not yet)
        const pool = await this.marketplace.agentPools(agentId);
        if (!pool.isActive) {
            // Retry on RPC-state staleness; some public Base RPCs return inconsistent
            // views across nodes for a few seconds after a registry write
            let tx;
            for (let i = 0; i < 5; i++) {
                try {
                    tx = await this.marketplace.createAgentPool();
                    break;
                } catch (e) {
                    if (i === 4 || !/Not a registered agent/.test(e.message || '')) throw e;
                    await new Promise(r => setTimeout(r, 2000));
                }
            }
            await tx.wait();
            out.poolTx = tx.hash;
        }

        // Step 3 (approval) intentionally removed — approvals are now exact and
        // just-in-time per operation. See _approveExact / borrow / repay / supply.
        return out;
    }

    /**
     * Ensure the marketplace can pull exactly `amount` USDC for the next
     * operation, and no more. Idempotent: if the current allowance already
     * covers `amount` it does nothing (so a leftover allowance is spent down
     * rather than re-approved). USDC (unlike USDT) permits non-zero→non-zero
     * approve, so no reset dance is needed.
     * @param {bigint} amount - base units to approve
     * @returns {Promise<string|null>} approve tx hash, or null if already covered
     */
    async _approveExact(amount) {
        if (amount <= 0n) return null;
        const current = await this.usdc.allowance(this.wallet.address, this.addresses.marketplace);
        if (current >= amount) return null;
        const tx = await this.usdc.approve(this.addresses.marketplace, amount);
        await tx.wait();
        // [RPC-staleness fix] Public RPCs load-balance across nodes (Base's
        // mainnet.base.org especially); the just-mined approve may not be visible
        // from the replica the NEXT call's estimateGas hits, which then reverts
        // "ERC20: transfer amount exceeds allowance". Poll until the new allowance
        // is visible before returning, so the dependent pull (supply/collateral/
        // repay) sees a consistent view. Same pattern the loan-state polling uses.
        for (let i = 0; i < 15; i++) {
            const seen = await this.usdc.allowance(this.wallet.address, this.addresses.marketplace);
            if (seen >= amount) break;
            await new Promise(r => setTimeout(r, 1000));
        }
        return tx.hash;
    }

    /**
     * Revoke the marketplace's USDC allowance (set to 0). Useful after a
     * session, or to clear a stale allowance. Returns tx hash or null if
     * already zero.
     */
    async revokeApproval() {
        const current = await this.usdc.allowance(this.wallet.address, this.addresses.marketplace);
        if (current === 0n) return null;
        const tx = await this.usdc.approve(this.addresses.marketplace, 0n);
        await tx.wait();
        return tx.hash;
    }

    /**
     * Request a loan. Returns loanId. Calls onboard() first if needed.
     * @param {number|string|bigint} amount - USDC amount (in display units, e.g. 100 = 100 USDC)
     * @param {number} durationDays - 7 to 365
     */
    async borrow(amount, durationDays) {
        // Authoritative validation — this is the single choke point every tool
        // wrapper (LangChain/OpenAI/Anthropic) funnels through, so validating
        // here backstops any NaN/undefined that slips a wrapper's own guard.
        assertDurationDays(durationDays, 'SpecularQuickstart.borrow');
        // Amount unit convention: number|string = display units (e.g. 100 = 100
        // USDC), bigint = base units. Reject NaN/Infinity/≤0 before it dies
        // opaquely inside parseUnits or is sent to the chain.
        if (typeof amount !== 'bigint') {
            const n = Number(amount);
            if (!Number.isFinite(n) || n <= 0) {
                throw new Error(`SpecularQuickstart.borrow: amount must be a positive number, got ${amount}`);
            }
        } else if (amount <= 0n) {
            throw new Error('SpecularQuickstart.borrow: amount must be > 0');
        }

        await this.onboard();
        const amt = typeof amount === 'bigint' ? amount : ethers.parseUnits(String(amount), this.cfg.decimals);

        // Low-reputation agents must post collateral, which requestLoan pulls
        // via safeTransferFrom. Approve exactly that (0 for 0%-collateral tiers).
        // requiredCollateral = amount * collateralPercent / 100 (matches contract).
        const collateralPct = await this.reputation.calculateCollateralRequirement(this.wallet.address);
        const requiredCollateral = (amt * collateralPct) / 100n;
        await this._approveExact(requiredCollateral);

        // requestLoan with two robustness layers:
        //  (a) Exact-approval is the common path (D2). If the contract pulls
        //      marginally MORE collateral than amount*pct/100 (rounding/version),
        //      approve a BOUNDED buffer (collateral + principal, capped, to the
        //      trusted marketplace) once, then revoke the leftover below.
        //  (b) Transient RPC staleness: on load-balanced public RPCs the prior
        //      supply/registration may not be visible from the replica this call's
        //      estimateGas hits ("Insufficient pool liquidity" / "Not a registered
        //      agent"). Back off and retry.
        let tx, buffered = false;
        for (let attempt = 0; attempt < 6; attempt++) {
            try {
                tx = await this.marketplace.requestLoan(amt, durationDays);
                break;
            } catch (e) {
                const msg = e.message || '';
                if (!buffered && /allowance|exceeds|transfer amount/i.test(msg)) {
                    buffered = true;
                    await this._approveExact(requiredCollateral + amt);
                    continue;
                }
                if (attempt < 5 && /Insufficient pool liquidity|Not a registered agent|No pool for agent/i.test(msg)) {
                    await new Promise(r => setTimeout(r, 2000));
                    continue;
                }
                throw e;
            }
        }
        if (!tx) throw new Error('requestLoan failed after retries');
        const r = await tx.wait();
        let loanId = null;
        for (const log of r.logs) {
            try {
                const parsed = this.marketplace.interface.parseLog(log);
                if (parsed && parsed.name === 'LoanRequested') { loanId = Number(parsed.args.loanId); break; }
            } catch (e) {}
        }
        if (loanId === null) throw new Error('LoanRequested event not found in receipt');
        // Restore exact-approval: clear any leftover collateral allowance — only
        // on the buffer path (the common exact path leaves 0, no read/tx needed).
        if (buffered) await this.revokeApproval().catch(() => {});
        // Public-RPC propagation: poll until the loan is readable from the
        // marketplace's view so the next call (e.g. repay) doesn't hit a
        // stale node that returns loan.borrower=0x0 → "Not the borrower"
        for (let i = 0; i < 20; i++) {
            const loan = await this.marketplace.loans(loanId);
            if (loan[1] && loan[1].toLowerCase() === this.wallet.address.toLowerCase()) break;
            await new Promise(r => setTimeout(r, 1000));
        }
        return { loanId, tx: tx.hash };
    }

    /**
     * Repay a loan. Returns tx hash. Retries on transient "Not the borrower"
     * errors which indicate the prior borrow's storage write is not yet
     * visible from this RPC node.
     */
    async repay(loanId) {
        // Approve exactly the total owed (principal + interest). The contract
        // computes interest from loan.duration (the FIXED full term), not
        // elapsed time, so this client-side figure matches to the base unit —
        // no time-drift, no over-approval.
        const loan = await this.marketplace.loans(loanId);
        const interest = await this.marketplace.calculateInterest(loan.amount, loan.interestRate, loan.duration);
        await this._approveExact(loan.amount + interest);

        let tx, bumped = false;
        for (let i = 0; i < 5; i++) {
            try {
                tx = await this.marketplace.repayLoan(loanId);
                break;
            } catch (e) {
                const msg = e.message || '';
                // Same bounded-buffer fallback as borrow: if the contract pulls
                // slightly more than principal+interest (rounding / drift), bump
                // the approval by one more interest-worth (bounded) and retry.
                if (!bumped && /allowance|exceeds|transfer amount/i.test(msg)) {
                    bumped = true;
                    await this._approveExact(loan.amount + interest * 2n);
                    continue;
                }
                if (i === 4 || !/Not the borrower/.test(msg)) throw e;
                await new Promise(r => setTimeout(r, 2000));
            }
        }
        await tx.wait();
        // Restore exact-approval if the buffer path was taken (no-op otherwise).
        if (bumped) await this.revokeApproval().catch(() => {});
        return tx.hash;
    }

    /**
     * Supply USDC liquidity to an agent's pool. Approves exactly `amt`.
     */
    async supply(agentId, amount) {
        const amt = typeof amount === 'bigint' ? amount : ethers.parseUnits(String(amount), this.cfg.decimals);
        await this._approveExact(amt);
        const tx = await this.marketplace.supplyLiquidity(agentId, amt);
        await tx.wait();
        return tx.hash;
    }

    /**
     * Withdraw lender position.
     */
    async withdraw(agentId, amount) {
        const amt = typeof amount === 'bigint' ? amount : ethers.parseUnits(String(amount), this.cfg.decimals);
        const tx = await this.marketplace.withdrawLiquidity(agentId, amt);
        await tx.wait();
        return tx.hash;
    }

    /**
     * Claim accrued interest from a pool.
     */
    async claim(agentId) {
        const tx = await this.marketplace.claimInterest(agentId);
        await tx.wait();
        return tx.hash;
    }

    /**
     * Returns current credit info: { score, creditLimit, collateralPct, interestRateBps }.
     * Use this to decide loan amounts/durations.
     */
    async creditInfo() {
        const addr = this.wallet.address;
        const [score, creditLimit, collPct, rateBps] = await Promise.all([
            this.reputation['getReputationScore(address)'](addr),
            this.reputation.calculateCreditLimit(addr),
            this.reputation.calculateCollateralRequirement(addr),
            this.reputation.calculateInterestRate(addr)
        ]);
        return {
            score: Number(score),
            creditLimit: ethers.formatUnits(creditLimit, this.cfg.decimals),
            collateralPct: Number(collPct),
            interestRateBps: Number(rateBps),
            interestRateAPR: Number(rateBps) / 100
        };
    }

    /**
     * Returns active loans for this agent.
     */
    async loans() {
        const addr = this.wallet.address;
        const out = [];
        let i = 0;
        while (true) {
            try {
                const lid = await this.marketplace.agentLoans(addr, i);
                const l = await this.marketplace.loans(lid);
                const states = ['REQUESTED', 'ACTIVE', 'REPAID', 'DEFAULTED'];
                out.push({
                    id: Number(lid),
                    amount: ethers.formatUnits(l.amount, this.cfg.decimals),
                    interestRate: Number(l.interestRate),
                    state: states[Number(l.state)],
                    endTime: Number(l.endTime)
                });
                i++;
            } catch (e) { break; }
        }
        return out;
    }

    /**
     * Returns explorer URL for a tx hash.
     */
    explorerUrl(txHash) { return this.cfg.explorer + txHash; }
}

module.exports = { SpecularQuickstart };
