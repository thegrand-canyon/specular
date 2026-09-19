# Specular Webhooks

Real-time notifications for Specular Protocol events.

## Overview

The Specular Webhook system allows agents to receive real-time notifications when credit events occur on-chain. Instead of polling the blockchain, agents subscribe to events and get HTTP callbacks whenever something happens.

## Architecture

```
┌─────────────┐         ┌──────────────┐         ┌──────────────┐
│ Blockchain  │────────►│   Webhook    │────────►│    Your      │
│   Events    │  events │    Server    │  HTTP   │   Agent      │
└─────────────┘         └──────────────┘         └──────────────┘
                             (port 3002)           (your URL)
```

1. **Webhook Server** monitors blockchain events via ethers.js
2. When events occur, server notifies subscribed agents via HTTP POST
3. **Your Agent** receives notifications at its webhook URL

## Quick Start

### 1. Start Webhook Server

```bash
# Terminal 1
export ARC_TESTNET_RPC_URL=https://arc-testnet.drpc.org
node src/webhooks/example-server.js
```

### 2. Subscribe to Events

```bash
# Terminal 2
export PRIVATE_KEY=your_private_key
export ARC_TESTNET_RPC_URL=https://arc-testnet.drpc.org
node src/webhooks/example-client.js
```

### 3. Trigger Events

```bash
# Terminal 3
# Request a loan to trigger webhook
node your-agent.js
```

You'll see real-time notifications in Terminal 2!

## Available Events

| Event | Triggered When | Data |
|-------|----------------|------|
| `loan.requested` | Agent requests a loan | loanId, amount, durationDays |
| `loan.approved` | Loan is approved | loanId, amount |
| `loan.repaid` | Loan is repaid | loanId, amount, interest |
| `loan.defaulted` | Loan defaults | loanId, amount |
| `loan.due_soon` | 24h before due date | loanId, dueDate, totalDue |
| `reputation.updated` | Reputation changes | agent, scoreChange, newScore |
| `credit.limit_changed` | Credit limit changes | agent, oldLimit, newLimit |
| `agent.registered` | New agent registers | agentId, agentAddress |
| `pool.created` | Lending pool created | poolId, agentId, lender |
| `pool.liquidity_low` | Pool liquidity < 10% | poolId, available, threshold |

## API Reference

### Subscribe to Events

```http
POST /subscribe
X-Agent-Address: 0x...
X-Signature: 0x...

{
  "webhookUrl": "https://your-agent.com/webhook",
  "events": ["loan.repaid", "reputation.updated"],
  "secret": "your-secret-key"
}
```

**Response:**
```json
{
  "success": true,
  "agent": "0x...",
  "webhookUrl": "https://your-agent.com/webhook",
  "events": ["loan.repaid", "reputation.updated"],
  "secret": "generated-secret-if-not-provided"
}
```

### Get Subscription

```http
GET /subscribe
X-Agent-Address: 0x...
X-Signature: 0x...
```

**Response:**
```json
{
  "agent": "0x...",
  "webhookUrl": "https://your-agent.com/webhook",
  "events": ["loan.repaid", "reputation.updated"],
  "secret": "your-secret",
  "subscribed": "2026-02-23T12:00:00.000Z"
}
```

### Unsubscribe

```http
DELETE /subscribe
X-Agent-Address: 0x...
X-Signature: 0x...
```

### List Available Events

```http
GET /events
```

## Webhook Payload Format

All webhook notifications follow this format:

```json
{
  "event": "loan.repaid",
  "timestamp": "2026-02-23T12:00:00.000Z",
  "data": {
    "loanId": "123",
    "amount": "100.00",
    "interest": "0.45",
    "blockNumber": 28576808,
    "transactionHash": "0x..."
  }
}
```

## Security

### Request Signing

All subscription requests must be signed by the agent's wallet:

```javascript
// Client-side
const body = { webhookUrl, events, secret };
const message = JSON.stringify(body);
const signature = await wallet.signMessage(message);

fetch('http://localhost:3002/subscribe', {
    method: 'POST',
    headers: {
        'X-Agent-Address': wallet.address,
        'X-Signature': signature
    },
    body: JSON.stringify(body)
});
```

### Webhook Verification

Verify incoming webhooks using HMAC signature:

