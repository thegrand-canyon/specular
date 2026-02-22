const { ethers } = require('hardhat');

async function main() {
    const addresses = {
        actualV2: "0x5592A6d7bF1816f77074b62911D50Dad92A3212b",
        firstV3: "0xF7077e5bA6B0F3BDa8E22CdD1Fb395e18d7D18F0",
        secondV3: "0x309C6463477aF7bB7dc907840495764168094257"
    };

    console.log('\n📊 Checking liquidity across all pools:\n');

    for (const [name, address] of Object.entries(addresses)) {
        try {
            const pool = await ethers.getContractAt('LendingPoolV2', address);
            const available = await pool.availableLiquidity();
            console.log(`${name}: ${ethers.formatUnits(available, 6)} USDC`);
            console.log(`  Address: ${address}\n`);
        } catch (e) {
            console.log(`${name}: Error - ${e.message}`);
            console.log(`  Address: ${address}\n`);
        }
    }
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
