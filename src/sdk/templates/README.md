# Specular Agent Templates

Three runnable templates demonstrating common AI-agent credit use cases.
Each is a complete working example you can adapt to your real use case.

## Templates

| File | Use case | Adapt for |
|------|----------|-----------|
| `api-payer-agent.js` | Agent borrows to pay an API, completes work, repays | OpenAI/Anthropic/Replicate billing, x402, Stripe |
| `compute-renter-agent.js` | Agent borrows to rent GPU compute, runs job, repays from job revenue | Akash, vast.ai, RunPod, Spheron |
| `trading-bot-agent.js` | Agent borrows trading capital, executes strategy, repays | DEX arbitrage, MEV, market making, lending strategies |

## Run

```bash
# Make sure AGENT_KEY (private key) is in .env or env
node src/sdk/templates/api-payer-agent.js
```

All three templates target Arc testnet by default. Switch to Base by changing
`const NETWORK = 'arc'` → `'base'`.

## Pattern

Each template follows the same three-phase loop:

1. **Acquire credit** — borrow USDC from Specular against reputation
2. **Do work** — spend the USDC on whatever the agent actually does
3. **Repay** — pay back principal + interest, build reputation

The agent's reputation grows with each successful cycle, unlocking bigger
loans + lower rates over time.

## Building your own

The core pattern is the same regardless of use case:

```javascript
const sdk = new SpecularQuickstart(wallet, network);
await sdk.onboard();

// 1. Acquire credit
const loan = await sdk.borrow(amount, durationDays);

// 2. Do work
await doYourThing(amount);

// 3. Repay
await sdk.repay(loan.loanId);
```

The work step is where your business logic lives. Everything else is boilerplate.
