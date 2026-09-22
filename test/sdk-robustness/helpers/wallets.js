/**
 * Real ethers.Wallet signers (own key, local signing, eth_sendRawTransaction)
 * over a fault-injecting provider — i.e. exactly the shape a third-party agent
 * runs, rather than a node-unlocked JsonRpcSigner.
 */
const { ethers } = require('ethers');

const HARDHAT_MNEMONIC = 'test test test test test test test test test test test junk';

function walletAt(index, provider) {
    const w = ethers.HDNodeWallet.fromPhrase(HARDHAT_MNEMONIC, undefined, `m/44'/60'/0'/0/${index}`);
    return new ethers.Wallet(w.privateKey, provider);
}

module.exports = { walletAt, HARDHAT_MNEMONIC };
