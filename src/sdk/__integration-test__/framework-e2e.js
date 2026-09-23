/**
 * Framework integrations e2e — invoke each tool with each framework's actual API.
 *
 * The three frameworks have legitimately different conventions:
 *   - LangChain JS: tools are { name, invoke(args) }, args use camelCase (durationDays)
 *   - OpenAI JS:    tools wrapped in { type, function: { name, parameters } }, snake_case args
 *   - Anthropic JS: tools are { name, input_schema }, snake_case args
 *   - executeSpecular*(sdk, name, args)  — both OpenAI + Anthropic use this signature
 */

require('dotenv').config();
const { ethers } = require('ethers');

const { specularTools } = require('../langchain/SpecularTools');
const { specularFunctions, executeSpecularFunction } = require('../openai/SpecularFunctions');
const { specularAnthropicTools, executeSpecularAnthropicTool } = require('../anthropic/SpecularTools');
const { SpecularQuickstart } = require('../SpecularQuickstart');

const RPC = process.env.ARC_TESTNET_RPC_URL || 'https://arc-testnet.drpc.org';

let pass = 0, fail = 0;

function logTest(name, ok, detail) {
    if (ok) { pass++; console.log(`  ✅ ${name}: ${detail || 'ok'}`); }
    else    { fail++; console.log(`  ❌ ${name}: ${detail}`); }
}

async function tryRun(label, fn) {
    try {
        const r = await fn();
        logTest(label, true, JSON.stringify(r).slice(0, 120));
        return r;
    } catch (e) {
        logTest(label, false, e.message.slice(0, 200));
        return null;
    }
}

function parseJsonResult(r) {
    if (typeof r === 'string') {
        try { return JSON.parse(r); } catch { return null; }
    }
    return r;
}

(async () => {
    const provider = new ethers.JsonRpcProvider(RPC, undefined, { batchMaxCount: 1 });
    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
    const sdk = new SpecularQuickstart(wallet, 'arc');
    console.log(`Agent: ${wallet.address}\nRPC:   ${RPC}\n`);

    // === LANGCHAIN JS ===
    console.log('═══ LangChain JS ═══');
    const lcTools = specularTools(wallet, 'arc');
    logTest('returns array', Array.isArray(lcTools), `${lcTools.length} tools`);
    const lcByName = Object.fromEntries(lcTools.map(t => [t.name, t]));
    const lcExpected = ['specular_credit_info', 'specular_onboard', 'specular_borrow', 'specular_repay', 'specular_loans', 'specular_supply', 'specular_withdraw', 'specular_claim_interest'];
    for (const n of lcExpected) {
        logTest(`tool ${n}`, !!lcByName[n], lcByName[n] ? `desc="${(lcByName[n].description || '').slice(0, 50)}…"` : 'missing');
    }
    await tryRun('langchain credit_info', () => lcByName.specular_credit_info.invoke({}));
    await tryRun('langchain loans',       () => lcByName.specular_loans.invoke({}));
    const lcBorrow = await tryRun('langchain borrow(0.5 USDC, 7d)',
        () => lcByName.specular_borrow.invoke({ amount: 0.5, durationDays: 7 }));
    if (lcBorrow) {
        const r = parseJsonResult(lcBorrow);
        if (r?.loanId !== undefined) {
            await tryRun(`langchain repay(${r.loanId})`, () => lcByName.specular_repay.invoke({ loanId: r.loanId }));
        } else {
            logTest('langchain borrow returned loanId', false, JSON.stringify(r).slice(0, 200));
        }
    }

    // === OPENAI JS ===
    console.log('\n═══ OpenAI Functions JS ═══');
    const oaFns = specularFunctions();
    logTest('returns array', Array.isArray(oaFns), `${oaFns.length} functions`);
    const oaByName = Object.fromEntries(oaFns.map(f => [f.function.name, f]));
    const oaExpected = ['specular_credit_info', 'specular_onboard', 'specular_borrow', 'specular_repay', 'specular_loans', 'specular_claim_initial_credit'];
    for (const n of oaExpected) {
        const fn = oaByName[n];
        logTest(`function ${n}`, !!fn, fn ? `params: ${Object.keys(fn.function.parameters?.properties || {}).join(',') || '(none)'}` : 'missing');
    }
    await tryRun('openai credit_info', () => executeSpecularFunction(sdk, 'specular_credit_info', {}));
    await tryRun('openai loans',       () => executeSpecularFunction(sdk, 'specular_loans', {}));
    const oaBorrow = await tryRun('openai borrow(0.5 USDC, 7d)',
        () => executeSpecularFunction(sdk, 'specular_borrow', { amount: 0.5, duration_days: 7 }));
    if (oaBorrow) {
        const r = parseJsonResult(oaBorrow);
        if (r?.loanId !== undefined) {
            await tryRun(`openai repay(${r.loanId})`, () => executeSpecularFunction(sdk, 'specular_repay', { loan_id: r.loanId }));
        } else {
            logTest('openai borrow returned loanId', false, JSON.stringify(r).slice(0, 200));
        }
    }

    // === ANTHROPIC JS ===
    console.log('\n═══ Anthropic Tool Use JS ═══');
    const anTools = specularAnthropicTools();
    logTest('returns array', Array.isArray(anTools), `${anTools.length} tools`);
    const anByName = Object.fromEntries(anTools.map(t => [t.name, t]));
    for (const n of oaExpected) {
        logTest(`tool ${n}`, !!anByName[n], anByName[n] ? `schema=${anByName[n].input_schema?.type}` : 'missing');
    }
    await tryRun('anthropic credit_info', () => executeSpecularAnthropicTool(sdk, 'specular_credit_info', {}));
    await tryRun('anthropic loans',       () => executeSpecularAnthropicTool(sdk, 'specular_loans', {}));
    const anBorrow = await tryRun('anthropic borrow(0.5 USDC, 7d)',
        () => executeSpecularAnthropicTool(sdk, 'specular_borrow', { amount: 0.5, duration_days: 7 }));
    if (anBorrow) {
        const r = parseJsonResult(anBorrow);
        if (r?.loanId !== undefined) {
            await tryRun(`anthropic repay(${r.loanId})`, () => executeSpecularAnthropicTool(sdk, 'specular_repay', { loan_id: r.loanId }));
        } else {
            logTest('anthropic borrow returned loanId', false, JSON.stringify(r).slice(0, 200));
        }
    }

    console.log(`\n═══ TOTAL: ${pass} pass, ${fail} fail ═══`);
    process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('SUITE ERROR:', e); process.exit(2); });
