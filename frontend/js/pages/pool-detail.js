import { marketplace, registry, reputation } from '../contracts.js';
import { formatUSDC, utilizationPct, reputationTier, agentName, shortAddr, loanStateLabel, loanStateCss, formatDate, showToast } from '../utils.js';
import { getAccount, isConnected } from '../wallet.js';
import { api } from '../api.js';

export async function renderPoolDetail(agentId) {
    const app = document.getElementById('app');
    app.innerHTML = `
        <div class="page-header">
            <a href="#leaderboard" class="back-link">← Back to Leaderboard</a>
            <h1>Pool Detail</h1>
        </div>
        <div id="pool-content">
            <div class="loading-state"><div class="spinner"></div><p>Loading pool data...</p></div>
        </div>
    `;

    try {
        await loadPoolDetail(agentId);
    } catch (err) {
        document.getElementById('pool-content').innerHTML =
            `<div class="error-state">Failed to load pool: ${err.message}</div>`;
    }
}

async function loadPoolDetail(agentId) {
    const alm = marketplace();
    const reg = registry();
    const rep = reputation();
    const account = getAccount();

    // Try API for fast pool data (includes totalEarnedUsdc, utilizationPct)
    let apiPool = null;
    try { apiPool = await api.getPool(Number(agentId)); } catch { /* API offline, use contract data */ }

    // Parallel contract fetch (still needed for credit terms, lender position, recent loans)
    const [poolData, rawPool, repScore, agentInfo] = await Promise.all([
        alm.getAgentPool(agentId).catch(() => null),
        alm.agentPools(agentId).catch(() => null),  // has isActive at [6]
        rep['getReputationScore(uint256)'](agentId).catch(() => 0n),
        reg.getAgentInfoById(agentId).catch(() => null),
    ]);

    // agentPools[6] = isActive
    if (!rawPool || !rawPool[6]) {
        document.getElementById('pool-content').innerHTML =
            `<div class="error-state">No active pool found for Agent #${agentId}</div>`;
        return;
    }

    // getAgentPool: [agentAddress, totalLiquidity, availableLiquidity, totalLoaned, totalEarned, utilizationRate, lenderCount]
    const [agentAddress, totalLiq, availLiq, totalLoaned, totalEarned, utilRate, lenderCount] =
        poolData || [rawPool[1], rawPool[2], rawPool[3], rawPool[4], rawPool[5], 0n, 0n];
    const tier = reputationTier(repScore);
    const util = utilizationPct(totalLoaned, totalLiq);
    const name = agentName(agentInfo, agentId);

    // Get credit info if agent address available
    let creditLimit = 0n, interestRate = 0n, collateralReq = 0n;
    const walletAddr = agentInfo?.[2] || agentInfo?.agentWallet;
    if (walletAddr) {
        try {
            [creditLimit, interestRate, collateralReq] = await Promise.all([
                rep.calculateCreditLimit(walletAddr).catch(() => 0n),
                rep.calculateInterestRate(walletAddr).catch(() => 0n),
                rep.calculateCollateralRequirement(walletAddr).catch(() => 0n),
            ]);
        } catch {}
    }

    // My lender position (if connected)
    let myPosition = null;
    if (account) {
        try {
            myPosition = await alm.getLenderPosition(agentId, account);
        } catch {}
    }

    // Recent loans — agentLoans(address, index) iterates mapping(address=>uint256[])
    let recentLoans = [];
    if (walletAddr) {
        try {
            const loanIds = [];
            for (let i = 0; i < 100; i++) {
                try {
                    const id = await alm.agentLoans(walletAddr, i);
                    if (!id || BigInt(id) === 0n) break;
                    loanIds.push(id);
                } catch { break; }
            }
            const slice = loanIds.slice(-10).reverse();
            const raw = await Promise.all(slice.map(id => alm.loans(id).catch(() => null)));
            recentLoans = raw.filter(Boolean).map((l, i) => ({ id: slice[i], ...l }));
        } catch {}
    }

    const content = document.getElementById('pool-content');
    content.innerHTML = `
        <div class="pool-hero">
            <div class="pool-hero-title">
                <h2>${name}</h2>
                <span class="badge ${tier.css}">${Number(repScore)} — ${tier.label}</span>
            </div>
            <div class="pool-hero-actions">
                <button class="btn btn-primary" onclick="window.location.hash='supply?agentId=${agentId}'">
                    Supply Liquidity
                </button>
                ${isConnected() ? `<button class="btn btn-outline" onclick="window.location.hash='borrow'">Request Loan</button>` : ''}
            </div>
        </div>

        <div class="cards-grid">
            <div class="card stat-card">
                <div class="stat-label">Total Liquidity</div>
                <div class="stat-value">${formatUSDC(totalLiq)} USDC</div>
            </div>
            <div class="card stat-card">
                <div class="stat-label">Available</div>
                <div class="stat-value text-green">${formatUSDC(availLiq)} USDC</div>
            </div>
            <div class="card stat-card">
                <div class="stat-label">Total Loaned</div>
                <div class="stat-value text-accent">${formatUSDC(totalLoaned)} USDC</div>
            </div>
            <div class="card stat-card">
                <div class="stat-label">Total Earned</div>
                <div class="stat-value text-green">
                    ${apiPool?.totalEarnedUsdc != null
                        ? apiPool.totalEarnedUsdc.toFixed(4) + ' USDC'
                        : formatUSDC(totalEarned) + ' USDC'}
                </div>
            </div>
            <div class="card stat-card">
                <div class="stat-label">Lenders</div>
                <div class="stat-value">${Number(lenderCount || 0)}</div>
            </div>
        </div>

        <div class="card">
            <h3>Utilization</h3>
            <div class="util-bar-large-wrap">
                <div class="util-bar-large" style="width:${util}%"></div>
            </div>
            <div class="util-detail">
                <span>${util.toFixed(1)}% utilized</span>
                <span>${formatUSDC(availLiq)} USDC available of ${formatUSDC(totalLiq)} USDC total</span>
            </div>
        </div>

        <div class="cards-grid">
            <div class="card">
                <h3>Loan Terms</h3>
                <div class="info-row"><span>Credit Limit</span><span>${formatUSDC(creditLimit)} USDC</span></div>
                <div class="info-row"><span>Interest Rate</span><span>${Number(interestRate)}% APR</span></div>
                <div class="info-row"><span>Collateral Required</span><span>${Number(collateralReq)}%</span></div>
                <div class="info-row"><span>Agent Address</span><span class="monospace">${shortAddr(walletAddr || '')}</span></div>
            </div>

            ${myPosition && Number(myPosition[0]) > 0 ? `
            <div class="card highlight-card">
                <h3>My Position</h3>
                <div class="info-row"><span>Supplied</span><span>${formatUSDC(myPosition[0])} USDC</span></div>
                <div class="info-row"><span>Earned Interest</span><span class="text-green">${formatUSDC(myPosition[1])} USDC</span></div>
                <div class="info-row"><span>Deposit Date</span><span>${formatDate(myPosition[2])}</span></div>
                <div class="card-actions">
                    <button class="btn btn-sm btn-success" id="claimBtn">Claim Interest</button>
                    <button class="btn btn-sm btn-outline" onclick="window.location.hash='portfolio'">Manage</button>
                </div>
            </div>
            ` : isConnected() ? `
            <div class="card">
                <h3>My Position</h3>
                <p class="muted">You have no active position in this pool.</p>
                <button class="btn btn-primary" onclick="window.location.hash='supply?agentId=${agentId}'">
                    Supply Liquidity
                </button>
            </div>
            ` : `
            <div class="card">
                <h3>My Position</h3>
                <p class="muted">Connect your wallet to see your position.</p>
            </div>
            `}
        </div>

        <div class="card">
            <h3>Recent Loans</h3>
            ${recentLoans.length === 0
                ? '<p class="muted">No loans yet.</p>'
                : `<div class="table-wrap">
                    <table class="data-table">
                        <thead><tr><th>Loan ID</th><th>Amount</th><th>Duration</th><th>Status</th><th>Date</th></tr></thead>
                        <tbody>${recentLoans.map(l => {
                            const amt   = l[3];  // amount
                            const dur   = l[8];  // duration in seconds
                            const state = l[9];  // LoanState enum
                            const start = l[6];  // startTime
                            const end   = l[7];  // endTime
                            return `<tr>
                                <td>#${l.id}</td>
                                <td>${formatUSDC(amt)} USDC</td>
                                <td>${Math.round(Number(dur) / 86400)}d</td>
                                <td><span class="badge ${loanStateCss(state)}">${loanStateLabel(state)}</span></td>
                                <td>${formatDate(end || start)}</td>
                            </tr>`;
                        }).join('')}</tbody>
                    </table>
                   </div>`
            }
        </div>
    `;

    // Wire claim button
    const claimBtn = document.getElementById('claimBtn');
    if (claimBtn) {
        claimBtn.addEventListener('click', async () => {
            claimBtn.disabled = true;
            claimBtn.textContent = 'Claiming...';
            try {
                const alm = marketplace(true);
                const tx = await alm.claimInterest(agentId);
                await tx.wait();
                showToast('Interest claimed successfully!');
                await loadPoolDetail(agentId);
            } catch (err) {
                showToast('Claim failed: ' + err.message, true);
                claimBtn.disabled = false;
                claimBtn.textContent = 'Claim Interest';
            }
        });
    }
}
