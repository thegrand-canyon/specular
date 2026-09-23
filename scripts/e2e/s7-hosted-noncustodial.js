/**
 * S7 — Hosted NON-CUSTODIAL path against the live server
 *   https://specular-agent-api-production.up.railway.app
 * Only the server's REST (/v1/arc-staging/…) and MCP (/mcp tools/call) routes are used
 * to prepare and relay transactions; signing happens locally with ethers. Every step is
 * asserted from direct contract reads. Round-trip latencies are recorded.
 *
 *  REST: prepare_register_agent → prepare_create_pool → prepare_approve_usdc +
 *        prepare_supply_liquidity → prepare_request_loan (simulate first) →
 *        preview_repayment → prepare_repay_loan → get_loan_status == REPAID
 *  MCP:  a second loan cycle entirely through JSON-RPC tools/call
 *        (prepare_request_loan, broadcast_signed_transaction, preview_repayment,
 *        prepare_repay_loan, get_loan_status).
 */
const L = require('./_lib');
const { USDC, fmt } = L;
const S = 'S7';
const BASE = process.env.SPECULAR_HOSTED_URL || 'https://specular-agent-api-production.up.railway.app';
const NET = 'arc-staging';
const latencies = [];

async function http(method, path, body, label) {
    const t0 = Date.now();
    const res = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json', accept: 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const ms = Date.now() - t0;
    let json = null; try { json = await res.json(); } catch (e) { json = { parseError: true }; }
    latencies.push({ route: 'REST', label: label || `${method} ${path}`, ms, status: res.status });
    console.log(`    REST ${label || path} -> ${res.status} in ${ms} ms`);
    return { status: res.status, json, ms };
}
let mcpId = 1;
async function mcp(name, args, label) {
    const t0 = Date.now();
    const res = await fetch(BASE + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: mcpId++, method: 'tools/call', params: { name, arguments: args } }) });
    const ms = Date.now() - t0;
    const env = await res.json();
    latencies.push({ route: 'MCP', label: label || name, ms, status: res.status });
    console.log(`    MCP ${label || name} -> ${res.status} in ${ms} ms`);
    if (env.error) throw new Error(`MCP error ${JSON.stringify(env.error)}`);
    const r = env.result;
    let data = r.structuredContent;
    if (!data && r.content && r.content[0] && r.content[0].text) { try { data = JSON.parse(r.content[0].text); } catch (e) { data = { text: r.content[0].text }; } }
    return { isError: Boolean(r.isError), data, ms };
}

