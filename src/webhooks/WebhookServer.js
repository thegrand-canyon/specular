/**
 * Specular Webhook Server
 *
 * Notifies subscribed agents of credit events in real-time:
 * - Loan approved/denied
 * - Loan repaid
 * - Reputation updated
 * - Credit limit changed
 * - Loan due date approaching
 * - Pool liquidity changes
 */

const express = require('express');
const crypto = require('crypto');
const { ethers } = require('ethers');

class WebhookServer {
    constructor({ port = 3002, rpcUrl, contracts, secretKey }) {
        this.port = port;
        this.app = express();
        this.subscriptions = new Map(); // agentAddress → { webhookUrl, events[], secret }
        this.secretKey = secretKey || crypto.randomBytes(32).toString('hex');

        // Setup provider and contracts
        this.provider = new ethers.JsonRpcProvider(rpcUrl, undefined, { batchMaxCount: 1 });
        this.contracts = {
            marketplace: new ethers.Contract(
                contracts.marketplace,
                ['event LoanRequested(uint256 indexed loanId, uint256 indexed agentPoolId, uint256 amount, uint256 durationDays)',
                 'event LoanRepaid(uint256 indexed loanId, uint256 amount, uint256 interest)',
                 'event LoanDefaulted(uint256 indexed loanId, uint256 amount)',
                 'event LiquiditySupplied(uint256 indexed poolId, address indexed lender, uint256 amount)',
                 'event LiquidityWithdrawn(uint256 indexed poolId, address indexed lender, uint256 amount, uint256 interest)'],
                this.provider
            ),
            reputation: new ethers.Contract(
                contracts.reputation,
                ['event ReputationUpdated(address indexed agent, int256 scoreChange, uint256 newScore)',
                 'event CreditLimitUpdated(address indexed agent, uint256 oldLimit, uint256 newLimit)'],
                this.provider
            ),
            registry: new ethers.Contract(
                contracts.registry,
                ['event AgentRegistered(uint256 indexed agentId, address indexed agentAddress)',
                 'event PoolCreated(uint256 indexed poolId, uint256 indexed agentId, address indexed lender)'],
                this.provider
            )
        };

        this.setupRoutes();
        this.setupEventListeners();
    }

    /**
     * Setup Express routes
     */
    setupRoutes() {
        this.app.use(express.json());

        // CORS
        this.app.use((req, res, next) => {
            res.header('Access-Control-Allow-Origin', '*');
            res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE');
            res.header('Access-Control-Allow-Headers', 'Content-Type, X-Agent-Address, X-Signature');
            if (req.method === 'OPTIONS') {
                return res.sendStatus(200);
            }
            next();
        });

        // Health check
        this.app.get('/health', (req, res) => {
            res.json({
                ok: true,
                subscriptions: this.subscriptions.size,
                uptime: process.uptime()
            });
        });

        // List available event types
        this.app.get('/events', (req, res) => {
            res.json({
                events: [
                    'loan.requested',
                    'loan.approved',
                    'loan.repaid',
                    'loan.defaulted',
                    'loan.due_soon',
                    'reputation.updated',
                    'credit.limit_changed',
                    'agent.registered',
                    'pool.created',
                    'pool.liquidity_low',
                    'liquidity.supplied',
                    'liquidity.withdrawn',
                    'earnings.accrued',
                    'pool.apy_changed'
                ],
                description: {
                    'loan.requested': 'Fired when agent requests a loan',
                    'loan.approved': 'Fired when loan is approved',
                    'loan.repaid': 'Fired when loan is repaid',
                    'loan.defaulted': 'Fired when loan defaults',
                    'loan.due_soon': 'Fired 24h before loan due date',
                    'reputation.updated': 'Fired when reputation score changes',
                    'credit.limit_changed': 'Fired when credit limit changes',
                    'agent.registered': 'Fired when agent registers',
                    'pool.created': 'Fired when lending pool is created',
                    'pool.liquidity_low': 'Fired when pool liquidity drops below threshold',
                    'liquidity.supplied': 'Fired when lender supplies USDC to a pool',
                    'liquidity.withdrawn': 'Fired when lender withdraws from a pool',
                    'earnings.accrued': 'Fired when lending interest is accrued',
                    'pool.apy_changed': 'Fired when pool APY changes significantly'
                }
            });
        });

        // Subscribe to webhooks
        this.app.post('/subscribe', this.authenticate.bind(this), (req, res) => {
            const { webhookUrl, events, secret } = req.body;
            const agentAddress = req.agentAddress;

            if (!webhookUrl) {
                return res.status(400).json({ error: 'webhookUrl required' });
            }

            if (!events || !Array.isArray(events)) {
                return res.status(400).json({ error: 'events array required' });
            }

            // Validate events
            const validEvents = [
                'loan.requested', 'loan.approved', 'loan.repaid', 'loan.defaulted', 'loan.due_soon',
                'reputation.updated', 'credit.limit_changed', 'agent.registered',
                'pool.created', 'pool.liquidity_low',
                'liquidity.supplied', 'liquidity.withdrawn', 'earnings.accrued', 'pool.apy_changed'
            ];

            const invalidEvents = events.filter(e => !validEvents.includes(e));
            if (invalidEvents.length > 0) {
                return res.status(400).json({
                    error: 'Invalid events',
                    invalid: invalidEvents,
                    valid: validEvents
                });
            }

            // Store subscription
            this.subscriptions.set(agentAddress, {
                webhookUrl,
                events,
                secret: secret || crypto.randomBytes(16).toString('hex'),
                subscribed: new Date().toISOString()
            });

            res.json({
                success: true,
                agent: agentAddress,
                webhookUrl,
                events,
                message: 'Webhook subscription created',
                secret: this.subscriptions.get(agentAddress).secret
            });
        });

        // Get subscription
        this.app.get('/subscribe', this.authenticate.bind(this), (req, res) => {
            const agentAddress = req.agentAddress;
            const subscription = this.subscriptions.get(agentAddress);

            if (!subscription) {
                return res.status(404).json({
                    error: 'No subscription found',
                    agent: agentAddress
                });
            }

            res.json({
                agent: agentAddress,
                ...subscription
            });
        });

        // Unsubscribe
        this.app.delete('/subscribe', this.authenticate.bind(this), (req, res) => {
            const agentAddress = req.agentAddress;

            if (!this.subscriptions.has(agentAddress)) {
                return res.status(404).json({
                    error: 'No subscription found',
                    agent: agentAddress
                });
            }

            this.subscriptions.delete(agentAddress);

            res.json({
                success: true,
                message: 'Webhook subscription removed'
            });
        });

        // List all subscriptions (for testing)
        this.app.get('/subscriptions', (req, res) => {
            const subs = Array.from(this.subscriptions.entries()).map(([agent, sub]) => ({
                agent,
                webhookUrl: sub.webhookUrl,
                events: sub.events,
                subscribed: sub.subscribed
            }));

            res.json({
                count: subs.length,
                subscriptions: subs
            });
        });
    }

