#!/usr/bin/env node
/* Stranger's path through the HOSTED REST API only. Signs locally, broadcasts via
 * the server relay AND (for 2+ steps) directly to a public RPC. Verifies on chain. */
require('dotenv').config({ path: require('path').join(__dirname, '../../../.env') });
const { ethers } = require('ethers');
const fs = require('fs');

const API = 'https://specular-agent-api-production.up.railway.app';
const TOKEN = process.env.SPECULAR_MCP_TOKEN;
const NET = 'arc-staging';
const keys = require('./keys.secret.json');
const KEY = keys[process.argv[2] || 'rest'];

// direct verification RPC (a stranger would use the public default)
const VERIFY_RPC = 'https://arc-testnet-rpc.publicnode.com';
const provider = new ethers.JsonRpcProvider(VERIFY_RPC, 5042002);
const wallet = new ethers.Wallet(KEY.privateKey, provider);

const log = [];
const t0 = Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, path, body) {
  const s = Date.now();
  const res = await fetch(API + path, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  const ms = Date.now() - s;
  let json;
  const text = await res.text();
  try { json = JSON.parse(text); } catch { json = { _raw: text }; }
  log.push({ step: path, method, status: res.status, ms });
  console.log(`  [api ${res.status} ${ms}ms] ${method} ${path}`);
  return { status: res.status, json, ms };
}

async function signAndSend(prep, { via }) {
  const nonce = await provider.getTransactionCount(wallet.address, 'pending');
  const fee = await provider.getFeeData();
  const tx = {
    chainId: prep.chainId,
    to: prep.to,
    data: prep.data,
    value: 0n,
    nonce,
    gasLimit: BigInt(Math.floor(Number(prep.gasEstimate || 500000) * 1.3)),
    maxFeePerGas: fee.maxFeePerGas ?? ethers.parseUnits('1', 'gwei'),
    maxPriorityFeePerGas: fee.maxPriorityFeePerGas ?? 0n,
    type: 2,
  };
  const raw = await wallet.signTransaction(tx);
  let hash;
  const s = Date.now();
  if (via === 'relay') {
    const r = await api('POST', `/v1/${NET}/tx/broadcast`, { signedTransaction: raw });
    if (r.status !== 200) throw new Error('relay refused: ' + JSON.stringify(r.json));
    hash = r.json.hash || r.json.transactionHash;
  } else {
    hash = await provider.send('eth_sendRawTransaction', [raw]);
  }
  const rcpt = await provider.waitForTransaction(hash, 1, 120000);
  const ms = Date.now() - s;
  console.log(`  [tx ${via} ${ms}ms] ${hash} status=${rcpt.status} gas=${rcpt.gasUsed}`);
  log.push({ step: `broadcast(${via})`, hash, status: rcpt.status, ms, gasUsed: rcpt.gasUsed.toString() });
  if (rcpt.status !== 1) throw new Error('tx reverted: ' + hash);
  await sleep(800);
  return { hash, rcpt };
}

const OUT = { wallet: wallet.address, steps: [] };
function rec(name, data) { OUT.steps.push({ name, tSinceStartMs: Date.now() - t0, ...data }); }

(async () => {
  console.log('WALLET', wallet.address);

  // ---- DISCOVERY -------------------------------------------------------
  const nets = await api('GET', '/v1/networks');
  rec('discover_networks', { networks: nets.json.networks.map((n) => n.network), ms: nets.ms });
  const status = await api('GET', `/v1/${NET}/status`);
  rec('protocol_status', {
    ms: status.ms,
    caps: status.json.capabilities,
    tier0: status.json.creditTiers.tiers[0],
    params: status.json.parameters,
  });
  const cfg = nets.json.networks.find((n) => n.network === NET).contracts;

  // ---- CREDIT (pre) ----------------------------------------------------
  let credit = await api('GET', `/v1/${NET}/agents/${wallet.address}/credit`);
  rec('credit_before_register', { ms: credit.ms, registered: credit.json.registered, body: credit.json });

  // ---- REGISTER (relay) ------------------------------------------------
  let p = await api('POST', `/v1/${NET}/tx/prepare/register_agent`, {
    from: wallet.address, agentURI: 'https://example.invalid/fresh-agent.json', simulate: true,
  });
  if (p.status !== 200) throw new Error('prepare_register failed ' + JSON.stringify(p.json));
  rec('prepare_register_agent', { ms: p.ms, summary: p.json.humanReadableSummary, sim: p.json.simulation, warnings: p.json.warnings });
  const reg = await signAndSend(p.json, { via: 'relay' });
  rec('send_register', { hash: reg.hash, via: 'relay' });

  // verify on chain
  const registry = new ethers.Contract(cfg.registry, [
    'function isRegistered(address) view returns (bool)',
    'function getAgentIdByOwner(address) view returns (uint256)',
    'function addressToAgentId(address) view returns (uint256)',
  ], provider);
  let agentId;
  try { agentId = await registry.getAgentIdByOwner(wallet.address); }
  catch { agentId = await registry.addressToAgentId(wallet.address); }
  console.log('  ON-CHAIN agentId =', agentId.toString());
  rec('verify_register_onchain', { agentId: agentId.toString() });

  // ---- CREATE POOL (self-broadcast) -----------------------------------
  p = await api('POST', `/v1/${NET}/tx/prepare/create_pool`, { from: wallet.address, simulate: true });
  rec('prepare_create_pool', { ms: p.ms, summary: p.json.humanReadableSummary, sim: p.json.simulation });
  if (p.status !== 200) throw new Error('prepare_create_pool ' + JSON.stringify(p.json));
  const pool = await signAndSend(p.json, { via: 'self-rpc' });
  rec('send_create_pool', { hash: pool.hash, via: 'self-rpc' });

  let pd = await api('GET', `/v1/${NET}/pools/${agentId}`);
  rec('verify_pool', { ms: pd.ms, body: pd.json });

  // ---- APPROVE + SUPPLY ------------------------------------------------
  const SUPPLY = 120;
  p = await api('POST', `/v1/${NET}/tx/prepare/supply_liquidity`, {
    from: wallet.address, agentId: Number(agentId), amount: SUPPLY, simulate: true,
  });
  rec('prepare_supply_liquidity', { ms: p.ms, summary: p.json.humanReadableSummary, prerequisite: p.json.prerequisite && p.json.prerequisite.humanReadableSummary, sim: p.json.simulation, warnings: p.json.warnings });
  if (p.json.prerequisite) {
    const ap = await signAndSend(p.json.prerequisite, { via: 'relay' });
    rec('send_approve_for_supply', { hash: ap.hash, via: 'relay' });
  }
  const sup = await signAndSend(p.json, { via: 'self-rpc' });
  rec('send_supply', { hash: sup.hash, via: 'self-rpc' });

  const usdc = new ethers.Contract(cfg.usdc, ['function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)'], provider);
  console.log('  ON-CHAIN marketplace USDC', ethers.formatUnits(await usdc.balanceOf(cfg.marketplace), 6));
  pd = await api('GET', `/v1/${NET}/pools/${agentId}`);
  rec('verify_supply', { poolAfter: pd.json, allowanceLeft: (await usdc.allowance(wallet.address, cfg.marketplace)).toString() });

  // ---- SELF-STAKE (V7 gate) -------------------------------------------
  const ss = await api('GET', `/v1/${NET}/agents/${agentId}/self-stake`);
  rec('get_self_stake', { ms: ss.ms, body: ss.json });
  const rss = await api('GET', `/v1/${NET}/agents/${agentId}/required-self-stake?additionalAmount=25`);
  rec('required_self_stake', { ms: rss.ms, body: rss.json });

  // ---- CREDIT (post) ---------------------------------------------------
  credit = await api('GET', `/v1/${NET}/agents/${wallet.address}/credit`);
  rec('credit_after_supply', { ms: credit.ms, body: credit.json });

  // ---- BORROW ----------------------------------------------------------
  const BORROW = 25;
  p = await api('POST', `/v1/${NET}/tx/prepare/request_loan`, {
    from: wallet.address, amount: BORROW, durationDays: 30, simulate: true,
  });
  rec('prepare_request_loan', { ms: p.ms, status: p.status, summary: p.json.humanReadableSummary, prerequisite: p.json.prerequisite && p.json.prerequisite.humanReadableSummary, sim: p.json.simulation, warnings: p.json.warnings, body: p.status !== 200 ? p.json : undefined });
  if (p.status !== 200) throw new Error('prepare_request_loan FAILED: ' + JSON.stringify(p.json));
  if (p.json.prerequisite) {
    const ap = await signAndSend(p.json.prerequisite, { via: 'relay' });
    rec('send_approve_collateral', { hash: ap.hash, via: 'relay' });
  }
  const loan = await signAndSend(p.json, { via: 'relay' });
  rec('send_request_loan', { hash: loan.hash, via: 'relay' });

  const txr = await api('GET', `/v1/${NET}/tx/${loan.hash}`);
  rec('get_transaction_loan', { ms: txr.ms, body: txr.json });
  const loanId = (txr.json.events || []).map((e) => e.args && (e.args.loanId ?? e.args[0])).find((v) => v !== undefined)
    ?? txr.json.loanId ?? (txr.json.decoded && txr.json.decoded.loanId);
  console.log('  loanId =', loanId, JSON.stringify(txr.json.events || txr.json.decoded || '').slice(0, 400));
  const ls = await api('GET', `/v1/${NET}/loans/${loanId}`);
  rec('get_loan_status', { ms: ls.ms, body: ls.json });

  // verify on chain directly
  const mkt = new ethers.Contract(cfg.marketplace, ['function loans(uint256) view returns (uint256 loanId, uint256 agentId, address borrower, uint256 amount, uint256 collateral, uint256 interestRate, uint256 duration, uint256 startTime, uint8 status)'], provider);
  try {
    const raw = await mkt.loans(loanId);
    console.log('  ON-CHAIN loan raw:', raw.toString());
    rec('verify_loan_onchain', { raw: raw.map(String) });
  } catch (e) { rec('verify_loan_onchain', { error: e.shortMessage || e.message }); }
  console.log('  ON-CHAIN borrower USDC after borrow', ethers.formatUnits(await usdc.balanceOf(wallet.address), 6));

  // ---- REPAY -----------------------------------------------------------
  const pr = await api('GET', `/v1/${NET}/loans/${loanId}/repayment`);
  rec('preview_repayment', { ms: pr.ms, body: pr.json });
  p = await api('POST', `/v1/${NET}/tx/prepare/repay_loan`, { from: wallet.address, loanId: Number(loanId), simulate: true });
  rec('prepare_repay_loan', { ms: p.ms, status: p.status, summary: p.json.humanReadableSummary, prerequisite: p.json.prerequisite && p.json.prerequisite.humanReadableSummary, sim: p.json.simulation, body: p.status !== 200 ? p.json : undefined });
  if (p.status !== 200) throw new Error('prepare_repay_loan FAILED ' + JSON.stringify(p.json));
  if (p.json.prerequisite) {
    const ap = await signAndSend(p.json.prerequisite, { via: 'relay' });
    rec('send_approve_repay', { hash: ap.hash, via: 'relay' });
  }
  const rep = await signAndSend(p.json, { via: 'relay' });
  rec('send_repay', { hash: rep.hash, via: 'relay' });
  const ls2 = await api('GET', `/v1/${NET}/loans/${loanId}`);
  rec('verify_repaid', { ms: ls2.ms, status: ls2.json.status || ls2.json.state, body: ls2.json });
  OUT.timeToRepaidLoanMs = Date.now() - t0;
  console.log('*** TIME FROM NOTHING TO REPAID LOAN:', ((Date.now() - t0) / 1000).toFixed(1), 's');

  credit = await api('GET', `/v1/${NET}/agents/${wallet.address}/credit`);
  rec('credit_after_repay', { ms: credit.ms, body: credit.json });

  // ---- CLAIM INTEREST --------------------------------------------------
  const pos = await api('GET', `/v1/${NET}/agents/${wallet.address}/positions`);
  rec('get_lending_positions', { ms: pos.ms, body: pos.json });
  p = await api('POST', `/v1/${NET}/tx/prepare/claim_interest`, { from: wallet.address, agentId: Number(agentId), simulate: true });
  rec('prepare_claim_interest', { ms: p.ms, status: p.status, summary: p.json.humanReadableSummary, sim: p.json.simulation, body: p.status !== 200 ? p.json : undefined });
  if (p.status === 200) {
    const before = await usdc.balanceOf(wallet.address);
    const cl = await signAndSend(p.json, { via: 'self-rpc' });
    const after = await usdc.balanceOf(wallet.address);
    rec('send_claim_interest', { hash: cl.hash, via: 'self-rpc', deltaUsdc: ethers.formatUnits(after - before, 6) });
    console.log('  claimed USDC delta', ethers.formatUnits(after - before, 6));
  }

  // ---- WITHDRAW --------------------------------------------------------
  p = await api('POST', `/v1/${NET}/tx/prepare/withdraw_liquidity`, { from: wallet.address, agentId: Number(agentId), amount: 50, simulate: true });
  rec('prepare_withdraw_liquidity', { ms: p.ms, status: p.status, summary: p.json.humanReadableSummary, sim: p.json.simulation, body: p.status !== 200 ? p.json : undefined });
  if (p.status === 200 && (!p.json.simulation || p.json.simulation.ok !== false)) {
    const before = await usdc.balanceOf(wallet.address);
    const wd = await signAndSend(p.json, { via: 'relay' });
    const after = await usdc.balanceOf(wallet.address);
    rec('send_withdraw', { hash: wd.hash, via: 'relay', deltaUsdc: ethers.formatUnits(after - before, 6) });
  }

  OUT.totalMs = Date.now() - t0;
  OUT.apiCalls = log;
  OUT.agentId = agentId.toString();
  OUT.loanId = String(loanId);
  fs.writeFileSync(__dirname + '/rest-journey-result.json', JSON.stringify(OUT, null, 2));
  console.log('DONE total', (OUT.totalMs / 1000).toFixed(1), 's');
})().catch((e) => {
  OUT.error = e.message;
  OUT.totalMs = Date.now() - t0;
  OUT.apiCalls = log;
  fs.writeFileSync(__dirname + '/rest-journey-result.json', JSON.stringify(OUT, null, 2));
  console.error('FAILED:', e.message);
  process.exit(1);
});
