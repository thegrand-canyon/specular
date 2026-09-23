// READ-ONLY. Proves that every lever INCIDENT_RUNBOOK.md tells a human to reach for
// actually exists, with that exact signature, on the CURRENTLY DEPLOYED contracts —
// and that the owner-only ones are owner-gated.
//
// Method: `eth_call` only. A simulated call from the owner address exercises the real
// deployed bytecode (dispatcher + modifiers + body) without broadcasting anything, so
// it distinguishes "function is absent" (no matching selector → the fallback reverts
// with empty data) from "function exists and reverted for a business reason" (a revert
// string) from "function exists and would succeed".
//
// It NEVER sends a transaction and holds no private key.
//
//   node scripts/incident-drill/verify-runbook-levers.js            # arc-mainnet
//   NET=arc-staging node scripts/incident-drill/verify-runbook-levers.js
//
// Exit codes: 0 every runbook lever present and correctly gated · 1 at least one
// MISSING or mis-gated · 2 could not read.

const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const NETS = {
    'arc-mainnet': { file: 'src/config/arc-mainnet-addresses.json', env: 'ARC_MAINNET_RPC_URL' },
    'arc-staging': { file: 'src/config/arc-testnet-v6-addresses.json', env: 'ARC_TESTNET_RPC_URL' },
};
const NET = process.env.NET || 'arc-mainnet';
if (!NETS[NET]) { console.error(`unknown NET; expected ${Object.keys(NETS).join(', ')}`); process.exit(2); }
const A = JSON.parse(fs.readFileSync(path.join(ROOT, NETS[NET].file)));
const RPC = process.env[NETS[NET].env] || A.rpcUrl;
const STRANGER = '0x000000000000000000000000000000000000dEaD';

let missing = 0, misgated = 0, checked = 0;
const rows = [];

// Classify one simulated call.
//   absent      — no such selector on the deployed contract
//   ok          — selector present; call would succeed
//   revert:...  — selector present; reverted with a reason (still proves it exists)
async function probe(provider, addr, sig, args, from) {
    const iface = new ethers.Interface([`function ${sig}`]);
    const name = sig.slice(0, sig.indexOf('('));
    const data = iface.encodeFunctionData(name, args);
    try {
        await provider.call({ to: addr, data, from });
        return { state: 'ok' };
    } catch (e) {
        const body = e.data ?? e.info?.error?.data ?? null;
        const reason = e.reason || e.shortMessage || e.message || '';
        // An unknown selector hits the (absent) fallback and reverts with NO return data.
        if ((body === '0x' || body === null || body === undefined) && /missing revert data|require\(false\)|CALL_EXCEPTION/i.test(reason) && !e.reason) {
            return { state: 'absent', reason: reason.slice(0, 90) };
        }
        // OZ v5 reverts with custom errors, which carry no reason string. Decode the
        // two that matter here by selector so "blocked because you are not the owner"
        // is distinguishable from "blocked for a business reason".
        const sel = typeof body === 'string' ? body.slice(0, 10) : '';
        const CUSTOM = { '0x118cdaa7': 'OwnableUnauthorizedAccount', '0xd93c0665': 'EnforcedPause', '0x8dfc202b': 'ExpectedPause', '0x1e4fbdf7': 'OwnableInvalidOwner' };
        if (CUSTOM[sel]) return { state: 'revert', reason: CUSTOM[sel] };
        return { state: 'revert', reason: (e.reason || reason).slice(0, 90) };
    }
}

async function check(provider, label, addr, sig, args, { ownerOnly = false, owner } = {}) {
    checked++;
    const asOwner = await probe(provider, addr, sig, args, owner);
    const row = { contract: label, signature: sig, asOwner: asOwner.state, detail: asOwner.reason || '' };
    if (asOwner.state === 'absent') { row.verdict = 'MISSING'; missing++; }
    else row.verdict = 'present';
    if (ownerOnly && asOwner.state !== 'absent') {
        const asStranger = await probe(provider, addr, sig, args, STRANGER);
        row.asStranger = asStranger.state;
        row.strangerReason = asStranger.reason || '';
        const gated = asStranger.state === 'revert' && /Ownable|owner|caller is not/i.test(asStranger.reason || '');
        row.ownerGated = gated;
        if (!gated) { row.verdict = 'NOT OWNER-GATED'; misgated++; }
    }
    rows.push(row);
}