async function main() {
    await L.assertStaging();
    const R = new L.Results(S);
    const { mp, reg, usdc } = L.contracts();
    const mpAddr = L.cfg.agentLiquidityMarketplace_v6;
    const C = L.freshRoleWallet('C');
    console.log('agent C', C.address);
    await L.fundNative(C, '1.0', S);
    await L.mintUsdc(C.address, 100, S);

    const health = await http('GET', '/health', null, 'GET /health');
    R.check('server healthy, arc-staging enabled', health.status === 200 && health.json.networks.some(n => n.network === NET && n.ok), JSON.stringify(health.json).slice(0, 160));
    const netInfo = await http('GET', `/v1/${NET}/network`, null, 'GET network');
    R.check('server pins the V6.1 staging marketplace address', JSON.stringify(netInfo.json).toLowerCase().includes(mpAddr.toLowerCase()), JSON.stringify(netInfo.json).slice(0, 200));

    // sign locally + relay via REST or MCP
    async function signAndBroadcast(prepared, label, via = 'REST') {
        if (!prepared || !prepared.to || !prepared.data) throw new Error(`no prepared tx for ${label}: ${JSON.stringify(prepared).slice(0, 300)}`);
        if (Number(prepared.chainId) !== L.CHAIN_ID) throw new Error(`prepared chainId ${prepared.chainId} != staging`);
        const fee = await L.provider.getFeeData();
        const tx = {
            to: prepared.to, data: prepared.data, value: 0n, chainId: L.CHAIN_ID,
            nonce: await L.provider.getTransactionCount(C.address, 'pending'),
            gasLimit: BigInt(prepared.gasEstimate),
            maxFeePerGas: fee.maxFeePerGas, maxPriorityFeePerGas: fee.maxPriorityFeePerGas, type: 2
        };
        const raw = await C.signTransaction(tx);
        let hash;
        if (via === 'REST') {
            const b = await http('POST', `/v1/${NET}/tx/broadcast`, { signedTransaction: raw }, `broadcast ${label}`);
            if (b.status !== 200) throw new Error(`broadcast failed ${b.status} ${JSON.stringify(b.json)}`);
            hash = b.json.hash;
        } else {
            const b = await mcp('broadcast_signed_transaction', { network: NET, signedTransaction: raw }, `broadcast ${label}`);
            if (b.isError) throw new Error(`MCP broadcast failed ${JSON.stringify(b.data)}`);
            hash = b.data.hash;
        }
        const rc = await L.provider.waitForTransaction(hash, 1, 120000);
        if (!rc || rc.status !== 1) throw new Error(`${label} mined with status ${rc && rc.status}`);
        L.logTx(S, `[${via}] ${label}`, rc);
        return { hash, rc };
    }

    // ---------------- REST flow ----------------
    const cs0 = await http('GET', `/v1/${NET}/agents/${C.address}/credit`, null, 'check_credit_score (before)');
    R.check('check_credit_score: not registered yet', cs0.status === 200 && cs0.json.registered === false, JSON.stringify(cs0.json).slice(0, 160));

    const reg1 = await http('POST', `/v1/${NET}/tx/prepare/register_agent`, { from: C.address, agentURI: 'ipfs://e2e-C', simulate: true }, 'prepare_register_agent');
    R.check('prepare_register_agent: unsigned tx to registry, simulation ok', reg1.status === 200 && reg1.json.to.toLowerCase() === L.cfg.agentRegistryV2.toLowerCase() && reg1.json.simulation && reg1.json.simulation.ok === true && reg1.json.value === '0', JSON.stringify(reg1.json).slice(0, 200));
    await signAndBroadcast(reg1.json, 'register_agent');
    const cId = Number(await reg.addressToAgentId(C.address));
    R.check('on-chain: C registered', cId > 0, `agentId ${cId}`);

    const pool1 = await http('POST', `/v1/${NET}/tx/prepare/create_pool`, { from: C.address, simulate: true }, 'prepare_create_pool');
    R.check('prepare_create_pool ok', pool1.status === 200 && pool1.json.simulation.ok === true);
    await signAndBroadcast(pool1.json, 'create_pool');
    R.check('on-chain: pool active, agentAddress == C', (await mp.agentPools(cId)).isActive && (await mp.agentPools(cId)).agentAddress === C.address);

    const appr = await http('POST', `/v1/${NET}/tx/prepare/approve_usdc`, { from: C.address, amount: 20, simulate: true }, 'prepare_approve_usdc 20');
    R.check('prepare_approve_usdc: exact 20 USDC to marketplace', appr.status === 200 && appr.json.to.toLowerCase() === L.cfg.usdc.toLowerCase() && appr.json.simulation.ok === true, JSON.stringify(appr.json.call || appr.json.humanReadableSummary).slice(0, 160));
    await signAndBroadcast(appr.json, 'approve_usdc 20');
    R.check('on-chain: allowance == 20', (await usdc.allowance(C.address, mpAddr)) === USDC(20));
    const sup = await http('POST', `/v1/${NET}/tx/prepare/supply_liquidity`, { from: C.address, agentId: cId, amount: 20, simulate: true }, 'prepare_supply_liquidity 20');
    R.check('prepare_supply_liquidity ok, no prerequisite (allowance already exact)', sup.status === 200 && sup.json.simulation.ok === true && !sup.json.prerequisite, JSON.stringify(sup.json.warnings));
    await signAndBroadcast(sup.json, 'supply_liquidity 20');
    R.check('on-chain: position 20, availableLiquidity 20, allowance 0', (await mp.positions(cId, C.address)).amount === USDC(20) && (await mp.agentPools(cId)).availableLiquidity === USDC(20) && (await usdc.allowance(C.address, mpAddr)) === 0n);

    // request loan — simulate first (no allowance for collateral → prerequisite expected)
    const rl1 = await http('POST', `/v1/${NET}/tx/prepare/request_loan`, { from: C.address, amount: 10, durationDays: 7, simulate: true }, 'prepare_request_loan (simulate, no allowance)');
    R.check('prepare_request_loan: returns approve prerequisite for 10 USDC collateral (score 0 → 100%)', rl1.status === 200 && rl1.json.prerequisite && rl1.json.prerequisite.to.toLowerCase() === L.cfg.usdc.toLowerCase(), JSON.stringify({ sim: rl1.json.simulation, prereq: rl1.json.prerequisite && rl1.json.prerequisite.humanReadableSummary }).slice(0, 300));
    R.note('prepare_request_loan simulation (before prerequisite)', JSON.stringify(rl1.json.simulation));
    await signAndBroadcast(rl1.json.prerequisite, 'request_loan prerequisite approve');
    R.check('on-chain: collateral allowance == 10', (await usdc.allowance(C.address, mpAddr)) === USDC(10));
    const rl2 = await http('POST', `/v1/${NET}/tx/prepare/request_loan`, { from: C.address, amount: 10, durationDays: 7, simulate: true }, 'prepare_request_loan (simulate, after approve)');
    R.check('prepare_request_loan: simulation ok, no prerequisite', rl2.status === 200 && rl2.json.simulation.ok === true && !rl2.json.prerequisite, JSON.stringify(rl2.json.simulation));
    const cBal0 = await usdc.balanceOf(C.address);
    const { hash: loanHash } = await signAndBroadcast(rl2.json, 'request_loan 10');
    const txv = await http('GET', `/v1/${NET}/tx/${loanHash}`, null, 'get_transaction (loan)');
    const evt = txv.json.events && txv.json.events.find(e => e.name === 'LoanRequested');
    const loanId = evt ? Number(evt.args.loanId) : null;
    R.check('get_transaction: confirmed + LoanRequested event carries loanId', txv.json.status === 'confirmed' && loanId !== null, `loanId ${loanId}`);
    const ln = await mp.loans(loanId);
    R.check('on-chain: loan ACTIVE, borrower C, 10 USDC, collateral 10', Number(ln.state) === 1 && ln.borrower === C.address && ln.amount === USDC(10) && ln.collateralAmount === USDC(10));
    R.check('on-chain: C balance unchanged (collateral out, principal in)', (await usdc.balanceOf(C.address)) === cBal0);
    const ls = await http('GET', `/v1/${NET}/loans/${loanId}`, null, 'get_loan_status (active)');
    R.check('get_loan_status: ACTIVE', ls.json.state === 'ACTIVE' && ls.json.principalUsdc === '10.0');

    const pv = await http('GET', `/v1/${NET}/loans/${loanId}/repayment`, null, 'preview_repayment');
    const pvChain = await mp.previewRepayment(loanId);
    R.check('preview_repayment matches contract previewRepayment', pv.status === 200 && JSON.stringify(pv.json).includes(fmt(pvChain.total)), `server ${JSON.stringify(pv.json).slice(0, 200)} chain total ${fmt(pvChain.total)}`);
    const rp1 = await http('POST', `/v1/${NET}/tx/prepare/repay_loan`, { from: C.address, loanId, simulate: true }, 'prepare_repay_loan (simulate)');
    R.check('prepare_repay_loan: prerequisite approve for exactly previewRepayment.total', rp1.status === 200 && rp1.json.prerequisite && JSON.stringify(rp1.json.prerequisite).includes(fmt(pvChain.total)), JSON.stringify(rp1.json.prerequisite && rp1.json.prerequisite.humanReadableSummary));
    await signAndBroadcast(rp1.json.prerequisite, 'repay prerequisite approve');
    R.check('on-chain: allowance == previewRepayment.total', (await usdc.allowance(C.address, mpAddr)) === pvChain.total);
    const rp2 = await http('POST', `/v1/${NET}/tx/prepare/repay_loan`, { from: C.address, loanId, simulate: true }, 'prepare_repay_loan (after approve)');
    R.check('prepare_repay_loan: simulation ok, no prerequisite', rp2.json.simulation.ok === true && !rp2.json.prerequisite);
    await signAndBroadcast(rp2.json, `repay_loan ${loanId}`);
    R.check('on-chain: loan REPAID, C paid exactly interest', Number((await mp.loans(loanId)).state) === 2 && cBal0 - (await usdc.balanceOf(C.address)) === pvChain.interest, `interest ${fmt(pvChain.interest)}`);
    const ls2 = await http('GET', `/v1/${NET}/loans/${loanId}`, null, 'get_loan_status (repaid)');
    R.check('get_loan_status: REPAID', ls2.json.state === 'REPAID', JSON.stringify(ls2.json).slice(0, 200));
    R.note('get_loan_status.repayment for a REPAID loan', JSON.stringify(ls2.json.repayment));
    const cs1 = await http('GET', `/v1/${NET}/agents/${C.address}/credit`, null, 'check_credit_score (after)');
    R.check('check_credit_score after: registered, score 0 (minHold not met)', cs1.json.registered === true && cs1.json.reputation && Number(cs1.json.reputation.score) === 0 && cs1.json.credit.collateralPercent === 100,
        // report the exact fields the assertion reads (the old 200-char prefix of the whole body cut them off)
        JSON.stringify({ status: cs1.status, registered: cs1.json.registered, reputation: cs1.json.reputation, collateralPercent: cs1.json.credit && cs1.json.credit.collateralPercent, chainScore: (await L.contracts().rep['getReputationScore(uint256)'](cId)).toString(), rpc: cs1.json.rpc, error: cs1.json.error }));

    // ---------------- MCP JSON-RPC flow (second loan cycle) ----------------
    const m0 = await mcp('get_protocol_status', { network: NET }, 'get_protocol_status');
    R.check('MCP get_protocol_status ok', !m0.isError && m0.data, JSON.stringify(m0.data).slice(0, 160));
    const mrl = await mcp('prepare_request_loan', { network: NET, from: C.address, amount: 5, durationDays: 7, simulate: true }, 'prepare_request_loan');
    R.check('MCP prepare_request_loan returns prerequisite approve (5 USDC collateral)', !mrl.isError && mrl.data.prerequisite, JSON.stringify(mrl.data.simulation));
    await signAndBroadcast(mrl.data.prerequisite, 'mcp request_loan prerequisite', 'MCP');
    const mrl2 = await mcp('prepare_request_loan', { network: NET, from: C.address, amount: 5, durationDays: 7, simulate: true }, 'prepare_request_loan (after approve)');
    R.check('MCP prepare_request_loan simulation ok', !mrl2.isError && mrl2.data.simulation.ok === true && !mrl2.data.prerequisite);
    const { hash: h2 } = await signAndBroadcast(mrl2.data, 'mcp request_loan 5', 'MCP');
    const mtx = await mcp('get_transaction', { network: NET, hash: h2 }, 'get_transaction');
    const loan2 = Number(mtx.data.events.find(e => e.name === 'LoanRequested').args.loanId);
    R.check('MCP get_transaction → loanId', Number.isFinite(loan2) && Number((await mp.loans(loan2)).state) === 1, `loanId ${loan2}`);
    const mpv = await mcp('preview_repayment', { network: NET, loanId: loan2 }, 'preview_repayment');
    const pv2 = await mp.previewRepayment(loan2);
    R.check('MCP preview_repayment matches contract', !mpv.isError && JSON.stringify(mpv.data).includes(fmt(pv2.total)), JSON.stringify(mpv.data).slice(0, 200));
    const mrp = await mcp('prepare_repay_loan', { network: NET, from: C.address, loanId: loan2, simulate: true }, 'prepare_repay_loan');
    R.check('MCP prepare_repay_loan returns exact approve prerequisite', !mrp.isError && mrp.data.prerequisite && JSON.stringify(mrp.data.prerequisite).includes(fmt(pv2.total)));
    await signAndBroadcast(mrp.data.prerequisite, 'mcp repay prerequisite', 'MCP');
    const mrp2 = await mcp('prepare_repay_loan', { network: NET, from: C.address, loanId: loan2, simulate: true }, 'prepare_repay_loan (after approve)');
    await signAndBroadcast(mrp2.data, `mcp repay_loan ${loan2}`, 'MCP');
    const mls = await mcp('get_loan_status', { network: NET, loanId: loan2 }, 'get_loan_status');
    R.check('MCP get_loan_status: REPAID; on-chain state 2', mls.data.state === 'REPAID' && Number((await mp.loans(loan2)).state) === 2);
    R.check('C allowance 0 at the end (all approvals exact)', (await usdc.allowance(C.address, mpAddr)) === 0n);

    // relay allow-list: a signed tx to a non-Specular target must be refused
    const rawBad = await C.signTransaction({ to: L.roleWallet('A').address, value: 1n, chainId: L.CHAIN_ID, nonce: await L.provider.getTransactionCount(C.address, 'pending'), gasLimit: 21000n, maxFeePerGas: (await L.provider.getFeeData()).maxFeePerGas, maxPriorityFeePerGas: (await L.provider.getFeeData()).maxPriorityFeePerGas, type: 2 });
    const bad = await http('POST', `/v1/${NET}/tx/broadcast`, { signedTransaction: rawBad }, 'broadcast (non-Specular target, must be refused)');
    R.check('relay refuses a signed tx to a non-Specular target', bad.status === 400, JSON.stringify(bad.json).slice(0, 160));

    const g = await L.globalSolvency();
    R.check('GLOBAL solvency exact', g.exact, `surplus ${g.surplus}`);

    // latency table
    const byRoute = {};
    for (const l of latencies) { (byRoute[l.route] = byRoute[l.route] || []).push(l.ms); }
    const stats = Object.fromEntries(Object.entries(byRoute).map(([k, v]) => { const s = [...v].sort((a, b) => a - b); return [k, { n: v.length, min: s[0], median: s[Math.floor(s.length / 2)], p90: s[Math.floor(s.length * 0.9)], max: s[s.length - 1], mean: Math.round(v.reduce((a, b) => a + b, 0) / v.length) }]; }));
    console.log('latency stats', stats);
    R.finish({ agentC: C.address, agentId: cId, loans: [loanId, loan2], latencies, latencyStats: stats, server: BASE });
}
main().catch((e) => { console.error(e); process.exit(1); });
