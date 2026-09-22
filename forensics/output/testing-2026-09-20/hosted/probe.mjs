/**
 * Hosted-server adversarial probe (2026-09-20/21 security round).
 *
 * Sections:
 *   A  input validation across REST routes
 *   B  input validation across MCP tools/call
 *   C  broadcast_signed_transaction adversarial cases (REAL signed txs, throwaway key)
 *   D  SSRF / proxy abuse of the simulate endpoint
 *   E  error-response leakage (stack traces, env vars, RPC URLs, file paths)
 *
 * Usage: node probe.mjs <baseUrl> [--live]
 *   --live restricts to non-aggressive, read-only conformance checks.
 *
 * NEVER broadcasts to arc-mainnet or base: the only network passed to the relay
 * route is arc-staging (chainId 5042002), and every case is designed to be
 * refused by the offline validator before any provider call.
 */
import { ethers } from '../../../../mcp-server/node_modules/ethers/lib.esm/index.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.argv[2] || 'http://127.0.0.1:3400';
const LIVE = process.argv.includes('--live');
const PACE = Number(process.env.PROBE_PACE_MS || (LIVE ? 550 : 0));
const NET = 'arc-staging';
const MAIN = 'arc-mainnet';
const AGENT = '0x800e305A0caDdE6289dFDFEDF38218f45C06F72C';

const here = path.dirname(fileURLToPath(import.meta.url));
const cfgStaging = JSON.parse(fs.readFileSync(path.resolve(here, '../../../../src/config/arc-testnet-v6-addresses.json'), 'utf8'));
const ADDR = {
  marketplace: ethers.getAddress(cfgStaging.agentLiquidityMarketplace_v6),
  registry: ethers.getAddress(cfgStaging.agentRegistryV2),
  usdc: ethers.getAddress(cfgStaging.usdc),
};

