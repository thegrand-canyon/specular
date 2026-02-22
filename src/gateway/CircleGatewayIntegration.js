/**
 * Circle Gateway Integration
 * Seamless USDC onboarding from any chain to Arc Network
 */

import { ethers } from 'ethers';

/**
 * Circle Gateway wrapper for Specular Protocol
 * Enables deposits from any chain with automatic routing to Arc
 */
export class CircleGatewayIntegration {
    constructor(config = {}) {
        this.appId = config.appId || process.env.CIRCLE_APP_ID;
        this.apiKey = config.apiKey || process.env.CIRCLE_API_KEY;
        this.environment = config.environment || 'testnet'; // 'testnet' or 'mainnet'

        // Chain configurations
        this.chains = {
            ethereum: { chainId: 1, domain: 0, name: 'Ethereum' },
            sepolia: { chainId: 11155111, domain: 0, name: 'Sepolia' },
            arbitrum: { chainId: 42161, domain: 2, name: 'Arbitrum' },
            optimism: { chainId: 10, domain: 1, name: 'Optimism' },
            base: { chainId: 8453, domain: 6, name: 'Base' },
            polygon: { chainId: 137, domain: 7, name: 'Polygon' },
            avalanche: { chainId: 43114, domain: 3, name: 'Avalanche' },
            arc: { chainId: 5042002, domain: 99, name: 'Arc' } // Custom domain for Arc
        };

        // Contract addresses (to be configured per environment)
        this.contracts = config.contracts || {};
    }

    /**
     * Initialize Gateway SDK
     */
    async initialize() {
        // In a real implementation, this would load Circle's Gateway SDK
        // For now, we'll use CCTP directly
        console.log('🔄 Initializing Circle Gateway...');

        // Load CCTP contracts
        this.cctpContracts = await this.loadCCTPContracts();

        console.log('✅ Gateway initialized');
    }

    /**
     * Load CCTP contract addresses
     */
    async loadCCTPContracts() {
        // CCTP Mainnet addresses
        if (this.environment === 'mainnet') {
            return {
                ethereum: {
                    tokenMessenger: '0xBd3fa81B58Ba92a82136038B25aDec7066af3155',
                    messageTransmitter: '0x0a992d191DEeC32aFe36203Ad87D7d289a738F81',
                    usdc: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
                },
                arbitrum: {
                    tokenMessenger: '0x19330d10D9Cc8751218eaf51E8885D058642E08A',
                    messageTransmitter: '0xC30362313FBBA5cf9163F0bb16a0e01f01A896ca',
                    usdc: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831'
                },
                base: {
                    tokenMessenger: '0x9f3B8679c73C2Fef8b59B4f3444d4e156fb70AA5',
                    messageTransmitter: '0xAD09780d193884d503182aD4588450C416D6F9D4',
                    usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
                }
            };
        }

        // CCTP Testnet addresses
        return {
            sepolia: {
                tokenMessenger: '0x9f3B8679c73C2Fef8b59B4f3444d4e156fb70AA5',
                messageTransmitter: '0x7865fAfC2db2093669d92c0F33AeEF291086BEFD',
                usdc: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238'
            },
            // Add other testnet chains as needed
        };
    }

    /**
     * Detect user's current chain
     */
    async detectChain(provider) {
        const network = await provider.getNetwork();
        const chainId = Number(network.chainId);

        for (const [name, config] of Object.entries(this.chains)) {
            if (config.chainId === chainId) {
                return name;
            }
        }

        throw new Error(`Unsupported chain: ${chainId}`);
    }

    /**
     * Estimate deposit cost and time
     */
    async estimateDeposit(params) {
        const { amount, sourceChain, destinationChain = 'arc' } = params;

        // Parse amount
        const amountWei = ethers.parseUnits(amount.toString(), 6); // USDC has 6 decimals

        // Estimate CCTP fee (usually ~$1-2)
        const bridgeFee = ethers.parseUnits('1', 6); // 1 USDC
        const destinationAmount = amountWei - bridgeFee;

        // Estimate time based on chain
        let estimatedTime = 15; // minutes
        if (sourceChain === 'ethereum') estimatedTime = 20;
        if (sourceChain === 'arbitrum' || sourceChain === 'optimism') estimatedTime = 10;

        return {
            sourceChain,
            destinationChain,
            sourceAmount: ethers.formatUnits(amountWei, 6),
            bridgeFee: ethers.formatUnits(bridgeFee, 6),
            destinationAmount: ethers.formatUnits(destinationAmount, 6),
            estimatedTime: `${estimatedTime} minutes`,
            steps: [
                `1. Approve USDC on ${this.chains[sourceChain].name}`,
                `2. Burn USDC via CCTP`,
                `3. Wait for Circle attestation (~${estimatedTime}min)`,
                `4. Mint USDC on Arc`,
                `5. Auto-deposit to pool`
            ]
        };
    }

    /**
     * Deposit USDC to Arc pool from any chain
     */
    async depositToArcPool(params) {
        const {
            provider,
            signer,
            amount,
            agentId,
            onProgress
        } = params;

        // Detect source chain
        const sourceChain = await this.detectChain(provider);
        onProgress?.({ step: 1, message: `Detected chain: ${this.chains[sourceChain].name}` });

        // If already on Arc, deposit directly
        if (sourceChain === 'arc') {
            return this.depositDirectOnArc({ signer, amount, agentId, onProgress });
        }

        // Otherwise, bridge via CCTP
        return this.bridgeAndDeposit({
            provider,
            signer,
            sourceChain,
            amount,
            agentId,
            onProgress
        });
    }

