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

export type SpecularNetwork = 'base' | 'arc';

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
    /** Tx hash of the requestLoan call */
    tx: string;
}

export interface CreditInfo {
    /** Reputation score, 0-1000 (higher = better terms) */
    score: number;
    /** Maximum borrowable amount as a decimal string (e.g. "10000") */
    creditLimit: string;
    /** Required collateral as a percent (0-100) */
    collateralPct: number;
    /** Interest rate in basis points (e.g. 500 = 5%) */
    interestRateBps: number;
    /** Interest rate as APR percentage (e.g. 5.0) */
    interestRateAPR: number;
}

export type LoanState = 'REQUESTED' | 'ACTIVE' | 'REPAID' | 'DEFAULTED';

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

    /** Request a loan. Auto-onboards if needed. */
    borrow(amount: number | string | bigint, durationDays: number): Promise<BorrowResult>;

    /** Repay a loan. Returns tx hash. */
    repay(loanId: number): Promise<string>;

    /** Supply USDC liquidity to an agent's pool. Auto-approves if needed. */
    supply(agentId: number, amount: number | string | bigint): Promise<string>;

    /** Withdraw lender position. */
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
