'use strict';
/**
 * Pool Analytics Tool
 *
 * Analyzes all lending pools on Arc Testnet:
 * - Total Value Locked (TVL)
 * - Utilization rates
 * - Interest earned
 * - Top pools by liquidity
 * - Agent activity
 */

require('dotenv').config();

const { ethers } = require('ethers');
const ADDRESSES = require('../config/arc-testnet-addresses.json');

const RPC_URL = process.env.ARC_TESTNET_RPC_URL || 'https://arc-testnet.drpc.org';

const MKT_ABI = [
    'function agentPoolIds(uint256) view returns (uint256)',
    'function agentPools(uint256) view returns (uint256 agentId, address agentAddress, uint256 totalLiquidity, uint256 availableLiquidity, uint256 totalLoaned, uint256 totalEarned, bool isActive)',
    'function poolLenders(uint256, uint256) view returns (address)',
    'function positions(uint256, address) view returns (uint256 amount, uint256 depositTimestamp, uint256 earned)',
];

const REP_ABI = [
    'function getReputationScore(uint256 agentId) view returns (uint256)',
    'function tierForScore(uint256 score) view returns (uint8)',
];

const TIERS = ['UNRATED', 'HIGH_RISK', 'MEDIUM_RISK', 'LOW_RISK', 'EXCELLENT'];

async function main() {
    console.log('\n' + '═'.repeat(70));
    console.log('  Specular Pool Analytics — Arc Testnet');
    console.log('═'.repeat(70));

    const provider = new ethers.JsonRpcProvider(RPC_URL, undefined, { batchMaxCount: 1 });
    const mkt = new ethers.Contract(ADDRESSES.agentLiquidityMarketplace, MKT_ABI, provider);
    const rep = new ethers.Contract(ADDRESSES.reputationManagerV3, REP_ABI, provider);

    // Fetch all pools by iterating agent IDs (not index array)
    const pools = [];
    for (let agentId = 1; agentId <= 200; agentId++) {
        try {
            const pool = await mkt.agentPools(agentId);
            if (!pool.isActive) continue;
            if (pool.totalLiquidity === 0n) continue;

            let score = 0n;
            let tier = 0;
            try {
                score = await rep['getReputationScore(uint256)'](agentId);
                // Calculate tier manually based on score
                const s = Number(score);
                if (s >= 800) tier = 4;
                else if (s >= 600) tier = 3;
                else if (s >= 400) tier = 2;
                else if (s >= 200) tier = 1;
                else tier = 0;
            } catch {
                // Agent might not be in reputation system yet
                score = 0n;
                tier = 0;
            }

            // Count lenders
            let lenderCount = 0;
            for (let j = 0; j < 50; j++) {
                try {
                    const lender = await mkt.poolLenders(agentId, j);
                    if (lender === ethers.ZeroAddress) break;
                    lenderCount++;
                } catch {
                    break;
                }
            }

            const totalLiq = Number(pool.totalLiquidity) / 1e6;
            const availLiq = Number(pool.availableLiquidity) / 1e6;
            const loaned = Number(pool.totalLoaned) / 1e6;
            const earned = Number(pool.totalEarned) / 1e6;
            const util = totalLiq > 0 ? ((loaned / totalLiq) * 100) : 0;

            pools.push({
                id: agentId,
                agent: pool.agentAddress,
                score: Number(score),
                tier: TIERS[tier],
                totalLiq,
                availLiq,
                loaned,
                earned,
                util,
                lenders: lenderCount,
            });
        } catch (err) {
            if (err.message?.includes('bad result')) break;
            throw err;
        }
    }

    if (pools.length === 0) {
        console.log('\n[INFO] No active pools found\n');
        return;
    }

    // Calculate totals
    const totalTVL = pools.reduce((sum, p) => sum + p.totalLiq, 0);
    const totalLoaned = pools.reduce((sum, p) => sum + p.loaned, 0);
    const totalEarned = pools.reduce((sum, p) => sum + p.earned, 0);
    const avgUtil = pools.reduce((sum, p) => sum + p.util, 0) / pools.length;

    console.log(`\n${'─'.repeat(70)}`);
    console.log('  Protocol Overview');
    console.log('─'.repeat(70));
    console.log(`  Active Pools:    ${pools.length}`);
    console.log(`  Total TVL:       ${totalTVL.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDC`);
    console.log(`  Total Loaned:    ${totalLoaned.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDC`);
    console.log(`  Total Earned:    ${totalEarned.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDC`);
    console.log(`  Avg Utilization: ${avgUtil.toFixed(1)}%`);

    // Tier distribution
    const tierCounts = {};
    pools.forEach(p => {
        tierCounts[p.tier] = (tierCounts[p.tier] || 0) + 1;
    });

    console.log(`\n${'─'.repeat(70)}`);
    console.log('  Agent Tier Distribution');
    console.log('─'.repeat(70));
    TIERS.forEach(tier => {
        const count = tierCounts[tier] || 0;
        if (count > 0) {
            const pct = (count / pools.length * 100).toFixed(1);
            console.log(`  ${tier.padEnd(15)} ${count.toString().padStart(3)} (${pct.padStart(5)}%)`);
        }
    });

    // Top pools by liquidity
    const topPools = [...pools].sort((a, b) => b.totalLiq - a.totalLiq).slice(0, 10);

    console.log(`\n${'─'.repeat(70)}`);
    console.log('  Top 10 Pools by Total Liquidity');
    console.log('─'.repeat(70));
    console.log('  Rank | Pool ID | Agent            | TVL (USDC) | Util  | Tier');
    console.log('─'.repeat(70));

    topPools.forEach((p, i) => {
        const rank = (i + 1).toString().padStart(5);
        const id = `#${p.id}`.padEnd(8);
        const agent = `${p.agent.slice(0, 8)}...${p.agent.slice(-4)}`;
        const tvl = p.totalLiq.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).padStart(12);
        const util = `${p.util.toFixed(1)}%`.padStart(6);
        const tier = p.tier.padEnd(12);

        console.log(`  ${rank} | ${id} | ${agent} | ${tvl} | ${util} | ${tier}`);
    });

    // High utilization pools (risk monitoring)
    const highUtil = pools.filter(p => p.util > 75).sort((a, b) => b.util - a.util);

    if (highUtil.length > 0) {
        console.log(`\n${'─'.repeat(70)}`);
        console.log('  High Utilization Pools (>75%  — Risk Monitoring)');
        console.log('─'.repeat(70));
        console.log('  Pool ID | Utilization | Available | Total Loaned | Agent Tier');
        console.log('─'.repeat(70));

        highUtil.forEach(p => {
            const id = `#${p.id}`.padEnd(8);
            const util = `${p.util.toFixed(1)}%`.padStart(12);
            const avail = p.availLiq.toFixed(2).padStart(10);
            const loaned = p.loaned.toFixed(2).padStart(13);
            const tier = p.tier;

            console.log(`  ${id} | ${util} | ${avail} | ${loaned} | ${tier}`);
        });
    }

    console.log('\n' + '═'.repeat(70) + '\n');
}

main().catch(err => {
    console.error('\n[ERROR]', err.message);
    process.exit(1);
});
