import { marketplace, registry, reputation, usdc } from '../contracts.js';
import { formatUSDC, parseUSDC, agentName, reputationTier, showToast, setLoading } from '../utils.js';
import { getAccount, isConnected } from '../wallet.js';
import { ADDRESSES } from '../config.js';

export async function renderSupply() {
    const app = document.getElementById('app');

    // Read agentId from query string e.g. #supply?agentId=5
    const params = new URLSearchParams(window.location.hash.split('?')[1] || '');
    const presetAgentId = params.get('agentId');

    app.innerHTML = `
        <div class="page-header">
            <a href="#leaderboard" class="back-link">← Back to Leaderboard</a>
            <h1>Supply Liquidity</h1>
        </div>

        ${!isConnected() ? `
        <div class="card">
            <div class="empty-state">
                <div class="empty-icon">🔌</div>
                <h3>Wallet Required</h3>
                <p>Connect your wallet to supply liquidity.</p>
                <button class="btn btn-primary" id="connectBtn">Connect Wallet</button>
            </div>
        </div>
        ` : `
        <div class="card form-card">
            <div class="form-group">
                <label>Agent ID</label>
                <input type="number" id="agentIdInput" class="form-input" placeholder="Enter agent ID"
                    value="${presetAgentId || ''}" min="1">
                <button class="btn btn-sm btn-outline" id="lookupBtn">Look Up Pool</button>
            </div>

            <div id="poolPreview"></div>

            <div class="form-group">
                <label>Amount to Supply (USDC)</label>
                <div class="input-with-badge">
                    <input type="number" id="supplyAmount" class="form-input" placeholder="0.00" min="0.01" step="0.01">
                    <button class="btn btn-sm btn-outline" id="maxBtn">MAX</button>
                </div>
                <div class="balance-hint" id="usdcBalanceHint">Balance: —</div>
            </div>

            <div id="supplyPreview" class="supply-preview" style="display:none"></div>

            <button class="btn btn-primary btn-block" id="supplyBtn" disabled>Supply Liquidity</button>
            <p class="hint">You must approve USDC spending before supplying (two transactions).</p>
        </div>
        `}
    `;

    if (!isConnected()) {
        document.getElementById('connectBtn')?.addEventListener('click', () => {
            document.getElementById('connectWallet').click();
        });
        return;
    }

    // Load balance
    await loadBalance();

    // Pre-fill lookup if agentId provided
    if (presetAgentId) {
        document.getElementById('agentIdInput').value = presetAgentId;
        await lookupPool();
    }

    document.getElementById('lookupBtn')?.addEventListener('click', lookupPool);
    document.getElementById('agentIdInput')?.addEventListener('keydown', e => {
        if (e.key === 'Enter') lookupPool();
    });
    document.getElementById('maxBtn')?.addEventListener('click', setMax);
    document.getElementById('supplyAmount')?.addEventListener('input', updatePreview);
    document.getElementById('supplyBtn')?.addEventListener('click', doSupply);
}

let _poolAgentId = null;
let _usdcBalance = 0n;

async function loadBalance() {
    const account = getAccount();
    const hint = document.getElementById('usdcBalanceHint');
    try {
        const bal = await usdc().balanceOf(account);
        _usdcBalance = bal;
        if (hint) hint.textContent = `Balance: ${formatUSDC(bal)} USDC`;
    } catch {
        if (hint) hint.textContent = 'Balance: unknown';
    }
}

async function lookupPool() {
    const id = document.getElementById('agentIdInput')?.value;
    if (!id) return;
    const agentId = BigInt(id);
    const preview = document.getElementById('poolPreview');
    if (preview) preview.innerHTML = '<p class="muted">Loading pool...</p>';

    try {
        const alm = marketplace();
        const reg = registry();
        const rep = reputation();

        const [poolData, repScore, agentInfo] = await Promise.all([
            alm.getAgentPool(agentId).catch(() => null),
            rep['getReputationScore(uint256)'](agentId).catch(() => 0n),
            reg.getAgentInfoById(agentId).catch(() => null),
        ]);

        if (!poolData || !poolData[5]) {
            preview.innerHTML = '<div class="error-state">No active pool for this agent ID.</div>';
            document.getElementById('supplyBtn').disabled = true;
            return;
        }

        const [agentAddress, totalLiq, availLiq, totalLoaned, totalEarned, utilRate, lenderCount] = poolData;
        const tier = reputationTier(repScore);
        const name = agentName(agentInfo, agentId);

        _poolAgentId = agentId;

        preview.innerHTML = `
            <div class="pool-mini-card">
                <div class="pool-mini-header">
                    <span>${name}</span>
                    <span class="badge ${tier.css}">${Number(repScore)}</span>
                </div>
                <div class="info-row"><span>Available Liquidity</span><span>${formatUSDC(availLiq)} USDC</span></div>
                <div class="info-row"><span>Lenders</span><span>${Number(lenderCount || 0)}</span></div>
            </div>
        `;

        document.getElementById('supplyBtn').disabled = false;
        updatePreview();
    } catch (err) {
        preview.innerHTML = `<div class="error-state">Error: ${err.message}</div>`;
    }
}

function setMax() {
    const input = document.getElementById('supplyAmount');
    if (input && _usdcBalance > 0n) {
        input.value = (Number(_usdcBalance) / 1_000_000).toFixed(6);
        updatePreview();
    }
}

function updatePreview() {
    const previewEl = document.getElementById('supplyPreview');
    const amtStr = document.getElementById('supplyAmount')?.value;
    const amt = parseUSDC(amtStr || '0');
    if (!previewEl) return;

    if (amt > 0n && _poolAgentId != null) {
        previewEl.style.display = '';
        previewEl.innerHTML = `
            <div class="info-row"><span>You are supplying</span><span>${formatUSDC(amt)} USDC</span></div>
            <div class="info-row"><span>To Agent Pool</span><span>#${_poolAgentId}</span></div>
            <p class="hint-small">Step 1: Approve USDC &rarr; Step 2: Supply</p>
        `;
    } else {
        previewEl.style.display = 'none';
    }
}

async function doSupply() {
    const amtStr = document.getElementById('supplyAmount')?.value;
    const amount = parseUSDC(amtStr || '0');
    const btn = document.getElementById('supplyBtn');

    if (!_poolAgentId || amount <= 0n) {
        showToast('Enter an amount and select a pool first', true);
        return;
    }
    if (amount > _usdcBalance) {
        showToast('Insufficient USDC balance', true);
        return;
    }

    setLoading(btn, true);

    try {
        const usdcContract = usdc(true);
        const alm = marketplace(true);

        // Step 1: Approve
        btn.textContent = 'Approving USDC...';
        const approveTx = await usdcContract.approve(ADDRESSES.marketplace, amount);
        await approveTx.wait();
        showToast('USDC approved. Now supplying...');

        // Step 2: Supply
        btn.textContent = 'Supplying...';
        const supplyTx = await alm.supplyLiquidity(_poolAgentId, amount);
        const receipt = await supplyTx.wait();

        showToast(`Successfully supplied ${formatUSDC(amount)} USDC!`);
        await loadBalance();
        await lookupPool();
    } catch (err) {
        showToast('Supply failed: ' + (err.reason || err.message), true);
    } finally {
        setLoading(btn, false);
    }
}
