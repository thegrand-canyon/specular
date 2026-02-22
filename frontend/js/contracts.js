import { ADDRESSES } from './config.js';
import { getProvider, getSigner, getReadProvider, isConnected } from './wallet.js';

let _abis = null;

export async function loadAbis() {
    const [marketplace, registry, reputation, usdc] = await Promise.all([
        fetch('./abis/AgentLiquidityMarketplace.json').then(r => r.json()),
        fetch('./abis/AgentRegistryV2.json').then(r => r.json()),
        fetch('./abis/ReputationManagerV3.json').then(r => r.json()),
        fetch('./abis/MockUSDC.json').then(r => r.json()),
    ]);
    _abis = { marketplace, registry, reputation, usdc };
}

function runner(withSigner) {
    if (withSigner) {
        const s = getSigner();
        if (!s) throw new Error('Wallet not connected');
        return s;
    }
    return isConnected() ? getProvider() : getReadProvider();
}

export function marketplace(withSigner = false) {
    return new ethers.Contract(ADDRESSES.marketplace, _abis.marketplace, runner(withSigner));
}
export function registry(withSigner = false) {
    return new ethers.Contract(ADDRESSES.registry, _abis.registry, runner(withSigner));
}
export function reputation(withSigner = false) {
    return new ethers.Contract(ADDRESSES.reputation, _abis.reputation, runner(withSigner));
}
export function usdc(withSigner = false) {
    return new ethers.Contract(ADDRESSES.usdc, _abis.usdc, runner(withSigner));
}
