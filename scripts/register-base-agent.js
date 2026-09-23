require('dotenv').config();
const { ethers } = require('ethers');

const RPC_URL = 'https://mainnet.base.org';
const REGISTRY_ADDRESS = '0xbd8210061bF24917Ca2F8098A1F3A4f76adA31fb';

const registryAbi = [
    'function register() external',
    'function addressToAgentId(address) view returns (uint256)',
    'function agents(uint256) view returns (address agentAddress, uint256 registrationTime, bool isActive)'
];

async function main() {
    console.log('🔐 Registering agent on Base Mainnet...\n');
    
    const provider = new ethers.JsonRpcProvider(RPC_URL, 8453, { batchMaxCount: 1 });
    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
    
    console.log('Wallet:', wallet.address);
    
    const registry = new ethers.Contract(REGISTRY_ADDRESS, registryAbi, wallet);
    
    // Check if already registered
    const agentId = await registry.addressToAgentId(wallet.address);
    
    if (agentId > 0n) {
        console.log('✅ Already registered! Agent ID:', agentId.toString());
        const agent = await registry.agents(agentId);
        console.log('   Active:', agent.isActive);
        return;
    }
    
    console.log('\n📝 Registering...');
    const tx = await registry.register();
    console.log('   Tx:', tx.hash);
    console.log('   Waiting for confirmation...');
    
    const receipt = await tx.wait();
    console.log('   ✓ Confirmed in block', receipt.blockNumber);
    
    // Verify
    const newAgentId = await registry.addressToAgentId(wallet.address);
    console.log('\n✅ Registration successful!');
    console.log('   Agent ID:', newAgentId.toString());
}

main().catch(error => {
    console.error('\n❌ Error:', error.message);
    process.exit(1);
});
