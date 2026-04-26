/**
 * Specular Multi-Network Agent API
 * Supports Arc Testnet, Base Mainnet, and Arbitrum One
 */

const express = require('express');
const cors = require('cors');
const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

// Import our custom middleware
const RequestLimiter = require('./middleware/requestLimiter');
const CircuitBreaker = require('./middleware/circuitBreaker');
const CacheManager = require('./middleware/cacheManager');

// Import blockchain cache (NEW - Performance optimization)
const BlockchainCache = require('../cache/BlockchainCache');
const SyncWorker = require('../cache/SyncWorker');

const app = express();
const PORT = process.env.PORT || 3001;

// Initialize middleware
const requestLimiter = new RequestLimiter({
    maxConcurrent: 20,  // Max 20 concurrent requests
    queueSize: 50,      // Max 50 queued requests
    timeout: 30000      // 30s timeout
});

const circuitBreaker = new CircuitBreaker({
    memoryThreshold: 0.85,  // Open circuit at 85% memory
    checkInterval: 5000,    // Check every 5s
    cooldownPeriod: 30000   // 30s cooldown
});

const agentsCache = new CacheManager({
    maxSize: 50,           // Max 50 cached responses
    ttl: 5 * 60 * 1000    // 5-minute TTL
});

const poolsCache = new CacheManager({
    maxSize: 30,           // Max 30 cached responses
    ttl: 3 * 60 * 1000    // 3-minute TTL
});

// Apply global middleware
app.use(cors());
app.use(express.json());

// Apply circuit breaker first (protects against memory exhaustion)
app.use(circuitBreaker.middleware());

// Apply request limiter to API routes only
const apiLimiterRoutes = ['/health', '/status', '/agents', '/pools'];
apiLimiterRoutes.forEach(route => {
    app.use(route, requestLimiter.middleware());
});

// Input validation middleware
function validateNetwork(req, res, next) {
    const networkParam = req.query.network || req.headers['x-network'] || DEFAULT_NETWORK;
    const network = networkParam.toLowerCase();

    if (!NETWORKS[network]) {
        return res.status(400).json({
            error: `Invalid network: ${networkParam}`,
            validNetworks: Object.keys(NETWORKS)
        });
    }

    req.validatedNetwork = network;
    next();
}

// Serve static frontend (relative path for Railway deployment)
// Try built files first (frontend/dist), fallback to raw files
const frontendDistPath = path.join(__dirname, '../../frontend/dist');
const frontendPath = path.join(__dirname, '../../frontend');

console.log('Checking frontend paths:');
console.log('  frontendDistPath:', frontendDistPath, 'exists:', fs.existsSync(frontendDistPath));
console.log('  frontendPath:', frontendPath, 'exists:', fs.existsSync(frontendPath));

if (fs.existsSync(frontendDistPath)) {
    console.log('✅ Serving built frontend from:', frontendDistPath);
    const distFiles = fs.readdirSync(frontendDistPath);
    console.log('   Files in dist:', distFiles.slice(0, 10));
    app.use(express.static(frontendDistPath));
} else if (fs.existsSync(frontendPath)) {
    console.log('⚠️  Serving raw frontend from:', frontendPath);
    console.log('   (Build may not have completed)');
    app.use(express.static(frontendPath));
} else {
    console.log('❌ No frontend directory found!');
}

