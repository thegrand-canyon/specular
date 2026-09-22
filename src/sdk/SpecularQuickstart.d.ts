/**
 * Specular Quickstart SDK — minimum-friction integration for AI agents.
 *
 * @example
 *   import { ethers } from 'ethers';
 *   import { SpecularQuickstart } from '@specular/sdk';
 *
 *   const provider = new ethers.JsonRpcProvider('https://mainnet.base.org');
 *   const wallet = new ethers.Wallet(process.env.AGENT_KEY!, provider);
 *   const sdk = new SpecularQuickstart(wallet, 'base');
 *
 *   await sdk.onboard();
 *   const loan = await sdk.borrow(100, 30);
 *   await sdk.repay(loan.loanId);
 */

import type { Wallet, Contract } from 'ethers';

export type SpecularNetwork = 'base' | 'arc' | 'arc-staging' | 'arc-mainnet';

/**
 * Three-way marketplace/reputation capability matrix.
 *
 * | generation | `version` | `v61` | `v62` | adds                                        |
 * |------------|-----------|-------|-------|---------------------------------------------|
 * | V6         | `'V6'`    | false | false | baseline                                     |
 * | V6.1       | `'V6.1'`  | true  | false | previewRepayment / canTopUp / getActiveLoanIds |
 * | V6.2 (V7)  | `'V6.2'`  | true  | true  | requiredSelfStake / selfStake, first-loss lock |
 *
 * Base mainnet and the current Arc deployments are NOT V6.2.
 */
export interface SpecularCapabilities {
    /** Marketplace `VERSION()`; `'V6'` when the selector is absent. */
    version: string;
    /** Numeric ordering of `version` (6, 6.1, 6.2) for `>=` gates. */
    ordinal: number;
    v61: boolean;
    v62: boolean;
    /** Reputation manager `VERSION()`; `'V3'` when the selector is absent. */
    reputationVersion: string;
    /** True on ReputationManagerV4 (on-chain, owner-settable tier table + credit ladder). */
    reputationV4: boolean;
}

/** [V6.2] The pool creator's own first-loss position. All amounts are base units. */
export interface SelfStakeInfo {
    amount: bigint;
    amountUsdc: string;
    /** True while the agent carries outstanding principal: the position cannot be withdrawn. */
    locked: boolean;
    /** `requiredSelfStake(agentId, 0)` — the stake the CURRENT exposure demands. */
    required: bigint;
    requiredUsdc: string;
    /** `max(0, required - amount)`. */
    shortfall: bigint;
    shortfallUsdc: string;
}

/** One row of the credit tier table. */
export interface CreditTier {
    index: number;
    minScore: number;
    limit: bigint;
    limitUsdc: string;
    collateralPct: number;
    interestRateBps: number;
    /** `limit * (100 - collateralPct) / 100` — the figure `MAX_TIER_LIMIT` bounds. */
    unsecuredExposure: bigint | null;
}

/**
 * The credit tier table. On ReputationManagerV4 it is READ FROM THE CHAIN
 * (`source: 'chain'`) because it is mutable owner-settable state; on V3 it is
 * the historical compiled-in constant set (`source: 'v3-constant'`).
 */
export interface CreditTierTable {
    source: 'chain' | 'v3-constant';
    /** Immutable ceiling every tier limit is bounded by; null on V3 (no such bound). */
    maxTierLimit: bigint | null;
    tiers: CreditTier[];
}

export interface OnboardResult {
    /** Numeric agent ID from AgentRegistryV2 */
    agentId: number;
    /** Tx hash if registration was performed (null if already registered) */
    registerTx: string | null;
    /** Tx hash if pool creation was performed (null if already created) */
    poolTx: string | null;
    /** Tx hash if USDC approval was set (null if already approved) */
    approveTx: string | null;
}

export interface BorrowResult {
    /** Numeric loan ID emitted by the LoanRequested event */
    loanId: number;
    /**
     * Tx hash of the requestLoan call, or `null` when the loan was recovered by
     * reconciliation after a lost send response (see `reconciled`).
     */
    tx: string | null;
    /**
     * Present and true when the send response was lost but the loan was found
     * on chain and adopted, instead of a retry opening a SECOND loan
     * (robustness F-R6).
     */
    reconciled?: boolean;
}

