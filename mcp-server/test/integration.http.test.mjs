// Integration test: boots dist/http.js against Arc testnet V6-STAGING (the
// only network enabled) and exercises REST + MCP-over-HTTP. READ tools run
// for real; write tools are prepare+simulate ONLY. Nothing is broadcast.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ethers } from 'ethers';

const here = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.join(here, '..', 'dist', 'http.js');
const NET = 'arc-staging';
const AGENT = '0x800e305A0caDdE6289dFDFEDF38218f45C06F72C'; // staging deployer / agent #1 (public address only)
const TOKEN = 'test-token-' + Math.random().toString(36).slice(2);

const servers = [];

async function boot(env) {
  const port = 3500 + Math.floor(Math.random() * 2000);
  const child = spawn(process.execPath, [ENTRY], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', SPECULAR_ENABLED_NETWORKS: NET, LOG_LEVEL: 'warn', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', (d) => (logs += d));
  child.stderr.on('data', (d) => (logs += d));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`${base}/`);
      if (r.ok) break;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
    if (child.exitCode !== null) throw new Error(`server exited early: ${logs}`);
  }
  const s = { base, child, logs: () => logs };
  servers.push(s);
  return s;
}

async function json(url, init) {
  const r = await fetch(url, init);
  const body = await r.json();
  return { status: r.status, body, headers: r.headers };
}
const post = (url, data, headers = {}) => json(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(data) });

let S; // open server
before(async () => {
  S = await boot({});
}, { timeout: 30_000 });
after(() => {
  for (const s of servers) s.child.kill('SIGTERM');
});

