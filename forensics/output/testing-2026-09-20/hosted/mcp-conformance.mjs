/**
 * MCP Streamable HTTP conformance suite for the Specular hosted server.
 *
 * Half the checks drive the official @modelcontextprotocol/sdk Client over
 * StreamableHTTPClientTransport (so "does a real MCP host work?" is answered by
 * a real MCP host), the other half are raw JSON-RPC probes for the wire-level
 * rules the SDK hides: Accept negotiation, SSE framing, batches, error codes,
 * session semantics and protocol-version negotiation.
 *
 * Usage: node mcp-conformance.mjs <baseUrl>          (read-only; safe against LIVE)
 */
import { Client } from '../../../../mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StreamableHTTPClientTransport } from '../../../../mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.argv[2] || 'http://127.0.0.1:3400';
const NET = process.argv[3] || 'arc-staging';
const AGENT = '0x800e305A0caDdE6289dFDFEDF38218f45C06F72C';
const here = path.dirname(fileURLToPath(import.meta.url));
const PACE = Number(process.env.PROBE_PACE_MS || (BASE.includes('127.0.0.1') ? 0 : 550));

const rows = [];
let pass = 0;
let fail = 0;
function check(area, requirement, ok, observed) {
  rows.push({ area, requirement, ok, observed: String(observed).slice(0, 300) });
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  [${area}] ${requirement}\n        ${String(observed).slice(0, 220)}`);
}

async function raw(body, headers = {}, method = 'POST') {
  const init = { method, headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers } };
  if (body !== undefined && method === 'POST') init.body = typeof body === 'string' ? body : JSON.stringify(body);
  for (const [k, v] of Object.entries(init.headers)) if (v === null) delete init.headers[k];
  if (PACE) await new Promise((res) => setTimeout(res, PACE));
  let r = await fetch(`${BASE}/mcp`, init);
  for (let i = 0; i < 3 && r.status === 429; i++) {
    const wait = Math.min(65, Number(r.headers.get('retry-after') || 5)) * 1000;
    await new Promise((res) => setTimeout(res, wait + 500));
    r = await fetch(`${BASE}/mcp`, init);
  }
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* SSE or empty */ }
  return { status: r.status, text, json, ct: r.headers.get('content-type') || '', headers: r.headers };
}

// ------------------------------------------------------------ SDK client
async function sdkSection() {
  const client = new Client({ name: 'specular-conformance', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`));
  await client.connect(transport);
  check('lifecycle', 'SDK Client.connect() completes initialize handshake', true, JSON.stringify(client.getServerVersion()));
  const caps = client.getServerCapabilities();
  check('lifecycle', 'server advertises tools capability', !!caps?.tools, JSON.stringify(caps));

  const list = await client.listTools();
  check('tools/list', 'returns a non-empty tool list with name+inputSchema', list.tools.length > 0 && list.tools.every((t) => t.name && t.inputSchema?.type === 'object'), `${list.tools.length} tools`);
  check('tools/list', 'every tool declares a description', list.tools.every((t) => typeof t.description === 'string' && t.description.length > 10), `${list.tools.filter((t) => !t.description).length} missing`);
  const readOnly = list.tools.filter((t) => t.annotations?.readOnlyHint);
  check('tools/list', 'read/prepare/simulate tools carry readOnlyHint, broadcast does not',
    readOnly.length > 0 && !list.tools.find((t) => t.name === 'broadcast_signed_transaction')?.annotations?.readOnlyHint,
    `${readOnly.length}/${list.tools.length} readOnlyHint`);
  check('tools/list', 'no cursor/pagination surprises (single page)', list.nextCursor === undefined, `nextCursor=${list.nextCursor}`);

  const res = await client.callTool({ name: 'get_protocol_status', arguments: { network: NET } });
  check('tools/call', 'returns content[] and structuredContent', Array.isArray(res.content) && res.content[0]?.type === 'text' && !!res.structuredContent, JSON.stringify(res.structuredContent).slice(0, 160));
  check('tools/call', 'structuredContent parses as the same JSON as content[0].text', JSON.stringify(JSON.parse(res.content[0].text)) === JSON.stringify(res.structuredContent), 'match');

  const bad = await client.callTool({ name: 'check_credit_score', arguments: { network: NET, address: '0xnope' } });
  check('tools/call', 'tool-level validation failure is isError:true (not a protocol error)', bad.isError === true, bad.content?.[0]?.text?.slice(0, 120));

  let unknownErr = null;
  try {
    await client.callTool({ name: 'no_such_tool', arguments: {} });
  } catch (e) {
    unknownErr = e;
  }
  check('tools/call', 'unknown tool raises a protocol error the SDK surfaces as McpError -32602', unknownErr?.code === -32602, `${unknownErr?.code} ${unknownErr?.message}`);

  await client.ping();
  check('lifecycle', 'ping round-trips', true, 'ok');

  await transport.close();
  return list.tools.map((t) => t.name);
}

