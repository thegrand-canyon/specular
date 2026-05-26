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

const NETWORK_CONFIGS = {
    base: {
        addresses: './src/config/base-addresses.json',
        explorer: 'https://basescan.org/tx/',
        decimals: 6
    },
    arc: {
        addresses: './src/config/arc-testnet-addresses.json',
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

        const addrPath = path.resolve(this.cfg.addresses);
        const addr = JSON.parse(fs.readFileSync(addrPath, 'utf8'));
        this.addresses = {
            marketplace: this.network === 'arc'
                ? addr.agentLiquidityMarketplace_v6  // arc: V6 not yet canonical
                : addr.agentLiquidityMarketplace,    // base: V6 IS canonical
            registry: addr.agentRegistryV2,
            reputation: addr.reputationManagerV3,
            usdc: addr.usdc
        };

        const root = path.resolve('.');
        const mpAbi = JSON.parse(fs.readFileSync(path.join(root, 'artifacts/contracts/core/AgentLiquidityMarketplaceV6.sol/AgentLiquidityMarketplaceV6.json'))).abi;
        const regAbi = JSON.parse(fs.readFileSync(path.join(root, 'artifacts/contracts/core/AgentRegistryV2.sol/AgentRegistryV2.json'))).abi;
        const repAbi = JSON.parse(fs.readFileSync(path.join(root, 'artifacts/contracts/core/ReputationManagerV3.sol/ReputationManagerV3.json'))).abi;
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

        // Step 3: approve USDC (if not yet)
        const allowance = await this.usdc.allowance(addr, this.addresses.marketplace);
        if (allowance < ethers.MaxUint256 / 2n) {
            const tx = await this.usdc.approve(this.addresses.marketplace, ethers.MaxUint256);
            await tx.wait();
            out.approveTx = tx.hash;
        }

        return out;
    }

    /**
     * Request a loan. Returns loanId. Calls onboard() first if needed.
     * @param {number|string|bigint} amount - USDC amount (in display units, e.g. 100 = 100 USDC)
     * @param {number} durationDays - 7 to 365
     */
    async borrow(amount, durationDays) {
        await this.onboard();
        const amt = typeof amount === 'bigint' ? amount : ethers.parseUnits(String(amount), this.cfg.decimals);
        const tx = await this.marketplace.requestLoan(amt, durationDays);
        const r = await tx.wait();
        let loanId = null;
        for (const log of r.logs) {
            try {
                const parsed = this.marketplace.interface.parseLog(log);
                if (parsed && parsed.name === 'LoanRequested') { loanId = Number(parsed.args.loanId); break; }
            } catch (e) {}
        }
        if (loanId === null) throw new Error('LoanRequested event not found in receipt');
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
        let tx;
        for (let i = 0; i < 5; i++) {
            try {
                tx = await this.marketplace.repayLoan(loanId);
                break;
            } catch (e) {
                if (i === 4 || !/Not the borrower/.test(e.message || '')) throw e;
                await new Promise(r => setTimeout(r, 2000));
            }
        }
        await tx.wait();
        return tx.hash;
    }

    /**
     * Ensure msg.sender has MaxUint allowance to the marketplace. Idempotent.
     * Returns the approve tx hash if one was needed, null if already approved.
     */
    async _ensureUsdcApproval() {
        const allowance = await this.usdc.allowance(this.wallet.address, this.addresses.marketplace);
        if (allowance < ethers.MaxUint256 / 2n) {
            const tx = await this.usdc.approve(this.addresses.marketplace, ethers.MaxUint256);
            await tx.wait();
            return tx.hash;
        }
        return null;
    }

    /**
     * Supply USDC liquidity to an agent's pool. Auto-approves USDC if needed.
     */
    async supply(agentId, amount) {
        await this._ensureUsdcApproval();
        const amt = typeof amount === 'bigint' ? amount : ethers.parseUnits(String(amount), this.cfg.decimals);
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
