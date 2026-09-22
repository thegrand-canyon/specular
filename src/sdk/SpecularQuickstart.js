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
    },
    // Arc MAINNET (chainId 5042) — real USDC (0x3600…0000, 6-dec ERC-20 view of the
    // native gas token). Deployed 2026-09-19; same fixed V6 code as arc-staging.
    'arc-mainnet': {
        addresses: path.join(REPO_ROOT, 'src/config/arc-mainnet-addresses.json'),
        explorer: 'https://explorer.arc.io/tx/',
        decimals: 6
    }
};

class SpecularQuickstart {
    /**
     * @param {ethers.Wallet} wallet - signer wallet, must be connected to network
     * @param {'base'|'arc'|'arc-staging'|'arc-mainnet'} network
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

        // [ROBUSTNESS F-R8] Bound every receipt wait. ethers' `tx.wait()` with no
        // timeout blocks FOREVER when the RPC stops returning receipts — an
        // unattended agent simply stops. Set to 0 to restore unbounded waiting.
        this.receiptTimeoutMs = 180000;
        // [ROBUSTNESS F-R5] Highest block this instance has observed. Used to
        // detect an RPC that load-balanced onto a lagging replica (or a reorg).
        this._maxSeenBlock = undefined;

        this.marketplace = new ethers.Contract(this.addresses.marketplace, mpAbi, wallet);
        this.registry = new ethers.Contract(this.addresses.registry, regAbi, wallet);
        this.reputation = new ethers.Contract(this.addresses.reputation, repAbi, wallet);
        this.usdc = new ethers.Contract(this.addresses.usdc, usdcAbi, wallet);
    }

    // ------------------------------------------------------------------
    // Robustness primitives (2026-09 SDK robustness pass)
    // ------------------------------------------------------------------

    /** Wall-clock lag (seconds) beyond which the RPC head is considered stale. */
    static get MAX_BLOCK_LAG_SECONDS() { return 600; }

    /**
     * [ROBUSTNESS F-R9] Authoritative amount parsing for every USDC-denominated
     * argument. `supply`/`withdraw` previously fed agent-supplied values straight
     * into `ethers.parseUnits(String(amount))`, so a negative amount, a NaN, an
     * object, or a value in exponential notation (`1e-7`, `1e21` — what
     * `String()` produces for small/large numbers) died with an opaque ethers
     * error, or in the negative case only failed later at ABI encoding.
     *
     * number|string are DISPLAY units (100 = 100 USDC); bigint is base units.
     */
    static _toBaseUnits(amount, decimals, ctx) {
        if (typeof amount === 'bigint') {
            if (amount <= 0n) throw new Error(`${ctx}: amount must be a positive number, got ${amount}`);
            return amount;
        }
        if (typeof amount !== 'number' && typeof amount !== 'string') {
            throw new Error(`${ctx}: amount must be a number, numeric string or bigint, got ${typeof amount}`);
        }
        const n = Number(amount);
        if (!Number.isFinite(n) || n <= 0) {
            throw new Error(`${ctx}: amount must be a positive number, got ${amount}`);
        }
        let out;
        try {
            out = ethers.parseUnits(String(amount), decimals);
        } catch (e) {
            throw new Error(
                `${ctx}: amount ${amount} is not representable as a ${decimals}-decimal USDC value ` +
                `(${e.shortMessage || e.message}). Pass a plain decimal string, or bigint base units.`);
        }
        if (out <= 0n) throw new Error(`${ctx}: amount ${amount} rounds to 0 base units`);
        return out;
    }

    /**
     * [ROBUSTNESS F-R10] Serialize this wallet's write operations.
     *
     * Every SDK op is multi-transaction (approve → act → revoke). ethers resolves
     * each nonce at send time from `pending`, so two SDK calls in flight on the
     * same wallet hand the same nonce to two different transactions: one lands,
     * the other dies "nonce has already been used" — and to an unattended agent
     * that looks like a random failure of whichever op lost the race. An agent
     * firing `supply`/`borrow`/`repay` together (a perfectly reasonable thing to
     * do) hit this every time.
     *
     * Public mutating methods queue behind each other; internal helpers call the
     * `*Inner` variants so a nested call can never deadlock on the same queue.
     * For deliberate parallel bursts from one key, use `NonceCounter`
     * (`src/sdk/nonce.js`) and drive the contracts directly.
     */
    async _serialize(fn) {
        const prev = this._txQueue || Promise.resolve();
        let release;
        this._txQueue = new Promise((r) => { release = r; });
        try { await prev; } catch (_) { /* a predecessor's failure must not block us */ }
        try { return await fn(); } finally { release(); }
    }