test('refuses to start the remote server with a private key in env', async () => {
  const port = 3500 + Math.floor(Math.random() * 2000);
  const child = spawn(process.execPath, [ENTRY], {
    env: { ...process.env, PORT: String(port), SPECULAR_ENABLED_NETWORKS: NET, SPECULAR_PRIVATE_KEY: '0x' + '11'.repeat(32) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  const code = await new Promise((r) => child.on('exit', r));
  assert.equal(code, 2);
  assert.match(out, /refuses to start/);
  assert.doesNotMatch(out, /1111111111/);
});

test('meta: /, /health, /openapi.json', async () => {
  const root = await json(`${S.base}/`);
  assert.equal(root.body.mcp.endpoint, '/mcp');
  assert.deepEqual(root.body.networks, [NET]);
  const h = await json(`${S.base}/health`);
  assert.equal(h.status, 200);
  assert.equal(h.body.networks[0].network, NET);
  assert.equal(typeof h.body.networks[0].blockNumber, 'number');
  const o = await json(`${S.base}/openapi.json`);
  assert.equal(o.body.openapi, '3.1.0');
  assert.ok(o.body.paths['/v1/{network}/agents/{address}/credit'].get);
  assert.ok(o.body.paths['/v1/{network}/tx/prepare/request_loan'].post);
  assert.ok(o.body.paths['/v1/{network}/tx/broadcast'].post);
  assert.ok(o.body.paths['/mcp'].post);
  assert.match(o.body.servers[0].url, new RegExp(S.base.replace('127.0.0.1', '(127\\.0\\.0\\.1|localhost)')));
});

test('network is explicit: missing/unknown/disabled -> 400', async () => {
  assert.equal((await json(`${S.base}/v1/base/status`)).status, 400);
  assert.match((await json(`${S.base}/v1/base/status`)).body.error, /not enabled/);
  assert.equal((await json(`${S.base}/v1/arc/status`)).status, 400);
  assert.equal((await json(`${S.base}/v1/arc-mainnet/status`)).status, 400);
  const n = await json(`${S.base}/v1/networks`);
  assert.equal(n.body.networks.length, 1);
  assert.equal(n.body.networks[0].chainId, 5042002);
});

test('READ: status, credit, pools, pool details, loans, positions, tx', async () => {
  const st = await json(`${S.base}/v1/${NET}/status`);
  assert.equal(st.status, 200);
  assert.equal(st.body.paused, false);
  assert.ok(st.body.totalPools > 0);
  assert.equal(st.body.rpc.stale, false);
  assert.equal(st.body.parameters.loanDurationDays.min, 7);

  const cr = await json(`${S.base}/v1/${NET}/agents/${AGENT}/credit`);
  assert.equal(cr.status, 200);
  assert.equal(cr.body.registered, true);
  assert.equal(cr.body.agentId, 1);
  assert.ok(cr.body.reputation.score >= 0 && cr.body.reputation.score <= 1000);
  assert.match(cr.body.credit.creditLimitUsdc, /^\d+(\.\d+)?$/);
  assert.match(cr.body.wallet.usdcAllowanceToMarketplace, /^\d+(\.\d+)?$/);

  const unreg = await json(`${S.base}/v1/${NET}/agents/${ethers.Wallet.createRandom().address}/credit`);
  assert.equal(unreg.body.registered, false);
  assert.equal((await json(`${S.base}/v1/${NET}/agents/0x1234/credit`)).status, 400);

  const pools = await json(`${S.base}/v1/${NET}/pools?limit=3&minAvailableUsdc=1`);
  assert.equal(pools.status, 200);
  assert.ok(pools.body.pools.length >= 1 && pools.body.pools.length <= 3);
  const p0 = pools.body.pools[0];
  const pd = await json(`${S.base}/v1/${NET}/pools/${p0.agentId}`);
  assert.equal(pd.status, 200);
  assert.equal(pd.body.agentAddress, p0.agentAddress);
  assert.equal(typeof pd.body.borrower.reputationScore, 'number');
  assert.equal((await json(`${S.base}/v1/${NET}/pools/999999`)).status, 400);

  const loan = await json(`${S.base}/v1/${NET}/loans/1`);
  assert.equal(loan.status, 200);
  assert.ok(['REQUESTED', 'ACTIVE', 'REPAID', 'DEFAULTED'].includes(loan.body.state));
  assert.equal((await json(`${S.base}/v1/${NET}/loans/99999999`)).status, 400);

  const al = await json(`${S.base}/v1/${NET}/agents/${AGENT}/loans?limit=2`);
  assert.equal(al.status, 200);
  assert.ok(al.body.totalLoans >= 1);
  assert.ok(al.body.loans.length <= 2);

  const pos = await json(`${S.base}/v1/${NET}/agents/${AGENT}/positions`);
  assert.equal(pos.status, 200);
  assert.ok(Array.isArray(pos.body.positions));

  const tx = await json(`${S.base}/v1/${NET}/tx/0x${'00'.repeat(32)}`);
  assert.equal(tx.status, 200);
  assert.equal(tx.body.found, false);
  assert.equal((await json(`${S.base}/v1/${NET}/tx/0x1234`)).status, 400);
});

test('PREPARE + SIMULATE: request_loan (no broadcast)', async () => {
  const r = await post(`${S.base}/v1/${NET}/tx/prepare/request_loan`, { from: AGENT, amount: 5, durationDays: 7, simulate: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const tx = r.body;
  assert.equal(tx.chainId, 5042002);
  assert.equal(tx.to, '0xDbDf60AE5CB46D23aA44c062a4943655a6820f31');
  assert.equal(tx.value, '0');
  assert.equal(tx.from, AGENT);
  assert.match(tx.gasEstimate, /^\d+$/);
  assert.ok(tx.humanReadableSummary.includes('5.0 USDC'));
  assert.ok(Array.isArray(tx.warnings));
  assert.equal(tx.call.function, 'requestLoan');
  assert.equal(tx.call.args.durationDays, '7');
  assert.ok(tx.simulation, 'simulation present');
  assert.equal(typeof tx.simulation.ok, 'boolean');
  if (!tx.simulation.ok) {
    assert.ok(tx.simulation.revertReason);
    assert.ok(tx.simulation.plainLanguage.length > 10);
  }
  // 100%-collateral tier on staging => exact approve prerequisite when allowance is short
  if (tx.call.args.collateralRequired !== '0' && tx.prerequisite) {
    assert.equal(tx.prerequisite.action, 'approve_usdc');
    assert.equal(tx.prerequisite.to, '0x9F3C10985998D1354D1465c5135Aa924775bd11D');
    assert.equal(tx.prerequisite.call.args.amount, tx.call.args.collateralRequired);
    assert.notEqual(tx.prerequisite.call.args.amount, ethers.MaxUint256.toString());
  }
  // validation errors
  assert.equal((await post(`${S.base}/v1/${NET}/tx/prepare/request_loan`, { from: AGENT, amount: 5, durationDays: 3 })).status, 400);
  assert.equal((await post(`${S.base}/v1/${NET}/tx/prepare/request_loan`, { amount: 5, durationDays: 7 })).status, 400);
  assert.equal((await post(`${S.base}/v1/${NET}/tx/prepare/request_loan`, { from: AGENT, amount: 60000, durationDays: 7 })).status, 400);
  assert.equal((await post(`${S.base}/v1/${NET}/tx/prepare/nuke`, { from: AGENT })).status, 400);
});

test('PREPARE + SIMULATE: supply_liquidity and simulate endpoint (no broadcast)', async () => {
  const r = await post(`${S.base}/v1/${NET}/tx/prepare/supply_liquidity`, { from: AGENT, agentId: 3, amount: '2.5', simulate: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const tx = r.body;
  assert.equal(tx.call.function, 'supplyLiquidity');
  assert.equal(tx.call.args.amount, '2500000');
  assert.ok(tx.simulation);
  const sim = await post(`${S.base}/v1/${NET}/tx/simulate`, { from: AGENT, to: tx.to, data: tx.data });
  assert.equal(sim.status, 200);
  assert.equal(sim.body.ok, tx.simulation.ok);
  const bad = await post(`${S.base}/v1/${NET}/tx/simulate`, { from: AGENT, to: ethers.Wallet.createRandom().address, data: tx.data });
  assert.equal(bad.status, 400);

  // remaining prepare actions at least encode + pre-check without error
  for (const [action, body] of [
    ['register_agent', {}],
    ['create_pool', {}],
    ['approve_usdc', { amount: 1 }],
    ['withdraw_liquidity', { agentId: 1, amount: 1 }],
    ['repay_loan', { loanId: 1 }],
    ['claim_interest', { agentId: 1 }],
  ]) {
    const rr = await post(`${S.base}/v1/${NET}/tx/prepare/${action}`, { from: AGENT, ...body });
    assert.equal(rr.status, 200, `${action}: ${JSON.stringify(rr.body)}`);
    assert.equal(rr.body.value, '0');
    assert.equal(rr.body.simulation, null);
  }
});

test('BROADCAST validator via REST rejects bad input without touching the chain', async () => {
  const w = ethers.Wallet.createRandom();
  const raw = await w.signTransaction({ chainId: 5042002, nonce: 0, gasLimit: 100000n, gasPrice: 1n, to: w.address, data: '0xaa452fa6' + '00'.repeat(64), value: 0n, type: 0 });
  const r = await post(`${S.base}/v1/${NET}/tx/broadcast`, { signedTransaction: raw });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /not a Specular contract/);
  assert.equal((await post(`${S.base}/v1/${NET}/tx/broadcast`, { signedTransaction: 'junk' })).status, 400);
  assert.equal((await post(`${S.base}/v1/${NET}/tx/broadcast`, {})).status, 400);
});

test('MCP Streamable HTTP: initialize, tools/list, tools/call', async () => {
  const hdr = { accept: 'application/json, text/event-stream' };
  const init = await post(`${S.base}/mcp`, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } }, hdr);
  assert.equal(init.status, 200);
  assert.equal(init.body.result.serverInfo.name, 'specular');
  assert.match(init.body.result.instructions, /NON-CUSTODIAL/);

  const list = await post(`${S.base}/mcp`, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, hdr);
  const names = list.body.result.tools.map((t) => t.name);
  for (const n of ['check_credit_score', 'prepare_request_loan', 'prepare_supply_liquidity', 'broadcast_signed_transaction', 'simulate_transaction', 'get_transaction']) assert.ok(names.includes(n), n);
  assert.ok(!names.includes('local_sign_and_broadcast'), 'remote server never exposes a signer');
  const credit = list.body.result.tools.find((t) => t.name === 'check_credit_score');
  assert.deepEqual(credit.inputSchema.required, ['network', 'address']);
  assert.equal(credit.annotations.readOnlyHint, true);

  const call = await post(`${S.base}/mcp`, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'check_credit_score', arguments: { network: NET, address: AGENT } } }, hdr);
  assert.equal(call.status, 200);
  assert.equal(call.body.result.isError, undefined);
  assert.equal(call.body.result.structuredContent.agentId, 1);
  assert.equal(JSON.parse(call.body.result.content[0].text).registered, true);

  const prep = await post(`${S.base}/mcp`, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'prepare_request_loan', arguments: { network: NET, from: AGENT, amount: 1, durationDays: 7, simulate: true } } }, hdr);
  assert.equal(prep.body.result.structuredContent.call.function, 'requestLoan');
  assert.ok(prep.body.result.structuredContent.simulation);

  const noNet = await post(`${S.base}/mcp`, { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'get_loan_status', arguments: { loanId: 1 } } }, hdr);
  assert.equal(noNet.body.result.isError, true);
  assert.match(noNet.body.result.content[0].text, /network.{1,4} is required/);

  const get = await fetch(`${S.base}/mcp`);
  assert.equal(get.status, 405);
});