    /**
     * Authenticate requests using signature
     */
    authenticate(req, res, next) {
        const agentAddress = req.headers['x-agent-address'];
        const signature = req.headers['x-signature'];

        if (!agentAddress) {
            return res.status(401).json({ error: 'X-Agent-Address header required' });
        }

        if (!signature) {
            return res.status(401).json({ error: 'X-Signature header required' });
        }

        try {
            // Verify signature
            const message = JSON.stringify(req.body);
            const messageHash = ethers.hashMessage(message);
            const recoveredAddress = ethers.recoverAddress(messageHash, signature);

            if (recoveredAddress.toLowerCase() !== agentAddress.toLowerCase()) {
                return res.status(403).json({ error: 'Invalid signature' });
            }

            req.agentAddress = agentAddress;
            next();
        } catch (error) {
            return res.status(403).json({ error: 'Signature verification failed' });
        }
    }

    /**
     * Setup blockchain event listeners
     */
    setupEventListeners() {
        // Loan requested
        this.contracts.marketplace.on('LoanRequested', async (loanId, agentPoolId, amount, durationDays, event) => {
            const loan = {
                loanId: loanId.toString(),
                agentPoolId: agentPoolId.toString(),
                amount: ethers.formatUnits(amount, 6),
                durationDays: durationDays.toString(),
                blockNumber: event.log.blockNumber,
                transactionHash: event.log.transactionHash
            };

            await this.notifySubscribers('loan.requested', loan);
        });

        // Loan repaid
        this.contracts.marketplace.on('LoanRepaid', async (loanId, amount, interest, event) => {
            const loan = {
                loanId: loanId.toString(),
                amount: ethers.formatUnits(amount, 6),
                interest: ethers.formatUnits(interest, 6),
                blockNumber: event.log.blockNumber,
                transactionHash: event.log.transactionHash
            };

            await this.notifySubscribers('loan.repaid', loan);
        });

        // Loan defaulted
        this.contracts.marketplace.on('LoanDefaulted', async (loanId, amount, event) => {
            const loan = {
                loanId: loanId.toString(),
                amount: ethers.formatUnits(amount, 6),
                blockNumber: event.log.blockNumber,
                transactionHash: event.log.transactionHash
            };

            await this.notifySubscribers('loan.defaulted', loan);
        });

        // Reputation updated
        this.contracts.reputation.on('ReputationUpdated', async (agent, scoreChange, newScore, event) => {
            const update = {
                agent,
                scoreChange: scoreChange.toString(),
                newScore: newScore.toString(),
                blockNumber: event.log.blockNumber,
                transactionHash: event.log.transactionHash
            };

            await this.notifySubscriber(agent, 'reputation.updated', update);
        });

        // Credit limit updated
        this.contracts.reputation.on('CreditLimitUpdated', async (agent, oldLimit, newLimit, event) => {
            const update = {
                agent,
                oldLimit: ethers.formatUnits(oldLimit, 6),
                newLimit: ethers.formatUnits(newLimit, 6),
                blockNumber: event.log.blockNumber,
                transactionHash: event.log.transactionHash
            };

            await this.notifySubscriber(agent, 'credit.limit_changed', update);
        });

        // Agent registered
        this.contracts.registry.on('AgentRegistered', async (agentId, agentAddress, event) => {
            const registration = {
                agentId: agentId.toString(),
                agentAddress,
                blockNumber: event.log.blockNumber,
                transactionHash: event.log.transactionHash
            };

            await this.notifySubscriber(agentAddress, 'agent.registered', registration);
        });

        // Pool created
        this.contracts.registry.on('PoolCreated', async (poolId, agentId, lender, event) => {
            const pool = {
                poolId: poolId.toString(),
                agentId: agentId.toString(),
                lender,
                blockNumber: event.log.blockNumber,
                transactionHash: event.log.transactionHash
            };

            await this.notifySubscribers('pool.created', pool);
        });

        // Liquidity supplied
        this.contracts.marketplace.on('LiquiditySupplied', async (poolId, lender, amount, event) => {
            const liquidityEvent = {
                poolId: poolId.toString(),
                lender,
                amount: ethers.formatUnits(amount, 6),
                blockNumber: event.log.blockNumber,
                transactionHash: event.log.transactionHash
            };

            // Notify the lender
            await this.notifySubscriber(lender, 'liquidity.supplied', liquidityEvent);

            // Also broadcast to all subscribers
            await this.notifySubscribers('liquidity.supplied', liquidityEvent);
        });

        // Liquidity withdrawn
        this.contracts.marketplace.on('LiquidityWithdrawn', async (poolId, lender, amount, interest, event) => {
            const liquidityEvent = {
                poolId: poolId.toString(),
                lender,
                amount: ethers.formatUnits(amount, 6),
                interest: ethers.formatUnits(interest, 6),
                total: ethers.formatUnits(amount + interest, 6),
                blockNumber: event.log.blockNumber,
                transactionHash: event.log.transactionHash
            };

            // Notify the lender
            await this.notifySubscriber(lender, 'liquidity.withdrawn', liquidityEvent);

            // Also broadcast to all subscribers
            await this.notifySubscribers('liquidity.withdrawn', liquidityEvent);
        });

        console.log('✅ Blockchain event listeners setup');
    }

