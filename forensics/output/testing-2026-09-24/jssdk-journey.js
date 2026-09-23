// JS SDK entry point: onboard -> supply -> borrow -> repay against the SAME
// deployed arc-staging contracts. Follows the usage block at the top of
// src/sdk/SpecularQuickstart.js.
const { ethers } = require('ethers');
const fs = require('fs');
const { SpecularQuickstart } = require('../../../src/sdk/SpecularQuickstart.js');
const keys = require('./keys.secret.json');

const out = { steps: [] };
const t0 = Date.now();
const mark = (n, d) => { out.steps.push({ name: n, tMs: Date.now() - t0, ...d }); console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${n}`, JSON.stringify(d).slice(0, 500)); };

(async () => {
  const provider = new ethers.JsonRpcProvider('https://arc-testnet-rpc.publicnode.com', 5042002);
  const wallet = new ethers.Wallet(keys.jssdk.privateKey, provider);
  out.wallet = wallet.address;
  const sdk = new SpecularQuickstart(wallet, 'arc-staging');

  let s = Date.now();
  mark('marketplaceVersion', { v: await sdk.marketplaceVersion(), ms: Date.now() - s });
  s = Date.now();
  mark('capabilities', { c: await sdk.capabilities(), ms: Date.now() - s });
  s = Date.now();
  const tiers = await sdk.tierTable();
  mark('tierTable', { n: Array.isArray(tiers) ? tiers.length : typeof tiers, ms: Date.now() - s });

  s = Date.now();
  const ob = await sdk.onboard();
  mark('onboard', { ob, ms: Date.now() - s });

  s = Date.now();
  const agentId = ob.agentId;
  const sup = await sdk.supply(agentId, 120);
  mark('supply(agentId,120)', { sup, ms: Date.now() - s });

  s = Date.now();
  const ci = await sdk.creditInfo();
  mark('creditInfo', { ci: JSON.parse(JSON.stringify(ci, (k, v) => typeof v === 'bigint' ? v.toString() : v)), ms: Date.now() - s });

  s = Date.now();
  const bor = await sdk.borrow(25, 30);
  mark('borrow(25,30)', { bor, ms: Date.now() - s });
  const loanId = bor.loanId ?? bor;

  s = Date.now();
  const pv = await sdk.previewRepayment(loanId);
  mark('previewRepayment', { pv: JSON.parse(JSON.stringify(pv, (k, v) => typeof v === 'bigint' ? v.toString() : v)), ms: Date.now() - s });

  s = Date.now();
  const rp = await sdk.repay(loanId);
  mark('repay', { rp, ms: Date.now() - s });
  out.timeToRepaidLoanMs = Date.now() - t0;

  // on-chain verification via a fresh provider (do not trust the SDK's own view)
  const p2 = new ethers.JsonRpcProvider('https://rpc.testnet.arc.io', 5042002);
  const mkt = new ethers.Contract('0x7E4D144AbEB3C695Ec2DdF00Fc710aABC04bDd18',
    require('../../../mcp-server/abi/AgentLiquidityMarketplaceV62.json').abi, p2);
  const l = await mkt.loans(loanId);
  mark('VERIFY loans(loanId) on chain', { state: String(l.state), amount: String(l.amount), borrower: l.borrower });

  s = Date.now();
  try { mark('claim', { r: await sdk.claim(agentId), ms: Date.now() - s }); } catch (e) { mark('claim', { error: e.message }); }
  s = Date.now();
  try { mark('withdraw(agentId,50)', { r: await sdk.withdraw(agentId, 50), ms: Date.now() - s }); } catch (e) { mark('withdraw(agentId,50)', { error: e.message }); }

  out.totalMs = Date.now() - t0;
  fs.writeFileSync(__dirname + '/jssdk-journey-result.json', JSON.stringify(out, null, 2));
  console.log('DONE', (out.totalMs / 1000).toFixed(1), 's');
})().catch((e) => {
  out.error = e.message; out.stack = (e.stack || '').split('\n').slice(0, 5);
  out.totalMs = Date.now() - t0;
  fs.writeFileSync(__dirname + '/jssdk-journey-result.json', JSON.stringify(out, null, 2));
  console.error('FAILED', e.message);
  process.exit(1);
});
