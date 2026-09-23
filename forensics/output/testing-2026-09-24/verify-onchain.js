// Independent on-chain verification of the REST journey, using the real ABIs and
// a direct RPC connection (nothing from the hosted API is trusted here).
const { ethers } = require('ethers');
const MKT = require('../../../mcp-server/abi/AgentLiquidityMarketplaceV62.json');
const REG = require('../../../mcp-server/abi/AgentRegistryV2.json');
const REP = require('../../../mcp-server/abi/ReputationManagerV4.json');
const abiOf = (m) => m.abi || m;

const C = {
  marketplace: '0x7E4D144AbEB3C695Ec2DdF00Fc710aABC04bDd18',
  registry: '0x4712A978A0EADe68f0b485b981112Ae66aA622d9',
  reputation: '0xD7906fDFBf69BA89a4c2FE148797e24f386fE3d2',
  usdc: '0x9F3C10985998D1354D1465c5135Aa924775bd11D',
};

(async () => {
  const addr = process.argv[2];
  const agentId = process.argv[3];
  const loanId = process.argv[4];
  const p = new ethers.JsonRpcProvider('https://arc-testnet-rpc.publicnode.com', 5042002);
  const mkt = new ethers.Contract(C.marketplace, abiOf(MKT), p);
  const reg = new ethers.Contract(C.registry, abiOf(REG), p);
  const rep = new ethers.Contract(C.reputation, abiOf(REP), p);
  const usdc = new ethers.Contract(C.usdc, ['function balanceOf(address) view returns(uint256)', 'function allowance(address,address) view returns(uint256)'], p);
  const f6 = (v) => ethers.formatUnits(v, 6);

  const out = {};
  out.block = await p.getBlockNumber();
  // registry
  for (const fn of ['isRegistered', 'getAgentIdByOwner', 'addressToAgentId', 'ownerToAgentId']) {
    try { out['registry.' + fn] = String(await reg[fn](addr)); } catch (e) { /* not present */ }
  }
  try { const a = await reg.getAgent(agentId); out['registry.getAgent'] = JSON.parse(JSON.stringify(a, (k, v) => typeof v === 'bigint' ? v.toString() : v)); } catch (e) { out['registry.getAgent.err'] = e.shortMessage; }
  // loan
  try { const l = await mkt.getLoan(loanId); out['mkt.getLoan'] = l.toObject ? JSON.parse(JSON.stringify(l.toObject(), (k, v) => typeof v === 'bigint' ? v.toString() : v)) : l.map(String); }
  catch (e) { try { const l = await mkt.loans(loanId); out['mkt.loans'] = l.toObject ? JSON.parse(JSON.stringify(l.toObject(), (k, v) => typeof v === 'bigint' ? v.toString() : v)) : l.map(String); } catch (e2) { out['mkt.loan.err'] = e2.shortMessage; } }
  // pool
  for (const fn of ['getPool', 'pools', 'agentPools']) {
    try { const x = await mkt[fn](agentId); out['mkt.' + fn] = x.toObject ? JSON.parse(JSON.stringify(x.toObject(), (k, v) => typeof v === 'bigint' ? v.toString() : v)) : (Array.isArray(x) ? x.map(String) : String(x)); break; } catch (e) { }
  }
  try { out['mkt.lenderPosition'] = (await mkt.lenderPositions(agentId, addr)).map ? (await mkt.lenderPositions(agentId, addr)).map(String) : String(await mkt.lenderPositions(agentId, addr)); } catch (e) { }
  // reputation
  for (const fn of ['getScore', 'getReputationScore', 'reputationScores', 'scores']) {
    try { out['rep.' + fn] = String(await rep[fn](agentId)); } catch (e) { try { out['rep.' + fn + '(addr)'] = String(await rep[fn](addr)); } catch (e2) { } }
  }
  for (const fn of ['getCreditLimit', 'getLoanTerms', 'getTier', 'maxRepaidPrincipal', 'getCreditLadder']) {
    try { const v = await rep[fn](agentId); out['rep.' + fn] = Array.isArray(v) ? v.map(String) : String(v); } catch (e) { }
  }
  out['usdc.balance(agent)'] = f6(await usdc.balanceOf(addr));
  out['usdc.balance(marketplace)'] = f6(await usdc.balanceOf(C.marketplace));
  out['usdc.allowance(agent->mkt)'] = f6(await usdc.allowance(addr, C.marketplace));
  console.log(JSON.stringify(out, null, 2));
})();
