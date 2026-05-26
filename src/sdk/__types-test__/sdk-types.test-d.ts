// Type check: exercises the SpecularSDK TypeScript declarations.
//
// This file intentionally does NOT execute — it's compiled with --noEmit to
// verify the .d.ts files type-check correctly.

import { ethers } from 'ethers';
import { SpecularQuickstart, type CreditInfo, type LoanRecord, type SpecularNetwork } from '../SpecularQuickstart';
import {
    SpecularX402Client,
    SpecularX402Server,
    type SpecularX402ClientOptions,
    type SpecularX402ServerOptions,
    type ServerStats,
    type X402ServerMode,
} from '../x402';

async function quickstartDemo(): Promise<void> {
    const provider = new ethers.JsonRpcProvider('https://mainnet.base.org');
    const wallet = new ethers.Wallet('0xdead', provider);
    const network: SpecularNetwork = 'base';
    const sdk = new SpecularQuickstart(wallet, network);

    const onb = await sdk.onboard();
    const _agentId: number = onb.agentId;
    const _registerTx: string | null = onb.registerTx;

    const loan = await sdk.borrow(100, 30);
    const _loanId: number = loan.loanId;
    const _tx: string = loan.tx;

    const info: CreditInfo = await sdk.creditInfo();
    const _score: number = info.score;
    const _apr: number = info.interestRateAPR;

    const loans: LoanRecord[] = await sdk.loans();
    if (loans.length > 0) {
        const state = loans[0].state;
        // type narrowing should work
        if (state === 'ACTIVE') {
            await sdk.repay(loans[0].id);
        }
    }
}

async function x402ClientDemo(): Promise<void> {
    const opts: SpecularX402ClientOptions = {
        maxPayment: ethers.parseUnits('1', 6),
        rpcUrl: 'https://mainnet.base.org',
    };
    const client = new SpecularX402Client('0xdead', 'base', opts);
    const res = await client.fetch('https://api.example.com/transcribe', { method: 'POST' });
    const _status: number = res.status;
    const _ok: boolean = res.ok;

    const loans = await client.outstandingLoans();
    if (loans.length > 0) {
        await client.repayLoan(loans[0].id);
    }
}

async function x402ServerDemo(): Promise<void> {
    const opts: SpecularX402ServerOptions = {
        network: 'base',
        privateKey: '0xdead',
        pricing: { '/transcribe': 0.5, default: 0.1 },
        poolAgentId: 49,
        autoFlushThresholdUsdc: 10,
        mode: 'local' satisfies X402ServerMode,
    };
    const server = new SpecularX402Server(opts);

    const stats: ServerStats = server.stats();
    const _req: number = stats.requestCount;
    const _pending: string = stats.pendingUsdc;

    const flush = await server.flushToPool();
    if (flush) {
        const _hash: string = flush.txHash;
        const _amt: number = flush.amountUsdc;
    }

    // node:http style
    const httpHandler = server.handle(async (_req, res, paymentResult) => {
        if (paymentResult.ok) {
            res.writeHead(200);
            res.end();
        }
    });
    const _h: typeof httpHandler = httpHandler;

    // express style
    const mw = server.express();
    const _mw: typeof mw = mw;

    server.startAutoFlush(60_000);
}

// Trigger them so tsc keeps the bindings (no runtime exec)
export { quickstartDemo, x402ClientDemo, x402ServerDemo };