    /**
     * [ROBUSTNESS F-R16] Validate an agent id. `supply`/`withdraw`/`claim` took
     * whatever the caller (often an LLM tool call) passed and handed it to
     * ethers, where a NaN/float/string died with an opaque ABI-encoding error
     * after the SDK had already spent RPC calls — and, for `supply`, after it
     * had already sent an approve.
     */
    static _toAgentId(agentId, ctx) {
        const n = typeof agentId === 'bigint' ? Number(agentId) : Number(agentId);
        if (agentId === null || agentId === undefined || typeof agentId === 'object' ||
            typeof agentId === 'boolean' || !Number.isInteger(n) || n < 0) {
            throw new Error(`${ctx}: agentId must be a non-negative integer, got ${String(agentId)}`);
        }
        return n;
    }

    /**
     * [ROBUSTNESS F-R17] Validate an agent metadata URI before it is written to
     * the registry. An agent-supplied value went straight on chain: a megabyte
     * string burns unbounded gas (and can exceed the block limit, so onboarding
     * fails in a way no retry fixes), and control characters produce metadata
     * no consumer can parse.
     */
    static get MAX_METADATA_URI_BYTES() { return 2048; }
    static _assertMetadataUri(uri, ctx = 'SpecularQuickstart.onboard') {
        if (typeof uri !== 'string') {
            throw new Error(`${ctx}: metadata URI must be a string, got ${typeof uri}`);
        }
        if (uri.length === 0) throw new Error(`${ctx}: metadata URI must not be empty`);
        const bytes = Buffer.byteLength(uri, 'utf8');
        if (bytes > SpecularQuickstart.MAX_METADATA_URI_BYTES) {
            throw new Error(
                `${ctx}: metadata URI is ${bytes} bytes, over the ${SpecularQuickstart.MAX_METADATA_URI_BYTES}-byte ` +
                'limit — store the document off chain and register its URI instead.');
        }
        // eslint-disable-next-line no-control-regex
        if (/[ -]/.test(uri) || /\s/.test(uri)) {
            throw new Error(`${ctx}: metadata URI must not contain whitespace or control characters`);
        }
        return uri;
    }

    /** Record the highest block height this instance has seen. */
    _noteBlock(n) {
        const b = Number(n);
        if (!Number.isFinite(b)) return;
        if (this._maxSeenBlock === undefined || b > this._maxSeenBlock) this._maxSeenBlock = b;
    }

    /**
     * [ROBUSTNESS F-R8] Bounded receipt wait. Also feeds the staleness detector.
     */
    async _wait(tx) {
        const ms = this.receiptTimeoutMs;
        const receipt = ms ? await tx.wait(1, ms) : await tx.wait();
        if (receipt) this._noteBlock(receipt.blockNumber);
        return receipt;
    }