    /**
     * Direct deposit on Arc (no bridging needed)
     */
    async depositDirectOnArc(params) {
        const { signer, amount, agentId, onProgress } = params;

        onProgress?.({ step: 2, message: 'Preparing direct deposit...' });

        // Load contracts
        const depositRouter = new ethers.Contract(
            this.contracts.depositRouter,
            [
                'function depositDirect(uint256 agentId, uint256 amount) external',
                'function usdc() external view returns (address)'
            ],
            signer
        );

        const usdcAddress = await depositRouter.usdc();
        const usdc = new ethers.Contract(
            usdcAddress,
            [
                'function approve(address spender, uint256 amount) external returns (bool)',
                'function balanceOf(address account) external view returns (uint256)'
            ],
            signer
        );

        // Check balance
        const balance = await usdc.balanceOf(await signer.getAddress());
        const amountWei = ethers.parseUnits(amount.toString(), 6);

        if (balance < amountWei) {
            throw new Error(`Insufficient USDC balance: ${ethers.formatUnits(balance, 6)} < ${amount}`);
        }

        // Approve USDC
        onProgress?.({ step: 3, message: 'Approving USDC...' });
        const approveTx = await usdc.approve(this.contracts.depositRouter, amountWei);
        await approveTx.wait();

        // Deposit
        onProgress?.({ step: 4, message: 'Depositing to pool...' });
        const depositTx = await depositRouter.depositDirect(agentId, amountWei);
        const receipt = await depositTx.wait();

        onProgress?.({ step: 5, message: 'Deposit complete!' });

        return {
            success: true,
            txHash: receipt.hash,
            amount,
            agentId,
            chain: 'arc'
        };
    }

    /**
     * Bridge USDC from source chain to Arc and deposit
     */
    async bridgeAndDeposit(params) {
        const {
            provider,
            signer,
            sourceChain,
            amount,
            agentId,
            onProgress
        } = params;

        onProgress?.({ step: 2, message: `Preparing bridge from ${this.chains[sourceChain].name}...` });

        // Load CCTP bridge contract on source chain
        const bridgeAddress = this.contracts.bridges?.[sourceChain];
        if (!bridgeAddress) {
            throw new Error(`Bridge not deployed on ${sourceChain}`);
        }

        const bridge = new ethers.Contract(
            bridgeAddress,
            [
                'function bridgeToArcPool(uint256 amount, uint256 agentId) external returns (uint64)',
                'function usdc() external view returns (address)'
            ],
            signer
        );

        const usdcAddress = await bridge.usdc();
        const usdc = new ethers.Contract(
            usdcAddress,
            [
                'function approve(address spender, uint256 amount) external returns (bool)',
                'function balanceOf(address account) external view returns (uint256)'
            ],
            signer
        );

        // Check balance
        const balance = await usdc.balanceOf(await signer.getAddress());
        const amountWei = ethers.parseUnits(amount.toString(), 6);

        if (balance < amountWei) {
            throw new Error(`Insufficient USDC balance: ${ethers.formatUnits(balance, 6)} < ${amount}`);
        }

        // Approve USDC
        onProgress?.({ step: 3, message: 'Approving USDC for bridge...' });
        const approveTx = await usdc.approve(bridgeAddress, amountWei);
        await approveTx.wait();

        // Initiate bridge
        onProgress?.({ step: 4, message: 'Initiating CCTP bridge...' });
        const bridgeTx = await bridge.bridgeToArcPool(amountWei, agentId);
        const receipt = await bridgeTx.wait();

        // Get nonce from event
        const bridgeEvent = receipt.logs.find(log => {
            try {
                const parsed = bridge.interface.parseLog(log);
                return parsed?.name === 'BridgeInitiated';
            } catch { return false; }
        });

        let nonce;
        if (bridgeEvent) {
            const parsed = bridge.interface.parseLog(bridgeEvent);
            nonce = parsed.args.nonce;
        }

        onProgress?.({
            step: 5,
            message: 'Bridge initiated! Waiting for attestation...',
            nonce: nonce?.toString()
        });

        return {
            success: true,
            txHash: receipt.hash,
            nonce: nonce?.toString(),
            amount,
            agentId,
            sourceChain,
            destinationChain: 'arc',
            status: 'pending_attestation',
            estimatedTime: '15 minutes'
        };
    }

    /**
     * Check bridge transaction status
     */
    async checkBridgeStatus(nonce, sourceChain) {
        // In production, this would query Circle's attestation API
        // https://iris-api.circle.com/attestations/{messageHash}

        console.log(`Checking bridge status: nonce ${nonce} from ${sourceChain}`);

        return {
            nonce,
            status: 'pending', // 'pending', 'complete', 'failed'
            attestation: null
        };
    }

    /**
     * Get supported chains for deposits
     */
    getSupportedChains() {
        return Object.entries(this.chains)
            .filter(([name]) => name !== 'arc') // Exclude Arc from source chains
            .map(([name, config]) => ({
                name,
                displayName: config.name,
                chainId: config.chainId,
                domain: config.domain
            }));
    }

    /**
     * Get chain info
     */
    getChainInfo(chainName) {
        return this.chains[chainName];
    }
}

export default CircleGatewayIntegration;
