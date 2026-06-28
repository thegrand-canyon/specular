/**
 * SpecularX402Client — pay any x402-gated API with auto-borrow from Specular.
 *
 * @example
 *   import { ethers } from 'ethers';
 *   import { SpecularX402Client } from '@specular/sdk/x402';
 *
 *   const client = new SpecularX402Client(process.env.AGENT_KEY!, 'base', {
 *       maxPayment: ethers.parseUnits('1', 6)
 *   });
 *   const res = await client.fetch('https://api.example.com/transcribe', {
 *       method: 'POST', body: audioBlob
 *   });
 */

import type { SpecularNetwork, LoanRecord } from '../SpecularQuickstart';

export interface SpecularX402ClientOptions {
    /** Override the network's default RPC URL */
    rpcUrl?: string;
    /** Maximum USDC amount (in 6-decimal base units) this client is willing to pay per call. Default: 10 USDC. */
    maxPayment?: bigint;
}

export class SpecularX402Client {
    constructor(
        privateKey: string | { privateKey: string },
        network?: SpecularNetwork,
        opts?: SpecularX402ClientOptions
    );

    readonly network: SpecularNetwork;
    readonly usdcAddr: string;
    readonly maxPayment: bigint;
    readonly wallet: import('ethers').Wallet;

    /**
     * Drop-in fetch that handles x402 PAYMENT-REQUIRED responses automatically.
     * Pre-flights USDC balance; if below maxPayment, tries faucet first, then
     * borrows the gap from Specular against agent reputation.
     */
    fetch(url: string, init?: RequestInit): Promise<Response>;

    /**
     * Peek at an endpoint's 402 challenge without paying. Returns the parsed
     * payment requirements plus a `batched` flag indicating whether the seller
     * accepts Circle Gateway batched settlement (gasless via @circle-fin/x402-batching).
     */
    previewPaymentRequirements(url: string): Promise<{
        status: number;
        requirements?: unknown;
        payTo?: string;
        asset?: string;
        priceBaseUnits?: string;
        network?: string;
        batched?: boolean;
        batchVerifyingContract?: string;
    }>;

    /** Active loans the agent owes. */
    outstandingLoans(): Promise<LoanRecord[]>;

    /** Repay a loan after earning revenue. Returns tx hash. */
    repayLoan(loanId: number): Promise<string>;
}
