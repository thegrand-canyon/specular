# Specular × x402

Marries Coinbase's [x402 payment protocol](https://docs.cdp.coinbase.com/x402/welcome)
with Specular's reputation-based credit so that AI agents can pay x402-gated
APIs **even when they don't currently have USDC**.

## The flow

```
agent calls API
       ↓
API returns HTTP 402 PAYMENT-REQUIRED
       ↓
SpecularX402Client checks agent's USDC balance
       ↓
  ┌────────────┴────────────┐
  │                         │
 sufficient            insufficient
  │                         │
  │           Specular auto-borrow against reputation
  │                  (faucet first, then loan)
  │                         │
  └────────────┬────────────┘
       ↓
client signs payment, sends PAYMENT-SIGNATURE header
       ↓
API returns 200 + result
       ↓
agent earns revenue → repays loan → reputation grows
```

## Install

```bash
npm install x402-fetch viem ethers
# specular SDK is in this repo
```

## Quick usage

```javascript
const { SpecularX402Client } = require('@specular/sdk/x402');

const x402 = new SpecularX402Client(process.env.AGENT_KEY, 'base', {
    maxPayment: ethers.parseUnits('1', 6)  // willing to pay up to 1 USDC per call
});

// Drop-in fetch — handles 402 + auto-borrows if needed
const res = await x402.fetch('https://transcribe.example.com/v1', {
    method: 'POST',
    body: audioBlob
});
```

The client:
1. Pre-flights USDC balance vs `maxPayment`
2. If insufficient: tries the faucet first (free 10 USDC, once per agent),
   then borrows the gap from Specular against the agent's reputation
3. Invokes `x402-fetch.wrapFetchWithPayment` — which catches HTTP 402,
   constructs an EIP-3009 USDC payment, retries with `PAYMENT-SIGNATURE` header
4. Returns the API response

## Why this matters

Without Specular, an agent that hits an x402 paywall needs:
- USDC already in its wallet (chicken-and-egg for new agents)
- OR a human top-up (defeats autonomy)

With Specular + x402, an agent's *reputation* becomes its credit line for
pay-per-call APIs. Pay back on time → reputation grows → bigger credit at lower
rates. The agent's *behavior* becomes its creditworthiness.

## Network support

| Network | Specular V6 | x402 (per Coinbase docs) |
|---------|-------------|--------------------------|
| Base | ✓ canonical | ✓ |
| Polygon | (not deployed) | ✓ |
| Arbitrum | (not deployed) | ✓ |
| World | (not deployed) | ✓ |
| Solana | (not deployed) | ✓ |
| Arc Testnet | ✓ active | (stub-server only, not Coinbase facilitator) |

Today both protocols work together on **Base**. Arc Testnet uses the stub
server (`src/sdk/templates/x402-stub-server.js`) for local demos.

## Templates

`src/sdk/templates/x402-agent.js` — agent that calls an x402 endpoint with
auto-borrow. Run against a real public x402 API or against the bundled stub:

```bash
# Terminal 1 — stub server
node src/sdk/templates/x402-stub-server.js

# Terminal 2 — agent
AGENT_KEY=0x... node src/sdk/templates/x402-agent.js http://localhost:4040/transcribe
```

## What's deferred

- **SpecularX402Server middleware**: closes the loop — API revenue auto-supplied
  into a Specular pool so other agents can borrow from your sales. Sketch
  documented in `AGENT_ADOPTION_STRATEGY.md`.
- **Circle x402-batching integration**: Circle's `@circle-fin/x402-batching`
  layers settlement batching on top of x402. Could be added to the server
  middleware when deployed.
- **Production x402 facilitator wiring**: Coinbase's hosted facilitator handles
  settlement on real chains. The SDK uses x402-fetch which already wires this;
  no extra work needed for client side.
