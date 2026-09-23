// "Naive newcomer" breakage battery against the DEPLOYED hosted REST API.
// Grades each failure on whether the message is clear + actionable.
require('dotenv').config({ path: require('path').join(__dirname, '../../../.env') });
const { ethers } = require('ethers');
const fs = require('fs');
const keys = require('./keys.secret.json');

const API = 'https://specular-agent-api-production.up.railway.app';
const TOKEN = process.env.SPECULAR_MCP_TOKEN;
const NET = 'arc-staging';
const provider = new ethers.JsonRpcProvider('https://arc-testnet-rpc.publicnode.com', 5042002);
const REST = new ethers.Wallet(keys.rest.privateKey, provider);   // agentId 66, pool w/ 70 USDC
const MCPW = new ethers.Wallet(keys.mcp.privateKey, provider);    // registered, no pool
const results = [];

async function probe(label, { method = 'POST', path, body, noAuth = false, expect }) {
  const s = Date.now();
  const res = await fetch(API + path, {
    method,
    headers: { 'content-type': 'application/json', ...(noAuth ? {} : { authorization: `Bearer ${TOKEN}` }) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const ms = Date.now() - s;
  let j; const t = await res.text();
  try { j = JSON.parse(t); } catch { j = { _raw: t.slice(0, 300) }; }
  const msg = j.error || (j.simulation && j.simulation.plainLanguage) || (j.simulation && j.simulation.revertReason) || JSON.stringify(j).slice(0, 300);
  results.push({ label, http: res.status, ms, message: msg, field: j.field, simOk: j.simulation ? j.simulation.ok : undefined, warnings: j.warnings, raw: j });
  console.log(`\n### ${label}\n  HTTP ${res.status} (${ms}ms)\n  -> ${String(msg).slice(0, 400)}`);
  if (j.warnings && j.warnings.length) console.log(`  warnings: ${JSON.stringify(j.warnings).slice(0, 300)}`);
  return j;
}

async function sendPrep(prep, w) {
  const fee = await provider.getFeeData();
  const raw = await w.signTransaction({
    chainId: prep.chainId, to: prep.to, data: prep.data, value: 0n,
    nonce: await provider.getTransactionCount(w.address, 'pending'),
    gasLimit: BigInt(Math.floor(Number(prep.gasEstimate) * 1.3)),
    maxFeePerGas: fee.maxFeePerGas ?? ethers.parseUnits('1', 'gwei'),
    maxPriorityFeePerGas: fee.maxPriorityFeePerGas ?? 0n, type: 2,
  });
  const h = await provider.send('eth_sendRawTransaction', [raw]);
  await provider.waitForTransaction(h, 1, 120000);
  return h;
}

(async () => {
  // ---- auth / transport -------------------------------------------------
  await probe('missing bearer token (REST read)', { method: 'GET', path: `/v1/${NET}/status`, noAuth: true });
  await probe('wrong bearer token', { method: 'GET', path: `/v1/${NET}/status`, noAuth: true }).catch(() => { });
  {
    const s = Date.now();
    const r = await fetch(API + `/v1/${NET}/status`, { headers: { authorization: 'Bearer definitely-not-the-token' } });
    const j = await r.json();
    results.push({ label: 'wrong bearer token', http: r.status, ms: Date.now() - s, message: j.error });
    console.log(`\n### wrong bearer token\n  HTTP ${r.status}\n  -> ${j.error}`);
  }
  results.pop(); // drop the duplicate no-auth probe row pushed above
  // ---- network naming ---------------------------------------------------
  await probe('wrong network name "arc-testnet"', { method: 'GET', path: `/v1/arc-testnet/status` });
  await probe('network "arc" (SDK name, not API name)', { method: 'GET', path: `/v1/arc/status` });
  await probe('network "base" (documented but NOT enabled here)', { method: 'GET', path: `/v1/base/status` });
  await probe('network "mainnet"', { method: 'GET', path: `/v1/mainnet/status` });

  // ---- addresses --------------------------------------------------------
  await probe('malformed address 0xdeadbeef', { method: 'GET', path: `/v1/${NET}/agents/0xdeadbeef/credit` });
  await probe('address with bad EIP-55 checksum', { method: 'GET', path: `/v1/${NET}/agents/0x801E256f516A2Fd3e0E06a871419e707695b82df/credit` });
  await probe('all-lowercase address (valid, should work)', { method: 'GET', path: `/v1/${NET}/agents/${REST.address.toLowerCase()}/credit` });
  await probe('ENS-style name instead of address', { method: 'GET', path: `/v1/${NET}/agents/myagent.eth/credit` });

  // ---- amount typing ----------------------------------------------------
  const base = { from: REST.address, agentId: 66 };
  await probe('amount as NUMBER 25', { path: `/v1/${NET}/tx/prepare/supply_liquidity`, body: { ...base, amount: 25, simulate: false } });
  await probe('amount as STRING "25"', { path: `/v1/${NET}/tx/prepare/supply_liquidity`, body: { ...base, amount: '25', simulate: false } });
  await probe('amount as DECIMAL 12.5', { path: `/v1/${NET}/tx/prepare/supply_liquidity`, body: { ...base, amount: 12.5, simulate: false } });
  await probe('amount 7 decimals 12.1234567', { path: `/v1/${NET}/tx/prepare/supply_liquidity`, body: { ...base, amount: 12.1234567, simulate: false } });
  await probe('amount as BASE UNITS 25000000 (common mistake)', { path: `/v1/${NET}/tx/prepare/supply_liquidity`, body: { ...base, amount: 25000000, simulate: false } });
  await probe('amount 0', { path: `/v1/${NET}/tx/prepare/supply_liquidity`, body: { ...base, amount: 0, simulate: false } });
  await probe('amount -5', { path: `/v1/${NET}/tx/prepare/supply_liquidity`, body: { ...base, amount: -5, simulate: false } });
  await probe('amount "twenty-five"', { path: `/v1/${NET}/tx/prepare/supply_liquidity`, body: { ...base, amount: 'twenty-five', simulate: false } });
  await probe('amount missing entirely', { path: `/v1/${NET}/tx/prepare/supply_liquidity`, body: { ...base, simulate: false } });

  // ---- supply below minimum (as a NON-creator lender) -------------------
  await probe('supply 5 USDC below 10 minimum (non-creator lender)', {
    path: `/v1/${NET}/tx/prepare/supply_liquidity`, body: { from: MCPW.address, agentId: 66, amount: 5, simulate: true },
  });

  // ---- borrow limits ----------------------------------------------------
  await probe('borrow 500 USDC over 100 credit limit', { path: `/v1/${NET}/tx/prepare/request_loan`, body: { from: REST.address, amount: 500, durationDays: 30, simulate: true } });
  await probe('borrow 99999 over transport cap', { path: `/v1/${NET}/tx/prepare/request_loan`, body: { from: REST.address, amount: 99999, durationDays: 30, simulate: true } });
  await probe('durationDays 3 (below min 7)', { path: `/v1/${NET}/tx/prepare/request_loan`, body: { from: REST.address, amount: 10, durationDays: 3, simulate: true } });
  await probe('durationDays 9999', { path: `/v1/${NET}/tx/prepare/request_loan`, body: { from: REST.address, amount: 10, durationDays: 9999, simulate: true } });
  await probe('durationDays 30.5', { path: `/v1/${NET}/tx/prepare/request_loan`, body: { from: REST.address, amount: 10, durationDays: 30.5, simulate: true } });
  await probe('borrow from an UNREGISTERED wallet', { path: `/v1/${NET}/tx/prepare/request_loan`, body: { from: ethers.Wallet.createRandom().address, amount: 10, durationDays: 30, simulate: true } });
  await probe('borrow as registered agent with NO pool', { path: `/v1/${NET}/tx/prepare/request_loan`, body: { from: MCPW.address, amount: 10, durationDays: 30, simulate: true } });

  // ---- nonexistent entities --------------------------------------------
  await probe('loanId 999999', { method: 'GET', path: `/v1/${NET}/loans/999999` });
  await probe('loanId "abc"', { method: 'GET', path: `/v1/${NET}/loans/abc` });
  await probe('pool for agentId 999999', { method: 'GET', path: `/v1/${NET}/pools/999999` });
  await probe('tx hash that does not exist', { method: 'GET', path: `/v1/${NET}/tx/0x${'11'.repeat(32)}` });

  // ---- live: open a loan so we can test locked-withdraw + wrong-borrower --
  console.log('\n--- opening a live loan on agent 66 for the lock tests ---');
  let p = await probe('prepare borrow 20 (setup)', { path: `/v1/${NET}/tx/prepare/request_loan`, body: { from: REST.address, amount: 20, durationDays: 30, simulate: false } });
  if (p.prerequisite) await sendPrep(p.prerequisite, REST);
  const loanHash = await sendPrep(p, REST);
  await new Promise((r) => setTimeout(r, 2000));
  const txj = await (await fetch(`${API}/v1/${NET}/tx/${loanHash}`, { headers: { authorization: `Bearer ${TOKEN}` } })).json();
  const liveLoanId = Number(txj.events.find((e) => e.name === 'LoanRequested').args.loanId);
  console.log('  live ACTIVE loanId =', liveLoanId);

  await probe('withdraw self-stake while borrowing (locked)', { path: `/v1/${NET}/tx/prepare/withdraw_liquidity`, body: { from: REST.address, agentId: 66, amount: 50, simulate: true } });
  await probe('repay SOMEONE ELSE\'S active loan', { path: `/v1/${NET}/tx/prepare/repay_loan`, body: { from: MCPW.address, loanId: liveLoanId, simulate: true } });
  await probe('repay an already-REPAID loan (#115)', { path: `/v1/${NET}/tx/prepare/repay_loan`, body: { from: REST.address, loanId: 115, simulate: true } });
  await probe('claim interest from a pool you never supplied to', { path: `/v1/${NET}/tx/prepare/claim_interest`, body: { from: MCPW.address, agentId: 66, simulate: true } });

  // clean up: repay the live loan
  p = await probe('prepare repay (cleanup)', { path: `/v1/${NET}/tx/prepare/repay_loan`, body: { from: REST.address, loanId: liveLoanId, simulate: false } });
  if (p.prerequisite) await sendPrep(p.prerequisite, REST);
  await sendPrep(p, REST);
  console.log('  cleanup repay done for loan', liveLoanId);

  // ---- relay abuse ------------------------------------------------------
  await probe('broadcast garbage hex', { path: `/v1/${NET}/tx/broadcast`, body: { signedTransaction: '0xdeadbeef' } });
  await probe('broadcast non-hex string', { path: `/v1/${NET}/tx/broadcast`, body: { signedTransaction: 'not a transaction' } });
  {
    const fee = await provider.getFeeData();
    const evil = await REST.signTransaction({
      chainId: 5042002, to: MCPW.address, value: ethers.parseEther('0.001'), data: '0x',
      nonce: await provider.getTransactionCount(REST.address, 'pending'),
      gasLimit: 21000n, maxFeePerGas: fee.maxFeePerGas ?? ethers.parseUnits('1', 'gwei'),
      maxPriorityFeePerGas: fee.maxPriorityFeePerGas ?? 0n, type: 2,
    });
    await probe('broadcast a plain native-value transfer (not Specular)', { path: `/v1/${NET}/tx/broadcast`, body: { signedTransaction: evil } });
    const usdcI = new ethers.Interface(['function approve(address,uint256)']);
    const unlim = await REST.signTransaction({
      chainId: 5042002, to: '0x9F3C10985998D1354D1465c5135Aa924775bd11D',
      data: usdcI.encodeFunctionData('approve', ['0x7E4D144AbEB3C695Ec2DdF00Fc710aABC04bDd18', ethers.MaxUint256]),
      value: 0n, nonce: await provider.getTransactionCount(REST.address, 'pending'), gasLimit: 80000n,
      maxFeePerGas: fee.maxFeePerGas ?? ethers.parseUnits('1', 'gwei'), maxPriorityFeePerGas: fee.maxPriorityFeePerGas ?? 0n, type: 2,
    });
    await probe('broadcast an UNLIMITED USDC approve', { path: `/v1/${NET}/tx/broadcast`, body: { signedTransaction: unlim } });
    const wrongChain = await REST.signTransaction({
      chainId: 8453, to: '0x7E4D144AbEB3C695Ec2DdF00Fc710aABC04bDd18', data: '0x12345678', value: 0n,
      nonce: 0, gasLimit: 80000n, maxFeePerGas: ethers.parseUnits('1', 'gwei'), maxPriorityFeePerGas: 0n, type: 2,
    });
    await probe('broadcast a tx signed for a DIFFERENT chain', { path: `/v1/${NET}/tx/broadcast`, body: { signedTransaction: wrongChain } });
  }

  // ---- misc typing ------------------------------------------------------
  await probe('register twice (already registered)', { path: `/v1/${NET}/tx/prepare/register_agent`, body: { from: REST.address, simulate: true } });
  await probe('prepare with `from` missing', { path: `/v1/${NET}/tx/prepare/create_pool`, body: { simulate: true } });
  await probe('agentId as string "66"', { path: `/v1/${NET}/tx/prepare/claim_interest`, body: { from: REST.address, agentId: '66', simulate: true } });
  await probe('body is not JSON object', { path: `/v1/${NET}/tx/prepare/create_pool`, body: 'hello' });

  fs.writeFileSync(__dirname + '/error-battery-result.json', JSON.stringify(results, null, 2));
  console.log('\nprobes:', results.length);
})().catch((e) => { console.error('BATTERY FAILED', e); fs.writeFileSync(__dirname + '/error-battery-result.json', JSON.stringify(results, null, 2)); process.exit(1); });
