// Real MCP client against the hosted /mcp endpoint, following REMOTE_MCP.md's
// TypeScript snippet. Discovery + read + prepare + sign + broadcast.
import 'dotenv/config';
import { Client } from '../../../mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StreamableHTTPClientTransport } from '../../../mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js';
import { ethers } from 'ethers';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const keys = require('./keys.secret.json');

const URL_ = 'https://specular-agent-api-production.up.railway.app/mcp';
const TOKEN = process.env.SPECULAR_MCP_TOKEN;
const NET = 'arc-staging';
const wallet = new ethers.Wallet(keys.mcp.privateKey, new ethers.JsonRpcProvider('https://arc-testnet-rpc.publicnode.com', 5042002));
const out = { wallet: wallet.address, steps: [] };
const t0 = Date.now();

const client = new Client({ name: 'fresh-third-party-agent', version: '1.0.0' });
const s0 = Date.now();
await client.connect(new StreamableHTTPClientTransport(new URL(URL_), {
  requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
}));
out.steps.push({ name: 'connect+initialize', ms: Date.now() - s0 });
console.log('connected in', Date.now() - s0, 'ms');

async function call(name, args) {
  const s = Date.now();
  const r = await client.callTool({ name, arguments: args });
  const ms = Date.now() - s;
  console.log(`  [mcp ${ms}ms] ${name} isError=${!!r.isError}`);
  out.steps.push({ name, ms, isError: !!r.isError, result: r.structuredContent ?? (r.content?.[0]?.text?.slice(0, 600)) });
  return r;
}

// tools/list
let s = Date.now();
const tools = await client.listTools();
out.steps.push({ name: 'tools/list', ms: Date.now() - s, count: tools.tools.length, names: tools.tools.map((t) => t.name) });
console.log('tools:', tools.tools.length, tools.tools.map((t) => t.name).join(','));

// annotations claimed by GROK_BOT.md
out.annotations = tools.tools.map((t) => ({ name: t.name, annotations: t.annotations }));

// 1. discovery
await call('list_networks', {});
await call('get_protocol_status', { network: NET });
// 2. read
await call('check_credit_score', { network: NET, address: wallet.address });
// 3. prepare + sign + broadcast via MCP broadcast_signed_transaction
const reg = await call('prepare_register_agent', { network: NET, from: wallet.address, simulate: true });
const prep = reg.structuredContent;
const provider = wallet.provider;
const fee = await provider.getFeeData();
const raw = await wallet.signTransaction({
  chainId: prep.chainId, to: prep.to, data: prep.data, value: 0n,
  nonce: await provider.getTransactionCount(wallet.address, 'pending'),
  gasLimit: BigInt(Math.floor(Number(prep.gasEstimate) * 1.3)),
  maxFeePerGas: fee.maxFeePerGas ?? ethers.parseUnits('1', 'gwei'),
  maxPriorityFeePerGas: fee.maxPriorityFeePerGas ?? 0n, type: 2,
});
const b = await call('broadcast_signed_transaction', { network: NET, signedTransaction: raw });
const hash = b.structuredContent?.hash;
console.log('  broadcast hash', hash);
const rcpt = await provider.waitForTransaction(hash, 1, 120000);
console.log('  ON-CHAIN receipt status', rcpt.status);
out.steps.push({ name: 'verify_onchain', hash, status: rcpt.status });
await new Promise((r) => setTimeout(r, 1500));
await call('get_transaction', { network: NET, hash });
await call('check_credit_score', { network: NET, address: wallet.address });

// error-quality probes over MCP
out.errors = [];
for (const [label, name, args] of [
  ['unknown network name', 'check_credit_score', { network: 'arc-testnet', address: wallet.address }],
  ['missing network', 'check_credit_score', { address: wallet.address }],
  ['malformed address', 'check_credit_score', { network: NET, address: '0xdeadbeef' }],
  ['unknown tool', 'borrow_all_the_money', { network: NET }],
]) {
  const s2 = Date.now();
  try {
    const r = await client.callTool({ name, arguments: args });
    out.errors.push({ label, ms: Date.now() - s2, isError: !!r.isError, text: r.content?.[0]?.text, structured: r.structuredContent });
    console.log(`  ERR[${label}] isError=${!!r.isError}: ${(r.content?.[0]?.text || '').slice(0, 200)}`);
  } catch (e) {
    out.errors.push({ label, ms: Date.now() - s2, threw: e.message, code: e.code });
    console.log(`  ERR[${label}] THREW: ${e.message}`);
  }
}

out.totalMs = Date.now() - t0;
fs.writeFileSync(new URL('./mcp-journey-result.json', import.meta.url), JSON.stringify(out, null, 2));
console.log('DONE', (out.totalMs / 1000).toFixed(1), 's');
await client.close();
