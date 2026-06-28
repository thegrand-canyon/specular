/**
 * SpecularX402Client — pay any x402-gated API with auto-borrow from Specular.
 *
 * Marries Coinbase's x402 protocol (https://docs.cdp.coinbase.com/x402/welcome)
 * with Specular's reputation-based credit. When an agent's USDC is insufficient
 * to satisfy an x402 PAYMENT-REQUIRED, this client automatically borrows the gap
 * from Specular against the agent's reputation, pays, and returns the response.
 *
 * Usage:
 *   const { SpecularX402Client } = require('@specular/sdk/x402');
 *   const x402 = new SpecularX402Client(privateKey, 'base');
 *   const res = await x402.fetch('https://api.example.com/transcribe', {
 *       method: 'POST', body: audio
 *   });
 *   // x402 dance + auto-borrow happens inside; res is the API response
 */

const { ethers } = require('ethers');
const { wrapFetchWithPayment } = require('x402-fetch');
const { createWalletClient, http } = require('viem');
const { privateKeyToAccount } = require('viem/accounts');
const { base } = require('viem/chains');
const { SpecularQuickstart } = require('../SpecularQuickstart');
const fs = require('fs');

// Optional: Circle batched-settlement detector (gasless x402 via Circle Gateway).
// Loaded lazily; absent import does not break the client.
let _circleBatching = null;
try { _circleBatching = require('@circle-fin/x402-batching'); } catch (_) {}

const arcTestnet = {
    id: 5042002,
    name: 'Arc Testnet',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: ['https://arc-testnet.drpc.org'] } },
    blockExplorers: { default: { name: 'Arcscan', url: 'https://testnet.arcscan.app' } },
};

const NETWORKS = {
    base: { chain: base, addresses: './src/config/base-addresses.json', defaultRpc: 'https://mainnet.base.org' },
    arc: { chain: arcTestnet, addresses: './src/config/arc-testnet-addresses.json', defaultRpc: 'https://arc-testnet.drpc.org' }
};

class SpecularX402Client {
    constructor(privateKey, network = 'base', opts = {}) {
        if (!NETWORKS[network]) throw new Error('Unknown network: ' + network);
        const netCfg = NETWORKS[network];
        const addr = JSON.parse(fs.readFileSync(netCfg.addresses, 'utf8'));

        const rpcUrl = opts.rpcUrl || netCfg.defaultRpc;
        this.network = network;
        this.usdcAddr = addr.usdc;
        this.maxPayment = opts.maxPayment ?? ethers.parseUnits('10', 6);

        const pk = typeof privateKey === 'string' ? privateKey : privateKey.privateKey;
        const pkPrefixed = pk.startsWith('0x') ? pk : '0x' + pk;

        // ethers side for Specular SDK
        this.provider = new ethers.JsonRpcProvider(rpcUrl);
        this.wallet = new ethers.Wallet(pkPrefixed, this.provider);
        this.sdk = new SpecularQuickstart(this.wallet, network);

        // viem side for x402
        const account = privateKeyToAccount(pkPrefixed);
        this.viemClient = createWalletClient({
            account,
            chain: netCfg.chain,
            transport: http(rpcUrl)
        });

        this.wrappedFetch = wrapFetchWithPayment(globalThis.fetch, this.viemClient, this.maxPayment);
    }

    /**
     * Drop-in fetch that handles x402 PAYMENT-REQUIRED responses automatically.
     * Pre-flights USDC balance vs maxPayment; auto-borrows from Specular gap.
     */
    async fetch(url, init = {}) {
        const have = await this._usdcBalance();
        if (have < this.maxPayment) {
            await this._ensureUsdc(this.maxPayment - have);
        }
        return await this.wrappedFetch(url, init);
    }

    /**
     * Peek at an endpoint's 402 challenge without paying. Useful for surfacing
     * Circle batched-settlement support, deciding price thresholds, or
     * diagnostics. Returns { status, requirements?, batched?, payTo?, asset? }.
     */
    async previewPaymentRequirements(url) {
        const res = await fetch(url, { method: 'GET' });
        if (res.status !== 402) return { status: res.status };
        const body = await res.json().catch(() => ({}));
        const accept = body.accepts?.[0];
        const out = {
            status: 402,
            requirements: body,
            payTo: accept?.payTo,
            asset: accept?.asset,
            priceBaseUnits: accept?.maxAmountRequired,
            network: accept?.network,
        };
        if (_circleBatching && accept) {
            out.batched = !!_circleBatching.supportsBatching(accept);
            if (out.batched) {
                out.batchVerifyingContract = _circleBatching.getVerifyingContract(accept);
            }
        }
        return out;
    }

    async _usdcBalance() {
        const usdc = new ethers.Contract(this.usdcAddr,
            ['function balanceOf(address) view returns (uint256)'], this.provider);
        return await usdc.balanceOf(this.wallet.address);
    }

    async _ensureUsdc(gap) {
        // Try faucet first
        try {
            const onb = await this.sdk.onboard();
            const addrs = JSON.parse(fs.readFileSync(NETWORKS[this.network].addresses, 'utf8'));
            if (addrs.agentCreditFaucet) {
                const faucetAbi = [
                    'function isEligible(uint256) view returns (bool)',
                    'function claim() returns (uint256)',
                    'function claimAmount() view returns (uint256)'
                ];
                const faucet = new ethers.Contract(addrs.agentCreditFaucet, faucetAbi, this.wallet);
                if (await faucet.isEligible(onb.agentId)) {
                    const claimAmt = await faucet.claimAmount();
                    const tx = await faucet.claim();
                    await tx.wait();
                    console.log(`[SpecularX402] Faucet claimed: +${ethers.formatUnits(claimAmt, 6)} USDC`);
                    const newBal = await this._usdcBalance();
                    if (newBal >= this.maxPayment) return null;
                }
            }
        } catch (e) { /* faucet not configured or already claimed */ }

        // Borrow from Specular for the remaining gap
        const borrowAmtUsdc = Math.max(1, Math.ceil(Number(ethers.formatUnits(gap, 6)) * 1.05));
        console.log(`[SpecularX402] Insufficient USDC. Borrowing ${borrowAmtUsdc} USDC from Specular...`);

        const info = await this.sdk.creditInfo();
        if (parseFloat(info.creditLimit) < borrowAmtUsdc) {
            throw new Error(`Need ${borrowAmtUsdc} USDC but credit limit is only ${info.creditLimit}`);
        }
        const loan = await this.sdk.borrow(borrowAmtUsdc, 7);
        console.log(`[SpecularX402] Loan #${loan.loanId} acquired: ${loan.tx}`);
        return loan.loanId;
    }

    /**
     * View: list outstanding loans the agent owes.
     */
    async outstandingLoans() {
        const loans = await this.sdk.loans();
        return loans.filter(l => l.state === 'ACTIVE');
    }

    /** Repay a loan after earning revenue from the x402-paid work. */
    async repayLoan(loanId) {
        return await this.sdk.repay(loanId);
    }
}

module.exports = { SpecularX402Client };
