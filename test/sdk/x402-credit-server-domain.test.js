/**
 * Regression tests for the 2026-09-25 CreditAssessmentServer fixes.
 *
 *  1. The quoted EIP-712 domain is resolved FROM THE TOKEN, not hardcoded to
 *     {name:'USD Coin', version:'1'} — a domain that matches no real USDC
 *     (Circle's Base USDC is version "2"; Arc mainnet USDC is name "USDC",
 *     version "2"). Quoting the wrong domain made every authorization
 *     unsettleable while the server's own signature check still passed, so the
 *     paywall served the resource and collected nothing.
 *
 *  2. With a settlement signer configured, a FAILED on-chain settlement is now
 *     fatal instead of silently falling back to signature-only verification.
 *
 *  3. /credit/<malformed> returns 400, not 404.
 *
 * All offline: a fake provider/token, no network, no keys, no transactions.
 */
'use strict';

const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { ethers } = require('ethers');

const CreditAssessmentServer = require('../../src/x402/CreditAssessmentServer.js');

const FEE = '1000000';
const CHAIN_ID = 5042;
const TOKEN = '0x3600000000000000000000000000000000000000';

// Token that reports a non-default EIP-712 domain, like the real ones do.
function fakeToken({ name = 'USDC', version = '2', settle } = {}) {
    const domainSeparator = ethers.TypedDataEncoder.hashDomain({
        name, version, chainId: CHAIN_ID, verifyingContract: TOKEN,
    });
    return {
        name: async () => name,
        version: async () => version,
        DOMAIN_SEPARATOR: async () => domainSeparator,
        authorizationState: async () => false,
        connect: () => ({
            transferWithAuthorization: async (...a) => {
                if (settle) return settle(...a);
                throw Object.assign(new Error('execution reverted'), { code: 'CALL_EXCEPTION' });
            },
        }),
    };
}

function makeServer(port, over = {}) {
    const srv = new CreditAssessmentServer({
        port, host: '127.0.0.1',
        rpcUrl: 'http://127.0.0.1:1', // never dialled: contracts are stubbed below
        chainId: CHAIN_ID, network: 'arc-mainnet',
        usdcAddress: TOKEN,
        reputationAddress: '0x12953e732e5D1aFdA640554125367d1CEC2ac4FB',
        feeRecipient: over.feeRecipient,
        feeAmount: FEE,
        nonceStorePath: over.nonceStorePath,
        ...over.cfg,
    });
    srv.usdc = over.token || fakeToken();
    srv.reputation = {
        getReputationScore: async () => 250n,
        calculateCreditLimit: async () => 5000000000n,
        calculateCollateralRequirement: async () => 100n,
        calculateInterestRate: async () => 1500n,
    };
    return srv;
}

async function get(port, p, headers = {}) {
    const res = await fetch(`http://127.0.0.1:${port}${p}`, { headers });
    let body; try { body = await res.json(); } catch { body = null; }
    return { status: res.status, body };
}