    /**
     * [ROBUSTNESS F-R5] Refuse to size money from stale state.
     *
     * Public RPC endpoints load-balance across replicas at different heights. A
     * read served from a replica minutes behind head makes a LATE loan look
     * on-time, so `previewRepayment` returns a smaller figure than the chain
     * will actually pull — the SDK then approves too little and the repay
     * reverts. Nothing in the SDK used to notice.
     *
     * Two checks, both cheap:
     *  (a) monotonic — the head must never be below a block we already observed
     *      (catches a mid-flow replica rollback AND a chain reorg);
     *  (b) wall clock — the head block must not be more than
     *      `maxBlockLagSeconds` behind real time (catches an endpoint that is
     *      globally lagging, where we have no earlier observation to compare).
     *      A head that is AHEAD of wall clock is never flagged (test chains,
     *      clock skew).
     *
     * Set `sdk.stalenessCheck = false` (or `maxBlockLagSeconds = 0` for (b)
     * alone) to opt out.
     */
    async _assertChainNotBehind(ctx = 'SpecularQuickstart') {
        if (this.stalenessCheck === false) return null;
        const p = this.wallet && this.wallet.provider;
        if (!p || typeof p.getBlockNumber !== 'function') return null; // nothing to compare against
        const head = Number(await SpecularQuickstart._retryTransient(
            () => this.wallet.provider.getBlockNumber()));
        if (this._maxSeenBlock !== undefined && head < this._maxSeenBlock) {
            throw new Error(
                `${ctx}: the RPC is serving state BEHIND what this session already observed ` +
                `(head ${head} < block ${this._maxSeenBlock} seen earlier). Either it load-balanced onto a lagging ` +
                'replica or the chain reorged. Refusing to act on stale state — retry, or set ' +
                '`sdk.stalenessCheck = false` to override.');
        }
        this._noteBlock(head);
        const maxLag = this.maxBlockLagSeconds === undefined
            ? SpecularQuickstart.MAX_BLOCK_LAG_SECONDS
            : this.maxBlockLagSeconds;
        if (maxLag) {
            const blk = await SpecularQuickstart._retryTransient(
                () => this.wallet.provider.getBlock(head)).catch(() => null);
            if (blk && blk.timestamp) {
                const lag = Math.floor(Date.now() / 1000) - Number(blk.timestamp);
                if (lag > maxLag) {
                    throw new Error(
                        `${ctx}: RPC head block ${head} is ${lag}s behind wall clock (max ${maxLag}s) — this endpoint ` +
                        'is serving stale state. Refusing to size an approval or a loan from it; retry against a ' +
                        'healthy RPC, or set `sdk.maxBlockLagSeconds = 0` to override.');
                }
            }
        }
        return head;
    }

    /**
     * [ROBUSTNESS F-R4] Run a USDC-pulling operation and guarantee that a
     * FAILURE never leaves the marketplace holding an allowance.
     *
     * The exact-approval model's resting state is zero. Before this, any error
     * between `_approveExact(...)` and the pull — a 503 on estimateGas, a
     * dropped socket in `wait()`, the process being killed — left a standing
     * allowance the marketplace could draw later.
     */
    async _withApprovalCleanup(fn) {
        this._approvedThisOp = false;
        try {
            return await fn();
        } catch (e) {
            if (this._approvedThisOp) {
                try { await this._revokeApprovalInner(); } catch (_) { /* best effort; residual stays bounded */ }
            }
            throw e;
        } finally {
            this._approvedThisOp = false;
        }
    }

    /** Number of loan ids recorded for this wallet (the `agentLoans[]` array length). */
    async _loanCount() {
        let i = 0;
        // eslint-disable-next-line no-constant-condition
        while (true) {
            try { await this.marketplace.agentLoans(this.wallet.address, i); } catch (_) { return i; }
            i++;
            if (i > 10000) return i;
        }
    }

    /**
     * [ROBUSTNESS F-R6] A borrow whose send response was lost may still have
     * mined. Poll for a new loan belonging to this wallet and adopt it rather
     * than letting the caller retry — a naive retry opens a SECOND loan.
     */
    async _reconcileNewLoan(countBefore, attempts = 10, delayMs = 1000) {
        for (let i = 0; i < attempts; i++) {
            let n;
            try { n = await this._loanCount(); } catch (_) { n = null; }
            if (n !== null && n > countBefore) {
                try { return Number(await this.marketplace.agentLoans(this.wallet.address, n - 1)); } catch (_) { /* retry */ }
            }
            await new Promise(r => setTimeout(r, delayMs));
        }
        return null;
    }

    /** [F-R6] Poll until `loanId` leaves ACTIVE (1) — i.e. a lost repay actually settled. */
    async _loanSettled(loanId, attempts = 10, delayMs = 1000) {
        for (let i = 0; i < attempts; i++) {
            try {
                const st = Number((await this.marketplace.loans(loanId)).state);
                if (st === 2 || st === 3) return st;
            } catch (_) { /* transient */ }
            await new Promise(r => setTimeout(r, delayMs));
        }
        return null;
    }

    /** A failure that might still have landed on chain (network/timeout), vs a definite revert. */
    static _isInconclusive(e) {
        if (!e) return false;
        if (SpecularQuickstart._isRealRevert(e)) return false;
        const code = e.code;
        return code === 'TIMEOUT' || code === 'NETWORK_ERROR' || code === 'SERVER_ERROR' ||
               code === 'UNKNOWN_ERROR' || code === 'CALL_EXCEPTION' || code === 'REPLACEMENT_UNDERPRICED' ||
               /timeout|socket|ECONN|coalesce|network/i.test(`${e.message || ''} ${e.shortMessage || ''}`);
    }

