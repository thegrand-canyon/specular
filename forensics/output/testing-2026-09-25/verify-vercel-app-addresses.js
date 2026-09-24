const {ethers}=require('ethers');
(async()=>{
const p=new ethers.JsonRpcProvider('https://sepolia.base.org',undefined,{batchMaxCount:1});
const t={AgentRegistryV2:'0xe4D78A509daa8dc8bFB453cb76d61f1Cb1c4C3fF',ReputationManagerV3:'0x77f8D49C706A566Eecc9a2C3DD6556D5be54CACE',MockUSDC:'0x771c293167AeD146EC4f56479056645Be46a0275',AgentLiquidityMarketplace:'0x5194D976F2f1B59C0500cDe1e54A362d9BB9124B'};
console.log('--- frontend/src/config.js (Base Sepolia, what specular.vercel.app uses) ---');
for(const [k,a] of Object.entries(t)){const c=await p.getCode(a);console.log(k.padEnd(26),a,c==='0x'?'NO CODE ***':(c.length/2-1)+' bytes');}
})().catch(e=>console.error(e.shortMessage||e.message));
