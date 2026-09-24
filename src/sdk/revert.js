/**
 * Specular SDK — revert decoding and RACE classification.
 *
 * Added by the 2026-09-25 concurrency round
 * (`forensics/output/testing-2026-09-25/CONCURRENCY_REPORT.md`).
 *
 * WHY. Under contention the protocol is safe but somebody loses: the second of two
 * transactions competing for the same liquidity, the same lender slot or the same loan
 * reverts. Every local race in that round ended that way, and the SDK's response was a
 * single opaque sentence — "tx 0x… reverted on-chain" — with no reason and no hint about
 * what to do next. That is the difference between an agent that retries one block later
 * and an agent that gives up (or, worse, retries something it must not).
 *
 * Three refusals are ordinary race outcomes and the caller should simply re-send:
 *   "Insufficient pool liquidity"   — a withdrawal or another borrow landed first
 *   "Pool lender capacity reached"  — the 50th slot was taken in the same block
 *   "Top-up would forfeit in-flight interest" — clears when the older loans close
 *
 * One looks similar and must NEVER be retried blindly:
 *   "Loan not active" — the loan may have been LIQUIDATED out from under the repayment
 *   (`repayLoan` and `liquidateLoan` race on every overdue loan; exactly one wins).
 *
 * `explainFailedTx` also replays the transaction at the block boundaries either side of
 * where it actually executed. If it would have succeeded one slot earlier or later, the
 * failure was purely POSITIONAL and is retryable no matter what the reason string says.
 */

const { ethers } = require('ethers');

const ERROR_STRING_SELECTOR = '0x08c379a0';
const PANIC_SELECTOR = '0x4e487b71';

/** Retry the identical call: the obstacle is somebody else's transaction, not yours. */
const RETRYABLE = 'retryable';
/** You must change something (amount, allowance, your own outstanding loans) first. */
const ACTIONABLE = 'actionable';
/** Re-sending will never work; the call is wrong for this wallet/contract/state. */
const TERMINAL = 'terminal';

