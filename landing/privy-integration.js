/**
 * Privy Integration for Specular Landing Page
 *
 * Handles wallet creation via social login (Google, Twitter, Email)
 * No seed phrases required - Privy manages custody via MPC
 */

// Privy Configuration
// NOTE: You'll need to set this in production from environment variables
const PRIVY_APP_ID = 'YOUR_PRIVY_APP_ID'; // Get from dashboard.privy.io

// State
let privyUser = null;
let privyWallet = null;

// ============================================================================
// Initialize Privy (called on page load)
// ============================================================================

// For now, we'll use a mock implementation until you get a Privy App ID
// To enable real Privy integration:
// 1. Sign up at https://dashboard.privy.io/
// 2. Create a new app
// 3. Replace PRIVY_APP_ID above
// 4. Add this script tag to index.html: <script src="https://cdn.privy.io/privy.js"></script>

document.addEventListener('DOMContentLoaded', () => {
    // Check if Privy SDK is loaded
    if (typeof window.Privy !== 'undefined') {
        initPrivy();
    } else {
        console.warn('Privy SDK not loaded - using mock mode');
        initMockPrivy();
    }
});

async function initPrivy() {
    try {
        // Initialize Privy
        const privy = new window.Privy({
            appId: PRIVY_APP_ID,
            onSuccess: handlePrivySuccess,
            onError: handlePrivyError
        });

        // Attach login handler
        document.getElementById('privy-login-btn').addEventListener('click', () => {
            privy.login();
        });

        console.log('✅ Privy initialized');
    } catch (error) {
        console.error('Failed to initialize Privy:', error);
        // Fall back to mock mode
        initMockPrivy();
    }
}

function handlePrivySuccess(user) {
    console.log('Privy login success:', user);

    privyUser = user;
    privyWallet = user.wallet;

    // Notify onboarding.js
    if (window.onWalletCreated) {
        window.onWalletCreated(privyWallet.address);
    }
}

function handlePrivyError(error) {
    console.error('Privy error:', error);
    alert(`Login failed: ${error.message || 'Unknown error'}`);
}

// ============================================================================
// Mock Implementation (for development without Privy App ID)
// ============================================================================

function initMockPrivy() {
    console.log('🔧 Using mock Privy implementation');

    document.getElementById('privy-login-btn').addEventListener('click', mockPrivyLogin);
}

async function mockPrivyLogin() {
    // Simulate login delay
    document.getElementById('privy-login-btn').disabled = true;
    document.getElementById('privy-login-btn').textContent = 'Signing in...';

    await new Promise(resolve => setTimeout(resolve, 1500));

    // Generate mock wallet address
    const mockAddress = '0x' + Array.from({length: 40}, () =>
        Math.floor(Math.random() * 16).toString(16)
    ).join('');

    privyUser = {
        email: 'demo@specular.xyz',
        wallet: {
            address: mockAddress
        }
    };

    privyWallet = privyUser.wallet;

    // Reset button
    document.getElementById('privy-login-btn').disabled = false;
    document.getElementById('privy-login-btn').textContent = 'Sign In with Privy';

    // Notify onboarding.js
    if (window.onWalletCreated) {
        window.onWalletCreated(mockAddress);
    }

    console.log('✅ Mock wallet created:', mockAddress);
}

// ============================================================================
// Export Wallet Access
// ============================================================================

window.getPrivyWallet = async function() {
    if (!privyWallet) {
        throw new Error('No wallet found. Please sign in first.');
    }

    // SECURITY: this is a MOCK. A real Privy integration returns Privy's own
    // ethers Signer here. It must NEVER return an in-browser Wallet.createRandom()
    // as a user signer — a throwaway keypair unrelated to the user's funded
    // address would irrecoverably lock/lose any funds sent to or signed with it.
    // Fail closed: only allow the random-wallet path in an explicit demo mode so
    // it can never be silently wired into a live borrow/supply flow.
    const demoMode = window.SPECULAR_PRIVY_DEMO === true;
    if (demoMode && typeof window.ethers !== 'undefined') {
        console.warn('[Privy MOCK] returning an ephemeral demo wallet — NOT for real transactions');
        return window.ethers.Wallet.createRandom();
    }
    if (!privyWallet) {
        throw new Error('Privy signer unavailable: real Privy integration not configured. ' +
            'Refusing to sign with a throwaway mock wallet (set window.SPECULAR_PRIVY_DEMO=true only for UI demos).');
    }
    return privyWallet;
};

window.getPrivyUser = function() {
    return privyUser;
};

// ============================================================================
// Helper Functions
// ============================================================================

function isPrivyLoaded() {
    return typeof window.Privy !== 'undefined';
}

function isWalletConnected() {
    return privyWallet !== null;
}

// Export for debugging
window.privyDebug = {
    isLoaded: isPrivyLoaded,
    isConnected: isWalletConnected,
    getUser: () => privyUser,
    getWallet: () => privyWallet
};
