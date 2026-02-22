/**
 * Specular Agent API - REST API for AI agent discovery and interaction
 *
 * Makes Specular protocol easily discoverable and usable by any agent
 */

const express = require('express');
const cors = require('cors');
const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// Serve static files from frontend directory
const frontendPath = '/Users/peterschroeder/Specular/frontend';
console.log('Serving static files from:', frontendPath);
app.use(express.static(frontendPath));

// Load contract addresses and ABIs
const addresses = JSON.parse(fs.readFileSync('./src/config/arc-testnet-addresses.json', 'utf8'));

function loadAbi(name) {
    const paths = [
        `./artifacts/contracts/${name}.sol/${name}.json`,
        `./artifacts/contracts/core/${name}.sol/${name}.json`,
        `./artifacts/contracts/tokens/${name}.sol/${name}.json`,
    ];
    for (const p of paths) {
        try {
            return JSON.parse(fs.readFileSync(p, 'utf8')).abi;
        } catch {}
    }
    throw new Error(`Cannot find ABI for ${name}`);
}

const mpAbi = loadAbi('AgentLiquidityMarketplace');
const registryAbi = loadAbi('AgentRegistryV2');
const rmAbi = loadAbi('ReputationManagerV3');

// Provider
const provider = new ethers.JsonRpcProvider(
    process.env.ARC_TESTNET_RPC_URL || 'https://arc-testnet.drpc.org',
    undefined,
    { batchMaxCount: 1 }
);

// Contracts
const marketplace = new ethers.Contract(addresses.agentLiquidityMarketplace, mpAbi, provider);
const registry = new ethers.Contract(addresses.agentRegistryV2, registryAbi, provider);
const reputationManager = new ethers.Contract(addresses.reputationManagerV3, rmAbi, provider);

// Routes

// Dashboard route
app.get('/dashboard', (req, res) => {
    res.sendFile(frontendPath + '/dashboard.html');
});

app.get('/', (req, res) => {
    res.json({
        name: 'Specular Agent API',
        version: '1.0.0',
        endpoints: {
            discovery: '/.well-known/specular.json',
            health: '/health',
            status: '/status',
            agents: '/agents/:address',
            pools: '/pools',
            dashboard: '/dashboard'
        }
    });
});

app.get('/.well-known/specular.json', (req, res) => {
    res.json({
        protocol: 'Specular',
        version: '3',
        network: 'arc-testnet',
        chainId: 5042002,
        api: `http://localhost:${PORT}`,
        contracts: addresses
    });
});

app.get('/health', async (req, res) => {
    try {
        const blockNumber = await provider.getBlockNumber();
        res.json({ ok: true, blockNumber });
    } catch (error) {
        res.status(503).json({ ok: false, error: error.message });
    }
});

app.get('/status', async (req, res) => {
    try {
        const totalPools = await marketplace.totalPools();

        // Calculate TVL by summing liquidity across all pools
        let totalTVL = 0n;
        for (let i = 1; i <= Number(totalPools); i++) {
            try {
                const pool = await marketplace.pools(i);
                totalTVL += pool.totalLiquidity;
            } catch (e) {
                // Skip pools that fail
            }
        }

        res.json({
            totalPools: Number(totalPools),
            tvl: '$' + Number(ethers.formatUnits(totalTVL, 6)).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
            network: 'arc-testnet'
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/agents/:address', async (req, res) => {
    try {
        const address = req.params.address;
        const agentId = await registry.addressToAgentId(address);

        if (agentId === 0n) {
            return res.json({ registered: false, address });
        }

        const score = await reputationManager['getReputationScore(address)'](address);
        const creditLimit = await reputationManager.calculateCreditLimit(address);

        // Determine tier name from score
        let tierName = 'Fair';
        if (Number(score) >= 800) tierName = 'Excellent';
        else if (Number(score) >= 600) tierName = 'Good';

        // Calculate interest rate based on score (base 5% + reputation adjustment)
        const baseRate = 500; // 5.00%
        const scoreFactor = Math.max(0, 1000 - Number(score)) / 100;
        const interestRate = (baseRate + scoreFactor * 50) / 100;

        // Get active loans count (mock for now - would need to query loan storage)
        const activeLoans = 0;

        res.json({
            registered: true,
            agentId: Number(agentId),
            reputation: {
                score: Number(score),
                tier: tierName
            },
            creditLimit: ethers.formatUnits(creditLimit, 6) + ' USDC',
            interestRate: interestRate.toFixed(2) + '%',
            activeLoans: activeLoans,
            maxActiveLoans: 10 // From MAX_ACTIVE_LOANS_PER_AGENT constant
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.listen(PORT, () => {
    console.log(`Specular Agent API running on http://localhost:${PORT}`);
});

module.exports = app;