const RULES = [
    // ── race outcomes: somebody else moved first ────────────────────────────────
    [/Insufficient pool liquidity/i, RETRYABLE,
        'Another transaction (a lender withdrawal, or another borrow) took the pool\'s available liquidity first. Re-read availableLiquidity and retry, or retry with a smaller amount. Nothing of yours moved.'],
    [/Pool lender capacity reached/i, RETRYABLE,
        'The pool\'s 50 lender slots were full when your supply executed. A slot frees the moment any lender exits in full, so this can clear on its own — retry, or pick another pool if it stays full.'],
    [/Last slot reserved for agent self-stake/i, RETRYABLE,
        'The pool\'s final slot is reserved for the agent\'s own first-loss self-stake, so a third party cannot take it while the agent holds no position. It opens once the agent stakes. This is NOT the same as the pool being full.'],
    [/Top-up would forfeit in-flight interest/i, RETRYABLE,
        'Topping up right now would forfeit interest already accruing on your position, so the contract refuses. Retry once the pool\'s older active loans close, or open a position from another address.'],
    [/Drain underflow/i, RETRYABLE,
        'The pool cannot cover this interest claim at this instant. Retry after the next repayment; if it persists, contact the protocol owner.'],
    [/EnforcedPause|Pausable: paused|^paused$/i, RETRYABLE,
        'The contract is paused by the owner. Retry later; no action of yours will change it.'],
    [/nonce too low|replacement transaction underpriced|already known/i, RETRYABLE,
        'Nonce collision from sending several transactions concurrently from one wallet. Allocate nonces explicitly (src/sdk/nonce.js NonceCounter) and re-send.'],

    // ── you must change something ───────────────────────────────────────────────
    [/Exceeds credit limit/i, ACTIONABLE,
        'Outstanding principal plus this amount exceeds your credit limit. Under the V7 model that limit is min(tier limit, credit ladder) and is exactly 0 during a post-default lockout. Repay an existing loan or borrow less.'],
    [/Too many active loans/i, ACTIONABLE,
        'You already hold the maximum concurrent active loans (10). Repay one first.'],
    [/Insufficient self-stake/i, ACTIONABLE,
        'The V7 first-loss gate: any exposure your collateral does not cover must already be backed by your own capital in your own pool. Supply the shortfall (see requiredSelfStake) and retry.'],
    [/Self-stake locked while borrowing/i, ACTIONABLE,
        'You are the pool creator, so your position is the agent\'s first-loss stake and is locked while the agent carries outstanding principal. Repay every active loan and it unlocks. Ordinary lenders are not locked, and claiming interest still works.'],
    [/Remaining below minimum supply/i, ACTIONABLE,
        'A partial withdrawal may not leave your position below the pool\'s minimum supply. Withdraw the position in FULL, or withdraw less.'],
    [/Below minimum supply/i, ACTIONABLE,
        'Your first supply into this pool is below its minimum. Supply at least minSupplyAmount (the pool creator is exempt for its own pool).'],
    [/Insufficient balance/i, ACTIONABLE,
        'You are withdrawing more than you supplied to this pool.'],
    [/ERC20InsufficientAllowance|insufficient allowance|exceeds allowance/i, ACTIONABLE,
        'The marketplace is not approved to pull enough USDC. Send the exact-amount approve first. Note that a LATE repayment costs more than principal + nominal interest — approve previewRepayment().total, not your own estimate.'],
    [/ERC20InsufficientBalance|exceeds balance|insufficient balance for transfer/i, ACTIONABLE,
        'Your wallet does not hold enough USDC for this transaction.'],

    // ── terminal ────────────────────────────────────────────────────────────────
    [/Loan not active/i, TERMINAL,
        'This loan is no longer ACTIVE. Do NOT retry: it was either already repaid, or LIQUIDATED — repayLoan and liquidateLoan race on every overdue loan and exactly one wins. Read loans(loanId).state (2 = REPAID, 3 = DEFAULTED) before assuming which; a 3 carries a reputation penalty and a lockout.'],
    [/Not the borrower/i, TERMINAL,
        'Only the original borrower, or the current holder of the agent NFT, may repay this loan.'],
    [/Not a registered agent|Agent not registered/i, TERMINAL,
        'This wallet is not a registered agent on this network. Register first.'],
    [/Agent already registered/i, TERMINAL, 'This wallet is already registered.'],
    [/Pool already exists/i, TERMINAL, 'This agent already has a pool.'],
    [/No pool for agent|Pool not active/i, TERMINAL, 'That agent has no active pool. Create one first, or check the agentId.'],
    [/Agent deactivated/i, TERMINAL,
        'The registry has deactivated this agent, so it cannot borrow or create a pool. Repayments and lender exits still work. Contact the protocol owner.'],
    [/Invalid duration/i, TERMINAL, 'durationDays must be between 7 and 365 — pass DAYS, not seconds.'],
    [/Amount must be > 0/i, TERMINAL, 'Amount must be greater than zero.'],
    [/No interest to claim/i, TERMINAL, 'This wallet has no claimable interest in this pool.'],
    [/Ownable|caller is not the owner/i, TERMINAL, 'This function is owner-only.'],
    [/ReentrancyGuardReentrantCall/i, TERMINAL,
        'Re-entrant call. Every state-changing entry point on the marketplace is nonReentrant, so two of them can never be composed inside one transaction.'],
];

/** Decode `Error(string)` / `Panic(uint256)` revert data. Returns null if it is neither. */
function decodeRevertData(data) {
    if (!data || typeof data !== 'string') return null;
    const hex = data.startsWith('0x') ? data : `0x${data}`;
    if (hex.length < 10) return null;
    const selector = hex.slice(0, 10).toLowerCase();
    if (selector === ERROR_STRING_SELECTOR) {
        try { return String(ethers.AbiCoder.defaultAbiCoder().decode(['string'], `0x${hex.slice(10)}`)[0]); } catch (_) { return null; }
    }
    if (selector === PANIC_SELECTOR) {
        try { return `Panic(0x${ethers.AbiCoder.defaultAbiCoder().decode(['uint256'], `0x${hex.slice(10)}`)[0].toString(16)})`; } catch (_) { return null; }
    }
    return null;
}

/** Pull the best available reason out of an ethers error object. */
function reasonFromError(e) {
    if (typeof e?.reason === 'string' && e.reason) return e.reason;
    const data = typeof e?.data === 'string' ? e.data : e?.info?.error?.data;
    const decoded = decodeRevertData(data);
    if (decoded) return decoded;
    const msg = e?.shortMessage || e?.info?.error?.message || e?.message || '';
    const m = /reverted with reason string ['"]([^'"]*)['"]/.exec(msg) || /execution reverted:?\s*(.+)$/i.exec(msg);
    if (m) return m[1].trim();
    return String(msg).replace(/\s+/g, ' ').slice(0, 200);
}

/**
 * Classify a revert reason.
 * @returns {{reason: string, class: 'retryable'|'actionable'|'terminal', advice: string}}
 */
function classifyRevertReason(reason) {
    const r = (reason || '').replace(/^execution reverted:?\s*/i, '').trim() || 'execution reverted (no reason given)';
    const hit = RULES.find(([re]) => re.test(r));
    if (hit) return { reason: r, class: hit[1], advice: hit[2] };
    return {
        reason: r,
        class: TERMINAL,
        advice: 'Unrecognised revert reason. Do not retry blindly: read the contract state the call depends on and confirm the precondition before re-sending.',
    };
}

