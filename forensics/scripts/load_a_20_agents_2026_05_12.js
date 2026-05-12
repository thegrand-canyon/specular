// Track A — 20-agent horizontal scale on Arc V6.
// Creates 20 fresh agents, each with own pool + 3 lenders. Each agent borrows + repays.
// Tests multi-pool concurrent operation, accounting at scale.

require('dotenv').config();
const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

const RPC = process.env.ARC_TESTNET_RPC_URL || 'https://arc-testnet.drpc.org';
const ADDR = JSON.parse(fs.readFileSync('./src/config/arc-testnet-addresses.json'));
const V6 = ADDR.agentLiquidityMarketplace_v6;
const ABI = JSON.parse(fs.readFileSync('./artifacts/contracts/core/AgentLiquidityMarketplaceV6.sol/AgentLiquidityMarketplaceV6.json')).abi;
const REG_ABI = JSON.parse(fs.readFileSync('./artifacts/contracts/core/AgentRegistryV2.sol/AgentRegistryV2.json')).abi;
const USDC_ABI = ['function approve(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)', 'function transfer(address,uint256) returns (bool)'];
const fmt = v => Number(ethers.formatUnits(v, 6));
const OUT = './forensics/output/regression-2026-05-07';

const N_AGENTS = 20;
const N_LENDERS_PER = 3;
const FUND_ETH_AGENT = ethers.parseEther('0.15');
const FUND_ETH_LENDER = ethers.parseEther('0.05');
const FUND_USDC_LENDER = ethers.parseUnits('110', 6);
const FUND_USDC_AGENT = ethers.parseUnits('220', 6); // collateral + repay buffer
const SUPPLY_AMT = ethers.parseUnits('100', 6);
const LOAN_AMT = ethers.parseUnits('100', 6);

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function withRetry(fn, attempts = 8) {
    for (let i = 0; i < attempts; i++) {
        try { return await fn(); }
        catch (e) {
            const m = e.shortMessage || e.message || '';
            const isRate = m.includes('rate') || m.includes('408') || m.includes('410') || m.includes('429') || m.includes('-32016') || m.includes('timeout');
            if (i === attempts - 1 || !isRate) throw e;
            await sleep(2000 * Math.pow(2, i));
        }
    }
}

const log = (...a) => console.log(...a);