// ------------------------------------------------------ raw wire semantics
async function wireSection() {
  // --- protocol version negotiation
  for (const v of ['2024-11-05', '2025-03-26', '2025-06-18']) {
    const r = await raw({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: v, capabilities: {}, clientInfo: { name: 'c', version: '1' } } });
    const got = r.json?.result?.protocolVersion;
    check('version', `initialize with protocolVersion ${v} negotiates a version`, r.status === 200 && typeof got === 'string', `-> ${got}`);
  }
  {
    const r = await raw({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '1999-01-01', capabilities: {}, clientInfo: { name: 'c', version: '1' } } });
    check('version', 'unsupported protocolVersion still negotiates down to a supported one (no hard failure)', r.status === 200 && typeof r.json?.result?.protocolVersion === 'string', `HTTP ${r.status} -> ${r.json?.result?.protocolVersion}`);
  }
  {
    const r = await raw({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 42, capabilities: {}, clientInfo: { name: 'c', version: '1' } } });
    check('version', 'non-string protocolVersion -> -32602 Invalid params', r.json?.error?.code === -32602, JSON.stringify(r.json).slice(0, 160));
  }
  {
    const r = await raw({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { 'mcp-protocol-version': '2025-06-18' });
    check('version', 'Mcp-Protocol-Version request header is honoured', r.status === 200 && Array.isArray(r.json?.result?.tools), `HTTP ${r.status}`);
  }
  {
    const r = await raw({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { 'mcp-protocol-version': 'not-a-version' });
    check('version', 'garbage Mcp-Protocol-Version header -> 400, no crash', r.status === 400 || r.status === 200, `HTTP ${r.status} ${r.text.slice(0, 120)}`);
  }

  // --- Accept negotiation
  for (const [label, accept] of [
    ['both types (spec-conformant)', 'application/json, text/event-stream'],
    ['application/json only', 'application/json'],
    ['*/*', '*/*'],
    ['absent', null],
    ['text/event-stream only', 'text/event-stream'],
    ['text/html (hostile)', 'text/html'],
  ]) {
    const r = await raw({ jsonrpc: '2.0', id: 1, method: 'ping' }, { accept });
    check('accept', `Accept: ${label} -> 200 JSON`, r.status === 200 && /application\/json/.test(r.ct), `HTTP ${r.status} ct=${r.ct}`);
  }

  // --- session semantics (stateless server)
  {
    const r = await raw({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'c', version: '1' } } });
    check('session', 'initialize issues NO Mcp-Session-Id (stateless)', !r.headers.get('mcp-session-id'), `header=${r.headers.get('mcp-session-id')}`);
  }
  {
    const r = await raw({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { 'mcp-session-id': 'bogus-session-id' });
    check('session', 'a bogus Mcp-Session-Id is ignored, not 404', r.status === 200 && Array.isArray(r.json?.result?.tools), `HTTP ${r.status}`);
  }
  {
    const r = await raw({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    check('session', 'tools/list works without a prior initialize (stateless)', r.status === 200 && Array.isArray(r.json?.result?.tools), `HTTP ${r.status}`);
  }
  {
    const r = await raw(undefined, {}, 'GET');
    check('session', 'GET /mcp (SSE listening stream) -> 405 Method Not Allowed', r.status === 405, `HTTP ${r.status} ${r.text.slice(0, 120)}`);
  }
  {
    const r = await raw(undefined, {}, 'DELETE');
    check('session', 'DELETE /mcp (session teardown) -> 405', r.status === 405, `HTTP ${r.status}`);
  }

  // --- notifications (no id)
  {
    const r = await raw({ jsonrpc: '2.0', method: 'notifications/initialized' });
    check('jsonrpc', 'notification (no id) -> 202 Accepted, empty body', r.status === 202 && r.text.length === 0, `HTTP ${r.status} body=${JSON.stringify(r.text)}`);
  }

  // --- batches
  {
    const r = await raw([
      { jsonrpc: '2.0', id: 1, method: 'ping' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_networks', arguments: {} } },
    ]);
    const arr = r.json;
    const ok = r.status === 200 && Array.isArray(arr) && arr.length === 3 && new Set(arr.map((x) => x.id)).size === 3;
    check('batch', 'JSON-RPC batch of 3 returns 3 correlated responses', ok, `HTTP ${r.status} ids=${Array.isArray(arr) ? arr.map((x) => x.id).join(',') : r.text.slice(0, 120)}`);
  }
  {
    const r = await raw([{ jsonrpc: '2.0', id: 1, method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/initialized' }]);
    check('batch', 'mixed batch (request + notification) answers only the request', r.status === 200 && Array.isArray(r.json) && r.json.length === 1, `HTTP ${r.status} ${r.text.slice(0, 140)}`);
  }
  {
    const r = await raw([]);
    check('batch', 'empty batch is rejected, not 500', r.status >= 400 || r.json?.error, `HTTP ${r.status} ${r.text.slice(0, 140)}`);
  }
  {
    const big = Array.from({ length: 30 }, (_, i) => ({ jsonrpc: '2.0', id: i + 1, method: 'ping' }));
    const r = await raw(big);
    check('batch', 'batch of 30 pings answered in full', r.status === 200 && Array.isArray(r.json) && r.json.length === 30, `HTTP ${r.status} n=${Array.isArray(r.json) ? r.json.length : '-'}`);
  }

  // --- error codes
  for (const [label, body, expected] of [
    ['unknown method', { jsonrpc: '2.0', id: 1, method: 'does/not/exist' }, -32601],
    ['unknown tool', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'nope', arguments: {} } }, -32602],
    ['tools/call without params', { jsonrpc: '2.0', id: 1, method: 'tools/call' }, -32602],
    ['tools/call name not a string', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 7 } }, -32602],
    ['tools/call arguments as array', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_networks', arguments: [] } }, -32602],
  ]) {
    const r = await raw(body);
    check('errors', `${label} -> ${expected}`, r.json?.error?.code === expected, `code=${r.json?.error?.code} msg=${String(r.json?.error?.message).slice(0, 90)}`);
    check('errors', `${label}: error message carries no zod dump`, !/invalid_type|"path"\s*:|ZodError/.test(r.text), r.text.slice(0, 120));
  }
  {
    const r = await raw('{"jsonrpc":"2.0",', {});
    check('errors', 'malformed JSON -> 400 with a JSON body, no stack', r.status === 400 && !/\bat .*:\d+:\d+/.test(r.text), `HTTP ${r.status} ${r.text.slice(0, 120)}`);
  }
  {
    const r = await raw({ id: 1, method: 'ping' });   // missing jsonrpc
    check('errors', 'missing "jsonrpc" member is rejected', r.status >= 400 || !!r.json?.error, `HTTP ${r.status} ${r.text.slice(0, 140)}`);
  }
  {
    const r = await raw({ jsonrpc: '1.0', id: 1, method: 'ping' });
    check('errors', 'wrong jsonrpc version is rejected', r.status >= 400 || !!r.json?.error, `HTTP ${r.status} ${r.text.slice(0, 140)}`);
  }
  {
    const r = await raw({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_protocol_status' } });
    check('errors', 'tools/call with omitted arguments is accepted (defaults to {})', r.status === 200 && (r.json?.result?.isError === true || !!r.json?.result), `HTTP ${r.status} ${r.text.slice(0, 140)}`);
  }

  // --- id handling
  for (const [label, id] of [['string id', 'abc-123'], ['zero id', 0], ['negative id', -5], ['large id', 2 ** 31]]) {
    const r = await raw({ jsonrpc: '2.0', id, method: 'ping' });
    check('jsonrpc', `${label} is echoed back unchanged`, r.json?.id === id, `sent ${JSON.stringify(id)} got ${JSON.stringify(r.json?.id)}`);
  }

  // --- CORS / browser hosts
  {
    const r = await fetch(`${BASE}/mcp`, { method: 'OPTIONS', headers: { origin: 'https://example.test', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' } });
    check('cors', 'preflight OPTIONS answered with allow-origin', r.status < 300 && !!r.headers.get('access-control-allow-origin'), `HTTP ${r.status} allow-origin=${r.headers.get('access-control-allow-origin')}`);
    const expose = (await fetch(`${BASE}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', origin: 'https://example.test' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) })).headers.get('access-control-expose-headers');
    check('cors', 'Mcp-Session-Id / rate-limit headers are exposed to browsers', /Mcp-Session-Id/i.test(expose || ''), String(expose));
  }

  // --- tool-call sanity over the wire
  {
    const r = await raw({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'check_credit_score', arguments: { network: NET, address: AGENT } } });
    check('tools/call', 'read tool over raw JSON-RPC returns structuredContent', !!r.json?.result?.structuredContent, JSON.stringify(r.json?.result?.structuredContent).slice(0, 140));
  }
  {
    const r = await raw({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'prepare_request_loan', arguments: { network: NET, from: AGENT, amount: 5, durationDays: 7 } } });
    const sc = r.json?.result?.structuredContent;
    check('tools/call', 'prepare_* returns an unsigned tx (value 0, no signature field)', !!sc && sc.value === '0' && sc.signature === undefined && !!sc.data, `to=${sc?.to} value=${sc?.value}`);
  }
}

// ------------------------------------------------------------------- run
const tools = await sdkSection();
await wireSection();
console.log(`\n==== MCP conformance ${BASE} ====\nPASS ${pass}  FAIL ${fail}  total ${pass + fail}  (${tools.length} tools)`);
const out = path.join(here, `mcp-conformance-${BASE.includes('127.0.0.1') ? 'local' : 'live'}.json`);
fs.writeFileSync(out, JSON.stringify({ base: BASE, at: new Date().toISOString(), pass, fail, tools, rows }, null, 1));
console.log(`results -> ${out}`);
process.exit(fail === 0 ? 0 : 1);