/**
 * Explain a MINED-BUT-FAILED transaction, and say whether the failure was positional.
 *
 * Positional detection re-runs the identical call as `eth_call` against the state at the
 * START of its block and at the END of it. Its real execution sat somewhere between, so:
 *   * succeeds at neither → the failure was unconditional in that block;
 *   * succeeds at the end → it would have worked one slot later (it was front-run);
 *   * succeeds at the start → it would have worked one slot earlier;
 *   * succeeds at both → purely positional.
 * Any of the last three make the call retryable regardless of its reason string.
 *
 * @param {import('ethers').Provider} provider
 * @param {string|{hash:string}} txOrHash
 * @returns {Promise<null|{hash,blockNumber,index,reason,class,advice,positional,positionalNote}>}
 *          null when the transaction succeeded or cannot be found.
 */
async function explainFailedTx(provider, txOrHash) {
    const hash = typeof txOrHash === 'string' ? txOrHash : txOrHash?.hash;
    if (!hash) return null;
    const receipt = await provider.getTransactionReceipt(hash);
    if (!receipt || receipt.status === 1) return null;
    const tx = await provider.getTransaction(hash);

    let startReason = null, endReason = null, startOk = false, endOk = false, replayed = false;
    if (tx) {
        const req = { from: tx.from, to: tx.to, data: tx.data, value: tx.value ?? 0n };
        const at = async (blockTag) => {
            try { await provider.call({ ...req, blockTag }); return { ok: true, reason: null }; }
            catch (e) {
                // A transport failure is not a simulation result — do not let a dead RPC
                // masquerade as "unconditional revert".
                if (e?.code === 'SERVER_ERROR' || e?.code === 'NETWORK_ERROR' || e?.code === 'TIMEOUT') throw e;
                return { ok: false, reason: reasonFromError(e) };
            }
        };
        try {
            const start = await at(receipt.blockNumber - 1);
            const end = await at(receipt.blockNumber);
            startOk = start.ok; endOk = end.ok;
            startReason = start.reason; endReason = end.reason;
            replayed = true;
        } catch (_) { replayed = false; }
    }

    // The transaction at index 0 executed against start-of-block state exactly, so that
    // replay's reason is authoritative for it. Otherwise prefer the end-of-block reason
    // and fall back to the start-of-block one.
    let raw = receipt.index === 0 && startReason ? startReason : (endReason || startReason);
    if (!raw) raw = 'execution reverted (no reason given)';

    let positional = false;
    let positionalNote = replayed ? 'unconditional-in-this-block' : 'not-replayed';
    if (replayed) {
        if (startOk && endOk) { positional = true; positionalNote = 'positional'; }
        else if (!startOk && endOk) { positional = true; positionalNote = 'would-succeed-if-placed-later'; raw = startReason || raw; }
        else if (startOk && !endOk) { positional = true; positionalNote = 'front-run: would-succeed-if-placed-earlier'; raw = endReason || raw; }
    }

    const c = classifyRevertReason(raw);
    if (positional && c.class !== RETRYABLE) {
        c.class = RETRYABLE;
        c.advice = `${c.advice} (This particular failure was POSITIONAL — the same call succeeds at a different point in the block — so re-sending it is the right response.)`;
    }
    return {
        hash, blockNumber: receipt.blockNumber, index: receipt.index,
        reason: c.reason, class: c.class, advice: c.advice, positional, positionalNote,
    };
}

/**
 * Build the Error a client should throw for a failed transaction: a message that names
 * the reason, plus machine-readable `revertReason` / `retryable` / `failureClass` /
 * `txHash` / `positional` properties.
 */
async function failedTxError(provider, hash, opLabel) {
    let x = null;
    try { x = await explainFailedTx(provider, hash); } catch (_) { /* explanation is best-effort */ }
    const reason = x?.reason || 'reverted with no reason string';
    const err = new Error(`${opLabel} tx ${String(hash).slice(0, 12)} reverted on-chain: ${reason}${x ? ` [${x.class}] ${x.advice}` : ''}`);
    err.txHash = hash;
    err.revertReason = x?.reason ?? null;
    err.failureClass = x?.class ?? null;
    err.retryable = x ? x.class === RETRYABLE : false;
    err.positional = x?.positional ?? false;
    err.advice = x?.advice ?? null;
    return err;
}

module.exports = {
    RETRYABLE, ACTIONABLE, TERMINAL,
    decodeRevertData, reasonFromError, classifyRevertReason, explainFailedTx, failedTxError,
};