async function signAuth(wallet, domain, { to, value, nonce }) {
    const now = Math.floor(Date.now() / 1000);
    const types = {
        TransferWithAuthorization: [
            { name: 'from', type: 'address' }, { name: 'to', type: 'address' },
            { name: 'value', type: 'uint256' }, { name: 'validAfter', type: 'uint256' },
            { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
        ],
    };
    const msg = { from: wallet.address, to, value: BigInt(value),
        validAfter: BigInt(now - 60), validBefore: BigInt(now + 300), nonce };
    const sig = ethers.Signature.from(await wallet.signTypedData(domain, types, msg));
    return { from: wallet.address, to, value: String(value),
        validAfter: String(now - 60), validBefore: String(now + 300), nonce, v: sig.v, r: sig.r, s: sig.s };
}

const hdr = (payload) => Buffer.from(JSON.stringify({
    x402Version: 1, scheme: 'eip3009', network: 'arc-mainnet', payload,
}), 'utf8').toString('base64');

describe('CreditAssessmentServer EIP-712 domain + settlement (2026-09-25)', function () {
    this.timeout(10000);

    let tmp, feeWallet, payer;
    const servers = [];

    before(() => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'x402-dom-'));
        feeWallet = ethers.Wallet.createRandom();
        payer = ethers.Wallet.createRandom();
    });
    afterEach(async () => { while (servers.length) await servers.pop().stop(); });
    after(() => { delete process.env.SERVER_PRIVATE_KEY; });

    it('quotes the EIP-712 domain read off the token, not a hardcoded USD Coin/1', async () => {
        const srv = makeServer(34101, { feeRecipient: feeWallet.address, nonceStorePath: path.join(tmp, '1.json') });
        servers.push(srv); await srv.start();

        const r = await get(34101, `/credit/${payer.address}`);
        assert.strictEqual(r.status, 402);
        const d = r.body.accepts[0].extra.eip712Domain;

        assert.strictEqual(d.name, 'USDC', 'must use the token\'s own name');
        assert.strictEqual(d.version, '2', 'must use the token\'s own version');
        assert.notStrictEqual(d.name, 'USD Coin');

        // And it must reconstruct to the token's real DOMAIN_SEPARATOR.
        const onchain = await srv.usdc.DOMAIN_SEPARATOR();
        assert.strictEqual(ethers.TypedDataEncoder.hashDomain(d), onchain);
    });

    it('accepts a signature made against the quoted domain', async () => {
        const srv = makeServer(34102, { feeRecipient: feeWallet.address, nonceStorePath: path.join(tmp, '2.json') });
        servers.push(srv); await srv.start();

        const d = (await get(34102, `/credit/${payer.address}`)).body.accepts[0].extra.eip712Domain;
        const p = await signAuth(payer, d, { to: feeWallet.address, value: FEE, nonce: ethers.hexlify(ethers.randomBytes(32)) });
        const r = await get(34102, `/credit/${payer.address}`, { 'X-PAYMENT': hdr(p) });

        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.body.creditScore, 250);
        assert.strictEqual(r.body.interestRateBps, '1500');
        assert.strictEqual(r.body.interestRate, '15.00% APR');
    });

    it('rejects a signature made against the OLD hardcoded USD Coin/1 domain', async () => {
        const srv = makeServer(34103, { feeRecipient: feeWallet.address, nonceStorePath: path.join(tmp, '3.json') });
        servers.push(srv); await srv.start();

        const stale = { name: 'USD Coin', version: '1', chainId: CHAIN_ID, verifyingContract: TOKEN };
        const p = await signAuth(payer, stale, { to: feeWallet.address, value: FEE, nonce: ethers.hexlify(ethers.randomBytes(32)) });
        const r = await get(34103, `/credit/${payer.address}`, { 'X-PAYMENT': hdr(p) });

        assert.strictEqual(r.status, 402);
        assert.match(r.body.reason, /signature invalid/i);
    });

    it('with a settlement signer, a failed on-chain settlement is fatal (no free resource)', async () => {
        process.env.SERVER_PRIVATE_KEY = '0x' + '22'.repeat(32);
        const srv = makeServer(34104, {
            feeRecipient: feeWallet.address, nonceStorePath: path.join(tmp, '4.json'),
            token: fakeToken(), // transferWithAuthorization always reverts
        });
        // _getSettlementSigner builds a Wallet against the (unreachable) provider;
        // only its presence matters — the stubbed token throws before any RPC.
        servers.push(srv); await srv.start();

        const d = (await get(34104, `/credit/${payer.address}`)).body.accepts[0].extra.eip712Domain;
        const p = await signAuth(payer, d, { to: feeWallet.address, value: FEE, nonce: ethers.hexlify(ethers.randomBytes(32)) });
        const r = await get(34104, `/credit/${payer.address}`, { 'X-PAYMENT': hdr(p) });

        assert.strictEqual(r.status, 402, 'unsettleable payment must not buy the resource');
        assert.match(r.body.reason, /could not be settled/i);
        delete process.env.SERVER_PRIVATE_KEY;
    });

    it('allowSigOnlyFallback restores the legacy behaviour when explicitly opted in', async () => {
        process.env.SERVER_PRIVATE_KEY = '0x' + '22'.repeat(32);
        const srv = makeServer(34105, {
            feeRecipient: feeWallet.address, nonceStorePath: path.join(tmp, '5.json'),
            token: fakeToken(),
            cfg: { allowSigOnlyFallback: true },
        });
        servers.push(srv); await srv.start();

        const d = (await get(34105, `/credit/${payer.address}`)).body.accepts[0].extra.eip712Domain;
        const p = await signAuth(payer, d, { to: feeWallet.address, value: FEE, nonce: ethers.hexlify(ethers.randomBytes(32)) });
        const r = await get(34105, `/credit/${payer.address}`, { 'X-PAYMENT': hdr(p) });

        assert.strictEqual(r.status, 200);
        delete process.env.SERVER_PRIVATE_KEY;
    });

    it('a malformed agent address returns 400, not 404', async () => {
        const srv = makeServer(34106, { feeRecipient: feeWallet.address, nonceStorePath: path.join(tmp, '6.json') });
        servers.push(srv); await srv.start();

        assert.strictEqual((await get(34106, '/credit/notanaddress')).status, 400);
        assert.strictEqual((await get(34106, '/credit/0x1234')).status, 400);
        assert.strictEqual((await get(34106, '/nope')).status, 404);
    });

    it('the 402 quote states the configured fee rather than a hardcoded 1 USDC', async () => {
        const srv = makeServer(34107, {
            feeRecipient: feeWallet.address, nonceStorePath: path.join(tmp, '7.json'),
            cfg: { feeAmount: '2500000' },
        });
        servers.push(srv); await srv.start();

        const acc = (await get(34107, `/credit/${payer.address}`)).body.accepts[0];
        assert.strictEqual(acc.maxAmountRequired, '2500000');
        assert.match(acc.description, /2\.5 USDC/);
    });

    it('does not claim a contract generation it cannot know (no "ReputationManagerV3" string)', async () => {
        const srv = makeServer(34108, { feeRecipient: feeWallet.address, nonceStorePath: path.join(tmp, '8.json') });
        servers.push(srv); await srv.start();

        const d = (await get(34108, `/credit/${payer.address}`)).body.accepts[0].extra.eip712Domain;
        const p = await signAuth(payer, d, { to: feeWallet.address, value: FEE, nonce: ethers.hexlify(ethers.randomBytes(32)) });
        const body = (await get(34108, `/credit/${payer.address}`, { 'X-PAYMENT': hdr(p) })).body;

        assert.ok(!/ReputationManagerV3/.test(body.dataSource), body.dataSource);
        assert.match(body.dataSource, /0x12953e732e5D1aFdA640554125367d1CEC2ac4FB/i);
        assert.strictEqual(body.network, 'arc-mainnet');
    });
});