test('auth + rate limit when configured', async () => {
  const A = await boot({ SPECULAR_MCP_TOKEN: TOKEN, SPECULAR_RATE_LIMIT_PER_MIN: '3' });
  assert.equal((await json(`${A.base}/health`)).status, 200, 'health stays open');
  assert.equal((await json(`${A.base}/v1/networks`)).status, 401);
  assert.equal((await json(`${A.base}/v1/networks`, { headers: { authorization: 'Bearer wrong' } })).status, 401);
  assert.equal((await post(`${A.base}/mcp`, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { accept: 'application/json, text/event-stream' })).status, 401);
  const auth = { authorization: `Bearer ${TOKEN}` };
  assert.equal((await json(`${A.base}/v1/networks`, { headers: auth })).status, 200);
  assert.equal((await json(`${A.base}/v1/networks`, { headers: auth })).status, 200);
  assert.equal((await json(`${A.base}/v1/networks`, { headers: auth })).status, 200);
  const limited = await json(`${A.base}/v1/networks`, { headers: auth });
  assert.equal(limited.status, 429);
  assert.ok(limited.headers.get('retry-after'));
  assert.doesNotMatch(A.logs(), new RegExp(TOKEN), 'token never logged');
});

test('request hygiene: body limit, malformed JSON, unknown route', async () => {
  const big = await fetch(`${S.base}/v1/${NET}/tx/simulate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ from: AGENT, to: AGENT, data: '0x' + 'ab'.repeat(200_000) }) });
  assert.equal(big.status, 413);
  const bad = await fetch(`${S.base}/v1/${NET}/tx/simulate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json' });
  assert.equal(bad.status, 400);
  assert.equal((await json(`${S.base}/nope`)).status, 404);
});
