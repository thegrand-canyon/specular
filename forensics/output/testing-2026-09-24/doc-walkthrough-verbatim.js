// Follow REMOTE_MCP.md's "Borrower walkthrough" (lines 104-115) VERBATIM, with
// no extra steps, and record exactly where it breaks.
require('dotenv').config({ path: require('path').join(__dirname, '../../../.env') });
const { ethers } = require('ethers');
const fs = require('fs');
const keys = require('./keys.secret.json');
const API = 'https://specular-agent-api-production.up.railway.app';
const TOKEN = process.env.SPECULAR_MCP_TOKEN;
const NET = 'arc-staging';
const provider = new ethers.JsonRpcProvider('https://arc-testnet-rpc.publicnode.com', 5042002);
const W = new ethers.Wallet(keys.mcp.privateKey, provider); // registered (agent 67), NO pool
const out = [];

const call = async (m, p, b) => {
  const r = await fetch(API + p, { method: m, headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` }, body: b ? JSON.stringify(b) : undefined });
  const j = await r.json();
  return { status: r.status, j };
};
const send = async (prep) => {
  const fee = await provider.getFeeData();
  const raw = await W.signTransaction({ chainId: prep.chainId, to: prep.to, data: prep.data, value: 0n, nonce: await provider.getTransactionCount(W.address, 'pending'), gasLimit: BigInt(Math.floor(Number(prep.gasEstimate) * 1.3)), maxFeePerGas: fee.maxFeePerGas ?? ethers.parseUnits('1', 'gwei'), maxPriorityFeePerGas: fee.maxPriorityFeePerGas ?? 0n, type: 2 });
  const h = await provider.send('eth_sendRawTransaction', [raw]);
  const rc = await provider.waitForTransaction(h, 1, 120000);
  return { h, status: rc.status };
};

(async () => {
  // Doc line 107: check_credit_score
  let r = await call('GET', `/v1/${NET}/agents/${W.address}/credit`);
  out.push({ docStep: 'check_credit_score', ok: r.status === 200, registered: r.j.registered, nextStep: r.j.nextStep });
  console.log('1. check_credit_score ->', r.j.registered ? 'registered' : 'NOT registered', '| nextStep:', r.j.nextStep);

  // Doc line 108: prepare_register_agent -- already done, doc says "skip if registered"
  out.push({ docStep: 'prepare_register_agent', note: 'skipped per doc: already registered' });

  // Doc line 109: prepare_create_pool
  r = await call('POST', `/v1/${NET}/tx/prepare/create_pool`, { from: W.address, simulate: true });
  console.log('2. prepare_create_pool ->', r.status, r.j.simulation && r.j.simulation.ok);
  const pool = await send(r.j);
  console.log('   pool tx', pool.h, 'status', pool.status);
  out.push({ docStep: 'prepare_create_pool', ok: pool.status === 1, hash: pool.h });
  await new Promise((s) => setTimeout(s, 1500));

  // Doc line 110-112: prepare_request_loan with simulate:true, exactly as written
  r = await call('POST', `/v1/${NET}/tx/prepare/request_loan`, { from: W.address, amount: 25, durationDays: 30, simulate: true });
  console.log('3. prepare_request_loan ->', r.status);
  console.log('   simulation.ok:', r.j.simulation && r.j.simulation.ok);
  console.log('   plainLanguage:', r.j.simulation && r.j.simulation.plainLanguage);
  console.log('   warnings:', JSON.stringify(r.j.warnings));
  console.log('   prerequisite:', r.j.prerequisite && r.j.prerequisite.humanReadableSummary);
  out.push({ docStep: 'prepare_request_loan (doc walkthrough, no supply step)', status: r.status, simOk: r.j.simulation && r.j.simulation.ok, plainLanguage: r.j.simulation && r.j.simulation.plainLanguage, warnings: r.j.warnings, prerequisite: r.j.prerequisite && r.j.prerequisite.humanReadableSummary });

  // Doc says: send prerequisite then the loan tx. Do exactly that and see what happens.
  if (r.j.prerequisite) {
    const a = await send(r.j.prerequisite);
    console.log('   prerequisite approve sent', a.h, 'status', a.status);
    out.push({ docStep: 'send prerequisite (per doc)', hash: a.h, status: a.status });
  }
  try {
    const l = await send(r.j);
    console.log('   LOAN TX', l.h, 'status', l.status);
    out.push({ docStep: 'send request_loan (per doc)', hash: l.h, status: l.status });
  } catch (e) {
    console.log('   LOAN TX FAILED:', (e.shortMessage || e.message).slice(0, 300));
    out.push({ docStep: 'send request_loan (per doc)', failed: true, error: (e.shortMessage || e.message).slice(0, 400), info: e.info && JSON.stringify(e.info).slice(0, 300) });
  }

  fs.writeFileSync(__dirname + '/doc-walkthrough-result.json', JSON.stringify(out, null, 2));
})().catch((e) => { console.error('ERR', e.message); fs.writeFileSync(__dirname + '/doc-walkthrough-result.json', JSON.stringify(out.concat([{ fatal: e.message }]), null, 2)); });