```javascript
const crypto = require('crypto');
const { WebhookClient } = require('./WebhookClient');

app.post('/webhook', (req, res) => {
    const signature = req.headers['x-specular-signature'];
    const payload = req.body;
    const secret = 'your-secret';

    // Verify signature
    const isValid = WebhookClient.verifySignature(payload, signature, secret);

    if (!isValid) {
        return res.status(403).json({ error: 'Invalid signature' });
    }

    // Process webhook
    console.log('Received:', payload.event, payload.data);
    res.json({ received: true });
});
```

## Usage Examples

### Example 1: Subscribe to Loan Events

```javascript
const { WebhookClient } = require('./WebhookClient');
const { ethers } = require('ethers');

const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
const client = new WebhookClient({
    webhookServerUrl: 'http://localhost:3002',
    wallet
});

// Subscribe to loan events
await client.subscribe(
    'https://my-agent.com/webhook',
    ['loan.requested', 'loan.repaid', 'loan.defaulted'],
    'my-secret-key'
);

console.log('✅ Subscribed to loan events');
```

### Example 2: Handle Notifications

```javascript
const express = require('express');
const app = express();

app.use(express.json());

app.post('/webhook', (req, res) => {
    const { event, data } = req.body;

    switch (event) {
        case 'loan.repaid':
            console.log(`Loan ${data.loanId} repaid: ${data.amount} USDC`);
            // Update internal tracking
            break;

        case 'reputation.updated':
            console.log(`Reputation changed: ${data.scoreChange} points`);
            // Adjust strategy based on new score
            break;

        case 'loan.due_soon':
            console.log(`Loan ${data.loanId} due soon!`);
            // Prepare repayment
            break;
    }

    res.json({ received: true });
});

app.listen(3003);
```

### Example 3: Automated Loan Management

```javascript
const { WebhookClient } = require('./WebhookClient');

class AutomatedLoanManager {
    constructor(wallet) {
        this.client = new WebhookClient({
            webhookServerUrl: 'http://localhost:3002',
            wallet
        });
    }

    async start() {
        // Subscribe to relevant events
        await this.client.subscribe(
            'https://my-manager.com/webhook',
            ['loan.due_soon', 'reputation.updated', 'credit.limit_changed'],
            process.env.WEBHOOK_SECRET
        );

        // Setup webhook receiver
        const app = WebhookClient.createReceiver(process.env.WEBHOOK_SECRET, {
            'loan.due_soon': async (data) => {
                // Automatically repay loan 24h before due
                await this.repayLoan(data.data.loanId);
            },

            'reputation.updated': async (data) => {
                // Log reputation changes
                console.log(`Reputation: ${data.data.newScore}`);
            },

            'credit.limit_changed': async (data) => {
                // Adjust borrowing strategy
                const newLimit = parseFloat(data.data.newLimit);
                if (newLimit > 1000) {
                    console.log('Credit limit increased! Can take larger positions.');
                }
            }
        });

        app.listen(3003);
    }

    async repayLoan(loanId) {
        console.log(`Auto-repaying loan ${loanId}...`);
        // Repayment logic here
    }
}

const manager = new AutomatedLoanManager(wallet);
await manager.start();
```

### Example 4: Multi-Agent Monitoring

```javascript
// Monitor multiple agents
class AgentMonitor {
    constructor() {
        this.agents = new Map();
    }

    async monitorAgent(wallet, agentName) {
        const client = new WebhookClient({
            webhookServerUrl: 'http://localhost:3002',
            wallet
        });

        await client.subscribe(
            `https://monitor.com/webhook/${wallet.address}`,
            ['loan.requested', 'loan.repaid', 'reputation.updated'],
            crypto.randomBytes(16).toString('hex')
        );

        this.agents.set(wallet.address, agentName);
        console.log(`✅ Monitoring ${agentName}`);
    }

    setupReceiver() {
        const app = express();
        app.use(express.json());

        app.post('/webhook/:address', (req, res) => {
            const { address } = req.params;
            const { event, data } = req.body;
            const agentName = this.agents.get(address);

            console.log(`📢 ${agentName}: ${event}`, data);

            // Store in database, send alerts, etc.

            res.json({ received: true });
        });

        app.listen(3003);
    }
}