(async () => {
    const provider = new ethers.JsonRpcProvider(RPC, undefined, { batchMaxCount: 1 });
    const owner = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
    const v6 = new ethers.Contract(V6, ABI, owner);
    const reg = new ethers.Contract(ADDR.agentRegistryV2, REG_ABI, owner);
    const usdc = new ethers.Contract(ADDR.usdc, USDC_ABI, owner);

    log(`=== TRACK A: ${N_AGENTS} AGENTS × ${N_LENDERS_PER} LENDERS ON V6 ===`);
    log(`V6: ${V6}`);
    log(`Owner: ${owner.address}`);

    const startEth = await provider.getBalance(owner.address);
    const startUsdc = await usdc.balanceOf(owner.address);
    log(`Start ETH: ${ethers.formatEther(startEth)}, USDC: ${fmt(startUsdc)}`);

    // 1. Generate wallets
    log(`\n[1] Generating ${N_AGENTS} agents + ${N_AGENTS * N_LENDERS_PER} lenders`);
    const agents = [];
    const lenders = [];
    for (let i = 0; i < N_AGENTS; i++) {
        agents.push(ethers.Wallet.createRandom().connect(provider));
        lenders.push([]);
        for (let j = 0; j < N_LENDERS_PER; j++) {
            lenders[i].push(ethers.Wallet.createRandom().connect(provider));
        }
    }

    // 2. Fund everyone in one pass
    log('\n[2] Funding wallets');
    const startMs = Date.now();
    for (let i = 0; i < N_AGENTS; i++) {
        // Agent ETH + USDC
        await withRetry(() => owner.sendTransaction({ to: agents[i].address, value: FUND_ETH_AGENT }).then(t => t.wait()));
        await withRetry(() => usdc.transfer(agents[i].address, FUND_USDC_AGENT).then(t => t.wait()));
        for (let j = 0; j < N_LENDERS_PER; j++) {
            await withRetry(() => owner.sendTransaction({ to: lenders[i][j].address, value: FUND_ETH_LENDER }).then(t => t.wait()));
            await withRetry(() => usdc.transfer(lenders[i][j].address, FUND_USDC_LENDER).then(t => t.wait()));
        }
        if ((i + 1) % 5 === 0) log(`  funded ${i + 1}/${N_AGENTS}`);
    }
    log(`  funding done in ${((Date.now() - startMs) / 1000).toFixed(0)}s`);

    // 3. Each agent registers + creates pool + approves
    log(`\n[3] Each agent: register + createPool + approve`);
    const agentIds = [];
    const setupGas = { register: [], createPool: [] };
    for (let i = 0; i < N_AGENTS; i++) {
        const r = new ethers.Contract(ADDR.agentRegistryV2, REG_ABI, agents[i]);
        const m = new ethers.Contract(V6, ABI, agents[i]);
        const u = new ethers.Contract(ADDR.usdc, USDC_ABI, agents[i]);
        try {
            const t1 = await withRetry(() => r.register(`ipfs://load-test-A-${i}`, []));
            const r1 = await withRetry(() => t1.wait());
            setupGas.register.push(Number(r1.gasUsed));
            const aid = await withRetry(() => reg.addressToAgentId(agents[i].address));
            agentIds.push(Number(aid));
            const t2 = await withRetry(() => m.createAgentPool());
            const r2 = await withRetry(() => t2.wait());
            setupGas.createPool.push(Number(r2.gasUsed));
            await withRetry(() => u.approve(V6, FUND_USDC_AGENT).then(t => t.wait()));
        } catch (e) { log(`  agent ${i}: ${(e.shortMessage || e.message).slice(0, 60)}`); }
        if ((i + 1) % 5 === 0) log(`  setup ${i + 1}/${N_AGENTS}`);
    }

    // 4. Each lender supplies
    log(`\n[4] Each lender supplies to their pool`);
    const supplyGas = [];
    for (let i = 0; i < N_AGENTS; i++) {
        for (let j = 0; j < N_LENDERS_PER; j++) {
            const m = new ethers.Contract(V6, ABI, lenders[i][j]);
            const u = new ethers.Contract(ADDR.usdc, USDC_ABI, lenders[i][j]);
            try {
                await withRetry(() => u.approve(V6, SUPPLY_AMT).then(t => t.wait()));
                const tx = await withRetry(() => m.supplyLiquidity(agentIds[i], SUPPLY_AMT));
                const r = await withRetry(() => tx.wait());
                supplyGas.push(Number(r.gasUsed));
            } catch (e) { log(`  L${i}-${j}: ${(e.shortMessage || e.message).slice(0, 50)}`); }
        }
        if ((i + 1) % 5 === 0) log(`  supplied for ${i + 1}/${N_AGENTS}`);
    }

    // 5. Each agent borrows + repays
    log(`\n[5] Each agent borrows ${fmt(LOAN_AMT)} USDC, repays`);
    const loanGas = [];
    const repayGas = [];
    let panics = 0;
    for (let i = 0; i < N_AGENTS; i++) {
        const m = new ethers.Contract(V6, ABI, agents[i]);
        try {
            const lTx = await withRetry(() => m.requestLoan(LOAN_AMT, 30));
            const lR = await withRetry(() => lTx.wait());
            loanGas.push(Number(lR.gasUsed));
            const iface = new ethers.Interface(ABI);
            let lid;
            for (const lg of lR.logs) {
                try { const p = iface.parseLog(lg); if (p && p.name === 'LoanRequested') { lid = p.args.loanId; break; } } catch {}
            }
            const rTx = await withRetry(() => m.repayLoan(lid));
            const rR = await withRetry(() => rTx.wait());
            repayGas.push(Number(rR.gasUsed));
        } catch (e) {
            if ((e.shortMessage || e.message).includes('Panic')) panics++;
            log(`  agent ${i}: ${(e.shortMessage || e.message).slice(0, 60)}`);
        }
        if ((i + 1) % 5 === 0) log(`  loan+repay ${i + 1}/${N_AGENTS}`);
    }

    // 6. Each lender claims
    log(`\n[6] Each lender claims interest`);
    const claimGas = [];
    for (let i = 0; i < N_AGENTS; i++) {
        for (let j = 0; j < N_LENDERS_PER; j++) {
            const m = new ethers.Contract(V6, ABI, lenders[i][j]);
            try {
                const pos = await withRetry(() => v6.positions(agentIds[i], lenders[i][j].address));
                if (pos[1] > 0n) {
                    const tx = await withRetry(() => m.claimInterest(agentIds[i]));
                    const r = await withRetry(() => tx.wait());
                    claimGas.push(Number(r.gasUsed));
                }
            } catch (e) { /* skip */ }
        }
    }

    // 7. Σ invariant check
    log(`\n[7] Σ invariant check across all ${N_AGENTS} pools`);
    let sumAvail = 0n, sumLoaned = 0n, sumTotalLiq = 0n;
    for (const aid of agentIds) {
        const p = await withRetry(() => v6.getAgentPool(aid));
        sumTotalLiq += p[1];
        sumAvail += p[2];
        sumLoaned += p[3];
    }
    const mpBal = await withRetry(() => usdc.balanceOf(V6));
    log(`  Σ totalLiquidity: ${fmt(sumTotalLiq)}`);
    log(`  Σ availableLiquidity: ${fmt(sumAvail)}`);
    log(`  Σ totalLoaned: ${fmt(sumLoaned)}`);
    log(`  MP USDC balance: ${fmt(mpBal)}`);
    log(`  §S1: avail ≤ mpBal? ${sumAvail <= mpBal ? '✅' : '❌'}`);

    // Stats
    const stats = (arr) => {
        if (arr.length === 0) return { n: 0 };
        const sorted = [...arr].sort((a, b) => a - b);
        return {
            n: arr.length,
            min: sorted[0], max: sorted[sorted.length - 1],
            mean: Math.round(arr.reduce((a, b) => a + b, 0) / arr.length),
            median: sorted[Math.floor(sorted.length / 2)],
        };
    };
    log(`\n=== GAS DISTRIBUTIONS ===`);
    log(`  register: ${JSON.stringify(stats(setupGas.register))}`);
    log(`  createPool: ${JSON.stringify(stats(setupGas.createPool))}`);
    log(`  supplyLiquidity: ${JSON.stringify(stats(supplyGas))}`);
    log(`  requestLoan: ${JSON.stringify(stats(loanGas))}`);
    log(`  repayLoan: ${JSON.stringify(stats(repayGas))}`);
    log(`  claimInterest: ${JSON.stringify(stats(claimGas))}`);

    const endEth = await provider.getBalance(owner.address);
    const endUsdc = await usdc.balanceOf(owner.address);
    log(`\nEnd ETH: ${ethers.formatEther(endEth)} (Δ ${ethers.formatEther(endEth - startEth)})`);
    log(`End USDC: ${fmt(endUsdc)} (Δ ${(fmt(endUsdc) - fmt(startUsdc)).toFixed(6)})`);
    log(`§B1 panics during repay: ${panics} (must be 0)`);

    fs.writeFileSync(path.join(OUT, '43-load-a-20-agents.json'), JSON.stringify({
        n_agents: N_AGENTS, n_lenders_per: N_LENDERS_PER,
        agentIds,
        gas: { register: stats(setupGas.register), createPool: stats(setupGas.createPool),
               supplyLiquidity: stats(supplyGas), requestLoan: stats(loanGas),
               repayLoan: stats(repayGas), claimInterest: stats(claimGas) },
        invariants: { s1_holds: sumAvail <= mpBal, panics },
        deltas: { eth: ethers.formatEther(endEth - startEth), usdc: fmt(endUsdc) - fmt(startUsdc) },
    }, null, 2));
    log('\nSaved.');
})().catch(e => { console.error('FATAL:', e); process.exit(2); });
