import { marketplace, registry, reputation, usdc } from '../contracts.js';
import { formatUSDC, parseUSDC, loanStateLabel, loanStateCss, formatDate, showToast, setLoading } from '../utils.js';
import { getAccount, isConnected } from '../wallet.js';
import { ADDRESSES } from '../config.js';

export async function renderBorrow() {
    const app = document.getElementById('app');
    app.innerHTML = `
        <div class="page-header">
            <h1>Request a Loan</h1>
            <p class="subtitle">Borrow USDC against your agent reputation</p>
        </div>
        <div id="borrow-content">
            <div class="loading-state"><div class="spinner"></div><p>Checking agent status...</p></div>
        </div>
    `;

    if (!isConnected()) {
        document.getElementById('borrow-content').innerHTML = `
            <div class="card">
                <div class="empty-state">
                    <div class="empty-icon">🔌</div>
                    <h3>Wallet Required</h3>
                    <p>Connect your wallet to request a loan.</p>
                    <button class="btn btn-primary" onclick="document.getElementById('connectWallet').click()">
                        Connect Wallet
                    </button>
                </div>
            </div>
        `;
        return;
    }

    await loadBorrowPage();
}

async function loadBorrowPage() {
    const account = getAccount();
    const reg = registry();
    const rep = reputation();
    const alm = marketplace();
    const content = document.getElementById('borrow-content');

    try {
        // Check if registered agent
        const agentId = await reg.addressToAgentId(account).catch(() => 0n);
        if (!agentId || BigInt(agentId) === 0n) {
            content.innerHTML = `
                <div class="card">
                    <div class="empty-state">
                        <div class="empty-icon">🤖</div>
                        <h3>Not Registered as Agent</h3>
                        <p>Your wallet is not registered as an agent. Run the bot simulation to register,
                           or register manually via the contract.</p>
                    </div>
                </div>
            `;
            return;
        }

        const [creditLimit, interestRate, collateralReq, repScore, poolData, balance] = await Promise.all([
            rep.calculateCreditLimit(account).catch(() => 0n),
            rep.calculateInterestRate(account).catch(() => 0n),
            rep.calculateCollateralRequirement(account).catch(() => 0n),
            rep['getReputationScore(uint256)'](agentId).catch(() => 0n),
            alm.getAgentPool(agentId).catch(() => null),
            usdc().balanceOf(account).catch(() => 0n),
        ]);

        // Existing loans — agentLoans is mapping(address=>uint256[]) so getter is (address, index)
        let activeLoans = [];
        try {
            const loanIds = [];
            for (let i = 0; i < 50; i++) {
                try {
                    const id = await alm.agentLoans(account, i);
                    if (!id || BigInt(id) === 0n) break;
                    loanIds.push(id);
                } catch { break; }
            }
            const all = await Promise.all(loanIds.map(id => alm.loans(id).catch(() => null)));
            activeLoans = all.filter(l => l && Number(l[9]) === 1); // state 1 = Active
        } catch {}

        const poolAvail = poolData ? poolData[2] : 0n; // availableLiquidity

        content.innerHTML = `
            <div class="cards-grid">
                <div class="card stat-card">
                    <div class="stat-label">Credit Limit</div>
                    <div class="stat-value">${formatUSDC(creditLimit)} USDC</div>
                </div>
                <div class="card stat-card">
                    <div class="stat-label">Interest Rate</div>
                    <div class="stat-value">${Number(interestRate)}% APR</div>
                </div>
                <div class="card stat-card">
                    <div class="stat-label">Reputation Score</div>
                    <div class="stat-value">${Number(repScore)}</div>
                </div>
                <div class="card stat-card">
                    <div class="stat-label">USDC Balance</div>
                    <div class="stat-value">${formatUSDC(balance)}</div>
                </div>
            </div>

            <div class="card form-card">
                <h3>New Loan Request</h3>

                ${Number(collateralReq) > 0 ? `
                <div class="alert alert-warning">
                    ⚠️ Your reputation requires <strong>${Number(collateralReq)}% collateral</strong>.
                    Collateral will be held until you repay the loan.
                </div>` : `
                <div class="alert alert-success">
                    ✅ No collateral required at your reputation level.
                </div>`}

                <div class="form-group">
                    <label>Loan Amount (USDC)</label>
                    <input type="number" id="loanAmount" class="form-input" placeholder="0.00"
                        max="${Number(creditLimit) / 1e6}" min="1" step="1">
                    <div class="balance-hint">Max: ${formatUSDC(creditLimit)} USDC (credit limit)</div>
                </div>

                <div class="form-group">
                    <label>Duration (days)</label>
                    <input type="number" id="loanDuration" class="form-input" value="30" min="7" max="365">
                    <div class="balance-hint">Min 7 days, Max 365 days</div>
                </div>

                <div id="loanPreview" class="supply-preview" style="display:none"></div>

                <button class="btn btn-primary btn-block" id="borrowBtn">Request Loan</button>
            </div>

            ${activeLoans.length > 0 ? `
            <div class="card">
                <h3>Active Loans (${activeLoans.length})</h3>
                <div class="table-wrap">
                    <table class="data-table">
                        <thead><tr><th>Loan ID</th><th>Amount</th><th>Due</th><th>Status</th><th></th></tr></thead>
                        <tbody id="activeLoansBody">
                            ${activeLoans.map((l, i) => `
                            <tr>
                                <td>#${l[0]}</td>
                                <td>${formatUSDC(l[3])} USDC</td>
                                <td>${formatDate(l[7])}</td>
                                <td><span class="badge ${loanStateCss(l[9])}">${loanStateLabel(l[9])}</span></td>
                                <td><button class="btn btn-sm btn-danger" data-loanid="${l[0]}">Repay</button></td>
                            </tr>
                            `).join('')}
                        </tbody>
                    </table>
                </div>
            </div>
            ` : ''}
        `;

        // Wire events
        document.getElementById('loanAmount')?.addEventListener('input', () => updateLoanPreview(collateralReq, interestRate));
        document.getElementById('loanDuration')?.addEventListener('input', () => updateLoanPreview(collateralReq, interestRate));
        document.getElementById('borrowBtn')?.addEventListener('click', () => doRequestLoan(collateralReq));

        // Repay buttons
        document.querySelectorAll('[data-loanid]').forEach(btn => {
            btn.addEventListener('click', () => doRepayLoan(BigInt(btn.dataset.loanid)));
        });

    } catch (err) {
        content.innerHTML = `<div class="error-state">Error: ${err.message}</div>`;
    }
}

