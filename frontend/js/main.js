import { loadAbis } from './contracts.js';
import { connectWallet, setupWalletEvents, getAccount, isConnected, shortAddr } from './wallet.js';
import { initRouter } from './router.js';
import { showToast } from './utils.js';

async function init() {
    // Load ABIs first (required before any contract interaction)
    try {
        await loadAbis();
    } catch (err) {
        document.getElementById('app').innerHTML = `
            <div class="error-state" style="margin:4rem auto;max-width:600px">
                <h2>Failed to load contract ABIs</h2>
                <p>${err.message}</p>
                <p>Make sure you are serving this directory over HTTP (not file://).</p>
            </div>
        `;
        return;
    }

    // Setup wallet events (account/chain changes)
    setupWalletEvents(account => {
        updateWalletUI(account);
        // Re-render current page to reflect new account state
        window.dispatchEvent(new HashChangeEvent('hashchange'));
    });

    // Connect button
    const connectBtn = document.getElementById('connectWallet');
    connectBtn?.addEventListener('click', async () => {
        try {
            const { account } = await connectWallet();
            updateWalletUI(account);
            showToast(`Connected: ${account.slice(0, 6)}...${account.slice(-4)}`);
            // Re-render current page
            window.dispatchEvent(new HashChangeEvent('hashchange'));
        } catch (err) {
            showToast('Connection failed: ' + err.message, true);
        }
    });

    // Auto-connect if previously connected (MetaMask remembers)
    if (window.ethereum) {
        try {
            const accounts = await window.ethereum.request({ method: 'eth_accounts' });
            if (accounts.length > 0) {
                await connectWallet();
                updateWalletUI(accounts[0]);
            }
        } catch {}
    }

    // Start router
    initRouter();
}

function updateWalletUI(account) {
    const btn     = document.getElementById('connectWallet');
    const display = document.getElementById('accountDisplay');

    if (account) {
        if (btn)     btn.textContent = 'Connected';
        if (display) display.textContent = account.slice(0, 6) + '...' + account.slice(-4);
        if (display) display.title = account;
    } else {
        if (btn)     btn.textContent = 'Connect Wallet';
        if (display) display.textContent = '';
    }
}

init();