export interface CreditInfo {
    /** Reputation score, 0-1000 (higher = better terms) */
    score: number;
    /**
     * Maximum borrowable amount as a decimal string, read from
     * `calculateCreditLimit` — never from a client-side tier table. On the V7
     * model this is `min(tier limit, ladder limit)`, and 0 during a post-default
     * lockout (see `limitExplanation`).
     */
    creditLimit: string;
    /** Required collateral as a percent (0-100) */
    collateralPct: number;
    /** Interest rate in basis points (e.g. 500 = 5%) */
    interestRateBps: number;
    /** Interest rate as APR percentage (e.g. 5.0) */
    interestRateAPR: number;

    // --- present once the capability probe succeeds -------------------------
    /** Marketplace `VERSION()` ('V6' | 'V6.1' | 'V6.2'). */
    marketplaceVersion?: string;
    /** Reputation manager `VERSION()` ('V3' | 'V4'). */
    reputationVersion?: string;

    // --- V4 reputation only (absent on V3, never faked) ---------------------
    agentId?: number;
    /** Tier index 0-5 for the current score. */
    tier?: number;
    /** `tierLimit(score)` in display units. */
    tierLimit?: string;
    /** `creditMultiple * maxRepaidPrincipal + growthStep`, floored at `bootstrapLimit`. */
    ladderLimit?: string;
    /** Largest single on-time-repaid principal — what the ladder is built on. */
    maxRepaidPrincipal?: string;
    /** `MAX_TIER_LIMIT()`, the immutable ceiling on any tier limit. */
    maxTierLimit?: string;
    /** True while frozen after a default (`creditLimit` is then "0.0"). */
    lockedOut?: boolean;
    /** Unix seconds the lockout ends (0 when never locked out). */
    lockedUntil?: number;
    /** Plain-language reason the limit is what it is. */
    limitExplanation?: string;

    // --- V6.2 marketplace only ---------------------------------------------
    /** The agent's own first-loss position in its own pool. */
    selfStake?: SelfStakeInfo;
}

export type LoanState = 'REQUESTED' | 'ACTIVE' | 'REPAID' | 'DEFAULTED';

/** Result of previewRepayment(): all amounts in USDC base units (6 decimals). */
export interface RepaymentPreview {
    principal: bigint;
    interest: bigint;
    /** Exactly what repayLoan() pulls at the block the preview was evaluated in. */
    total: bigint;
    /** Seconds of interest charged: duration <= x <= duration + LATE_INTEREST_CAP (V6.1); duration on V6. */
    chargeableSeconds: bigint;
    /** Seconds past endTime (0 if on time; always 0 on V6). */
    lateSeconds: bigint;
    durationSeconds: bigint;
    interestRateBps: bigint;
    /** 'previewRepayment' on V6.1, 'calculateInterest' (nominal fixed term) on V6. */
    source: 'previewRepayment' | 'calculateInterest';
}

export interface LoanRecord {
    id: number;
    /** Principal amount as decimal string in USDC */
    amount: string;
    /** Interest rate in basis points */
    interestRate: number;
    state: LoanState;
    /** Unix seconds */
    endTime: number;
}

export class SpecularQuickstart {
    constructor(wallet: Wallet, network?: SpecularNetwork);

    /** Underlying ethers signer. */
    readonly wallet: Wallet;
    /** Network this instance is bound to. */
    readonly network: SpecularNetwork;
    /** Resolved contract addresses. */
    readonly addresses: {
        marketplace: string;
        registry: string;
        reputation: string;
        usdc: string;
    };
    /** Contract instances wired with the signer wallet. */
    readonly marketplace: Contract;
    readonly registry: Contract;
    readonly reputation: Contract;
    readonly usdc: Contract;

    /** One-call onboarding: register agent + create pool + approve USDC. Idempotent. */
    onboard(ipfsHash?: string): Promise<OnboardResult>;