// Apply validation middleware to API routes that use network parameter
const validateNetworkRoutes = [
    '/health',
    '/status',
    '/agents',
    '/agents/:address',
    '/pools',
    '/pools/:id',
    '/.well-known/specular.json'
];
validateNetworkRoutes.forEach(route => {
    app.use(route, validateNetwork);
});

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
    },
    arbitrum: {
        name: 'Arbitrum One',
        chainId: 42161,
        rpcUrl: process.env.ARBITRUM_RPC_URL || 'https://arb1.arbitrum.io/rpc',
        addresses: JSON.parse(fs.readFileSync(path.join(__dirname, '../config/arbitrum-addresses.json'), 'utf8')),
        explorer: 'https://arbiscan.io'
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
    // Use pre-validated network from middleware if available
    if (req.validatedNetwork) {
        return req.validatedNetwork;
    }

    // Fallback for routes without middleware (case-insensitive)
    const networkParam = req.query.network || req.headers['x-network'] || DEFAULT_NETWORK;
    const network = networkParam.toLowerCase();

    if (!NETWORKS[network]) {
        throw new Error(`Unknown network: ${networkParam}. Available: ${Object.keys(NETWORKS).join(', ')}`);
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

// Initialize blockchain cache and background sync worker
const ENABLE_CACHE = process.env.ENABLE_CACHE !== 'false'; // Default: enabled
const blockchainCache = new BlockchainCache({
    enabled: ENABLE_CACHE,
    ttl: 60000 // 60 seconds
});

const syncWorker = new SyncWorker(blockchainCache, NETWORKS, getContracts, {
    enabled: ENABLE_CACHE,
    syncInterval: 30000 // Sync every 30 seconds
});

// Start background sync worker
syncWorker.start();

// Routes

app.get('/dashboard', (req, res) => {
    const dashboardFileDist = path.join(frontendDistPath, 'dashboard.html');
    const dashboardFile = path.join(frontendPath, 'dashboard.html');

    if (fs.existsSync(dashboardFileDist)) {
        res.sendFile(dashboardFileDist);
    } else if (fs.existsSync(dashboardFile)) {
        res.sendFile(dashboardFile);
    } else {
        res.status(404).json({ error: 'Dashboard not available in production' });
    }
});

app.get('/build', (req, res) => {
    const buildFileDist = path.join(frontendDistPath, 'build.html');
    const buildFile = path.join(frontendPath, 'build.html');

    if (fs.existsSync(buildFileDist)) {
        res.sendFile(buildFileDist);
    } else if (fs.existsSync(buildFile)) {
        res.sendFile(buildFile);
    } else {
        res.status(404).json({ error: 'Build page not found' });
    }
});

app.get('/', (req, res) => {
    res.json({
        name: 'Specular Multi-Network Agent API',
        version: '2.3.0',
        defaultNetwork: DEFAULT_NETWORK,
        networks: Object.keys(NETWORKS),
        endpoints: {
            discovery: '/.well-known/specular.json?network={arc|base|arbitrum}',
            health: '/health?network={arc|base|arbitrum}',
            status: '/status?network={arc|base|arbitrum}',
            allAgents: '/agents?network={arc|base|arbitrum}',
            agentByAddress: '/agents/:address?network={arc|base|arbitrum}',
            agentById: '/agent/:id?network={arc|base|arbitrum}',
            agentLoans: '/agent/:id/loans?network={arc|base|arbitrum}',
            allPools: '/pools?network={arc|base|arbitrum}',
            poolById: '/pools/:id?network={arc|base|arbitrum}',
            allNetworks: '/networks',
            networkInfo: '/network/:network',
            dashboard: '/dashboard',
            build: '/build',
            stats: '/stats'
        },
        usage: 'Add ?network=arc, ?network=base, or ?network=arbitrum to any endpoint. Network parameter is case-insensitive. Default: ' + DEFAULT_NETWORK
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

        // Get active pools for this agent
        const totalPools = await marketplace.totalPools();
        const agentPools = [];
        for (let i = 0; i < Number(totalPools); i++) {
            try {
                const poolAgentId = await marketplace.agentPoolIds(i);
                if (poolAgentId === agentId) {
                    const pool = await marketplace.agentPools(poolAgentId);
                    if (pool.isActive) {
                        agentPools.push({
                            poolId: i + 1, // Human-readable pool ID
                            liquidity: Number(ethers.formatUnits(pool.totalLiquidity, 6)),
                            available: Number(ethers.formatUnits(pool.availableLiquidity, 6))
                        });
                    }
                }
            } catch (e) {}
        }

        res.json({
            network: networkKey,
            registered: true,
            agentId: Number(agentId),
            owner: agent.owner,
            agentWallet: agent.agentWallet,
            agentURI: agent.agentURI,
            reputationScore: Number(score),
            creditLimit: Number(ethers.formatUnits(limit, 6)),
            interestRate: Number(interestRate) / 100, // Convert basis points to percentage
            registrationTime: Number(agent.registrationTime),
            isActive: agent.isActive,
            pools: agentPools
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/pools', async (req, res) => {
    try {
        const networkKey = getNetwork(req);

        // Pagination parameters
        const limit = Math.min(parseInt(req.query.limit) || 20, 50);
        const offset = parseInt(req.query.offset) || 0;

        // Check blockchain cache first (1-10ms response)
        const cachedPools = blockchainCache.getPools(networkKey);
        if (cachedPools) {
            // Apply pagination to cached data
            const paginatedPools = cachedPools.slice(offset, offset + limit);

            return res.json({
                network: networkKey,
                totalPools: cachedPools.length,
                returned: paginatedPools.length,
                offset,
                limit,
                hasMore: (offset + limit) < cachedPools.length,
                pools: paginatedPools,
                cached: true,
                lastSync: blockchainCache.getLastSync(networkKey)
            });
        }

        // Cache miss - fall back to direct RPC call (slower, 1-10s response)
        console.log(`[CACHE MISS] /pools?network=${networkKey} - Fetching from RPC...`);

        const { marketplace, registry } = getContracts(networkKey);

        // Set timeout for this request (30 seconds for pools)
        const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Request timeout after 30 seconds')), 30000)
        );

        const fetchPools = async () => {
            const totalPools = await marketplace.totalPools();
            const poolCount = Number(totalPools);

            // Pagination: max 20 pools per request
            const limit = Math.min(parseInt(req.query.limit) || 20, 20);
            const offset = parseInt(req.query.offset) || 0;
            const endIdx = Math.min(poolCount, offset + limit);

            // Parallel fetch pool data (limited batch size)
            const poolPromises = [];
            for (let i = offset; i < endIdx; i++) {
                poolPromises.push(
                    (async () => {
                        try {
                            const agentId = await marketplace.agentPoolIds(i);
                            const pool = await marketplace.agentPools(agentId);
                            if (!pool.isActive) return null;

                            const agent = await registry.agents(pool.agentId);

                            return {
                                poolId: i + 1,
                                agentId: Number(pool.agentId),
                                agentWallet: agent.agentWallet,
                                totalLiquidity: Number(ethers.formatUnits(pool.totalLiquidity, 6)),
                                availableLiquidity: Number(ethers.formatUnits(pool.availableLiquidity, 6)),
                                totalLoaned: Number(ethers.formatUnits(pool.totalLoaned, 6))
                            };
                        } catch (e) {
                            console.error(`Error getting pool ${i}:`, e.message);
                            return null;
                        }
                    })()
                );
            }

            const poolsResults = await Promise.all(poolPromises);
            const pools = poolsResults.filter(p => p !== null);

            // Sort by available liquidity
            pools.sort((a, b) => b.availableLiquidity - a.availableLiquidity);

            return {
                network: networkKey,
                totalPools: poolCount,
                returned: pools.length,
                offset,
                limit,
                hasMore: endIdx < poolCount,
                pools,
                cached: false
            };
        };

        // Race between fetch and timeout
        const result = await Promise.race([fetchPools(), timeoutPromise]);

        // Cache the result
        poolsCache.set(cacheKey, { ...result, cached: false });

        res.json(result);
    } catch (error) {
        console.error('[ERROR] /pools failed:', error);

        if (error.message.includes('timeout')) {
            res.status(504).json({
                error: 'Request timeout',
                hint: 'Try reducing limit: ?limit=10'
            });
        } else {
            res.status(500).json({ error: error.message });
        }
    }
});

// List all agents endpoint (OPTIMIZED with BlockchainCache)
app.get('/agents', async (req, res) => {
    try {
        const networkKey = getNetwork(req);
        const { registry, reputationManager, network } = getContracts(networkKey);

        // Pagination parameters
        const limit = Math.min(parseInt(req.query.limit) || 25, 50); // Max 50 per request
        const offset = parseInt(req.query.offset) || 0;

        // Check blockchain cache first (1-10ms response)
        const cachedAgents = blockchainCache.getAgents(networkKey);
        if (cachedAgents) {
            // Apply pagination to cached data
            const paginatedAgents = cachedAgents.slice(offset, offset + limit);

            return res.json({
                network: networkKey,
                networkName: network.name,
                totalAgents: cachedAgents.length,
                returned: paginatedAgents.length,
                offset,
                limit,
                hasMore: (offset + limit) < cachedAgents.length,
                agents: paginatedAgents,
                cached: true,
                lastSync: blockchainCache.getLastSync(networkKey)
            });
        }

        // Cache miss - fall back to direct RPC call (slower, 1-10s response)
        console.log(`[CACHE MISS] /agents?network=${networkKey} - Fetching from RPC...`);

        // Set timeout for this request (10 seconds)
        const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Request timeout after 10 seconds')), 10000)
        );

        const fetchAgents = async () => {
            const totalAgents = await registry.totalAgents();
            const totalCount = Number(totalAgents);

            // Calculate range to fetch
            const startIdx = Math.max(1, offset + 1); // Agent IDs start at 1
            const endIdx = Math.min(totalCount, offset + limit);

            // Batch fetch agent data - use Promise.all to parallelize
            const agentPromises = [];
            for (let i = startIdx; i <= endIdx; i++) {
                agentPromises.push(
                    (async () => {
                        try {
                            const agent = await registry.agents(i);
                            const score = await reputationManager['getReputationScore(address)'](agent.agentWallet);

                            return {
                                agentId: i,
                                owner: agent.owner,
                                agentWallet: agent.agentWallet,
                                agentURI: agent.agentURI || '',
                                reputationScore: Number(score),
                                registrationTime: Number(agent.registrationTime),
                                isActive: agent.isActive
                            };
                        } catch (e) {
                            console.error(`Error getting agent ${i}:`, e.message);
                            return null;
                        }
                    })()
                );
            }

            const agentsResults = await Promise.all(agentPromises);
            const agents = agentsResults.filter(a => a !== null);

            // Sort by reputation score (descending)
            agents.sort((a, b) => b.reputationScore - a.reputationScore);

            return {
                network: networkKey,
                networkName: network.name,
                totalAgents: totalCount,
                returned: agents.length,
                offset,
                limit,
                hasMore: endIdx < totalCount,
                agents,
                cached: false
            };
        };

        // Race between fetch and timeout
        const result = await Promise.race([fetchAgents(), timeoutPromise]);

        // Cache the result (CacheManager handles size limits automatically)
        agentsCache.set(cacheKey, { ...result, cached: false });

        res.json(result);
    } catch (error) {
        console.error('[ERROR] /agents failed:', error);

        if (error.message.includes('timeout')) {
            res.status(504).json({
                error: 'Request timeout - try reducing limit or using pagination',
                hint: 'Use ?limit=20&offset=0 for faster responses'
            });
        } else {
            res.status(500).json({ error: error.message });
        }
    }
});

// Get specific pool by ID endpoint (OPTIMIZED with BlockchainCache)
app.get('/pools/:id', async (req, res) => {
    try {
        const networkKey = getNetwork(req);
        const poolId = parseInt(req.params.id);

        if (isNaN(poolId) || poolId <= 0) {
            return res.status(400).json({ error: 'Invalid pool ID - must be a positive integer' });
        }

        // Check blockchain cache first (1-10ms response)
        const cachedPool = blockchainCache.getPool(networkKey, poolId);
        if (cachedPool) {
            return res.json({
                ...cachedPool,
                network: networkKey,
                cached: true,
                lastSync: blockchainCache.getLastSync(networkKey)
            });
        }

        // Cache miss - fall back to direct RPC call (slower, 1-10s response)
        console.log(`[CACHE MISS] /pools/${poolId}?network=${networkKey} - Fetching from RPC...`);

        const { marketplace, registry, network } = getContracts(networkKey);

        // Get pool data
        let pool;
        try {
            // Pool IDs are stored in agentPoolIds array, indexed from 0
            // But pool data is stored by agentId in agentPools mapping
            const agentId = await marketplace.agentPoolIds(poolId - 1); // Convert to 0-indexed
            pool = await marketplace.agentPools(agentId);

            if (!pool.isActive) {
                return res.status(404).json({ error: 'Pool not found or inactive' });
            }
        } catch (error) {
            return res.status(404).json({ error: 'Pool not found' });
        }

        // Get agent details
        const agent = await registry.agents(pool.agentId);

        res.json({
            network: networkKey,
            networkName: network.name,
            poolId,
            agentId: Number(pool.agentId),
            agentWallet: agent.agentWallet,
            agentOwner: agent.owner,
            totalLiquidity: Number(ethers.formatUnits(pool.totalLiquidity, 6)),
            availableLiquidity: Number(ethers.formatUnits(pool.availableLiquidity, 6)),
            totalLoaned: Number(ethers.formatUnits(pool.totalLoaned, 6)),
            totalEarned: Number(ethers.formatUnits(pool.totalEarned, 6)),
            isActive: pool.isActive
        });
    } catch (error) {
        console.error('[ERROR] /pools/:id failed:', error);
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

// Get agent by numeric ID (convenience endpoint - OPTIMIZED with BlockchainCache)
app.get('/agent/:id', validateNetwork, async (req, res) => {
    try {
        const networkKey = getNetwork(req);
        const agentId = Number(req.params.id);

        // Check blockchain cache first (1-10ms response)
        const cachedAgent = blockchainCache.getAgent(networkKey, agentId);
        if (cachedAgent) {
            return res.json({
                ...cachedAgent,
                network: networkKey,
                cached: true,
                lastSync: blockchainCache.getLastSync(networkKey)
            });
        }

        // Cache miss - fall back to direct RPC call (slower, 1-10s response)
        console.log(`[CACHE MISS] /agent/${agentId}?network=${networkKey} - Fetching from RPC...`);

        const { registry, reputationManager, marketplace } = getContracts(networkKey);
        const agentIdBigInt = BigInt(agentId);

        // Get agent data
        const agent = await registry.agents(agentIdBigInt);

        if (!agent.isActive && agent.owner === ethers.ZeroAddress) {
            return res.status(404).json({
                error: 'Agent not found',
                network: networkKey,
                agentId
            });
        }

        const agentAddress = agent.agentWallet;
        const score = await reputationManager['getReputationScore(address)'](agentAddress);
        const limit = await reputationManager['calculateCreditLimit(address)'](agentAddress);
        const interestRate = await reputationManager.calculateInterestRate(agentAddress);

        // Get active pools for this agent
        const totalPools = await marketplace.totalPools();
        const agentPools = [];
        for (let i = 0; i < Number(totalPools); i++) {
            try {
                const poolAgentId = await marketplace.agentPoolIds(i);
                if (poolAgentId === agentIdBigInt) {
                    const pool = await marketplace.agentPools(poolAgentId);
                    if (pool.isActive) {
                        agentPools.push({
                            poolId: i + 1,
                            liquidity: Number(ethers.formatUnits(pool.totalLiquidity, 6)),
                            available: Number(ethers.formatUnits(pool.availableLiquidity, 6))
                        });
                    }
                }
            } catch (e) {}
        }

        res.json({
            network: networkKey,
            agentId: Number(agentId),
            owner: agent.owner,
            agentWallet: agent.agentWallet,
            agentURI: agent.agentURI,
            reputationScore: Number(score),
            creditLimit: Number(ethers.formatUnits(limit, 6)),
            interestRate: Number(interestRate) / 100,
            registrationTime: Number(agent.registrationTime),
            isActive: agent.isActive,
            pools: agentPools
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get loan history for an agent by ID
app.get('/agent/:id/loans', validateNetwork, async (req, res) => {
    try {
        const networkKey = getNetwork(req);
        const { registry, marketplace } = getContracts(networkKey);
        const agentId = BigInt(req.params.id);

        // Verify agent exists
        const agent = await registry.agents(agentId);
        if (!agent.isActive && agent.owner === ethers.ZeroAddress) {
            return res.status(404).json({
                error: 'Agent not found',
                network: networkKey,
                agentId: Number(agentId)
            });
        }

        const agentAddress = agent.agentWallet;
        const totalLoans = await marketplace.nextLoanId();
        const loans = [];

        // Get all loans involving this agent (as borrower or lender)
        for (let i = 1n; i <= totalLoans; i++) {
            try {
                const loan = await marketplace.loans(i);

                // Check if this agent is involved (as borrower)
                if (loan.borrower.toLowerCase() === agentAddress.toLowerCase()) {
                    loans.push({
                        loanId: Number(i),
                        borrower: loan.borrower,
                        lender: loan.lender,
                        amount: Number(ethers.formatUnits(loan.amount, 6)),
                        interestRate: Number(loan.interestRate) / 100,
                        duration: Number(loan.duration),
                        startTime: Number(loan.startTime),
                        endTime: Number(loan.endTime),
                        repaid: loan.repaid,
                        defaulted: loan.defaulted,
                        role: 'borrower'
                    });
                }
            } catch (e) {
                // Loan might not exist
            }
        }

        res.json({
            network: networkKey,
            agentId: Number(agentId),
            agentWallet: agentAddress,
            totalLoans: loans.length,
            loans: loans.sort((a, b) => b.startTime - a.startTime) // Most recent first
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get specific network info
app.get('/network/:network', (req, res) => {
    const networkKey = req.params.network.toLowerCase();
    const network = NETWORKS[networkKey];

    if (!network) {
        return res.status(404).json({
            error: `Network not found: ${req.params.network}`,
            availableNetworks: Object.keys(NETWORKS)
        });
    }

    res.json({
        key: networkKey,
        name: network.name,
        chainId: network.chainId,
        rpcUrl: network.rpcUrl,
        explorer: network.explorer,
        contracts: {
            agentRegistryV2: network.addresses.agentRegistryV2,
            agentLiquidityMarketplace: network.addresses.agentLiquidityMarketplace,
            reputationManagerV3: network.addresses.reputationManagerV3,
            usdc: network.addresses.usdc
        }
    });
});

// Monitoring/stats endpoint
app.get('/stats', (req, res) => {
    const memUsage = process.memoryUsage();

    res.json({
        server: {
            uptime: process.uptime(),
            memory: {
                heapUsed: `${(memUsage.heapUsed / 1024 / 1024).toFixed(2)} MB`,
                heapTotal: `${(memUsage.heapTotal / 1024 / 1024).toFixed(2)} MB`,
                rss: `${(memUsage.rss / 1024 / 1024).toFixed(2)} MB`,
                external: `${(memUsage.external / 1024 / 1024).toFixed(2)} MB`,
                usagePercent: `${((memUsage.heapUsed / memUsage.heapTotal) * 100).toFixed(1)}%`
            }
        },
        requestLimiter: requestLimiter.getStats(),
        circuitBreaker: circuitBreaker.getStatus(),
        blockchainCache: blockchainCache.getStats(),
        cacheHealth: blockchainCache.getHealth(),
        legacyCaches: {
            agents: agentsCache.getStats(),
            pools: poolsCache.getStats()
        }
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
    console.log(`   - GET /.well-known/specular.json?network=arc|base|arbitrum`);
    console.log(`   - GET /health?network=arc|base|arbitrum`);
    console.log(`   - GET /status?network=arc|base|arbitrum`);
    console.log(`   - GET /agents?network=arc|base|arbitrum - List all agents`);
    console.log(`   - GET /agents/:address?network=arc|base|arbitrum - Get agent by address`);
    console.log(`   - GET /agent/:id?network=arc|base|arbitrum - Get agent by numeric ID`);
    console.log(`   - GET /agent/:id/loans?network=arc|base|arbitrum - Get agent loan history`);
    console.log(`   - GET /pools?network=arc|base|arbitrum - List all pools`);
    console.log(`   - GET /pools/:id?network=arc|base|arbitrum - Get pool by ID`);
    console.log(`   - GET /networks - List all networks`);
    console.log(`   - GET /network/:network - Get specific network info`);
    console.log(`   - GET /stats - Server performance metrics`);
    console.log(`   - GET /dashboard - Web dashboard`);

    console.log(`\n⚡ Performance Optimizations:`);
    console.log(`   ✅ Request limiter: Max ${requestLimiter.maxConcurrent} concurrent, queue ${requestLimiter.queueSize}`);
    console.log(`   ✅ Circuit breaker: Opens at ${(circuitBreaker.memoryThreshold * 100).toFixed(0)}% memory`);
    console.log(`   ✅ Cache: Agents (${agentsCache.maxSize} entries), Pools (${poolsCache.maxSize} entries)`);
    console.log(``);
});
