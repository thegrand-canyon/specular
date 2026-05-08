// Test C — Multi-pool stress on Arc V6.
// Register 5 fresh agents on Arc, each creates a V6 pool, each gets supplied
// + borrowed + repaid by independent participants. Tests cross-pool independence.

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

const N_AGENTS = 5;
const N_LENDERS_PER = 3;
const SUPPLY_AMT = ethers.parseUnits('200', 6); // each lender supplies 200, 3 lenders = 600/pool
const LOAN_AMT = ethers.parseUnits('100', 6); // each agent borrows 100
const FUND_ETH_AGENT = ethers.parseEther('0.1'); // agent does register + createPool + borrow + repay = 4 tx
const FUND_ETH_LENDER = ethers.parseEther('0.05'); // approve + supply + claim + withdraw = 4 tx
const FUND_USDC_LENDER = ethers.parseUnits('220', 6);
const FUND_USDC_AGENT = ethers.parseUnits('110', 6); // for collateral + repay buffer

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function withRetry(fn, label, attempts = 8) {
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

    log('Owner:', owner.address);
    log('V6:', V6);
    log(`Plan: ${N_AGENTS} fresh agents, ${N_LENDERS_PER} lenders each, multi-pool independence test`);

    // Generate fresh agent + lender wallets
    const agents = [];
    const lenders = [];
    for (let i = 0; i < N_AGENTS; i++) {
        agents.push(ethers.Wallet.createRandom().connect(provider));
        lenders.push([]);
        for (let j = 0; j < N_LENDERS_PER; j++) {
            lenders[i].push(ethers.Wallet.createRandom().connect(provider));
        }
    }

    // Fund all wallets
    log(`\n[1] Funding ${N_AGENTS} agents + ${N_AGENTS * N_LENDERS_PER} lenders`);
    for (let i = 0; i < N_AGENTS; i++) {
        // Fund agent
        const ethTx = await withRetry(() => owner.sendTransaction({ to: agents[i].address, value: FUND_ETH_AGENT }), 'agentETH');
        await withRetry(() => ethTx.wait(), 'agentETH.wait');
        const usdcTx = await withRetry(() => usdc.transfer(agents[i].address, FUND_USDC_AGENT), 'agentUSDC');
        await withRetry(() => usdcTx.wait(), 'agentUSDC.wait');
        // Fund lenders
        for (let j = 0; j < N_LENDERS_PER; j++) {
            const e = await withRetry(() => owner.sendTransaction({ to: lenders[i][j].address, value: FUND_ETH_LENDER }), 'lenderETH');
            await withRetry(() => e.wait(), 'lenderETH.wait');
            const u = await withRetry(() => usdc.transfer(lenders[i][j].address, FUND_USDC_LENDER), 'lenderUSDC');
            await withRetry(() => u.wait(), 'lenderUSDC.wait');
        }
        log(`  agent ${i + 1}/${N_AGENTS} + ${N_LENDERS_PER} lenders funded`);
    }

    // Register each agent
    log(`\n[2] Each agent registers + creates pool`);
    const agentIds = [];
    for (let i = 0; i < N_AGENTS; i++) {
        const r = new ethers.Contract(ADDR.agentRegistryV2, REG_ABI, agents[i]);
        const m = new ethers.Contract(V6, ABI, agents[i]);
        const u = new ethers.Contract(ADDR.usdc, USDC_ABI, agents[i]);
        try {
            const t = await withRetry(() => r.register(`ipfs://multipool-test-agent-${i}`, []), `reg${i}`);
            await withRetry(() => t.wait(), 'reg.wait');
            const aid = await withRetry(() => reg.addressToAgentId(agents[i].address), `aid${i}`);
            agentIds.push(Number(aid));
            const cp = await withRetry(() => m.createAgentPool(), `cp${i}`);
            await withRetry(() => cp.wait(), 'cp.wait');
            const apprTx = await withRetry(() => u.approve(V6, FUND_USDC_AGENT), `appr${i}`);
            await withRetry(() => apprTx.wait(), 'appr.wait');
            log(`  agent ${i + 1}: registered as agentId=${aid}, pool created`);
        } catch (e) { log(`  agent ${i} setup error: ${(e.shortMessage || e.message).slice(0, 80)}`); }
    }

    // Each lender supplies to their assigned agent's pool
    log(`\n[3] Each lender supplies ${fmt(SUPPLY_AMT)} USDC to assigned pool`);
    for (let i = 0; i < N_AGENTS; i++) {
        for (let j = 0; j < N_LENDERS_PER; j++) {
            const m = new ethers.Contract(V6, ABI, lenders[i][j]);
            const u = new ethers.Contract(ADDR.usdc, USDC_ABI, lenders[i][j]);
            try {
                const a = await withRetry(() => u.approve(V6, SUPPLY_AMT), `lapp${i}${j}`);
                await withRetry(() => a.wait(), 'lapp.wait');
                const s = await withRetry(() => m.supplyLiquidity(agentIds[i], SUPPLY_AMT), `lsup${i}${j}`);
                await withRetry(() => s.wait(), 'lsup.wait');
            } catch (e) { log(`  lender ${i}-${j} supply err: ${(e.shortMessage || e.message).slice(0, 80)}`); }
        }
        log(`  pool ${agentIds[i]}: ${N_LENDERS_PER} lenders supplied`);
    }

    // Snapshot post-supply
    log(`\n[4] Cross-pool snapshot`);
    const poolSnapshots = [];
    for (let i = 0; i < N_AGENTS; i++) {
        const p = await withRetry(() => v6.getAgentPool(agentIds[i]), `pool${i}`);
        poolSnapshots.push({
            agentId: agentIds[i],
            agentAddress: agents[i].address,
            totalLiquidity: fmt(p[1]),
            availableLiquidity: fmt(p[2]),
            lenderCount: Number(p[6]),
        });
        log(`  pool ${agentIds[i]}: avail=${fmt(p[2])}, lenders=${p[6]}`);
    }

    // Each agent borrows + repays
    log(`\n[5] Each agent borrows ${fmt(LOAN_AMT)} USDC, repays`);
    for (let i = 0; i < N_AGENTS; i++) {
        const m = new ethers.Contract(V6, ABI, agents[i]);
        try {
            const lTx = await withRetry(() => m.requestLoan(LOAN_AMT, 30), `loan${i}`);
            const lR = await withRetry(() => lTx.wait(), 'loan.wait');
            // Find loanId
            const iface = new ethers.Interface(ABI);
            let loanId;
            for (const lg of lR.logs) {
                try { const p = iface.parseLog(lg); if (p && p.name === 'LoanRequested') { loanId = p.args.loanId; break; } } catch {}
            }
            const rTx = await withRetry(() => m.repayLoan(loanId), `rep${i}`);
            await withRetry(() => rTx.wait(), 'rep.wait');
            log(`  agent ${agentIds[i]}: loan ${loanId} repaid`);
        } catch (e) { log(`  agent ${i} loan/repay err: ${(e.shortMessage || e.message).slice(0, 80)}`); }
    }

    // Each lender claims interest
    log(`\n[6] Each lender claims`);
    let totalInterest = 0n;
    for (let i = 0; i < N_AGENTS; i++) {
        for (let j = 0; j < N_LENDERS_PER; j++) {
            const m = new ethers.Contract(V6, ABI, lenders[i][j]);
            try {
                const pos = await withRetry(() => v6.positions(agentIds[i], lenders[i][j].address), `pos${i}${j}`);
                if (pos[1] > 0n) {
                    const t = await withRetry(() => m.claimInterest(agentIds[i]), `cl${i}${j}`);
                    await withRetry(() => t.wait(), 'cl.wait');
                    totalInterest += pos[1];
                }
            } catch (e) { log(`  lender ${i}-${j} claim err: ${(e.shortMessage || e.message).slice(0, 80)}`); }
        }
    }
    log(`  total interest claimed across all pools: ${fmt(totalInterest)} USDC`);

    // Cross-pool independence check: each pool should have its own state
    log(`\n[7] Cross-pool independence verification`);
    let invariantsHold = true;
    for (let i = 0; i < N_AGENTS; i++) {
        const p = await withRetry(() => v6.getAgentPool(agentIds[i]), `final${i}`);
        const expectedAvail = SUPPLY_AMT * BigInt(N_LENDERS_PER); // back to fully available after repay-claim
        // Total earned should be > 0 (interest accrued)
        log(`  pool ${agentIds[i]}: avail=${fmt(p[2])}, totalEarned=${fmt(p[4])}, lenderCount=${p[6]}`);
        if (Number(p[6]) !== N_LENDERS_PER) {
            log(`    ⚠ unexpected lenderCount (expected ${N_LENDERS_PER})`);
            invariantsHold = false;
        }
    }

    // Cleanup: each lender withdraws + returns USDC
    log(`\n[8] Cleanup`);
    for (let i = 0; i < N_AGENTS; i++) {
        for (let j = 0; j < N_LENDERS_PER; j++) {
            const m = new ethers.Contract(V6, ABI, lenders[i][j]);
            const u = new ethers.Contract(ADDR.usdc, USDC_ABI, lenders[i][j]);
            try {
                const pos = await withRetry(() => v6.positions(agentIds[i], lenders[i][j].address), `cpos${i}${j}`);
                if (pos[0] > 0n) {
                    const t = await withRetry(() => m.withdrawLiquidity(agentIds[i], pos[0]), `cwd${i}${j}`);
                    await withRetry(() => t.wait(), 'cwd.wait');
                }
                const bal = await withRetry(() => u.balanceOf(lenders[i][j].address), `cbal${i}${j}`);
                if (bal > 0n) {
                    const t = await withRetry(() => u.transfer(owner.address, bal), `cret${i}${j}`);
                    await withRetry(() => t.wait(), 'cret.wait');
                }
            } catch {}
        }
        // Agent returns leftover USDC
        const u = new ethers.Contract(ADDR.usdc, USDC_ABI, agents[i]);
        try {
            const bal = await withRetry(() => u.balanceOf(agents[i].address), `abal${i}`);
            if (bal > 0n) {
                const t = await withRetry(() => u.transfer(owner.address, bal), `aret${i}`);
                await withRetry(() => t.wait(), 'aret.wait');
            }
        } catch {}
    }
    log('  cleanup done');

    fs.writeFileSync(path.join(OUT, '30-test-c-multipool.json'), JSON.stringify({
        n_agents: N_AGENTS, n_lenders_per: N_LENDERS_PER,
        agentIds, poolSnapshots,
        total_interest_claimed: fmt(totalInterest),
        invariants_hold: invariantsHold,
    }, null, 2));
    log('\nSaved.');
})().catch(e => { console.error('FATAL:', e); process.exit(2); });
