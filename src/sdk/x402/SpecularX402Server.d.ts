/**
 * SpecularX402Server — x402 payment middleware that auto-supplies revenue
 * into a Specular pool, turning API sellers into passive lenders.
 *
 * @example
 *   import { SpecularX402Server } from '@specular/sdk/x402';
 *
 *   const x402 = new SpecularX402Server({
 *       network: 'base',
 *       privateKey: process.env.SELLER_KEY!,
 *       pricing: { '/transcribe': 0.5, default: 0.1 },
 *       poolAgentId: 49,
 *       autoFlushThresholdUsdc: 10,
 *       mode: 'local',
 *   });
 *
 *   http.createServer(x402.handle(async (req, res) => {
 *       res.writeHead(200);
 *       res.end(JSON.stringify({ result: '...' }));
 *   }));
 */

import type { IncomingMessage, ServerResponse } from 'http';
import type { SpecularNetwork } from '../SpecularQuickstart';

export type X402ServerMode = 'stub' | 'local' | 'facilitator';

export interface PricingMap {
    [route: string]: number;
    default?: number;
}

export interface SpecularX402ServerOptions {
    /** Specular network: 'base' (production) or 'arc' (testnet). Default: 'base'. */
    network?: SpecularNetwork;
    /** Seller's private key (also read from SELLER_KEY or PRIVATE_KEY env). */
    privateKey?: string;
    /** Override RPC URL. */
    rpcUrl?: string;
    /** Address to receive USDC. Defaults to wallet address. */
    payTo?: string;
    /** If set, auto-supplies accumulated revenue into this agent's Specular pool. */
    poolAgentId?: number | null;
    /** Per-route USDC price (display units). Use `default` for fallback. */
    pricing?: PricingMap;
    /** Auto-flush when accumulated revenue ≥ this many USDC. Default: 10. */
    autoFlushThresholdUsdc?: number;
    /** stub | local | facilitator. Default: 'facilitator' on Base, 'stub' on Arc. */
    mode?: X402ServerMode;
    /** Override remote facilitator URL (only used in 'facilitator' mode). */
    facilitatorUrl?: string;
}

export interface ProcessOk {
    ok: true;
    /** Settlement response from facilitator/local-settle (mode-dependent). */
    settlement?: unknown;
    /** First 40 chars of received payment header (stub mode). */
    headerSnippet?: string;
}

export interface ProcessFail {
    ok: false;
    status: number;
    body: unknown;
}

export type ProcessResult = ProcessOk | ProcessFail;

export interface ServerStats {
    mode: X402ServerMode;
    network: SpecularNetwork;
    sellerWallet: string;
    payTo: string;
    poolAgentId: number | null;
    requestCount: number;
    /** Decimal string */
    pendingUsdc: string;
    /** Decimal string */
    totalFlushedUsdc: string;
    /** ISO timestamp or null */
    lastFlushAt: string | null;
    autoFlushThresholdUsdc: number;
}

export interface FlushResult {
    txHash: string;
    amountUsdc: number;
}

export type ProtectedHandler = (
    req: IncomingMessage,
    res: ServerResponse,
    paymentResult: ProcessOk
) => void | Promise<void>;

export type ExpressMiddleware = (
    req: IncomingMessage & { x402?: ProcessOk; path?: string },
    res: ServerResponse & { status: (code: number) => any; json: (body: unknown) => any },
    next: () => void
) => Promise<void>;

export class SpecularX402Server {
    constructor(opts?: SpecularX402ServerOptions);

    readonly network: SpecularNetwork;
    readonly mode: X402ServerMode;
    readonly payTo: string;
    readonly poolAgentId: number | null;
    readonly pricing: PricingMap;
    readonly autoFlushThresholdUsdc: number;
    readonly facilitatorUrl: string | null;
    readonly wallet: import('ethers').Wallet;
    readonly provider: import('ethers').JsonRpcProvider;

    /**
     * Process a single request — verify the x402 payment header, settle on-chain.
     * Returns { ok: true, ... } on success or { ok: false, status, body } on failure.
     */
    process(req: IncomingMessage, routePath?: string): Promise<ProcessResult>;

    /** Manually flush accumulated revenue into the configured Specular pool. */
    flushToPool(): Promise<FlushResult | null>;

    /** Snapshot of seller stats. */
    stats(): ServerStats;

    /** node:http request handler factory. Wraps a user handler with x402 gating. */
    handle(handler: ProtectedHandler): (req: IncomingMessage, res: ServerResponse) => Promise<void>;

    /** Express middleware. Mounts payment gating before the next handler. */
    express(): ExpressMiddleware;

    /** Periodic auto-flush. Returns the interval handle. */
    startAutoFlush(intervalMs?: number): NodeJS.Timeout;
}