    /**
     * One-call onboarding: register agent + create pool + approve USDC.
     * Returns { agentId, registerTx, poolTx, approveTx }.
     * If already onboarded, idempotent — skips completed steps.
     * @param {string} ipfsHash - metadata URI (default 'ipfs://agent')
     */
    async onboard(ipfsHash = 'ipfs://agent') {
        SpecularQuickstart._assertMetadataUri(ipfsHash);
        return this._serialize(() => this._onboardInner(ipfsHash));
    }

    async _onboardInner(ipfsHash = 'ipfs://agent') {
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
            await this._wait(tx);
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
            await this._wait(tx);
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
        // [ROBUSTNESS F-R15] EXACT means exact in both directions. A larger
        // pre-existing allowance (left by a crashed session, or by an older SDK
        // that granted MaxUint256) used to be accepted as "already covered" and
        // silently carried forward, so a wallet could keep an unbounded approval
        // standing forever while every SDK call reported exact behaviour. Tighten
        // it down to what this operation actually needs — one extra approve, and
        // only in the anomalous case.
        if (current === amount) return null;
        if (current > amount) {
            const tx0 = await this.usdc.approve(this.addresses.marketplace, amount);
            this._approvedThisOp = true;
            await this._wait(tx0);
            return tx0.hash;
        }
        const tx = await this.usdc.approve(this.addresses.marketplace, amount);
        // Mark BEFORE waiting: if wait() dies on a dropped socket the approval may
        // still have mined, so the cleanup path must run. (F-R4)
        this._approvedThisOp = true;
        await this._wait(tx);
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
        return this._serialize(() => this._revokeApprovalInner());
    }

    /** Unlocked revoke — used from inside an op that already holds the write queue. */
    async _revokeApprovalInner() {
        const current = await this.usdc.allowance(this.wallet.address, this.addresses.marketplace);
        if (current === 0n) return null;
        const tx = await this.usdc.approve(this.addresses.marketplace, 0n);
        await this._wait(tx);
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

        const amt = SpecularQuickstart._toBaseUnits(amount, this.cfg.decimals, 'SpecularQuickstart.borrow');
        return this._serialize(async () => {
            await this._onboardInner();
            return this._withApprovalCleanup(() => this._borrowInner(amt, durationDays));
        });
    }

