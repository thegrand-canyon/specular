import { ARC_TESTNET } from './config.js';
import { showToast } from './utils.js';

let _provider = null;
let _signer   = null;
let _account  = null;

export async function connectWallet() {
    if (!window.ethereum) throw new Error('MetaMask not installed. Please install it to use this app.');

    const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
    _account = accounts[0];

    _provider = new ethers.BrowserProvider(window.ethereum);
    await ensureArcNetwork(_provider);
    _signer = await _provider.getSigner();

    return { provider: _provider, signer: _signer, account: _account };
}

async function ensureArcNetwork(provider) {
    const network = await provider.getNetwork();
    if (Number(network.chainId) === ARC_TESTNET.chainId) return;

    try {
        await window.ethereum.request({
            method: 'wallet_switchEthereumChain',
            params: [{ chainId: ARC_TESTNET.chainIdHex }],
        });
    } catch (err) {
        if (err.code === 4902) {
            await window.ethereum.request({
                method: 'wallet_addEthereumChain',
                params: [{
                    chainId:           ARC_TESTNET.chainIdHex,
                    chainName:         ARC_TESTNET.chainName,
                    rpcUrls:           [ARC_TESTNET.rpcUrl],
                    nativeCurrency:    ARC_TESTNET.nativeCurrency,
                    blockExplorerUrls: ARC_TESTNET.blockExplorerUrls,
                }],
            });
        } else {
            throw err;
        }
    }
}

export function setupWalletEvents(onAccountChange) {
    if (!window.ethereum) return;
    window.ethereum.on('accountsChanged', accts => {
        _account = accts[0] || null;
        if (!_account) {
            _signer = null;
            showToast('Wallet disconnected');
        }
        onAccountChange(_account);
    });
    window.ethereum.on('chainChanged', () => window.location.reload());
}

export function getProvider() { return _provider; }
export function getSigner()   { return _signer;   }
export function getAccount()  { return _account;  }
export function isConnected() { return !!_account; }

// Read-only provider for view calls when wallet not connected
export function getReadProvider() {
    return new ethers.JsonRpcProvider(ARC_TESTNET.rpcUrl);
}
