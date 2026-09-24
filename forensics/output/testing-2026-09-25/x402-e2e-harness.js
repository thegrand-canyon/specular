/**
 * x402 end-to-end + failure-path harness  (READ-ONLY on chain — no transactions)
 *
 * Boots `src/x402/CreditAssessmentServer.js` locally in two configurations:
 *   A) its shipped DEFAULTS            → Arc testnet ReputationManagerV3
 *   B) explicitly pointed at V7        → Arc mainnet ReputationManagerV4 (read-only)
 *
 * Then drives the real `src/x402/x402Client.js` plus hand-built X-PAYMENT
 * headers through every failure path, and cross-checks the assessment body
 * against direct on-chain reads.
 *
 * No SERVER_PRIVATE_KEY is set, so the server runs in signature-verification
 * ("dev") mode and never broadcasts. Fee recipient + payer are throwaway keys
 * generated per run and never funded.
 */
'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '../../../.env') });
const { ethers } = require('ethers');
const path = require('path');
const os = require('os');
const fs = require('fs');

const CreditAssessmentServer = require('../../../src/x402/CreditAssessmentServer.js');
const x402Client = require('../../../src/x402/x402Client.js');

const results = [];
function rec(section, name, verdict, detail) {
    results.push({ section, name, verdict, detail });
    const mark = verdict === 'PASS' ? '  ok  ' : verdict === 'FAIL' ? ' FAIL ' : ' NOTE ';
    console.log(`[${mark}] ${section} :: ${name}${detail ? ' — ' + detail : ''}`);
}

// ── throwaway identities (never funded, never persisted) ────────────────────
const payer     = ethers.Wallet.createRandom();
const feeWallet = ethers.Wallet.createRandom();
const AGENT     = '0x800e305A0caDdE6289dFDFEDF38218f45C06F72C'; // read-only subject

const ARC_TESTNET = {
    rpc: process.env.ARC_TESTNET_RPC_URL || 'https://arc-testnet.drpc.org',
    chainId: 5042002,
    usdc: '0xf2807051e292e945751A25616705a9aadfb39895',
    reputation: '0x94F2fa47c4488202a46dAA9038Ed9C9c4c07467F',
    network: 'arc-testnet',
};
const ARC_MAINNET = {
    rpc: process.env.ARC_MAINNET_RPC_URL || 'https://rpc.mainnet.arc.io',
    chainId: 5042,
    usdc: '0x3600000000000000000000000000000000000000',
    reputation: '0x12953e732e5D1aFdA640554125367d1CEC2ac4FB', // ReputationManagerV4 (V7)
    network: 'arc-mainnet',
};

const FEE = '1000000'; // 1 USDC