function updateLoanPreview(collateralReq, interestRate) {
    const amtStr = document.getElementById('loanAmount')?.value;
    const durStr = document.getElementById('loanDuration')?.value;
    const preview = document.getElementById('loanPreview');
    if (!preview) return;

    const amt = parseUSDC(amtStr || '0');
    const dur = parseInt(durStr || '0');

    if (amt > 0n && dur >= 7) {
        const collateral = (amt * BigInt(Number(collateralReq))) / 100n;
        const approxInterest = (amt * BigInt(Number(interestRate)) * BigInt(dur)) / (100n * 365n);

        preview.style.display = '';
        preview.innerHTML = `
            <div class="info-row"><span>Loan Amount</span><span>${formatUSDC(amt)} USDC</span></div>
            <div class="info-row"><span>Duration</span><span>${dur} days</span></div>
            ${Number(collateral) > 0 ? `<div class="info-row text-warning"><span>Collateral Required</span><span>${formatUSDC(collateral)} USDC</span></div>` : ''}
            <div class="info-row"><span>Est. Interest</span><span>${formatUSDC(approxInterest)} USDC</span></div>
        `;
    } else {
        preview.style.display = 'none';
    }
}

async function doRequestLoan(collateralReq) {
    const amtStr = document.getElementById('loanAmount')?.value;
    const durStr = document.getElementById('loanDuration')?.value;
    const amount = parseUSDC(amtStr || '0');
    const duration = parseInt(durStr || '0');
    const btn = document.getElementById('borrowBtn');

    if (amount <= 0n || duration < 7 || duration > 365) {
        showToast('Enter a valid amount (min 1 USDC) and duration (7–365 days)', true);
        return;
    }

    setLoading(btn, true);

    try {
        const collateral = (amount * BigInt(Number(collateralReq))) / 100n;

        if (collateral > 0n) {
            btn.textContent = 'Approving collateral...';
            const usdcContract = usdc(true);
            const approveTx = await usdcContract.approve(ADDRESSES.marketplace, collateral);
            await approveTx.wait();
            showToast('Collateral approved. Requesting loan...');
        }

        btn.textContent = 'Requesting loan...';
        const alm = marketplace(true);
        const LOAN_SIG = ethers.id('LoanRequested(uint256,uint256,address,uint256)');
        const tx = await alm.requestLoan(amount, duration);
        const receipt = await tx.wait();

        let loanId = null;
        for (const log of receipt.logs) {
            if (log.topics[0] === LOAN_SIG && log.topics.length >= 2) {
                loanId = BigInt(log.topics[1]);
                break;
            }
        }

        showToast(`Loan #${loanId} requested successfully! ${formatUSDC(amount)} USDC disbursed.`);
        await loadBorrowPage();
    } catch (err) {
        showToast('Loan request failed: ' + (err.reason || err.message), true);
        setLoading(btn, false);
    }
}

async function doRepayLoan(loanId) {
    const btn = document.querySelector(`[data-loanid="${loanId}"]`);
    setLoading(btn, true);

    try {
        const alm = marketplace();
        const loan = await alm.loans(loanId);
        const principal = loan[3];
        const interestRate = loan[5];
        const duration = loan[8];
        const interest = await alm.calculateInterest(principal, interestRate, duration);
        const total = principal + interest;

        const usdcContract = usdc(true);
        const approveTx = await usdcContract.approve(ADDRESSES.marketplace, total);
        await approveTx.wait();

        const almSigner = marketplace(true);
        const repayTx = await almSigner.repayLoan(loanId);
        await repayTx.wait();

        showToast(`Loan #${loanId} repaid! Total: ${formatUSDC(total)} USDC`);
        await loadBorrowPage();
    } catch (err) {
        showToast('Repayment failed: ' + (err.reason || err.message), true);
        setLoading(btn, false);
    }
}
