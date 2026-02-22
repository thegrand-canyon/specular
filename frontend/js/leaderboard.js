// Specular Protocol - Reputation Leaderboard
// Arc Testnet Dashboard

const CONFIG = {
    rpcUrl: 'https://arc-testnet.drpc.org',
    chainId: 5042002,
    contracts: {
        agentRegistry: '0xF72AdE178A84c80eFc79Bc94378b8B650C83CDE0',
        reputationManager: '0x94F2fa47c4488202a46dAA9038Ed9C9c4c07467F',
        marketplace: '0xD1cf6E7864Bc4CbBE52aA94369dF08B106927559'
    }
};

const ABIS = {
    agentRegistry: [
        'function totalAgents() view returns (uint256)',
        'function agents(uint256) view returns (uint256 agentId, address agentAddress, string metadataCID, uint256 registrationTimestamp, bool isActive)',
        'function addressToAgentId(address) view returns (uint256)'
    ],
    reputationManager: [
        'function getReputationScore(uint256) view returns (uint256)',
        'function totalBorrowed(uint256) view returns (uint256)',
        'function totalRepaid(uint256) view returns (uint256)',
        'function loanCount(uint256) view returns (uint256)',
        'function defaultCount(uint256) view returns (uint256)',
        'function calculateCreditLimit(address) view returns (uint256)',
        'function calculateCollateralRequirement(address) view returns (uint256)',
        'function calculateInterestRate(address) view returns (uint256)'
    ]
};

let provider;
let contracts = {};

// Initialize connection
async function init() {
    try {
        provider = new ethers.JsonRpcProvider(CONFIG.rpcUrl, undefined, { batchMaxCount: 1 });

        contracts.registry = new ethers.Contract(
            CONFIG.contracts.agentRegistry,
            ABIS.agentRegistry,
            provider
        );

        contracts.reputation = new ethers.Contract(
            CONFIG.contracts.reputationManager,
            ABIS.reputationManager,
            provider
        );

        console.log('✓ Connected to Arc Testnet');
        return true;
    } catch (error) {
        console.error('Failed to initialize:', error);
        showError('Failed to connect to Arc Testnet');
        return false;
    }
}

// Get tier name from score
function getTier(score) {
    if (score >= 800) return 'EXCELLENT';
    if (score >= 600) return 'LOW_RISK';
    if (score >= 400) return 'MEDIUM_RISK';
    if (score >= 200) return 'HIGH_RISK';
    return 'UNRATED';
}

// Format USDC amount
function formatUSDC(amount) {
    return Number(ethers.formatUnits(amount, 6)).toLocaleString('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    });
}

// Format address
function formatAddress(address) {
    return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

// Load all agent data
async function loadAgents() {
    try {
        const totalAgents = await contracts.registry.totalAgents();
        console.log(`Found ${totalAgents} agents`);

        const agents = [];

        // Fetch agent data in batches to avoid rate limits
        for (let id = 1n; id <= totalAgents; id++) {
            try {
                console.log(`Loading agent #${id}...`);

                const agentData = await contracts.registry.agents(id);

                // Skip inactive agents
                if (!agentData.isActive) continue;

                // Get reputation data
                const [score, totalBorrowed, totalRepaid, loanCount, defaultCount] = await Promise.all([
                    contracts.reputation.getReputationScore(id),
                    contracts.reputation.totalBorrowed(id),
                    contracts.reputation.totalRepaid(id),
                    contracts.reputation.loanCount(id),
                    contracts.reputation.defaultCount(id)
                ]);

                agents.push({
                    id: Number(id),
                    address: agentData.agentAddress,
                    score: Number(score),
                    tier: getTier(Number(score)),
                    totalBorrowed: totalBorrowed,
                    totalRepaid: totalRepaid,
                    loanCount: Number(loanCount),
                    defaultCount: Number(defaultCount)
                });

                // Rate limit: wait 150ms between requests
                await new Promise(r => setTimeout(r, 150));

            } catch (error) {
                console.error(`Error loading agent #${id}:`, error);
                // Continue to next agent
            }
        }

        // Sort by score descending
        agents.sort((a, b) => b.score - a.score);

        console.log(`✓ Loaded ${agents.length} active agents`);
        return agents;

    } catch (error) {
        console.error('Error loading agents:', error);
        throw error;
    }
}

// Calculate stats
function calculateStats(agents) {
    if (agents.length === 0) {
        return {
            totalAgents: 0,
            totalLoans: 0,
            avgScore: 0,
            topScore: 0
        };
    }

    const totalLoans = agents.reduce((sum, a) => sum + a.loanCount, 0);
    const avgScore = Math.round(
        agents.reduce((sum, a) => sum + a.score, 0) / agents.length
    );
    const topScore = agents[0].score;

    return {
        totalAgents: agents.length,
        totalLoans,
        avgScore,
        topScore
    };
}

// Render leaderboard
function renderLeaderboard(agents) {
    const tbody = document.getElementById('tbody');
    tbody.innerHTML = '';

    agents.forEach((agent, index) => {
        const rank = index + 1;
        let rankClass = 'rank';
        if (rank === 1) rankClass += ' gold';
        else if (rank === 2) rankClass += ' silver';
        else if (rank === 3) rankClass += ' bronze';

        const row = document.createElement('tr');
        row.innerHTML = `
            <td><span class="${rankClass}">#${rank}</span></td>
            <td>
                <div><strong>Agent #${agent.id}</strong></div>
                <div class="address">${formatAddress(agent.address)}</div>
            </td>
            <td><span class="tier-badge tier-${agent.tier}">${agent.tier}</span></td>
            <td><span class="score">${agent.score}</span></td>
            <td class="metric">$${formatUSDC(agent.totalBorrowed)}</td>
            <td class="metric">$${formatUSDC(agent.totalRepaid)}</td>
            <td class="metric">${agent.loanCount}</td>
            <td class="metric">${agent.defaultCount}</td>
        `;
        tbody.appendChild(row);
    });
}

// Update stats bar
function updateStats(stats) {
    document.getElementById('totalAgents').textContent = stats.totalAgents;
    document.getElementById('totalLoans').textContent = stats.totalLoans;
    document.getElementById('avgScore').textContent = stats.avgScore;
    document.getElementById('topScore').textContent = stats.topScore;
}

// Show error
function showError(message) {
    document.getElementById('loading').innerHTML = `
        <div class="error">
            <h3>⚠️ Error</h3>
            <p>${message}</p>
            <button class="refresh-btn" onclick="loadLeaderboard()">Retry</button>
        </div>
    `;
}

// Main load function
async function loadLeaderboard() {
    const loading = document.getElementById('loading');
    const leaderboard = document.getElementById('leaderboard');

    loading.style.display = 'block';
    leaderboard.style.display = 'none';

    try {
        // Initialize if needed
        if (!provider) {
            const success = await init();
            if (!success) return;
        }

        // Load agents
        const agents = await loadAgents();

        // Calculate stats
        const stats = calculateStats(agents);

        // Render
        updateStats(stats);
        renderLeaderboard(agents);

        // Show leaderboard
        loading.style.display = 'none';
        leaderboard.style.display = 'block';

        console.log('✓ Leaderboard loaded successfully');

    } catch (error) {
        console.error('Failed to load leaderboard:', error);
        showError('Failed to load leaderboard data. Please try again.');
    }
}

// Auto-load on page load
window.addEventListener('DOMContentLoaded', loadLeaderboard);
