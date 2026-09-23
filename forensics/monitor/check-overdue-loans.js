// READ-ONLY. Lists every ACTIVE loan that is past its endTime — i.e. every
// liquidation candidate.
//
// This exists because `forensics/monitor/v6-invariants.js` has NO overdue-loan
// check: a borrower a full day past endTime produces exit 0 with no findings
// (measured 2026-09-23, INCIDENT_DRILL_REPORT.md §2). `liquidateLoan` is the
// protocol's only recovery action and nothing pages anyone to run it, so this has
// to be polled. Sends no transactions.
//
// Usage:
//   node scripts/incident-drill/check-overdue-loans.js                     # arc-mainnet
//   NET=arc-staging node scripts/incident-drill/check-overdue-loans.js
//   NET=local       node scripts/incident-drill/check-overdue-loans.js
//
// Exit codes: 0 nothing overdue · 1 at least one overdue loan · 2 could not read.

const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const NETS = {
    'arc-mainnet': { file: 'src/config/arc-mainnet-addresses.json', env: 'ARC_MAINNET_RPC_URL' },
    'arc-staging': { file: 'src/config/arc-testnet-v6-addresses.json', env: 'ARC_TESTNET_RPC_URL' },
    'arc-testnet': { file: 'src/config/arc-testnet-addresses.json', env: 'ARC_TESTNET_RPC_URL' },
    'local': { file: 'src/config/local-addresses.json', env: 'LOCAL_RPC_URL' },
};
const NET = process.env.NET || process.env.V6_MONITOR_NETWORK || 'arc-mainnet';
const cfg = NETS[NET];
if (!cfg) { console.error(`unknown NET; expected one of ${Object.keys(NETS).join(', ')}`); process.exit(2); }

const A = JSON.parse(fs.readFileSync(path.join(ROOT, cfg.file)));
const RPC = process.env[cfg.env] || A.rpcUrl;
const MP = process.env.V6_MONITOR_MARKETPLACE || A.agentLiquidityMarketplace_v6;

const ABI = [
    'function nextLoanId() view returns (uint256)',
    'function loans(uint256) view returns (uint256 loanId, address borrower, uint256 agentId, uint256 amount, uint256 collateralAmount, uint256 interestRate, uint256 startTime, uint256 endTime, uint256 duration, uint8 state)',
    'function previewRepayment(uint256) view returns (uint256 interest, uint256 total, uint256 chargeableSeconds, uint256 lateSeconds)',
    'function paused() view returns (bool)',
];
const u = v => Number(ethers.formatUnits(v, 6));

(async () => {
    const p = new ethers.JsonRpcProvider(RPC, undefined, { staticNetwork: true });
    const mp = new ethers.Contract(MP, ABI, p);
    const head = await p.getBlock('latest');
    const nowTs = Number(head.timestamp);
    const paused = await mp.paused();
    const next = Number(await mp.nextLoanId());

    const overdue = [];
    for (let id = 1; id < next; id++) {
        const l = await mp.loans(id);
        if (Number(l.state) !== 1) continue;                  // 1 == ACTIVE
        if (nowTs <= Number(l.endTime)) continue;
        let owed = null;
        try { const pr = await mp.previewRepayment(id); owed = { interest: u(pr[0]), total: u(pr[1]), lateSeconds: Number(pr[3]) }; } catch {}
        overdue.push({
            loanId: id, agentId: l.agentId.toString(), borrower: l.borrower,
            principal: u(l.amount), collateral: u(l.collateralAmount),
            unsecured: u(l.amount > l.collateralAmount ? l.amount - l.collateralAmount : 0n),
            endTime: new Date(Number(l.endTime) * 1000).toISOString(),
            daysOverdue: +((nowTs - Number(l.endTime)) / 86400).toFixed(2),
            owedIfRepaidNow: owed,
        });
    }

    console.log(JSON.stringify({
        network: NET, marketplace: MP, block: head.number, chainTime: new Date(nowTs * 1000).toISOString(),
        paused, loansScanned: next - 1, overdueCount: overdue.length, overdue,
        action: overdue.length === 0 ? 'nothing to do'
            : paused ? 'OVERDUE LOANS EXIST BUT THE CONTRACT IS PAUSED — liquidateLoan is blocked by pause. Unpause before liquidating.'
            : 'liquidateLoan(loanId) as owner for each. See INCIDENT_RUNBOOK.md §3.1a for the loss waterfall.',
    }, null, 2));
    process.exit(overdue.length ? 1 : 0);
})().catch(e => { console.error('READ FAILED:', e.shortMessage || e.message); process.exit(2); });
