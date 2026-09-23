/**
 * Get Protocol Stats
 * Displays current analytics for Specular Protocol
 */

const { ethers } = require('ethers');
const { ProtocolAnalytics } = require('../src/analytics/ProtocolAnalytics');

const network = process.env.DEFAULT_NETWORK || 'arc';

// Load addresses for the network
const addresses = network === 'base'
    ? require('../src/config/base-addresses.json')
    : require('../src/config/arc-testnet-addresses.json');

// Provider config
const RPC_URL = network === 'base'
    ? 'https://mainnet.base.org'
    : process.env.ARC_TESTNET_RPC_URL || 'https://arc-testnet.drpc.org';

const CHAIN_ID = network === 'base' ? 8453 : 5042002;

async function main() {
    console.log('='.repeat(60));
    console.log(`  SPECULAR PROTOCOL ANALYTICS - ${network.toUpperCase()}`);
    console.log('='.repeat(60));
    console.log('');

    // Create provider
    const provider = new ethers.JsonRpcProvider(RPC_URL, CHAIN_ID, { batchMaxCount: 1 });

    // Create analytics instance
    const analytics = new ProtocolAnalytics(provider, addresses);

    try {
        // Get full snapshot
        console.log('⏳ Fetching protocol data...\n');
        const snapshot = await analytics.getFullSnapshot();

        // Display results
        console.log('📊 PROTOCOL OVERVIEW');
        console.log('─'.repeat(60));
        console.log(`Network:             ${network === 'base' ? 'Base Mainnet' : 'Arc Testnet'}`);
        console.log(`Total Value Locked:  $${ethers.formatUnits(snapshot.tvl, 6)} USDC`);
        console.log(`Utilization Rate:    ${snapshot.utilizationRate.toFixed(2)}%`);
        console.log(`Protocol Revenue:    $${ethers.formatUnits(snapshot.protocolRevenue, 6)} USDC`);
        console.log(`Snapshot Time:       ${snapshot.snapshotAt}`);
        console.log('');

        console.log('💼 LOAN STATISTICS');
        console.log('─'.repeat(60));
        console.log(`Total Loans:         ${snapshot.loanStats.total}`);
        console.log(`  • Pending:         ${snapshot.loanStats.pending}`);
        console.log(`  • Active:          ${snapshot.loanStats.active}`);
        console.log(`  • Completed:       ${snapshot.loanStats.completed}`);
        console.log(`  • Defaulted:       ${snapshot.loanStats.defaulted}`);
        console.log(`Total Volume:        $${ethers.formatUnits(snapshot.loanStats.totalVolume, 6)} USDC`);
        console.log('');

        console.log('🏆 TOP AGENTS BY LIQUIDITY');
        console.log('─'.repeat(60));

        if (snapshot.topAgents.length === 0) {
            console.log('No active agents yet');
        } else {
            snapshot.topAgents.slice(0, 10).forEach((agent, i) => {
                const liquidity = ethers.formatUnits(agent.totalLiquidity, 6);
                const available = ethers.formatUnits(agent.availableLiquidity, 6);
                const earned = ethers.formatUnits(agent.totalEarned, 6);

                console.log(`${i + 1}. Agent #${agent.agentId}`);
                console.log(`   Reputation:       ${agent.reputation}`);
                console.log(`   Total Liquidity:  $${liquidity} USDC`);
                console.log(`   Available:        $${available} USDC`);
                console.log(`   Utilization:      ${agent.utilizationPct.toFixed(2)}%`);
                console.log(`   Total Earned:     $${earned} USDC`);
                console.log(`   Status:           ${agent.isActive ? '✅ Active' : '❌ Inactive'}`);
                console.log('');
            });
        }

        console.log('='.repeat(60));
        console.log('  Analysis Complete');
        console.log('='.repeat(60));

    } catch (error) {
        console.error('❌ Error fetching analytics:', error.message);
        process.exit(1);
    }
}

main()
    .then(() => process.exit(0))
    .catch(error => {
        console.error('Fatal error:', error);
        process.exit(1);
    });
