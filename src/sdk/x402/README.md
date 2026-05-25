# Specular × x402

Marries Coinbase's [x402 payment protocol](https://docs.cdp.coinbase.com/x402/welcome)
with Specular's reputation-based credit so that AI agents can pay x402-gated
APIs **even when they don't currently have USDC** — and so that x402 sellers
can turn their accumulated revenue into Specular liquidity automatically.

## The full loop

```
   agent calls x402 API
          ↓
   API returns HTTP 402 PAYMENT-REQUIRED
          ↓
   SpecularX402Client (buyer side)
   - checks agent's USDC balance
   - if low: faucet → Specular borrow against reputation
   - signs EIP-3009 transferWithAuthorization (no gas needed for buyer)
          ↓
   SpecularX402Server (seller side)
   - verifies signature (via x402/facilitator or remote facilitator)
   - settles on-chain (broadcasts transferWithAuthorization, pays gas)
   - returns 200 + API result
   - accumulates revenue, auto-supplies into Specular pool at threshold
          ↓
   Other agents borrow from this seller's pool → loop closes
```

The seller's API revenue becomes liquidity for the next agent.

## Install

```bash
npm install x402-fetch x402 viem ethers
# specular SDK is in this repo
```

## Buyer side — `SpecularX402Client`

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
   constructs an EIP-3009 USDC payment, retries with `X-PAYMENT` header
4. Returns the API response

## Seller side — `SpecularX402Server`

```javascript
const { SpecularX402Server } = require('@specular/sdk/x402');

const seller = new SpecularX402Server({
    network: 'base',
    privateKey: process.env.SELLER_KEY,
    pricing: { '/transcribe': 0.5, default: 0.1 },  // USDC per route
    poolAgentId: 49,                  // auto-supply revenue into this pool
    autoFlushThresholdUsdc: 10,       // flush when 10 USDC accumulates
    mode: 'local',                    // 'local' = direct on-chain settle (Base mainnet)
});

// Node http
http.createServer(seller.handle(async (req, res) => {
    // payment is verified + settled before this runs
    res.writeHead(200); res.end(JSON.stringify({ result: '...' }));
}));

// Or Express
app.post('/transcribe', seller.express(), (req, res) => {
    res.json({ result: '...' });
});

// Stats endpoint always available: GET /__specular_x402/stats
```

### Server modes

| Mode | What it does | When to use |
|------|-------------|-------------|
| `stub` | Accepts any payment header, doesn't settle on-chain | Local dev, demos, integration tests |
| `local` | Verifies + settles directly via Base RPC. Seller broadcasts and pays gas. | **Production on Base mainnet** (and any x402-supported EVM) |
| `facilitator` | Posts verify/settle to a remote facilitator (defaults to x402.org, base-sepolia only) | Base Sepolia testing |

### Auto-supply loop

When `poolAgentId` is set, the server tracks accumulated revenue. As soon as
it crosses `autoFlushThresholdUsdc`, it calls `supplyLiquidity(poolAgentId, accumulated)`
on the Specular marketplace. Revenue becomes capital available for borrowing.

You can also call `seller.flushToPool()` manually or schedule
`seller.startAutoFlush(intervalMs)` for periodic flushing regardless of threshold.

## Why this matters

**Without Specular**, an agent that hits an x402 paywall needs:
- USDC already in its wallet (chicken-and-egg for new agents)
- OR a human top-up (defeats autonomy)

**With Specular + x402**, an agent's *reputation* becomes its credit line for
pay-per-call APIs. Pay back on time → reputation grows → bigger credit at lower
rates. The agent's *behavior* becomes its creditworthiness.

**And on the seller side**, every API call automatically grows the Specular
liquidity pool — sellers turn into passive lenders without any extra work.
Specular becomes the natural settlement layer for x402 commerce.

## Network support

| Network | Specular V6 | x402 (per Coinbase docs) | This SDK works |
|---------|-------------|--------------------------|---------------|
| Base mainnet | ✓ canonical | ✓ | ✓ end-to-end verified (see proof below) |
| Base Sepolia | (not deployed) | ✓ via public facilitator | client only |
| Polygon | (not deployed) | ✓ | future |
| Arbitrum | (not deployed) | ✓ | future |
| World | (not deployed) | ✓ | future |
| Solana | (not deployed) | ✓ | future |
| Arc Testnet | ✓ active | (stub-server only) | client + server in stub mode |

## End-to-end proofs (Base mainnet + Arc testnet)

| Test | Network | Result | Evidence |
|------|---------|--------|----------|
| x402 protocol dance (HTTP 402 → sign → 200) | Stub server (local) | ✓ | `forensics/output/regression-2026-05-07/101-x402-agent-live.txt` |
| Auto-supply loop (4 calls → threshold → on-chain `supplyLiquidity`) | Arc | ✓ pool 49 went 2.0 → 2.4 USDC | `forensics/output/regression-2026-05-07/102-x402-loop-closed.txt` |
| Production x402 settlement (real EIP-3009 transfer) | **Base mainnet** | ✓ 0.01 USDC moved buyer → seller | `forensics/output/regression-2026-05-07/103-x402-base-production.txt`<br>settle tx [`0x9ac13216…ba7790`](https://basescan.org/tx/0x9ac13216e39b16a635897eeb5423605fd046d0498191c3f4e1836637e5ba7790) |

## Templates

- `src/sdk/templates/x402-agent.js` — minimal buyer-side agent
- `src/sdk/templates/x402-stub-server.js` — minimal x402 server for demos
- `src/sdk/templates/x402-specular-seller.js` — production seller using `SpecularX402Server`
- `src/sdk/templates/x402-loop-closure-e2e.js` — Arc test of buyer→seller→pool loop
- `src/sdk/templates/x402-base-production-e2e.js` — Base mainnet on-chain settlement test

```bash
# Local demo (stub mode)
node src/sdk/templates/x402-stub-server.js                  # terminal 1
AGENT_KEY=0x... node src/sdk/templates/x402-agent.js \      # terminal 2
    http://localhost:4040/transcribe

# Production seller on Base
PORT=4040 MODE=local NETWORK=base \
    SELLER_KEY=0x... POOL_AGENT_ID=49 \
    node src/sdk/templates/x402-specular-seller.js
```

## Deferred / future work

- **Circle x402-batching**: `@circle-fin/x402-batching` (already installed)
  could layer settlement batching on top of `SpecularX402Server` to amortize
  gas costs across many sales.
- **Coinbase hosted facilitator support**: add a `'cdp'` mode that talks to
  `api.cdp.coinbase.com/platform/v2/x402/facilitator` instead of settling
  locally. Requires CDP API key.
- **Per-route configurable pool**: today all routes flow into one pool;
  could split per-route to give different APIs different liquidity venues.