(async () => {
    const provider = new ethers.JsonRpcProvider(RPC, undefined, { staticNetwork: true });
    const mpAddr = A.agentLiquidityMarketplace_v6;
    const mp = new ethers.Contract(mpAddr, ['function owner() view returns (address)', 'function reputationManager() view returns (address)'], provider);
    const owner = await mp.owner();
    const rmAddr = await mp.reputationManager();
    const regAddr = A.agentRegistryV2;
    const faAddr = A.agentCreditFaucet;

    // --- marketplace levers named in INCIDENT_RUNBOOK.md §3, §4.1, §5 -----------------
    const M = [
        ['pause()', [], true], ['unpause()', [], true],
        ['setPlatformFeeRate(uint256)', [100n], true],
        ['setMinSupplyAmount(uint256)', [10000000n], true],
        ['setMinHoldForReputationReward(uint256)', [86400n], true],
        ['setBindBorrowToPoolCreator(bool)', [true], true],
        ['liquidateLoan(uint256)', [1n], true],
        ['withdrawFees(uint256)', [1n], true],
        ['compactPoolLenders(uint256)', [1n], true],
        ['resetPoolAccounting(uint256)', [1n], true],
        ['setMigrationFinalized()', [], true],
        ['seedPool(uint256,address,uint256,uint256,uint256)', [1n, STRANGER, 0n, 0n, 0n], true],
        ['seedPosition(uint256,address,uint256,uint256,uint256)', [1n, STRANGER, 0n, 0n, 0n], true],
        ['transferOwnership(address)', [owner], true],
        ['acceptOwnership()', [], false],
        ['renounceOwnership()', [], true],
    ];
    for (const [sig, args, ownerOnly] of M) await check(provider, 'marketplace', mpAddr, sig, args, { ownerOnly, owner });
    // views the runbook's triage steps depend on
    for (const [sig, args] of [
        ['selfStake(uint256)', [1n]], ['requiredSelfStake(uint256,uint256)', [1n, 0n]],
        ['qualifiedAmountAt(uint256,address,uint256)', [1n, owner, 0n]],
        ['previewRepayment(uint256)', [1n]], ['getActiveLoanIds(uint256)', [1n]],
        ['outstandingPrincipal(uint256)', [1n]], ['activeLoanCount(uint256)', [1n]],
        ['MAX_ACTIVE_LOANS_PER_AGENT()', []], ['migrationFinalized()', []],
    ]) await check(provider, 'marketplace(view)', mpAddr, sig, args, { owner });

    // --- ReputationManagerV4 levers, §4.2 --------------------------------------------
    const R = [
        ['setTierLimits(uint256[6])', [[1000000000n, 5000000000n, 10000000000n, 10000000000n, 2500000000n, 5000000000n]], true],
        ['setLadderParameters(uint256,uint256,uint256,uint256)', [2n, 100000000n, 100000000n, 604800n], true],
        ['setDefaultLockout(uint256)', [15552000n], true],
        ['setReputationRateLimit(uint256,uint256)', [5n, 86400n], true],
        ['setScoringParameters(uint256,uint256,uint256,uint256)', [10n, 50n, 100n, 1000000000n], true],
        ['setBonusReferenceAmount(uint256)', [100000000n], true],
        ['setLatePenaltyParameters(uint256,uint256,uint256)', [10n, 5n, 100n], true],
        ['setValidationBonusParameters(uint256,uint256)', [75n, 2000000000n], true],
        ['setValidationRegistry(address)', [ethers.ZeroAddress], true],
        ['authorizePool(address)', [STRANGER], true],
        ['revokePool(address)', [STRANGER], true],
        ['transferOwnership(address)', [owner], true],
        ['renounceOwnership()', [], true],
    ];
    for (const [sig, args, ownerOnly] of R) await check(provider, 'reputation', rmAddr, sig, args, { ownerOnly, owner });
    for (const [sig, args] of [['calculateCreditLimit(address)', [owner]], ['MAX_TIER_LIMIT()', []], ['validationRegistry()', []]])
        await check(provider, 'reputation(view)', rmAddr, sig, args, { owner });

    // --- AgentRegistryV2, §4.3 --------------------------------------------------------
    for (const [sig, args, ownerOnly] of [
        ['deactivateAgent(uint256)', [1n], true],
        ['reactivateAgent(uint256)', [1n], true],
        ['pause()', [], true],
        ['transferOwnership(address)', [owner], true],
        ['renounceOwnership()', [], true],
    ]) await check(provider, 'registry', regAddr, sig, args, { ownerOnly, owner });
    await check(provider, 'registry(view)', regAddr, 'isAgentActive(address)', [owner], { owner });

    // --- AgentCreditFaucet, §4.4 ------------------------------------------------------
    for (const [sig, args, ownerOnly] of [
        ['drain(uint256)', [1n], true],
        ['setClaimAmount(uint256)', [1000000n], true],
        ['setMaxEligibleAgentId(uint256)', [100n], true],
        ['transferOwnership(address)', [owner], true],
        ['renounceOwnership()', [], true],
    ]) await check(provider, 'faucet', faAddr, sig, args, { ownerOnly, owner });

    console.log(JSON.stringify({
        network: NET, rpc: RPC, block: await provider.getBlockNumber(),
        marketplace: mpAddr, reputation: rmAddr, registry: regAddr, faucet: faAddr, owner,
        checked, missing, notOwnerGated: misgated, rows,
    }, null, 2));
    process.exit(missing || misgated ? 1 : 0);
})().catch(e => { console.error('READ FAILED:', e.shortMessage || e.message); process.exit(2); });