    /**
     * Notify all subscribers of an event
     */
    async notifySubscribers(eventType, data) {
        console.log(`📢 Broadcasting event: ${eventType}`);

        const promises = [];
        for (const [agent, subscription] of this.subscriptions.entries()) {
            if (subscription.events.includes(eventType)) {
                promises.push(this.sendWebhook(subscription, eventType, data));
            }
        }

        await Promise.allSettled(promises);
    }

    /**
     * Notify specific subscriber of an event
     */
    async notifySubscriber(agentAddress, eventType, data) {
        const subscription = this.subscriptions.get(agentAddress.toLowerCase());

        if (!subscription) {
            return;
        }

        if (!subscription.events.includes(eventType)) {
            return;
        }

        await this.sendWebhook(subscription, eventType, data);
    }

    /**
     * Send webhook notification
     */
    async sendWebhook(subscription, eventType, data) {
        const payload = {
            event: eventType,
            timestamp: new Date().toISOString(),
            data
        };

        // Generate signature
        const signature = this.signPayload(payload, subscription.secret);

        try {
            const response = await fetch(subscription.webhookUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Specular-Event': eventType,
                    'X-Specular-Signature': signature,
                    'User-Agent': 'Specular-Webhook/1.0'
                },
                body: JSON.stringify(payload)
            });

            if (!response.ok) {
                console.error(`❌ Webhook failed: ${response.status} ${response.statusText}`);
            } else {
                console.log(`✅ Webhook sent: ${eventType} → ${subscription.webhookUrl}`);
            }
        } catch (error) {
            console.error(`❌ Webhook error: ${error.message}`);
        }
    }

    /**
     * Sign webhook payload
     */
    signPayload(payload, secret) {
        const hmac = crypto.createHmac('sha256', secret);
        hmac.update(JSON.stringify(payload));
        return hmac.digest('hex');
    }

    /**
     * Verify webhook signature (for recipients)
     */
    static verifySignature(payload, signature, secret) {
        const hmac = crypto.createHmac('sha256', secret);
        hmac.update(JSON.stringify(payload));
        const expected = hmac.digest('hex');
        return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
    }

    /**
     * Start the webhook server
     */
    async start() {
        return new Promise((resolve) => {
            this.server = this.app.listen(this.port, () => {
                console.log(`🎣 Webhook server listening on port ${this.port}`);
                console.log(`📡 Monitoring blockchain events...`);
                resolve();
            });
        });
    }

    /**
     * Stop the webhook server
     */
    async stop() {
        if (this.server) {
            return new Promise((resolve) => {
                this.server.close(resolve);
            });
        }
    }
}

module.exports = { WebhookServer };