    /**
     * Request a loan. Auto-onboards if needed.
     *
     * On a V6.2 deployment the first-loss self-stake gate is checked BEFORE any
     * transaction is sent: an under-staked borrow rejects locally with
     * `code === 'SPECULAR_INSUFFICIENT_SELF_STAKE'` (carrying `required`,
     * `current` and `shortfall` in base units) instead of reverting on chain.
     */
    borrow(amount: number | string | bigint, durationDays: number): Promise<BorrowResult>;

    /**
     * Repay a loan. Returns tx hash. Approves exactly what the contract will
     * pull: `previewRepayment(loanId).total` on V6.1 (late loans pay for
     * elapsed time, capped at duration + 30 days), the nominal fixed-term
     * figure on V6. Never an unlimited approval.
     *
     * Resolves to `null` in one case only: the repay was CONFIRMED settled on
     * chain but its send response was lost, so the hash was never learned.
     * Treat `null` as success (robustness F-R6).
     */
    repay(loanId: number): Promise<string | null>;

    /** Marketplace `VERSION()`; 'V6' for deployments that predate the V6.1 (2026-09) fixes. */
    marketplaceVersion(): Promise<string>;

    /** Reputation manager `VERSION()`; 'V3' for deployments that predate the V7 model. */
    reputationVersion(): Promise<string>;

    /** Three-way capability matrix (V6 / V6.1 / V6.2) plus the reputation generation. Cached per instance. */
    capabilities(): Promise<SpecularCapabilities>;

    /**
     * [V6.2] First-loss self-stake the agent must hold in its OWN pool before it
     * could borrow `additionalAmount` more. Returns base units.
     * @throws `code === 'SPECULAR_UNSUPPORTED_ON_DEPLOYMENT'` on V6 / V6.1.
     */
    requiredSelfStake(agentId: number, additionalAmount?: number | string | bigint): Promise<bigint>;

    /**
     * [V6.2] The agent's own first-loss position and whether it is locked.
     * @throws `code === 'SPECULAR_UNSUPPORTED_ON_DEPLOYMENT'` on V6 / V6.1.
     */
    selfStake(agentId: number): Promise<SelfStakeInfo>;

    /**
     * The credit tier table. Read from the contract on ReputationManagerV4,
     * where it is owner-settable state; the compiled-in V3 constants otherwise.
     * No client may carry a hardcoded copy.
     */
    tierTable(): Promise<CreditTierTable>;

    /** Numeric ordering for a VERSION string ('V6' -> 6, 'V6.1' -> 6.1, 'V6.2' -> 6.2). */
    static versionOrdinal(v: string): number;

    /** Exact amount `repayLoan(loanId)` would pull now (V6.1 view, nominal fallback on V6). */
    previewRepayment(loanId: number): Promise<RepaymentPreview>;

    /** V6.1: whether a top-up by `lender` (default: this wallet) would be refused; always true on V6. */
    canTopUp(agentId: number, lender?: string): Promise<boolean>;

    /** IDs of the agent's ACTIVE loans (V6.1 `getActiveLoanIds`, bounded walk on V6). */
    activeLoanIds(agentId: number): Promise<number[]>;

    /** Supply USDC liquidity to an agent's pool. Auto-approves if needed; on V6.1 a top-up is pre-checked with canTopUp. */
    supply(agentId: number, amount: number | string | bigint): Promise<string>;

    /**
     * Withdraw lender position.
     *
     * On a V6.2 deployment a POOL CREATOR withdrawing its own first-loss stake
     * while the agent carries outstanding principal rejects locally with
     * `code === 'SPECULAR_SELF_STAKE_LOCKED'` instead of reverting "Self-stake
     * locked while borrowing". Ordinary lenders are never locked.
     */
    withdraw(agentId: number, amount: number | string | bigint): Promise<string>;

    /** Claim accrued interest from a pool. */
    claim(agentId: number): Promise<string>;

    /** Returns current credit info. */
    creditInfo(): Promise<CreditInfo>;

    /** Returns active loans for this agent. */
    loans(): Promise<LoanRecord[]>;

    /** Returns block explorer URL for a tx hash. */
    explorerUrl(txHash: string): string;
}