function b64(obj) { return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64'); }

async function signAuth({ wallet, to, value, validAfter, validBefore, nonce, domain }) {
    const types = {
        TransferWithAuthorization: [
            { name: 'from', type: 'address' }, { name: 'to', type: 'address' },
            { name: 'value', type: 'uint256' }, { name: 'validAfter', type: 'uint256' },
            { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
        ],
    };
    const message = { from: wallet.address, to, value: BigInt(value),
        validAfter: BigInt(validAfter), validBefore: BigInt(validBefore), nonce };
    const sig = ethers.Signature.from(await wallet.signTypedData(domain, types, message));
    return { from: wallet.address, to, value: String(value), validAfter: String(validAfter),
        validBefore: String(validBefore), nonce, v: sig.v, r: sig.r, s: sig.s };
}

function header(payload, over = {}) {
    return b64({ x402Version: 1, scheme: 'eip3009', network: ARC_TESTNET.network, payload, ...over });
}

async function req(port, pathname, hdrs = {}) {
    const res = await fetch(`http://127.0.0.1:${port}${pathname}`, { headers: hdrs });
    let body; try { body = await res.json(); } catch { body = null; }
    return { status: res.status, body, headers: Object.fromEntries(res.headers) };
}

async function startServer(cfg, port, nonceFile) {
    const s = new CreditAssessmentServer({
        port, host: '127.0.0.1',
        rpcUrl: cfg.rpc, chainId: cfg.chainId, network: cfg.network,
        usdcAddress: cfg.usdc, reputationAddress: cfg.reputation,
        feeRecipient: feeWallet.address, feeAmount: FEE,
        nonceStorePath: nonceFile,
    });
    await s.start();
    return s;
}

(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'x402-e2e-'));
    // Domain the server now quotes (resolved from the token), not a guess.
    const probe = await (async () => {
        const s0 = await startServer(ARC_TESTNET, 34020, path.join(tmp, 'probe.json'));
        const r = await req(34020, `/credit/${AGENT}`);
        await s0.stop();
        return r.body.accepts[0].extra.eip712Domain;
    })();
    const domainT = probe;
    console.log('server-quoted EIP-712 domain:', JSON.stringify(domainT));

    console.log(`\npayer (throwaway) ${payer.address}`);
    console.log(`feeRecipient      ${feeWallet.address}\n`);

    // ════════════════ A) shipped defaults → Arc testnet V3 ════════════════
    const srvA = await startServer(ARC_TESTNET, 34021, path.join(tmp, 'a.json'));

    // -- health / discovery -------------------------------------------------
    {
        const r = await req(34021, '/health');
        rec('flow', 'GET /health', r.status === 200 && r.body.status === 'ok' ? 'PASS' : 'FAIL', `status=${r.status}`);
    }
    {
        const r = await req(34021, '/credit/notanaddress');
        rec('failpath', 'invalid agent address → 400', r.status === 400 ? 'PASS' : 'FAIL', `status=${r.status}`);
    }
    {
        const r = await req(34021, '/nope');
        rec('failpath', 'unknown route → 404', r.status === 404 ? 'PASS' : 'FAIL', `status=${r.status}`);
    }

    // -- 1. unpaid request ---------------------------------------------------
    let quote;
    {
        const r = await req(34021, `/credit/${AGENT}`);
        const acc = r.body && r.body.accepts && r.body.accepts[0];
        quote = acc;
        const ok = r.status === 402 && acc && acc.scheme === 'eip3009'
            && acc.maxAmountRequired === FEE && acc.payTo.toLowerCase() === feeWallet.address.toLowerCase()
            && acc.asset.toLowerCase() === ARC_TESTNET.usdc.toLowerCase()
            && r.headers['x-402-version'] === '1';
        rec('failpath', 'unpaid request → 402 + requirements', ok ? 'PASS' : 'FAIL',
            `status=${r.status} amount=${acc && acc.maxAmountRequired} desc="${acc && acc.description}"`);
        rec('failpath', 'quote description reflects the configured fee',
            acc && acc.description && acc.description.includes(String(Number(FEE) / 1e6)) ? 'PASS' : 'FAIL',
            acc && acc.description);
    }

    // -- 2. malformed header -------------------------------------------------
    for (const [name, h] of [
        ['not base64 JSON', 'this-is-not-base64-json!!!'],
        ['base64 of non-JSON', Buffer.from('hello').toString('base64')],
        ['empty string', ' '],
        ['base64 JSON array', Buffer.from('[1,2,3]').toString('base64')],
    ]) {
        const r = await req(34021, `/credit/${AGENT}`, { 'X-PAYMENT': h });
        rec('failpath', `malformed header (${name}) → 402`, r.status === 402 ? 'PASS' : 'FAIL',
            `status=${r.status} reason="${r.body && r.body.reason || r.body && r.body.error}"`);
    }

    // -- 3. wrong scheme -----------------------------------------------------
    {
        const p = await signAuth({ wallet: payer, to: feeWallet.address, value: FEE,
            validAfter: Math.floor(Date.now()/1e3)-60, validBefore: Math.floor(Date.now()/1e3)+300,
            nonce: ethers.hexlify(ethers.randomBytes(32)), domain: domainT });
        const r = await req(34021, `/credit/${AGENT}`, { 'X-PAYMENT': b64({ x402Version:1, scheme:'exact', network: ARC_TESTNET.network, payload: p }) });
        rec('failpath', 'wrong scheme → 402', r.status === 402 && /Unsupported scheme/.test(r.body.reason||'') ? 'PASS':'FAIL', r.body && r.body.reason);
    }

    // -- 4. wrong network ----------------------------------------------------
    {
        const p = await signAuth({ wallet: payer, to: feeWallet.address, value: FEE,
            validAfter: Math.floor(Date.now()/1e3)-60, validBefore: Math.floor(Date.now()/1e3)+300,
            nonce: ethers.hexlify(ethers.randomBytes(32)), domain: domainT });
        const r = await req(34021, `/credit/${AGENT}`, { 'X-PAYMENT': header(p, { network: 'base' }) });
        rec('failpath', 'wrong network → 402', r.status === 402 && /Wrong network/.test(r.body.reason||'') ? 'PASS':'FAIL', r.body && r.body.reason);
    }

    // -- 5. missing fields ---------------------------------------------------
    {
        const r = await req(34021, `/credit/${AGENT}`, { 'X-PAYMENT': header({ from: payer.address, to: feeWallet.address }) });
        rec('failpath', 'missing EIP-3009 fields → 402', r.status === 402 && /Missing/.test(r.body.reason||'') ? 'PASS':'FAIL', r.body && r.body.reason);
    }

    // -- 6. wrong payTo (payment to attacker) --------------------------------
    {
        const attacker = ethers.Wallet.createRandom().address;
        const p = await signAuth({ wallet: payer, to: attacker, value: FEE,
            validAfter: Math.floor(Date.now()/1e3)-60, validBefore: Math.floor(Date.now()/1e3)+300,
            nonce: ethers.hexlify(ethers.randomBytes(32)), domain: domainT });
        const r = await req(34021, `/credit/${AGENT}`, { 'X-PAYMENT': header(p) });
        rec('failpath', 'payment to wrong recipient → 402', r.status === 402 && /fee recipient/.test(r.body.reason||'') ? 'PASS':'FAIL', r.body && r.body.reason);
    }

    // -- 7. underpaid --------------------------------------------------------
    {
        const p = await signAuth({ wallet: payer, to: feeWallet.address, value: '999999',
            validAfter: Math.floor(Date.now()/1e3)-60, validBefore: Math.floor(Date.now()/1e3)+300,
            nonce: ethers.hexlify(ethers.randomBytes(32)), domain: domainT });
        const r = await req(34021, `/credit/${AGENT}`, { 'X-PAYMENT': header(p) });
        rec('failpath', 'underpaid (0.999999 USDC) → 402', r.status === 402 && /Insufficient/.test(r.body.reason||'') ? 'PASS':'FAIL', r.body && r.body.reason);
    }
    {
        const p = await signAuth({ wallet: payer, to: feeWallet.address, value: '0',
            validAfter: Math.floor(Date.now()/1e3)-60, validBefore: Math.floor(Date.now()/1e3)+300,
            nonce: ethers.hexlify(ethers.randomBytes(32)), domain: domainT });
        const r = await req(34021, `/credit/${AGENT}`, { 'X-PAYMENT': header(p) });
        rec('failpath', 'zero-value payment → 402', r.status === 402 ? 'PASS':'FAIL', r.body && r.body.reason);
    }

    // -- 8. expired / not-yet-valid ------------------------------------------
    {
        const now = Math.floor(Date.now()/1e3);
        const p = await signAuth({ wallet: payer, to: feeWallet.address, value: FEE,
            validAfter: now - 3600, validBefore: now - 10,
            nonce: ethers.hexlify(ethers.randomBytes(32)), domain: domainT });
        const r = await req(34021, `/credit/${AGENT}`, { 'X-PAYMENT': header(p) });
        rec('failpath', 'expired authorization → 402', r.status === 402 && /expired/.test(r.body.reason||'') ? 'PASS':'FAIL', r.body && r.body.reason);
    }
    {
        const now = Math.floor(Date.now()/1e3);
        const p = await signAuth({ wallet: payer, to: feeWallet.address, value: FEE,
            validAfter: now + 600, validBefore: now + 3600,
            nonce: ethers.hexlify(ethers.randomBytes(32)), domain: domainT });
        const r = await req(34021, `/credit/${AGENT}`, { 'X-PAYMENT': header(p) });
        rec('failpath', 'not-yet-valid authorization → 402', r.status === 402 && /not yet valid/.test(r.body.reason||'') ? 'PASS':'FAIL', r.body && r.body.reason);
    }

    // -- 9. invalid signature (tampered) -------------------------------------
    {
        const now = Math.floor(Date.now()/1e3);
        const p = await signAuth({ wallet: payer, to: feeWallet.address, value: FEE,
            validAfter: now-60, validBefore: now+300,
            nonce: ethers.hexlify(ethers.randomBytes(32)), domain: domainT });
        p.value = '5000000'; // tamper AFTER signing — pay less, claim more
        const r = await req(34021, `/credit/${AGENT}`, { 'X-PAYMENT': header(p) });
        rec('failpath', 'tampered value (sig mismatch) → 402', r.status === 402 && /signature invalid/i.test(r.body.reason||'') ? 'PASS':'FAIL', r.body && r.body.reason);
    }
    {
        const now = Math.floor(Date.now()/1e3);
        const p = await signAuth({ wallet: payer, to: feeWallet.address, value: FEE,
            validAfter: now-60, validBefore: now+300,
            nonce: ethers.hexlify(ethers.randomBytes(32)), domain: domainT });
        p.r = ethers.hexlify(ethers.randomBytes(32)); // garbage signature
        const r = await req(34021, `/credit/${AGENT}`, { 'X-PAYMENT': header(p) });
        rec('failpath', 'garbage signature → 402', r.status === 402 ? 'PASS':'FAIL', r.body && r.body.reason);
    }
    {
        // signature from a DIFFERENT wallet than `from`
        const now = Math.floor(Date.now()/1e3);
        const other = ethers.Wallet.createRandom();
        const p = await signAuth({ wallet: other, to: feeWallet.address, value: FEE,
            validAfter: now-60, validBefore: now+300,
            nonce: ethers.hexlify(ethers.randomBytes(32)), domain: domainT });
        p.from = payer.address; // claim someone else signed it
        const r = await req(34021, `/credit/${AGENT}`, { 'X-PAYMENT': header(p) });
        rec('failpath', 'signature from wrong signer → 402', r.status === 402 ? 'PASS':'FAIL', r.body && r.body.reason);
    }

    // -- 10. wrong token / wrong chainId in the signing domain ----------------
    {
        const now = Math.floor(Date.now()/1e3);
        const p = await signAuth({ wallet: payer, to: feeWallet.address, value: FEE,
            validAfter: now-60, validBefore: now+300, nonce: ethers.hexlify(ethers.randomBytes(32)),
            domain: { ...domainT, verifyingContract: ethers.Wallet.createRandom().address } });
        const r = await req(34021, `/credit/${AGENT}`, { 'X-PAYMENT': header(p) });
        rec('failpath', 'signed against wrong token → 402', r.status === 402 ? 'PASS':'FAIL', r.body && r.body.reason);
    }
    {
        const now = Math.floor(Date.now()/1e3);
        const p = await signAuth({ wallet: payer, to: feeWallet.address, value: FEE,
            validAfter: now-60, validBefore: now+300, nonce: ethers.hexlify(ethers.randomBytes(32)),
            domain: { ...domainT, chainId: 8453 } });
        const r = await req(34021, `/credit/${AGENT}`, { 'X-PAYMENT': header(p) });
        rec('failpath', 'signed against wrong chainId → 402', r.status === 402 ? 'PASS':'FAIL', r.body && r.body.reason);
    }

    // -- 11. HAPPY PATH ------------------------------------------------------
    let goodPayload, goodAssessment;
    {
        const now = Math.floor(Date.now()/1e3);
        goodPayload = await signAuth({ wallet: payer, to: feeWallet.address, value: FEE,
            validAfter: now-60, validBefore: now+300,
            nonce: ethers.hexlify(ethers.randomBytes(32)), domain: domainT });
        const r = await req(34021, `/credit/${AGENT}`, { 'X-PAYMENT': header(goodPayload) });
        goodAssessment = r.body;
        rec('flow', 'valid payment → 200 assessment', r.status === 200 && r.body.creditScore != null ? 'PASS':'FAIL',
            `status=${r.status} score=${r.body && r.body.creditScore} limit=${r.body && r.body.creditLimit} rate=${r.body && r.body.interestRate} coll=${r.body && r.body.collateralRequired}`);
    }

    // -- 12. replay the SAME payment -----------------------------------------
    {
        const r = await req(34021, `/credit/${AGENT}`, { 'X-PAYMENT': header(goodPayload) });
        rec('failpath', 'replayed payment (same nonce) → 402', r.status === 402 && /replay/i.test(r.body.reason||'') ? 'PASS':'FAIL', r.body && r.body.reason);
    }
    // replay survives restart?
    {
        await srvA.stop?.();
        const srvA2 = await startServer(ARC_TESTNET, 34022, path.join(tmp, 'a.json'));
        const r = await req(34022, `/credit/${AGENT}`, { 'X-PAYMENT': header(goodPayload) });
        rec('failpath', 'replay across server restart → 402', r.status === 402 && /replay/i.test(r.body.reason||'') ? 'PASS':'FAIL', r.body && r.body.reason);
        await srvA2.stop?.();
    }

    // -- 13. overpay / different amount than quoted --------------------------
    const srvA3 = await startServer(ARC_TESTNET, 34023, path.join(tmp, 'a3.json'));
    {
        const now = Math.floor(Date.now()/1e3);
        const p = await signAuth({ wallet: payer, to: feeWallet.address, value: '50000000', // 50 USDC for a 1 USDC quote
            validAfter: now-60, validBefore: now+300,
            nonce: ethers.hexlify(ethers.randomBytes(32)), domain: domainT });
        const r = await req(34023, `/credit/${AGENT}`, { 'X-PAYMENT': header(p) });
        rec('failpath', 'overpay 50x quote → server accepts (no upper bound)', r.status === 200 ? 'NOTE' : 'PASS',
            `status=${r.status} — server only checks value >= fee`);
    }

    // -- 14. UNFUNDED authorization still served (settlement fallback) -------
    {
        // payer has zero USDC and does not exist on chain. In dev mode (no
        // SERVER_PRIVATE_KEY) the server never attempts settlement, so a
        // signature from an empty wallet buys the resource.
        const now = Math.floor(Date.now()/1e3);
        const bal = await new ethers.Contract(ARC_TESTNET.usdc, ['function balanceOf(address) view returns (uint256)'],
            new ethers.JsonRpcProvider(ARC_TESTNET.rpc, undefined, { batchMaxCount: 1 })).balanceOf(payer.address);
        const p = await signAuth({ wallet: payer, to: feeWallet.address, value: FEE,
            validAfter: now-60, validBefore: now+300,
            nonce: ethers.hexlify(ethers.randomBytes(32)), domain: domainT });
        const r = await req(34023, `/credit/${AGENT}`, { 'X-PAYMENT': header(p) });
        rec('bug', 'unfunded payer (0 USDC) served for free', r.status === 200 ? 'NOTE' : 'PASS',
            `payer balance=${bal} status=${r.status} — no settlement, signature-only`);
    }

    // -- 15. client-chosen validity window is not bound to the quote ----------
    {
        const now = Math.floor(Date.now()/1e3);
        const p = await signAuth({ wallet: payer, to: feeWallet.address, value: FEE,
            validAfter: now-60, validBefore: now + 86400 * 365,
            nonce: ethers.hexlify(ethers.randomBytes(32)), domain: domainT });
        const r = await req(34023, `/credit/${AGENT}`, { 'X-PAYMENT': header(p) });
        rec('bug', 'client picks a 1-year validBefore (quote said 300s)', r.status === 200 ? 'NOTE':'PASS',
            `status=${r.status} — maxTimeoutSeconds not enforced against the payload`);
    }

    // ── real x402Client end-to-end ──────────────────────────────────────────
    {
        const client = new x402Client(payer, { verbose: false });
        try {
            const out = await client.get(`http://127.0.0.1:34023/credit/${AGENT}`);
            rec('flow', 'x402Client.get() full 402→sign→retry→200', out && out.creditScore != null ? 'PASS':'FAIL',
                `score=${out && out.creditScore} spent=${client.spentUsdc ? client.spentUsdc() : 'n/a'}`);
        } catch (e) {
            rec('flow', 'x402Client.get() full 402→sign→retry→200', 'FAIL', e.message);
        }
    }
    // client refuses when the server demands more than the 10 USDC cap
    {
        const srvBig = await startServer({ ...ARC_TESTNET }, 34024, path.join(tmp, 'big.json'));
        srvBig.cfg.feeAmount = '11000000'; // 11 USDC > default cap
        const client = new x402Client(payer, {});
        let msg = '';
        try { await client.get(`http://127.0.0.1:34024/credit/${AGENT}`); }
        catch (e) { msg = e.message; }
        rec('2026-07', 'F1 default 10 USDC per-payment cap still enforced',
            /exceeds maxPayment/.test(msg) ? 'PASS':'FAIL', msg.slice(0, 120));
        await srvBig.stop?.();
    }
    // client refuses a token-substituted quote
    {
        const srvTok = await startServer({ ...ARC_TESTNET, usdc: ethers.Wallet.createRandom().address }, 34025, path.join(tmp, 'tok.json'));
        const client = new x402Client(payer, {});
        let msg = '';
        try { await client.get(`http://127.0.0.1:34025/credit/${AGENT}`); }
        catch (e) { msg = e.message; }
        rec('2026-07', 'F1 verifyingContract pin blocks token substitution',
            /refusing to sign/.test(msg) ? 'PASS':'FAIL', msg.slice(0, 140));
        await srvTok.stop?.();
    }

    await srvA3.stop?.();

    // ════════════════ B) pointed at V7 (Arc mainnet V4) ════════════════
    const srvB = await startServer(ARC_MAINNET, 34031, path.join(tmp, 'b.json'));
    // Take the domain from the server's own quote — it is resolved from the token.
    const domainM = (await req(34031, `/credit/${AGENT}`)).body.accepts[0].extra.eip712Domain;
    console.log('  arc-mainnet quoted domain:', JSON.stringify(domainM));
    {
        const now = Math.floor(Date.now()/1e3);
        const p = await signAuth({ wallet: payer, to: feeWallet.address, value: FEE,
            validAfter: now-60, validBefore: now+300,
            nonce: ethers.hexlify(ethers.randomBytes(32)), domain: domainM });
        const r = await fetch(`http://127.0.0.1:34031/credit/${AGENT}`, {
            headers: { 'X-PAYMENT': b64({ x402Version:1, scheme:'eip3009', network: ARC_MAINNET.network, payload: p }) } });
        const body = await r.json();
        // Ground truth straight from the chain
        const prov = new ethers.JsonRpcProvider(ARC_MAINNET.rpc, undefined, { batchMaxCount: 1 });
        const rep = new ethers.Contract(ARC_MAINNET.reputation, [
            'function getReputationScore(address) view returns (uint256)',
            'function calculateCreditLimit(address) view returns (uint256)',
            'function calculateCollateralRequirement(address) view returns (uint256)',
            'function calculateInterestRate(address) view returns (uint256)',
        ], prov);
        const [sc, lim, col, bps] = await Promise.all([
            rep.getReputationScore(AGENT), rep.calculateCreditLimit(AGENT),
            rep.calculateCollateralRequirement(AGENT), rep.calculateInterestRate(AGENT)]);
        console.log(`\n  chain truth  score=${sc} limit=${Number(lim)/1e6} USDC coll=${col}% rate=${Number(bps)/100}%`);
        console.log(`  x402 body    score=${body.creditScore} limit=${body.creditLimit} coll=${body.collateralRequired} rate=${body.interestRate}`);
        const ok = r.status === 200
            && Number(body.creditScore) === Number(sc)
            && body.creditLimitRaw === lim.toString()
            && body.interestRateBps === bps.toString()
            && body.collateralRequired === `${col}%`;
        rec('v7', 'assessment matches V7 chain reads exactly', ok ? 'PASS':'FAIL',
            `score ${body.creditScore}/${sc}, limitRaw ${body.creditLimitRaw}/${lim}, bps ${body.interestRateBps}/${bps}`);
        rec('v7', 'dataSource string', body.dataSource === 'on-chain (ReputationManagerV3)' ? 'FAIL':'PASS',
            `"${body.dataSource}" while actually reading ReputationManagerV4`);
        rec('v7', 'protocol version string', body.protocol === 'Specular Protocol v3' ? 'FAIL':'PASS', `"${body.protocol}"`);
        rec('v7', 'autoApproveMaxUsdc no longer a hardcoded 50000',
            body.loanTerms.autoApproveMaxUsdc === 50000 ? 'NOTE':'PASS',
            `${body.loanTerms.autoApproveMaxUsdc} (configurable via CREDIT_AUTO_APPROVE_MAX_USDC; V7 MAX_TIER_LIMIT is 10,000)`);
        rec('v7', 'tier labels vs on-chain 6-tier table', 'NOTE',
            `server uses 800/600/400/200 buckets; V7 TIER_MIN_SCORE = 0/200/400/500/600/800 (no 500 bucket)`);
        rec('v7', 'loanTerms.minDurationDays hardcoded 7 / max 365', 'NOTE', 'not read from chain');

        // The quoted domain must match the token's real DOMAIN_SEPARATOR, or
        // every authorization signed against it is unsettleable on-chain.
        const q = await fetch(`http://127.0.0.1:34031/credit/${AGENT}`);
        const dom = (await q.json()).accepts[0].extra.eip712Domain;
        const usdcC = new ethers.Contract(ARC_MAINNET.usdc,
            ['function DOMAIN_SEPARATOR() view returns (bytes32)'], prov);
        const onchain = await usdcC.DOMAIN_SEPARATOR();
        const local   = ethers.TypedDataEncoder.hashDomain(dom);
        rec('2026-09', 'quoted EIP-712 domain matches token DOMAIN_SEPARATOR (Arc mainnet USDC)',
            onchain.toLowerCase() === local.toLowerCase() ? 'PASS' : 'FAIL',
            `quoted ${JSON.stringify(dom.name)}/${JSON.stringify(dom.version)} → ${local.slice(0,14)} vs on-chain ${onchain.slice(0,14)}`);
    }
    await srvB.stop?.();

    // ── summary ────────────────────────────────────────────────────────────
    const f = results.filter(r => r.verdict === 'FAIL').length;
    const p = results.filter(r => r.verdict === 'PASS').length;
    const n = results.filter(r => r.verdict === 'NOTE').length;
    console.log(`\n${'='.repeat(70)}\nPASS ${p}   FAIL ${f}   NOTE ${n}`);
    fs.writeFileSync(path.join(__dirname, 'x402-e2e-results.json'), JSON.stringify(results, null, 2));
    process.exit(0);
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(1); });