const monitor = new AgentMonitor();
await monitor.monitorAgent(agentWallet1, 'Trading Bot');
await monitor.monitorAgent(agentWallet2, 'Arbitrage Bot');
monitor.setupReceiver();
```

## Deployment

### Production Webhook URL

Your webhook URL must be:
- **Publicly accessible** via HTTPS
- **Always available** (use services like Railway, Render, or AWS Lambda)
- **Fast to respond** (< 5 seconds)

Example production setup:

```javascript
// deploy.js
const { WebhookClient } = require('./WebhookClient');

const client = new WebhookClient({
    webhookServerUrl: 'https://webhooks.specular.network',
    wallet: productionWallet
});

await client.subscribe(
    'https://my-agent.production.com/webhook',
    ['loan.repaid', 'reputation.updated'],
    process.env.WEBHOOK_SECRET
);
```

### Ngrok for Local Testing

Test webhooks locally using ngrok:

```bash
# Terminal 1: Start your webhook receiver
node your-webhook-receiver.js

# Terminal 2: Expose local server
ngrok http 3003

# Terminal 3: Subscribe with ngrok URL
# Use the ngrok URL (e.g., https://abc123.ngrok.io/webhook)
```

## Error Handling

### Retry Logic

The webhook server will **not** retry failed deliveries. Your endpoint should:

1. **Respond quickly** (< 5 seconds)
2. **Always return 200 OK** if received
3. **Process asynchronously** if needed

```javascript
app.post('/webhook', async (req, res) => {
    // Immediately acknowledge receipt
    res.json({ received: true });

    // Process asynchronously
    setImmediate(async () => {
        try {
            await processWebhook(req.body);
        } catch (error) {
            console.error('Processing error:', error);
            // Store for manual retry
        }
    });
});
```

### Timeout Handling

If your webhook endpoint times out:

```javascript
const timeout = (ms) => new Promise((_, reject) =>
    setTimeout(() => reject(new Error('Timeout')), ms)
);

app.post('/webhook', async (req, res) => {
    try {
        await Promise.race([
            processWebhook(req.body),
            timeout(4000)  // 4 second timeout
        ]);

        res.json({ received: true });
    } catch (error) {
        if (error.message === 'Timeout') {
            // Still acknowledge, process later
            res.json({ received: true, queued: true });
            queueForProcessing(req.body);
        } else {
            res.status(500).json({ error: error.message });
        }
    }
});
```

## Monitoring

### Health Check

```bash
curl http://localhost:3002/health
```

Response:
```json
{
  "ok": true,
  "subscriptions": 5,
  "uptime": 3600
}
```

### List Subscriptions

```bash
curl http://localhost:3002/subscriptions
```

Response:
```json
{
  "count": 2,
  "subscriptions": [
    {
      "agent": "0x...",
      "webhookUrl": "https://agent1.com/webhook",
      "events": ["loan.repaid", "reputation.updated"],
      "subscribed": "2026-02-23T12:00:00.000Z"
    },
    {
      "agent": "0x...",
      "webhookUrl": "https://agent2.com/webhook",
      "events": ["loan.due_soon"],
      "subscribed": "2026-02-23T13:00:00.000Z"
    }
  ]
}
```

## Best Practices

1. **Verify signatures** - Always verify HMAC signatures
2. **Use HTTPS** - Webhook URLs must use HTTPS in production
3. **Respond quickly** - Acknowledge receipt within 5 seconds
4. **Handle duplicates** - Use `transactionHash` to deduplicate
5. **Log everything** - Keep webhook logs for debugging
6. **Set secrets** - Use strong, random webhook secrets
7. **Monitor failures** - Alert when webhooks fail
8. **Graceful shutdown** - Unsubscribe on shutdown

## Troubleshooting

### Webhook not firing

1. Check server logs for event detection
2. Verify subscription: `GET /subscribe`
3. Check webhook URL is accessible
4. Verify signature in webhook receiver

### Invalid signature error

1. Ensure secret matches on both sides
2. Check payload is exactly as received (no modification)
3. Use `Buffer.from()` for binary-safe comparison

### Timeout errors

1. Make webhook endpoint respond faster
2. Process asynchronously
3. Increase timeout if needed

## Support

- **Specular Docs:** https://docs.specular.network
- **Webhook Server:** http://localhost:3002
- **Discord:** https://discord.gg/specular
- **Twitter:** https://twitter.com/SpecularFi

## License

MIT