    async _borrowInner(amt, durationDays) {
        // [F-R5] Never size collateral (or decide a tier) from a lagging replica.
        await this._assertChainNotBehind('SpecularQuickstart.borrow');

        // How many loans this borrower already has — used to reconcile a borrow
        // whose send response was lost but which actually mined (F-R6).
        const loansBefore = await this._loanCount().catch(() => null);

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
                if (!buffered && SpecularQuickstart.isAllowanceShortfall(e)) {
                    buffered = true;
                    await this._approveExact(requiredCollateral + amt);
                    continue;
                }
                if (attempt < 5 && /Insufficient pool liquidity|Not a registered agent|No pool for agent/i.test(msg)) {
                    await new Promise(r => setTimeout(r, 2000));
                    continue;
                }
                // [F-R6] The send may have landed even though the response didn't
                // come back. NEVER blindly resend (that double-borrows); instead
                // reconcile against the chain and adopt the loan if one appeared.
                if (SpecularQuickstart._isInconclusive(e) && loansBefore !== null) {
                    const adopted = await this._reconcileNewLoan(loansBefore);
                    if (adopted !== null) return { loanId: adopted, tx: null, reconciled: true };
                }
                throw e;
            }
        }
        if (!tx) throw new Error('requestLoan failed after retries');
        let r;
        try {
            r = await this._wait(tx);
        } catch (e) {
            if (SpecularQuickstart._isInconclusive(e) && loansBefore !== null) {
                const adopted = await this._reconcileNewLoan(loansBefore);
                if (adopted !== null) return { loanId: adopted, tx: tx.hash, reconciled: true };
            }
            throw e;
        }
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
        if (buffered) await this._revokeApprovalInner().catch(() => {});
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

    // ------------------------------------------------------------------
    // V6.1 capability detection (2026-09 audit fixes)
    //
    // V6.1 added `VERSION()`, `previewRepayment`, `canTopUp`, `getActiveLoanIds`
    // and changed `repayLoan` to charge interest on max(duration, elapsed)
    // (capped at duration + LATE_INTEREST_CAP). Pre-V6.1 deployments (Arc
    // testnet V6-staging, Base canonical) have none of those selectors, so every
    // new call is gated on the version and falls back to the V6 computation.
    // ------------------------------------------------------------------

    /**
     * [ROBUSTNESS F-R1] Distinguish "this deployment does not have that
     * function" from "the RPC failed while I asked".
     *
     * Only the former may downgrade capability detection. A 429/500/timeout/
     * socket reset mistaken for a missing selector silently switches the SDK to
     * V6 repayment math on a V6.1 chain, which UNDER-APPROVES a late repayment
     * — the repay then reverts and the agent cannot close its loan at all.
     *
     * Missing selector looks like: not in the ABI (TypeError), empty return
     * data (BAD_DATA), or a revert carrying no data/reason (CALL_EXCEPTION with
     * data '0x'). Everything else — notably any transport-level error — is
     * transient and must NOT be treated as a capability answer.
     */
    /**
     * A genuine contract revert carrying a payload (reason string or custom
     * error data). Anything else — a transport failure during `eth_call`
     * included — is indistinguishable from an empty revert at the ethers layer,
     * which is exactly why capability detection must NOT rely on error shapes.
     */
    static _isRealRevert(e) {
        return !!(e && e.code === 'CALL_EXCEPTION' && ((e.data && e.data !== '0x') || e.reason));
    }

    /** Retry `fn` while the failure could be transient; surface real reverts / ABI errors at once. */
    static async _retryTransient(fn, { attempts = 3, delayMs = 400 } = {}) {
        let last;
        for (let i = 0; i < attempts; i++) {
            try {
                return await fn();
            } catch (e) {
                last = e;
                if (SpecularQuickstart._isRealRevert(e) || e instanceof TypeError || e.code === 'BAD_DATA') throw e;
                if (i < attempts - 1) await new Promise(r => setTimeout(r, delayMs));
            }
        }
        throw last;
    }

    /**
     * [ROBUSTNESS F-R1] Is `name` actually deployed at the marketplace?
     *
     * Answered from the DEPLOYED BYTECODE (`eth_getCode`, cached), not from
     * whether an `eth_call` happened to fail. ethers collapses a 429/500/socket
     * reset during `eth_call` into the same `CALL_EXCEPTION (no data)` it
     * produces for a selector the contract does not implement, so the previous
     * `try { VERSION() } catch { 'V6' }` treated one transient RPC hiccup as
     * "this is an old deployment" — and then under-approved every late
     * repayment on a V6.1 chain.
     */
    async _codeHasSelector(name) {
        let frag;
        try { frag = this.marketplace.interface.getFunction(name); } catch (_) { return false; }
        if (!frag) return false;
        if (this._mpCode === undefined) {
            const code = await SpecularQuickstart._retryTransient(
                () => this.wallet.provider.getCode(this.addresses.marketplace));
            if (!code || code === '0x') {
                throw new Error(
                    `SpecularQuickstart: no contract code at marketplace ${this.addresses.marketplace} ` +
                    '(wrong address, wrong network, or an RPC serving an empty view).');
            }
            this._mpCode = code.toLowerCase();
        }
        return this._mpCode.includes(frag.selector.slice(2).toLowerCase());
    }

    /**
     * Marketplace contract version string. 'V6' for deployments that predate
     * `VERSION()` (pre-2026-09 code), otherwise whatever the contract reports
     * (e.g. 'V6.1'). Cached per instance (the contract is not proxied).
     *
     * [ROBUSTNESS F-R1] Capability is decided by deployed bytecode; a transient
     * RPC failure is retried and then SURFACED, never silently cached as 'V6'.
     */
    async marketplaceVersion() {
        if (this._mpVersion !== undefined) return this._mpVersion;
        let present;
        try {
            present = await this._codeHasSelector('VERSION');
        } catch (e) {
            const err = new Error(
                `SpecularQuickstart: could not determine the marketplace version at ${this.addresses.marketplace} ` +
                `(${e.shortMessage || e.message}). Refusing to guess — guessing "V6" would under-approve a late ` +
                'repayment on a V6.1 deployment and the repay would revert. Retry against a healthy RPC.');
            err.code = 'SPECULAR_VERSION_UNKNOWN';
            err.cause = e;
            throw err;
        }
        if (!present) { this._mpVersion = 'V6'; return this._mpVersion; }
        const v = await SpecularQuickstart._retryTransient(() => this.marketplace.VERSION());
        this._mpVersion = String(v);
        return this._mpVersion;
    }

    /** True when the deployment exposes the V6.1 views (previewRepayment, canTopUp, getActiveLoanIds). */
    async _hasV61Views() {
        return (await this.marketplaceVersion()) !== 'V6';
    }

    /**
     * [ROBUSTNESS F-R3] Did this failure mean "the marketplace tried to pull
     * more USDC than I approved"?
     *
     * The original string test (`/allowance|exceeds|transfer amount/i` over
     * `e.message`) only matches legacy string reverts like Base USDC's
     * "ERC20: transfer amount exceeds allowance". OpenZeppelin v5 tokens — and
     * anything else using custom errors — revert with
     * `ERC20InsufficientAllowance(address,uint256,uint256)` (selector
     * 0xfb8f41b2), whose ethers message is the useless "execution reverted
     * (unknown custom error)". That made the SDK's bounded-buffer safety net
     * silently dead on those tokens: the repay/borrow just failed.
     */
    static ERC20_INSUFFICIENT_ALLOWANCE = '0xfb8f41b2';
    static isAllowanceShortfall(e) {
        if (!e) return false;
        const msg = `${e.message || ''} ${e.shortMessage || ''} ${e.reason || ''}`;
        if (/allowance|exceeds|transfer amount/i.test(msg)) return true;
        const candidates = [
            e.data,
            e.info && e.info.error && e.info.error.data,
            e.error && e.error.data,
            e.revert && e.revert.data
        ];
        for (const d of candidates) {
            if (typeof d === 'string' && d.toLowerCase().startsWith(SpecularQuickstart.ERC20_INSUFFICIENT_ALLOWANCE)) return true;
        }
        return false;
    }

    /** Mirrors calculateInterest() exactly (divide-before-multiply), in seconds. */
    static interestForSeconds(principal, rateBps, seconds) {
        const annual = (BigInt(principal) * BigInt(rateBps)) / 10000n;
        return (annual * BigInt(seconds)) / BigInt(365 * 86400);
    }

    /**
     * Exact amount `repayLoan(loanId)` would pull right now.
     *
     * V6.1: `previewRepayment(loanId)` (interest on max(duration, elapsed),
     * capped at duration + LATE_INTEREST_CAP). V6: the nominal fixed-term
     * figure `calculateInterest(amount, rate, duration)` — which is what V6
     * actually charges. All amounts are bigint base units.
     *
     * @returns {Promise<{principal:bigint, interest:bigint, total:bigint, chargeableSeconds:bigint, lateSeconds:bigint, durationSeconds:bigint, interestRateBps:bigint, source:'previewRepayment'|'calculateInterest'}>}
     */
    async previewRepayment(loanId) {
        const loan = await this.marketplace.loans(loanId);
        if (await this._hasV61Views()) {
            try {
                const pv = await SpecularQuickstart._retryTransient(() => this.marketplace.previewRepayment(loanId));
                return {
                    principal: loan.amount,
                    interest: pv.interest,
                    total: pv.total,
                    chargeableSeconds: pv.chargeableSeconds,
                    lateSeconds: pv.lateSeconds,
                    durationSeconds: loan.duration,
                    interestRateBps: loan.interestRate,
                    source: 'previewRepayment'
                };
            } catch (e) {
                // [ROBUSTNESS F-R2] Fall back to the nominal figure ONLY when the
                // selector is genuinely absent from the deployed bytecode. A real
                // revert ("Loan not active") and any transient RPC failure must
                // surface: silently returning the V6 nominal amount for a LATE V6.1
                // loan under-approves the repay, which then reverts and the agent
                // cannot close the loan at all.
                let deployed = true;
                try { deployed = await this._codeHasSelector('previewRepayment'); } catch (_) { deployed = true; }
                if (deployed) throw e;
            }
        }
        const interest = await this.marketplace.calculateInterest(loan.amount, loan.interestRate, loan.duration);
        return {
            principal: loan.amount,
            interest,
            total: loan.amount + interest,
            chargeableSeconds: loan.duration,
            lateSeconds: 0n,
            durationSeconds: loan.duration,
            interestRateBps: loan.interestRate,
            source: 'calculateInterest'
        };
    }

    /**
     * Seconds of extra accrual to cover between the preview and the mined
     * repay on a LATE loan (V6.1 charges per second until the cap). Bounded and
     * clamped to the contract cap; leftover allowance is revoked after repay.
     */
    static get LATE_REPAY_HEADROOM_SECONDS() { return 600; }

    /**
     * Amount to approve for repay(loanId): exactly previewRepayment().total,
     * plus — only for a loan that is late AND still under the interest cap — the
     * interest that can accrue during LATE_REPAY_HEADROOM_SECONDS (clamped at
     * duration + LATE_INTEREST_CAP, so it can never exceed the maximum the
     * contract could ever pull). On-time loans and cap-hit late loans owe a
     * constant amount, so their approval is exact to the base unit.
     * @returns {Promise<{approve:bigint, preview:object, headroom:bigint}>}
     */
    async _repayApproval(loanId) {
        // [F-R5] A stale replica makes a LATE loan read as on-time and cheap, so
        // the approval would be sized below what the chain will actually pull.
        await this._assertChainNotBehind('SpecularQuickstart.repay');
        const preview = await this.previewRepayment(loanId);
        let headroom = 0n;
        if (preview.source === 'previewRepayment' && preview.lateSeconds > 0n) {
            let cap;
            try { cap = BigInt(await this.marketplace.LATE_INTEREST_CAP()); } catch (e) { cap = 30n * 86400n; }
            const maxChargeable = preview.durationSeconds + cap;
            let target = preview.chargeableSeconds + BigInt(SpecularQuickstart.LATE_REPAY_HEADROOM_SECONDS);
            if (target > maxChargeable) target = maxChargeable;
            const withHeadroom = SpecularQuickstart.interestForSeconds(preview.principal, preview.interestRateBps, target);
            if (withHeadroom > preview.interest) headroom = withHeadroom - preview.interest;
        }
        return { approve: preview.total + headroom, preview, headroom };
    }

    /**
     * Repay a loan. Returns tx hash. Retries on transient "Not the borrower"
     * errors which indicate the prior borrow's storage write is not yet
     * visible from this RPC node.
     *
     * Approval policy (exact, never unlimited): `previewRepayment(loanId).total`
     * on V6.1 (late loans pay for elapsed time, capped at duration + 30 days),
     * `amount + calculateInterest(amount, rate, duration)` on V6. See
     * `_repayApproval` for the bounded headroom applied to in-window late loans.
     */
    async repay(loanId) {
        return this._serialize(() => this._withApprovalCleanup(() => this._repayInner(loanId)));
    }

    async _repayInner(loanId) {
        const { approve, preview, headroom } = await this._repayApproval(loanId);
        await this._approveExact(approve);

        let tx, bumped = false;
        for (let i = 0; i < 5; i++) {
            try {
                tx = await this.marketplace.repayLoan(loanId);
                break;
            } catch (e) {
                const msg = e.message || '';
                // Same bounded-buffer fallback as borrow: if the contract pulls
                // more than previewed (rounding / a repay delayed past the late
                // headroom), bump the approval by one more interest-worth
                // (bounded) and retry.
                if (!bumped && SpecularQuickstart.isAllowanceShortfall(e)) {
                    bumped = true;
                    // Re-price from the chain rather than guessing: the loan may have
                    // accrued past the headroom while we were approving. Clamped by
                    // the contract's own cap inside _repayApproval, so still bounded.
                    let bumpTo;
                    try {
                        const fresh = await this._repayApproval(loanId);
                        bumpTo = fresh.approve > approve ? fresh.approve : approve + (preview.interest > 0n ? preview.interest : 1n);
                    } catch (_) {
                        bumpTo = approve + (preview.interest > 0n ? preview.interest : 1n);
                    }
                    await this._approveExact(bumpTo);
                    continue;
                }
                // [F-R6] The send may have landed even though the response was
                // lost. Resending is not an option here either (it would revert
                // "Loan not active" at best) — reconcile against the chain.
                if (SpecularQuickstart._isInconclusive(e) && !SpecularQuickstart._isRealRevert(e)) {
                    const settled = await this._loanSettled(loanId, 5, 500);
                    if (settled === 2) {
                        if (bumped || headroom > 0n) await this._revokeApprovalInner().catch(() => {});
                        return null; // repaid, but we never learned the hash
                    }
                }
                if (i === 4 || !/Not the borrower/.test(msg)) throw e;
                await new Promise(r => setTimeout(r, 2000));
            }
        }
        try {
            await this._wait(tx);
        } catch (e) {
            if (SpecularQuickstart._isInconclusive(e)) {
                const settled = await this._loanSettled(loanId, 5, 500);
                if (settled === 2) {
                    if (bumped || headroom > 0n) await this._revokeApprovalInner().catch(() => {});
                    return tx.hash;
                }
            }
            throw e;
        }
        // Restore exact-approval if the buffer/headroom path was taken (no-op otherwise).
        if (bumped || headroom > 0n) await this._revokeApprovalInner().catch(() => {});
        return tx.hash;
    }

    /**
     * V6.1: whether `lender` (default: this wallet) can top up `agentId`'s pool
     * now without `supplyLiquidity` reverting "Top-up would forfeit in-flight
     * interest". Always true on V6 (no tranche accounting there) and for a
     * lender with no existing position.
     */
    async canTopUp(agentId, lender = this.wallet.address) {
        if (!(await this._hasV61Views())) return true;
        try {
            return Boolean(await this.marketplace.canTopUp(agentId, lender));
        } catch (e) {
            return true;
        }
    }

    /**
     * IDs of the agent's currently ACTIVE loans. V6.1: `getActiveLoanIds`;
     * V6: walks the pool owner's `agentLoans[]` and filters on state.
     * @returns {Promise<number[]>}
     */
    async activeLoanIds(agentId) {
        if (await this._hasV61Views()) {
            try {
                return (await this.marketplace.getActiveLoanIds(agentId)).map(Number);
            } catch (e) { /* fall back */ }
        }
        const pool = await this.marketplace.agentPools(agentId);
        const addr = pool.agentAddress;
        if (!addr || addr === ethers.ZeroAddress) return [];
        const out = [];
        for (let i = 0; i < 200; i++) {
            let lid;
            try { lid = await this.marketplace.agentLoans(addr, i); } catch (e) { break; }
            const l = await this.marketplace.loans(lid);
            if (Number(l.state) === 1) out.push(Number(lid));
        }
        return out;
    }

    /**
     * Supply USDC liquidity to an agent's pool. Approves exactly `amt`.
     * On V6.1 a top-up (existing position) is pre-checked with `canTopUp` so
     * the caller gets an actionable error instead of an on-chain revert.
     */
    async supply(agentId, amount) {
        const id = SpecularQuickstart._toAgentId(agentId, 'SpecularQuickstart.supply');
        const amt = SpecularQuickstart._toBaseUnits(amount, this.cfg.decimals, 'SpecularQuickstart.supply');
        return this._serialize(() => this._withApprovalCleanup(() => this._supplyInner(id, amt)));
    }

    async _supplyInner(agentId, amt) {
        if (await this._hasV61Views()) {
            const pos = await this.marketplace.getLenderPosition(agentId, this.wallet.address);
            if (pos.amount > 0n && !(await this.canTopUp(agentId, this.wallet.address))) {
                throw new Error(
                    `SpecularQuickstart.supply: topping up pool #${agentId} from ${this.wallet.address} now would forfeit ` +
                    'in-flight interest and the contract would revert ("Top-up would forfeit in-flight interest"). ' +
                    'Wait for the pool\'s older active loans to close (check canTopUp(agentId) first), or open a fresh position from another address.'
                );
            }
        }
        await this._approveExact(amt);
        const tx = await this.marketplace.supplyLiquidity(agentId, amt);
        await this._wait(tx);
        return tx.hash;
    }

    /**
     * Withdraw lender position.
     */
    async withdraw(agentId, amount) {
        const id = SpecularQuickstart._toAgentId(agentId, 'SpecularQuickstart.withdraw');
        const amt = SpecularQuickstart._toBaseUnits(amount, this.cfg.decimals, 'SpecularQuickstart.withdraw');
        return this._serialize(async () => {
            const tx = await this.marketplace.withdrawLiquidity(id, amt);
            await this._wait(tx);
            return tx.hash;
        });
    }

    /**
     * Claim accrued interest from a pool.
     */
    async claim(agentId) {
        const id = SpecularQuickstart._toAgentId(agentId, 'SpecularQuickstart.claim');
        return this._serialize(async () => {
            const tx = await this.marketplace.claimInterest(id);
            await this._wait(tx);
            return tx.hash;
        });
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
