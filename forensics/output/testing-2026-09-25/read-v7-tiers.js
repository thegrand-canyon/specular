require('dotenv').config({path:'/Users/peterschroeder/Specular/.env'});
const {ethers}=require('ethers');
const ABI=[
 'function tierLimits(uint256) view returns (uint256)',
 'function tierCollateralPct(uint256) view returns (uint256)',
 'function tierInterestBps(uint256) view returns (uint256)',
 'function MAX_TIER_LIMIT() view returns (uint256)',
 'function tierLimit(uint256) view returns (uint256)',
 'function tierOf(uint256) view returns (uint256)',
];
(async()=>{
 const p=new ethers.JsonRpcProvider(process.env.ARC_MAINNET_RPC_URL||'https://rpc.mainnet.arc.io',undefined,{batchMaxCount:1});
 const c=new ethers.Contract('0x12953e732e5D1aFdA640554125367d1CEC2ac4FB',ABI,p);
 console.log('ARC MAINNET ReputationManagerV4 (V7) LIVE tier table');
 console.log('MAX_TIER_LIMIT =', Number(await c.MAX_TIER_LIMIT())/1e6, 'USDC');
 const mins=[0,200,400,500,600,800];
 for(let i=0;i<6;i++){
  const l=await c.tierLimits(i), col=await c.tierCollateralPct(i), bps=await c.tierInterestBps(i);
  console.log(`tier ${i} score>=${String(mins[i]).padStart(3)} | limit ${(Number(l)/1e6).toLocaleString().padStart(7)} USDC | collateral ${String(col).padStart(3)}% | rate ${Number(bps)/100}%`);
 }
})().catch(e=>console.error(e.shortMessage||e.message));
