/**
 * Specular Multi-Network Agent API
 * Supports Arc Testnet and Base Mainnet
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

// Serve static frontend (relative path for Railway deployment)
const frontendPath = path.join(__dirname, '../../frontend');
if (fs.existsSync(frontendPath)) {
    app.use(express.static(frontendPath));
}

// Network configurations
const NETWORKS = {
    arc: {
        name: 'Arc Testnet',
        chainId: 5042002,
        rpcUrl: process.env.ARC_TESTNET_RPC_URL || 'https://arc-testnet.drpc.org',
        addresses: JSON.parse(fs.readFileSync(path.join(__dirname, '../config/arc-testnet-addresses.json'), 'utf8')),
        explorer: 'https://arc-testnet.explorer.com'
    },
    base: {
        name: 'Base Mainnet',
        chainId: 8453,
        rpcUrl: 'https://mainnet.base.org',
        addresses: JSON.parse(fs.readFileSync(path.join(__dirname, '../config/base-addresses.json'), 'utf8')),
        explorer: 'https://basescan.org'
    }
};

// Default network
const DEFAULT_NETWORK = process.env.DEFAULT_NETWORK || 'arc';

// Load ABIs from committed abis/ folder
function loadAbi(name) {
    const abiPath = path.join(__dirname, '../../abis', `${name}.json`);
    try {
        const abiFile = JSON.parse(fs.readFileSync(abiPath, 'utf8'));
        // If it's already just the ABI array, return it
        if (Array.isArray(abiFile)) return abiFile;
        // If it's a Hardhat artifact with .abi property, return that
        if (abiFile.abi) return abiFile.abi;
        return abiFile;
    } catch (err) {
        throw new Error(`Cannot find ABI for ${name}: ${err.message}`);
    }
}

const mpAbi = loadAbi('AgentLiquidityMarketplace');
const registryAbi = loadAbi('AgentRegistryV2');
const rmAbi = loadAbi('ReputationManagerV3');

// Get network context from request
function getNetwork(req) {
    const network = req.query.network || req.headers['x-network'] || DEFAULT_NETWORK;
    if (!NETWORKS[network]) {
        throw new Error(`Unknown network: ${network}. Available: ${Object.keys(NETWORKS).join(', ')}`);
    }
    return network;
}

// Create provider and contracts for network
function getContracts(networkKey) {
    const network = NETWORKS[networkKey];
    const provider = new ethers.JsonRpcProvider(network.rpcUrl, undefined, { batchMaxCount: 1 });
    const addresses = network.addresses;

    return {
        provider,
        marketplace: new ethers.Contract(addresses.agentLiquidityMarketplace, mpAbi, provider),
        registry: new ethers.Contract(addresses.agentRegistryV2, registryAbi, provider),
        reputationManager: new ethers.Contract(addresses.reputationManagerV3, rmAbi, provider),
        addresses,
        network
    };
}

// Routes

app.get('/dashboard', (req, res) => {
    const dashboardFile = path.join(frontendPath, 'dashboard.html');
    if (fs.existsSync(dashboardFile)) {
        res.sendFile(dashboardFile);
    } else {
        res.status(404).json({ error: 'Dashboard not available in production' });
    }
});

app.get('/', (req, res) => {
    res.json({
        name: 'Specular Multi-Network Agent API',
        version: '2.0.0',
        defaultNetwork: DEFAULT_NETWORK,
        networks: Object.keys(NETWORKS),
        endpoints: {
            discovery: '/.well-known/specular.json?network={arc|base}',
            health: '/health?network={arc|base}',
            status: '/status?network={arc|base}',
            agents: '/agents/:address?network={arc|base}',
            pools: '/pools?network={arc|base}',
            dashboard: '/dashboard'
        },
        usage: 'Add ?network=arc or ?network=base to any endpoint. Default: ' + DEFAULT_NETWORK
    });
});

app.get('/.well-known/specular.json', (req, res) => {
    try {
        const networkKey = getNetwork(req);
        const network = NETWORKS[networkKey];

        // Construct API URL from request
        const protocol = req.get('x-forwarded-proto') || req.protocol || 'https';
        const host = req.get('x-forwarded-host') || req.get('host');
        const apiUrl = `${protocol}://${host}`;

        res.json({
            protocol: 'Specular',
            version: '3',
            network: networkKey,
            networkName: network.name,
            chainId: network.chainId,
            api: apiUrl,
            explorer: network.explorer,
            contracts: network.addresses
        });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

app.get('/health', async (req, res) => {
    try {
        const networkKey = getNetwork(req);
        const { provider, network } = getContracts(networkKey);

        const blockNumber = await provider.getBlockNumber();
        res.json({
            ok: true,
            network: networkKey,
            chainId: network.chainId,
            blockNumber
        });
    } catch (error) {
        res.status(503).json({ ok: false, error: error.message });
    }
});

app.get('/status', async (req, res) => {
    try {
        const networkKey = getNetwork(req);
        const { marketplace, provider, addresses, network } = getContracts(networkKey);

        const totalPools = await marketplace.totalPools();

        // Calculate TVL by getting USDC balance of marketplace contract
        // This is more reliable than summing pool.totalLiquidity
        console.log(`[DEBUG] Getting TVL for ${networkKey}`);
        console.log(`[DEBUG] USDC address: ${addresses.usdc}`);
        console.log(`[DEBUG] Marketplace address: ${addresses.agentLiquidityMarketplace}`);

        const usdcAbi = ['function balanceOf(address) view returns (uint256)'];
        const usdc = new ethers.Contract(addresses.usdc, usdcAbi, provider);
        const totalTVL = await usdc.balanceOf(addresses.agentLiquidityMarketplace);

        console.log(`[DEBUG] Total TVL (raw): ${totalTVL.toString()}`);
        console.log(`[DEBUG] Total TVL (formatted): ${ethers.formatUnits(totalTVL, 6)}`);

        res.json({
            network: networkKey,
            networkName: network.name,
            chainId: network.chainId,
            totalPools: Number(totalPools),
            tvl: '$' + Number(ethers.formatUnits(totalTVL, 6)).toLocaleString('en-US', {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2
            })
        });
    } catch (error) {
        console.error(`[ERROR] /status failed:`, error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/agents/:address', async (req, res) => {
    try {
        const networkKey = getNetwork(req);
        const { registry, reputationManager, marketplace } = getContracts(networkKey);
        const address = req.params.address;

        const agentId = await registry.addressToAgentId(address);

        if (agentId === 0n) {
            return res.json({
                network: networkKey,
                registered: false,
                address,
                hint: 'Agent not registered on this network'
            });
        }

        const agent = await registry.agents(agentId);
        const score = await reputationManager['getReputationScore(address)'](address);
        const limit = await reputationManager['calculateCreditLimit(address)'](address);
        const interestRate = await reputationManager.calculateInterestRate(address);

        // Get active pools
        const totalPools = await marketplace.totalPools();
        const agentPools = [];
        for (let i = 1; i <= Number(totalPools); i++) {
            try {
                const pool = await marketplace.pools(i);
                if (pool.agentId === agentId && pool.isActive) {
                    agentPools.push({
                        poolId: i,
                        liquidity: Number(ethers.formatUnits(pool.totalLiquidity, 6)),
                        lenderCount: Number(pool.lenderCount)
                    });
                }
            } catch (e) {}
        }

        res.json({
            network: networkKey,
            registered: true,
            agentId: Number(agentId),
            address: agent.agentAddress,
            metadata: agent.metadata,
            reputationScore: Number(score),
            creditLimit: Number(ethers.formatUnits(limit, 6)),
            interestRate: Number(interestRate) / 100, // Convert basis points to percentage
            pools: agentPools
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/pools', async (req, res) => {
    try {
        const networkKey = getNetwork(req);
        const { marketplace, registry } = getContracts(networkKey);

        const totalPools = await marketplace.totalPools();
        const pools = [];

        for (let i = 1; i <= Number(totalPools); i++) {
            try {
                const pool = await marketplace.pools(i);
                if (!pool.isActive) continue;

                const agent = await registry.agents(pool.agentId);

                pools.push({
                    poolId: i,
                    agentId: Number(pool.agentId),
                    agentAddress: agent.agentAddress,
                    totalLiquidity: Number(ethers.formatUnits(pool.totalLiquidity, 6)),
                    availableLiquidity: Number(ethers.formatUnits(pool.availableLiquidity, 6)),
                    lenderCount: Number(pool.lenderCount)
                });
            } catch (e) {
                // Skip pools that fail
            }
        }

        // Sort by available liquidity
        pools.sort((a, b) => b.availableLiquidity - a.availableLiquidity);

        res.json({
            network: networkKey,
            totalPools: pools.length,
            pools
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Network list endpoint
app.get('/networks', (req, res) => {
    res.json({
        default: DEFAULT_NETWORK,
        available: Object.entries(NETWORKS).map(([key, config]) => ({
            key,
            name: config.name,
            chainId: config.chainId,
            explorer: config.explorer
        }))
    });
});

// Start server
app.listen(PORT, () => {
    console.log(`\n╔══════════════════════════════════════════════════╗`);
    console.log(`║  Specular Multi-Network Agent API                ║`);
    console.log(`╚══════════════════════════════════════════════════╝\n`);
    console.log(`🌐 Running on: http://localhost:${PORT}`);
    console.log(`📡 Default network: ${DEFAULT_NETWORK}`);
    console.log(`\n🔗 Available networks:`);
    Object.entries(NETWORKS).forEach(([key, config]) => {
        console.log(`   - ${key}: ${config.name} (Chain ID: ${config.chainId})`);
    });
    console.log(`\n📖 Endpoints:`);
    console.log(`   - GET / - API info`);
    console.log(`   - GET /.well-known/specular.json?network=arc|base`);
    console.log(`   - GET /health?network=arc|base`);
    console.log(`   - GET /status?network=arc|base`);
    console.log(`   - GET /agents/:address?network=arc|base`);
    console.log(`   - GET /pools?network=arc|base`);
    console.log(`   - GET /networks - List all networks`);
    console.log(`   - GET /dashboard - Web dashboard\n`);
});