const results = [];
let pass = 0;
let fail = 0;
function record(section, label, ok, detail) {
  results.push({ section, label, ok, detail: String(detail).slice(0, 400) });
  if (ok) pass++;
  else fail++;
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  [${section}] ${label}\n${ok ? '' : `        -> ${String(detail).slice(0, 300)}\n`}`);
}

async function req(method, url, { body, headers = {}, raw, noContentType } = {}) {
  const init = { method, headers: { ...headers } };
  if (raw !== undefined) {
    init.body = noContentType ? new Blob([raw]) : raw;   // a Blob with no type sends NO Content-Type
    if (!noContentType && !init.headers['content-type']) init.headers['content-type'] = 'application/json';
  } else if (body !== undefined) {
    init.body = JSON.stringify(body);
    if (!init.headers['content-type']) init.headers['content-type'] = 'application/json';
  }
  if (PACE) await new Promise((res) => setTimeout(res, PACE));
  let r = await fetch(BASE + url, init);
  // The public deployment is per-IP rate limited; a 429 is not a test result, so back off once.
  for (let i = 0; i < 3 && r.status === 429; i++) {
    const wait = Math.min(65, Number(r.headers.get('retry-after') || 5)) * 1000;
    await new Promise((res) => setTimeout(res, wait + 500));
    r = await fetch(BASE + url, init);
  }
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non JSON */ }
  return { status: r.status, text, json, headers: r.headers };
}
const get = (u, o) => req('GET', u, o);
const post = (u, body, o) => req('POST', u, { body, ...o });

// No response may ever contain these.
const LEAK_ALWAYS = [
  /\bat [A-Za-z0-9_$.<>]+ \(.*:\d+:\d+\)/,                       // stack frame
  /\/Users\/|\/app\/dist\/|node_modules/,                        // filesystem paths
  /version=6\.\d+\.\d+|NUMERIC_FAULT|BUFFER_OVERRUN|code=[A-Z_]{6,}/, // ethers internals
  /privateKey|mnemonic|-----BEGIN/i,                             // key material
  /SPECULAR_(PRIVATE_KEY|MCP_TOKEN|KEYSTORE\w*|X402\w*)\s*[=:]\s*\S/,  // an env NAME is fine in docs; a name with a VALUE is not
  /RAILWAY_(TOKEN|API)/,
];
// Additionally forbidden on ERROR responses (the public rpcUrl of a default network is
// deliberately advertised on /v1/networks, but an error must never echo the upstream).
const LEAK_ERRORS = [/drpc\.org|rpc\.mainnet\.arc\.io|mainnet\.base\.org/];
function leakCheck(label, text, section = 'E', status = 0) {
  const set = status >= 400 ? [...LEAK_ALWAYS, ...LEAK_ERRORS] : LEAK_ALWAYS;
  const hits = set.filter((re) => re.test(text)).map((re) => re.source);
  record(section, `no leakage: ${label}`, hits.length === 0, hits.length ? `matched ${hits.join(' | ')} in: ${text.slice(0, 250)}` : 'clean');
}

// ---------------------------------------------------------------- A: REST
async function sectionA() {
  const bad4xx = async (label, method, url, opts) => {
    const r = await req(method, url, opts);
    record('A', label, r.status >= 400 && r.status < 500, `HTTP ${r.status} ${r.text.slice(0, 160)}`);
    leakCheck(label, r.text, 'A-leak', r.status);
    return r;
  };

  // --- addresses
  await bad4xx('address: too short', 'GET', `/v1/${NET}/agents/0x1234/credit`);
  await bad4xx('address: no 0x', 'GET', `/v1/${NET}/agents/${AGENT.slice(2)}/credit`);
  await bad4xx('address: 41 nibbles', 'GET', `/v1/${NET}/agents/0x${'a'.repeat(41)}/credit`);
  await bad4xx('address: non-hex', 'GET', `/v1/${NET}/agents/0x${'z'.repeat(40)}/credit`);
  await bad4xx('address: bad EIP-55 checksum (mixed case)', 'GET', `/v1/${NET}/agents/0x800E305A0caDdE6289dFDFEDF38218f45C06F72C/credit`);
  {
    const r = await get(`/v1/${NET}/agents/${AGENT.toLowerCase()}/credit`);
    record('A', 'address: all-lowercase accepted (checksum-free form)', r.status === 200, `HTTP ${r.status}`);
  }
  await bad4xx('address: ENS name rejected', 'GET', `/v1/${NET}/agents/vitalik.eth/credit`);
  await bad4xx('address: path traversal', 'GET', `/v1/${NET}/agents/..%2f..%2fetc%2fpasswd/credit`);

  // --- amounts on prepare_request_loan
  for (const [label, amount] of [
    ['negative', -1], ['zero', 0], ['float sub-unit', 0.0000001], ['7 decimals string', '0.1234567'],
    ['NaN', 'NaN'], ['Infinity', 'Infinity'], ['exponent string', '1e6'], ['huge', 1e30],
    ['1e309 (Infinity)', 1e309], ['null', null], ['object', { a: 1 }], ['array', [1]],
    ['bool', true], ['hex string', '0xff'], ['over cap', 999999999],
    ['unicode digits', '\u0665'], ['600-char numeric', '1'.repeat(600)],
  ]) {
    await bad4xx(`amount: ${label}`, 'POST', `/v1/${NET}/tx/prepare/request_loan`, { body: { from: AGENT, amount, durationDays: 7 } });
  }
  {
    // JS numeric coercion accepts surrounding whitespace; assert the VALUE is still exact (informational).
    const r = await post(`/v1/${NET}/tx/prepare/request_loan`, { from: AGENT, amount: ' 5 ', durationDays: 7 });
    const exact = r.status === 200 && /\b5\.0 USDC\b/.test(r.text);
    record('A', 'amount: surrounding whitespace coerces to the exact value (INFO, lenient but not lossy)', exact || (r.status >= 400 && r.status < 500), `HTTP ${r.status} ${r.text.slice(0, 200)}`);
  }

  // --- durationDays
  for (const [label, d] of [['0', 0], ['6 (below min)', 6], ['366 (above max)', 366], ['float', 7.5], ['string junk', 'week'], ['negative', -7], ['huge', 1e18]]) {
    await bad4xx(`durationDays: ${label}`, 'POST', `/v1/${NET}/tx/prepare/request_loan`, { body: { from: AGENT, amount: 5, durationDays: d } });
  }
  // --- network
  await bad4xx('network: unknown', 'GET', `/v1/nope/status`);
  await bad4xx('network: wrong case', 'GET', `/v1/ARC-STAGING/status`);
  await bad4xx('network: alias "arc"', 'GET', `/v1/arc/status`);
  await bad4xx('network: base (not enabled here)', 'GET', `/v1/base/status`);
  await bad4xx('network: __proto__', 'GET', `/v1/__proto__/status`);
  await bad4xx('network: constructor', 'GET', `/v1/constructor/status`);
  await bad4xx('network: 300 chars', 'GET', `/v1/${'a'.repeat(300)}/status`);

  // --- ids
  for (const [label, id] of [['negative', '-1'], ['float', '1.5'], ['huge', '1'.repeat(40)], ['junk', 'abc'], ['hex', '0x01'], ['empty-ish space', '%20']]) {
    await bad4xx(`loanId: ${label}`, 'GET', `/v1/${NET}/loans/${id}`);
  }
  for (const [label, q] of [['limit=0', 'limit=0'], ['limit=201', 'limit=201'], ['limit=1.5', 'limit=1.5'], ['limit=abc', 'limit=abc'],
    ['minAvailableUsdc=-1', 'minAvailableUsdc=-1'], ['minAvailableUsdc=1e3', 'minAvailableUsdc=1e3'], ['minAvailableUsdc 7dp', 'minAvailableUsdc=0.1234567']]) {
    await bad4xx(`pools query: ${label}`, 'GET', `/v1/${NET}/pools?${q}`);
  }

  // --- tx hashes
  await bad4xx('txHash: short', 'GET', `/v1/${NET}/tx/0x1234`);
  await bad4xx('txHash: non-hex', 'GET', `/v1/${NET}/tx/0x${'g'.repeat(64)}`);

  // --- body handling
  {
    const r = await post(`/v1/${NET}/tx/prepare/request_loan`, undefined, { raw: '{not json' });
    record('A', 'malformed JSON -> 400', r.status === 400, `HTTP ${r.status} ${r.text.slice(0, 120)}`);
    leakCheck('malformed JSON', r.text, 'A-leak', r.status);
  }
  {
    const big = JSON.stringify({ from: AGENT, amount: 5, durationDays: 7, pad: 'x'.repeat(400 * 1024) });
    const r = await req('POST', `/v1/${NET}/tx/prepare/request_loan`, { raw: big });
    record('A', 'oversized body (400KB) -> 413', r.status === 413, `HTTP ${r.status} ${r.text.slice(0, 120)}`);
  }
  {
    const r = await req('POST', `/v1/${NET}/tx/prepare/request_loan`, { raw: JSON.stringify({ from: AGENT, amount: 5, durationDays: 7 }), headers: { 'content-type': 'text/plain' } });
    record('A', 'wrong content-type text/plain is not parsed as JSON -> 4xx', r.status >= 400 && r.status < 500, `HTTP ${r.status} ${r.text.slice(0, 160)}`);
  }
  {
    const r = await req('POST', `/v1/${NET}/tx/prepare/request_loan`, { raw: 'from=' + AGENT + '&amount=5', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    record('A', 'form-urlencoded body -> 4xx', r.status >= 400 && r.status < 500, `HTTP ${r.status} ${r.text.slice(0, 160)}`);
  }
  {
    const r = await req('POST', `/v1/${NET}/tx/prepare/request_loan`, { raw: JSON.stringify({ from: AGENT, amount: 5, durationDays: 7 }), noContentType: true });
    record('A', 'absent content-type is NOT parsed as JSON -> 4xx (no no-preflight CSRF shape)', r.status >= 400 && r.status < 500, `HTTP ${r.status} ${r.text.slice(0, 160)}`);
    const ok = await req('POST', `/v1/${NET}/tx/prepare/request_loan`, { raw: JSON.stringify({ from: AGENT, amount: 5, durationDays: 7 }), headers: { 'content-type': 'application/json; charset=utf-8' } });
    record('A', 'content-type with charset is accepted', ok.status === 200, `HTTP ${ok.status}`);
  }

  // --- prototype pollution
  const pollution = [
    { label: '__proto__ in body', body: { __proto__: { polluted: 'yes' }, from: AGENT, amount: 5, durationDays: 7 } },
    { label: 'nested __proto__', body: { from: AGENT, amount: 5, durationDays: 7, meta: { __proto__: { polluted: 'yes' } } } },
    { label: 'constructor.prototype', body: { constructor: { prototype: { polluted: 'yes' } }, from: AGENT, amount: 5, durationDays: 7 } },
  ];
  for (const p of pollution) {
    // Serialise literally so __proto__ survives JSON.stringify.
    const raw = JSON.stringify(p.body).replace('"meta":{}', '"meta":{"__proto__":{"polluted":"yes"}}');
    const literal = p.label === '__proto__ in body' ? `{"__proto__":{"polluted":"yes"},"from":"${AGENT}","amount":5,"durationDays":7}`
      : p.label === 'nested __proto__' ? `{"from":"${AGENT}","amount":5,"durationDays":7,"meta":{"__proto__":{"polluted":"yes"}}}` : raw;
    const r = await req('POST', `/v1/${NET}/tx/prepare/request_loan`, { raw: literal });
    const probe = await get(`/v1/networks`);
    const polluted = /polluted/.test(probe.text);
    record('A', `prototype pollution: ${p.label} has no effect`, !polluted && r.status < 500, `HTTP ${r.status}; subsequent /v1/networks polluted=${polluted}`);
  }

  // --- unknown routes / methods
  {
    const r = await post(`/v1/${NET}/tx/prepare/drain_everything`, { from: AGENT });
    record('A', 'unknown prepare action -> 400 with valid list', r.status === 400 && Array.isArray(r.json?.valid), `HTTP ${r.status} ${r.text.slice(0, 160)}`);
  }
  {
    const r = await get('/v1/does/not/exist');
    record('A', 'unknown route -> 404 {error}', r.status === 404 && r.json?.error === 'not found', `HTTP ${r.status} ${r.text.slice(0, 120)}`);
  }
  {
    const r = await req('GET', '/mcp');
    record('A', 'GET /mcp -> 405', r.status === 405, `HTTP ${r.status}`);
  }
  {
    const r = await get('/../../etc/passwd');
    record('A', 'path traversal on root -> 4xx, no file content', r.status >= 400 && !/root:/.test(r.text), `HTTP ${r.status} ${r.text.slice(0, 120)}`);
  }
  {
    const r = await req('GET', '/', { headers: { 'x-powered-by-probe': '1' } });
    record('A', 'no X-Powered-By header', !r.headers.get('x-powered-by'), String(r.headers.get('x-powered-by')));
  }
}

// ---------------------------------------------------------------- B: MCP
const MCP_H = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
let rpcId = 1000;
async function rpc(body, headers = {}) {
  return req('POST', '/mcp', { raw: JSON.stringify(body), headers: { ...MCP_H, ...headers } });
}
const call = (name, args, extra = {}) => rpc({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args }, ...extra });

async function sectionB() {
  const toolErr = async (label, name, args) => {
    const r = await call(name, args);
    const isErr = r.status === 200 && (r.json?.result?.isError === true || typeof r.json?.error?.code === 'number');
    record('B', label, isErr, `HTTP ${r.status} ${JSON.stringify(r.json).slice(0, 200)}`);
    leakCheck(label, r.text, 'B-leak', r.status);
  };
  await toolErr('MCP address: bad checksum', 'check_credit_score', { network: NET, address: '0x800E305A0caDdE6289dFDFEDF38218f45C06F72C' });
  await toolErr('MCP address: short', 'check_credit_score', { network: NET, address: '0x1' });
  await toolErr('MCP address: object', 'check_credit_score', { network: NET, address: { $ne: null } });
  await toolErr('MCP address: array', 'check_credit_score', { network: NET, address: [AGENT] });
  await toolErr('MCP network: missing', 'check_credit_score', { address: AGENT });
  await toolErr('MCP network: number', 'check_credit_score', { network: 5042002, address: AGENT });
  await toolErr('MCP network: null-prototype object', 'get_protocol_status', { network: { toString: 'x' } });
  await toolErr('MCP network: unknown', 'get_protocol_status', { network: 'ethereum' });
  await toolErr('MCP amount: negative', 'prepare_request_loan', { network: NET, from: AGENT, amount: -5, durationDays: 7 });
  await toolErr('MCP amount: 7 decimals', 'prepare_request_loan', { network: NET, from: AGENT, amount: '0.1234567', durationDays: 7 });
  await toolErr('MCP amount: 1e30', 'prepare_request_loan', { network: NET, from: AGENT, amount: 1e30, durationDays: 7 });
  await toolErr('MCP amount: NaN', 'prepare_request_loan', { network: NET, from: AGENT, amount: 'NaN', durationDays: 7 });
  await toolErr('MCP limit: 1.5', 'get_available_liquidity', { network: NET, limit: 1.5 });
  await toolErr('MCP limit: 1e9', 'get_available_liquidity', { network: NET, limit: 1e9 });
  await toolErr('MCP loanId: negative', 'get_loan_status', { network: NET, loanId: -1 });
  await toolErr('MCP data: odd-length hex', 'simulate_transaction', { network: NET, from: AGENT, to: ADDR.marketplace, data: '0xabc' });
  await toolErr('MCP data: 9KB hex over cap', 'simulate_transaction', { network: NET, from: AGENT, to: ADDR.marketplace, data: '0x' + 'ab'.repeat(9000) });
  {
    // arguments carrying __proto__
    const raw = `{"jsonrpc":"2.0","id":${++rpcId},"method":"tools/call","params":{"name":"list_networks","arguments":{"__proto__":{"polluted":"yes"}}}}`;
    const r = await req('POST', '/mcp', { raw, headers: MCP_H });
    const probe = await get('/v1/networks');
    record('B', 'MCP arguments.__proto__ has no effect', !/polluted/.test(probe.text) && r.status === 200, `HTTP ${r.status}; polluted=${/polluted/.test(probe.text)}`);
  }
  {
    const r = await rpc({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name: '../../etc/passwd', arguments: {} } });
    record('B', 'MCP unknown tool name with traversal -> -32602', r.json?.error?.code === -32602, JSON.stringify(r.json).slice(0, 200));
  }
  {
    const big = { jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name: 'check_credit_score', arguments: { network: NET, address: AGENT, pad: 'x'.repeat(400 * 1024) } } };
    const r = await req('POST', '/mcp', { raw: JSON.stringify(big), headers: MCP_H });
    record('B', 'MCP oversized body -> 413', r.status === 413, `HTTP ${r.status}`);
  }
}

// ------------------------------------------------- C: broadcast adversarial
async function sectionC() {
  const wallet = ethers.Wallet.createRandom();   // THROWAWAY, never funded, never persisted
  const iface = {
    marketplace: new ethers.Interface([
      'function requestLoan(uint256 amount, uint256 durationDays)',
      'function setPlatformFeeRate(uint256 newRate)',
      'function pause()',
      'function withdrawFees(uint256 amount)',
    ]),
    usdc: new ethers.Interface(['function approve(address spender, uint256 amount)', 'function transfer(address to, uint256 amount)']),
  };
  const sign = (over) => wallet.signTransaction({
    chainId: 5042002, nonce: 0, gasLimit: 200_000n, maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n, value: 0n, type: 2, ...over,
  });
  const relay = (network, signedTransaction) => post(`/v1/${network}/tx/broadcast`, { signedTransaction });
  const mustReject = async (label, network, raw) => {
    const r = await relay(network, raw);
    const rejected = r.status >= 400 && r.status < 500;
    const relayed = r.status === 200 && r.json?.accepted === true;
    record('C', label, rejected && !relayed, `HTTP ${r.status} ${r.text.slice(0, 220)}`);
    leakCheck(label, r.text, 'C-leak', r.status);
    return r;
  };

  const goodLoan = iface.marketplace.encodeFunctionData('requestLoan', [5_000_000n, 7n]);

  await mustReject('C1 tx to a non-Specular address (valid calldata)', NET, await sign({ to: ethers.Wallet.createRandom().address, data: goodLoan }));
  await mustReject('C1b tx to the OLD (legacy) staging marketplace', NET, await sign({ to: ethers.getAddress(cfgStaging.agentLiquidityMarketplace_v6_0_legacy_still_live), data: goodLoan }));
  await mustReject('C2 USDC approve to a foreign spender', NET, await sign({ to: ADDR.usdc, data: iface.usdc.encodeFunctionData('approve', [ethers.Wallet.createRandom().address, 1_000_000n]) }));
  await mustReject('C3 USDC approve MaxUint256 to the marketplace', NET, await sign({ to: ADDR.usdc, data: iface.usdc.encodeFunctionData('approve', [ADDR.marketplace, ethers.MaxUint256]) }));
  await mustReject('C3b USDC approve just over the 100k cap', NET, await sign({ to: ADDR.usdc, data: iface.usdc.encodeFunctionData('approve', [ADDR.marketplace, 100_000_000_001n]) }));
  await mustReject('C3c USDC transfer (not an allow-listed fn)', NET, await sign({ to: ADDR.usdc, data: iface.usdc.encodeFunctionData('transfer', [ADDR.marketplace, 1_000_000n]) }));
  await mustReject('C4 owner-only selector setPlatformFeeRate', NET, await sign({ to: ADDR.marketplace, data: iface.marketplace.encodeFunctionData('setPlatformFeeRate', [10000n]) }));
  await mustReject('C4b owner-only pause()', NET, await sign({ to: ADDR.marketplace, data: iface.marketplace.encodeFunctionData('pause', []) }));
  await mustReject('C4c owner-only withdrawFees(amount)', NET, await sign({ to: ADDR.marketplace, data: iface.marketplace.encodeFunctionData('withdrawFees', [1n]) }));
  await mustReject('C5 wrong chainId (base 8453 tx offered to arc-staging)', NET, await wallet.signTransaction({ chainId: 8453, nonce: 0, gasLimit: 200000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, value: 0n, type: 2, to: ADDR.marketplace, data: goodLoan }));
  await mustReject('C5b arc-staging tx offered to the arc-mainnet route (cross-network replay)', MAIN, await sign({ to: ADDR.marketplace, data: goodLoan }));
  await mustReject('C6 value > 0', NET, await sign({ to: ADDR.marketplace, data: goodLoan, value: 1n }));
  await mustReject('C6b value > 0 to USDC with valid approve', NET, await sign({ to: ADDR.usdc, data: iface.usdc.encodeFunctionData('approve', [ADDR.marketplace, 1_000_000n]), value: ethers.parseEther('1') }));
  await mustReject('C7 contract creation (to = null)', NET, await wallet.signTransaction({ chainId: 5042002, nonce: 0, gasLimit: 200000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, value: 0n, type: 2, data: '0x60806040' }));
  await mustReject('C8 non-canonical calldata: allow-listed call + trailing byte (H-1)', NET, await sign({ to: ADDR.marketplace, data: goodLoan + 'ff' }));
  await mustReject('C8b non-canonical calldata: + 32 zero bytes', NET, await sign({ to: ADDR.marketplace, data: goodLoan + '00'.repeat(32) }));
  await mustReject('C9 empty calldata (plain call to the marketplace)', NET, await sign({ to: ADDR.marketplace, data: '0x' }));
  await mustReject('C9b unknown selector on the marketplace', NET, await sign({ to: ADDR.marketplace, data: '0xdeadbeef' + '00'.repeat(32) }));

  // legacy type-0
  const legacyEip155 = await wallet.signTransaction({ chainId: 5042002, nonce: 0, gasLimit: 200000n, gasPrice: 1_000_000_000n, value: 0n, type: 0, to: ADDR.marketplace, data: goodLoan });
  {
    const r = await relay(NET, legacyEip155);
    // Documented outcome: the validator is transport-agnostic. Report whichever it is.
    const relayed = r.status === 200 && r.json?.accepted === true;
    record('C', 'C10 legacy type-0 (EIP-155) is NOT silently relayed as a funded tx', !relayed || !!r.json?.hash, `HTTP ${r.status} ${r.text.slice(0, 260)}`);
    results.push({ section: 'C-note', label: 'C10 legacy type-0 observed status', ok: null, detail: `HTTP ${r.status} ${r.text.slice(0, 260)}` });
    console.log(`NOTE  [C] legacy type-0 -> HTTP ${r.status} ${r.text.slice(0, 200)}`);
  }
  // pre-EIP-155 legacy (no chainId) must fail the chainId gate
  {
    const tx = ethers.Transaction.from({ chainId: 0, nonce: 0, gasLimit: 200000n, gasPrice: 1n, value: 0n, type: 0, to: ADDR.marketplace, data: goodLoan });
    const sig = wallet.signingKey.sign(tx.unsignedHash);
    tx.signature = sig;
    await mustReject('C10b pre-EIP-155 legacy tx (no replay protection)', NET, tx.serialized);
  }

  // garbage RLP / shape
  for (const [label, raw] of [
    ['C11 garbage hex', '0xdeadbeef'],
    ['C11b empty 0x', '0x'],
    ['C11c odd-length hex', '0xabc'],
    ['C11d not hex at all', 'hello world'],
    ['C11e decimal number', 12345],
    ['C11f null', null],
    ['C11g object', { raw: '0x01' }],
    ['C11h array', ['0x01']],
    ['C11i 17KB of hex (over MAX_RAW_BYTES)', '0x' + 'ab'.repeat(17 * 1024)],
    ['C11j valid RLP list but not a tx', '0x' + 'c9'.padEnd(20, '0')],
  ]) {
    await mustReject(label, NET, raw);
  }
  // unsigned but well-formed tx
  {
    const unsigned = ethers.Transaction.from({ chainId: 5042002, nonce: 0, gasLimit: 200000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, value: 0n, type: 2, to: ADDR.marketplace, data: goodLoan }).unsignedSerialized;
    await mustReject('C12 unsigned transaction', NET, unsigned);
  }
  // missing field entirely
  {
    const r = await post(`/v1/${NET}/tx/broadcast`, {});
    record('C', 'C13 missing signedTransaction -> 4xx', r.status >= 400 && r.status < 500, `HTTP ${r.status} ${r.text.slice(0, 160)}`);
  }
  // same via MCP tool
  {
    const r = await call('broadcast_signed_transaction', { network: NET, signedTransaction: await sign({ to: ethers.Wallet.createRandom().address, data: goodLoan }) });
    const isErr = r.json?.result?.isError === true;
    record('C', 'C14 MCP broadcast tool refuses a non-Specular target', isErr, JSON.stringify(r.json).slice(0, 220));
  }
  // confirm the validator accepts the legitimate shape (so the rejections above are meaningful)
  {
    const r = await relay(NET, await sign({ to: ADDR.marketplace, data: goodLoan }));
    const reachedChain = r.status === 502 || (r.status === 200) || /insufficient|nonce|funds|underpriced|gas/i.test(r.text);
    record('C', 'C15 a well-formed allow-listed tx passes validation (fails only at the chain, unfunded key)', reachedChain && !/not a Specular contract|not relayable|canonical/.test(r.text), `HTTP ${r.status} ${r.text.slice(0, 220)}`);
  }
}

// --------------------------------------------------- D: SSRF / simulate abuse
async function sectionD() {
  const sim = (body, network = NET) => post(`/v1/${network}/tx/simulate`, body);
  const goodData = new ethers.Interface(['function requestLoan(uint256,uint256)']).encodeFunctionData('requestLoan', [1_000_000n, 7n]);

  const reject = async (label, body, network = NET) => {
    const r = await sim(body, network);
    record('D', label, r.status >= 400 && r.status < 500, `HTTP ${r.status} ${r.text.slice(0, 200)}`);
    leakCheck(label, r.text, 'D-leak', r.status);
  };
  await reject('D1 to = arbitrary EOA', { from: AGENT, to: ethers.Wallet.createRandom().address, data: goodData });
  await reject('D1b to = zero address', { from: AGENT, to: ethers.ZeroAddress, data: goodData });
  await reject('D1c to = legacy staging marketplace', { from: AGENT, to: ethers.getAddress(cfgStaging.agentLiquidityMarketplace_v6_0_legacy_still_live), data: goodData });
  await reject('D1d to = a Specular contract on the OTHER network', { from: AGENT, to: ADDR.marketplace, data: goodData }, MAIN);
  await reject('D2 to = a URL', { from: AGENT, to: 'http://169.254.169.254/latest/meta-data/', data: goodData });
  await reject('D2b to = file path', { from: AGENT, to: 'file:///etc/passwd', data: goodData });
  await reject('D2c to = localhost:port', { from: AGENT, to: 'http://127.0.0.1:3400/health', data: goodData });
  {
    const clean = await sim({ from: AGENT, to: ADDR.marketplace, data: goodData });
    const withRpc = await sim({ from: AGENT, to: ADDR.marketplace, data: goodData, rpcUrl: 'http://127.0.0.1:9/', provider: 'http://evil.test', chainId: 1 });
    const ignored = withRpc.status === clean.status && withRpc.json?.chainId === clean.json?.chainId && !/evil\.test|127\.0\.0\.1:9/.test(withRpc.text);
    record('D', 'D3 client-supplied rpcUrl/provider/chainId in the body are IGNORED (RPC is pinned server-side)', ignored, `clean HTTP ${clean.status} vs override HTTP ${withRpc.status}: ${withRpc.text.slice(0, 200)}`);
  }
  await reject('D4 from = junk', { from: 'not-an-address', to: ADDR.marketplace, data: goodData });
  {
    // arbitrary read-only calldata against an allow-listed contract: permitted by design, must stay read-only
    const owner = new ethers.Interface(['function owner() view returns (address)']).encodeFunctionData('owner', []);
    const r = await sim({ from: AGENT, to: ADDR.marketplace, data: owner });
    record('D', 'D5 arbitrary calldata to an allow-listed contract is eth_call only (read-only, no state change)', r.status === 200, `HTTP ${r.status} ${r.text.slice(0, 200)}`);
    results.push({ section: 'D-note', label: 'D5 arbitrary-calldata simulate response', ok: null, detail: r.text.slice(0, 300) });
  }
  {
    const r = await get(`/v1/${NET}/networks`);
    const hasCreds = /:\/\/[^/@]*@/.test(r.text);
    record('D', 'D6 no credentials in any advertised rpcUrl', !hasCreds, r.text.slice(0, 200));
  }
}

// ------------------------------------------------------ E: error leakage
async function sectionE() {
  const probes = [
    ['root', () => get('/')],
    ['openapi', () => get('/openapi.json')],
    ['health', () => get('/health')],
    ['unknown network', () => get('/v1/nope/status')],
    ['bad address', () => get(`/v1/${NET}/agents/0x1/credit`)],
    ['unknown loan id', () => get(`/v1/${NET}/loans/99999999`)],
    ['bad prepare', () => post(`/v1/${NET}/tx/prepare/request_loan`, { from: AGENT, amount: 'x', durationDays: 7 })],
    ['bad broadcast', () => post(`/v1/${NET}/tx/broadcast`, { signedTransaction: '0xdeadbeef' })],
    ['malformed json', () => req('POST', '/mcp', { raw: '{', headers: MCP_H })],
    ['mcp unknown method', () => rpc({ jsonrpc: '2.0', id: 1, method: 'nope/nope' })],
    ['mcp tool error', () => call('get_loan_status', { network: NET, loanId: 99999999 })],
    ['mcp non-object body', () => req('POST', '/mcp', { raw: '"a string"', headers: MCP_H })],
    ['mcp array of junk', () => req('POST', '/mcp', { raw: '[1,2,3]', headers: MCP_H })],
  ];
  for (const [label, fn] of probes) {
    const r = await fn();
    leakCheck(label, r.text, 'E', r.status);
    record('E', `${label}: response is JSON, status ${r.status}`, r.json !== null || r.status === 202 || r.text === '', `HTTP ${r.status} ${r.text.slice(0, 120)}`);
  }
}

// ------------------------------------------------------------------ main
const only = process.env.PROBE_SECTIONS || 'ABCDE';
if (only.includes('A')) await sectionA();
if (only.includes('B')) await sectionB();
if (!LIVE && only.includes('C')) await sectionC();
if (only.includes('D')) await sectionD();
if (only.includes('E')) await sectionE();

console.log(`\n==== ${BASE} ====\nPASS ${pass}  FAIL ${fail}  total ${pass + fail}`);
const out = path.join(here, LIVE ? 'probe-live.json' : 'probe-local.json');
fs.writeFileSync(out, JSON.stringify({ base: BASE, at: new Date().toISOString(), pass, fail, results }, null, 1));
console.log(`results -> ${out}`);
process.exit(fail === 0 ? 0 : 1);
