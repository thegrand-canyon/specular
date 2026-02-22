const { ethers } = require('hardhat');
async function main() {
    const [deployer] = await ethers.getSigners();
    console.log('Deployer:', deployer.address);
    const rm3 = await ethers.getContractAt('ReputationManagerV3', '0x94F2fa47c4488202a46dAA9038Ed9C9c4c07467F');
    const owner = await rm3.owner();
    console.log('RM3 owner:', owner);
    console.log('Is owner:', owner.toLowerCase() === deployer.address.toLowerCase());
    const vr = await rm3.validationRegistry();
    console.log('Current validationRegistry:', vr);
}
main().catch(console.error);
