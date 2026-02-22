const { ethers } = require('hardhat');
const fs = require('fs');
const path = require('path');

async function main() {
    console.log('\n💧 Moving Liquidity to V2 for Reputation Building\n');

    const [signer] = await ethers.getSigners();
    const addressesPath = path.join(__dirname, '..', 'src', 'config', 'sepolia-addresses.json');
    const addresses = JSON.parse(fs.readFileSync(addressesPath, 'utf8'));

    const v2 = await ethers.getContractAt('LendingPoolV2', addresses.lendingPoolV2);
    const v3 = await ethers.getContractAt('LendingPoolV3', addresses.lendingPool);
    const usdc = await ethers.getContractAt('MockUSDC', addresses.mockUSDC);

    const amount = ethers.parseUnits('50000', 6);

    console.log('Withdrawing from V3...');
    const withdrawTx = await v3.withdrawLiquidity(amount);
    await withdrawTx.wait();

    console.log('Approving V2...');
    const approveTx = await usdc.approve(addresses.lendingPoolV2, amount);
    await approveTx.wait();

    console.log('Depositing to V2...');
    const depositTx = await v2.depositLiquidity(amount);
    await depositTx.wait();

    const v2Liquidity = await v2.availableLiquidity();
    console.log('\n✅ V2 Liquidity:', ethers.formatUnits(v2Liquidity, 6), 'USDC\n');
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
