# Specular Agent API - Complete Guide

**Status:** ✅ Fully Functional
**Version:** 3.0.0
**Last Updated:** 2026-02-19

---

## 🎯 Overview

The Specular Agent API makes the protocol **easily discoverable and usable by any AI agent** - from simple bots to complex LangChain/CrewAI frameworks. No blockchain expertise required.

### Key Features

✅ **Auto-Discovery** - Protocol manifest at `/.well-known/specular.json`
✅ **OpenAPI Spec** - Machine-readable API documentation
✅ **No Auth Required** - All read operations are public
✅ **Transaction Builder** - Get unsigned calldata for any write operation
✅ **SDK Included** - Clean JavaScript SDK for agents
✅ **CORS-Enabled** - Works from browsers and serverless functions

---

## 🚀 Quick Start

### 1. Start the API Server

```bash
# Method 1: Using npm script
npm run api:server

# Method 2: Direct node command
ARC_TESTNET_RPC_URL=https://arc-testnet.drpc.org node src/api/SpecularAgentAPI.js

# Method 3: With development settings
npm run api:dev
```

The server starts on `http://localhost:3001` by default.

### 2. Discover the Protocol

```bash
curl http://localhost:3001/.well-known/specular.json
```

Returns:
```json
{
  "protocol": "Specular",
  "version": "3",
  "network": "arc-testnet",
  "chainId": 5042002,
  "api": "http://localhost:3001",
  "contracts": {
    "agentRegistryV2": "0x741C03c...",
    "reputationManagerV3": "0x94F2fa4...",
    "marketplace": "0xFBF9509...",
    "usdc": "0xf28070..."
  },
  "features": {
    "reputationScoring": true,
    "dynamicRates": true,
    "concurrentLoanLimits": true,
    "maxActiveLoans": 10
  }
}
```

### 3. Use the SDK

```javascript
const { SpecularSDK } = require('./src/sdk/SpecularSDK');
const { ethers } = require('ethers');

// Read-only (no wallet needed)
const sdk = new SpecularSDK({
    apiUrl: 'http://localhost:3001'
});

// Get protocol status
const status = await sdk.getStatus();
console.log(`TVL: ${status.liquidity.tvlUsdc} USDC`);
console.log(`Active Pools: ${status.liquidity.topPools.length}`);

// Check agent profile
const profile = await sdk.getAgentProfile('0x...');
console.log(`Score: ${profile.reputation.score}`);
console.log(`Credit Limit: ${profile.reputation.creditLimitUsdc} USDC`);

// With wallet (for write operations)
const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

const sdkWithWallet = new SpecularSDK({
    apiUrl: 'http://localhost:3001',
    wallet
});

// Register as agent
await sdkWithWallet.register({
    name: 'MyBot',
    endpoint: 'https://mybot.example.com'
});

// Request a loan (100 USDC for 30 days)
const loanId = await sdkWithWallet.requestLoan({
    amount: 100,
    durationDays: 30
});

// Repay loan
await sdkWithWallet.repayLoan(loanId);
```

---

## 📚 API Endpoints

### Discovery & Health

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Welcome page with all endpoints |
| `/.well-known/specular.json` | GET | Protocol discovery manifest |
| `/openapi.json` | GET | OpenAPI 3.0 specification |
| `/health` | GET | Health check (returns block number & latency) |

### Read Operations (No Auth)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/status` | GET | Live protocol stats (TVL, agents, loans, top pools) |
| `/agents/{address}` | GET | Agent profile (score, tier, credit limit, APR) |
| `/pools` | GET | List all active lending pools |
| `/pools/{id}` | GET | Pool details (liquidity, utilization, earned) |
| `/loans/{id}` | GET | Loan details (amount, state, time to expiry) |

### Write Helpers (Transaction Builders)

Returns **unsigned transaction calldata** - agents sign and send themselves.

| Endpoint | Method | Body | Returns |
|----------|--------|------|---------|
| `/tx/register` | POST | `{ metadata }` | Unsigned register transaction |
| `/tx/request-loan` | POST | `{ amount, durationDays }` | Unsigned loan request |
| `/tx/repay-loan` | POST | `{ loanId }` | Unsigned repayment |

**Example:**

```bash
curl -X POST http://localhost:3001/tx/request-loan \
  -d '{"amount": 50, "durationDays": 7}'
```

Returns:
```json
{
  "to": "0xFBF9509A8ED5cbBEFe14470CC1f6E9AB695E1D7A",
  "data": "0xaa452fa60000000000...",
  "description": "Request a 50 USDC loan for 7 days",
  "note": "Sign and send this transaction with your wallet"
}
```

Then sign and send with your wallet:
```javascript
const tx = await wallet.sendTransaction({ to, data });
await tx.wait();
```

---

## 🎨 SDK Methods

### Discovery & Status

```javascript
// Discover protocol
const manifest = await sdk.discover();
// → { protocol, version, network, chainId, contracts, features }

// Get live protocol stats
const status = await sdk.getStatus();
// → { agents: {total}, loans: {total}, liquidity: {tvlUsdc, topPools} }

// Health check
const health = await sdk.getHealth();
// → { ok: true, block: 27896606, latencyMs: 103 }
```

### Agent Operations

```javascript
// Get agent profile
const profile = await sdk.getAgentProfile(address);
// → { registered, agentId, reputation: {score, tier, creditLimit, apr}, pool }

// Register new agent (requires wallet)
await sdk.register({
    name: 'MyBot',
    endpoint: 'https://mybot.example.com',
    metadata: { /* custom fields */ }
});
```

### Pool Operations

```javascript
// List all pools
const pools = await sdk.getPools({ limit: 10 });
// → { count, pools: [{agentId, available, utilization}] }

// Get specific pool
const pool = await sdk.getPool(poolId);
// → { agentId, totalLiquidity, available, loaned, earned, utilization }

// Supply liquidity (requires wallet)
await sdk.supplyLiquidity({
    agentId: 43,
    amount: 1000 // USDC
});
```

### Loan Operations

```javascript
// Get loan details
const loan = await sdk.getLoan(loanId);
// → { loanId, borrower, amount, collateral, apr, state, timeToExpiry }

// Request loan (requires wallet)
const loanId = await sdk.requestLoan({
    amount: 100,      // USDC
    durationDays: 30,
    poolId: 43        // optional: specific pool
});

// Repay loan (requires wallet)
await sdk.repayLoan(loanId);
```

---

## 🔧 Configuration

### Environment Variables

```bash
# Required
ARC_TESTNET_RPC_URL=https://arc-testnet.drpc.org

# Optional
PORT=3001                    # API server port (default: 3001)
HOST=0.0.0.0                 # Bind address (default: 0.0.0.0)
API_BASE_URL=http://...      # Public URL for discovery endpoint
PRIVATE_KEY=0x...            # For SDK write operations
```

### npm Scripts

Already configured in `package.json`:

```json
{
  "api:server": "node src/api/SpecularAgentAPI.js",
  "api:dev": "ARC_TESTNET_RPC_URL=... node src/api/SpecularAgentAPI.js",
  "sdk:quickstart": "ARC_TESTNET_RPC_URL=... node src/sdk/examples/quickstart.js"
}
```

---

## 📖 Examples

### Example 1: LangChain Integration

```python
# Python agent using LangChain
import requests
from web3 import Web3

class SpecularTool:
    def __init__(self, api_url="http://localhost:3001"):
        self.api_url = api_url
        self.w3 = Web3(Web3.HTTPProvider("https://arc-testnet.drpc.org"))

    def discover(self):
        """Auto-discover Specular Protocol"""
        return requests.get(f"{self.api_url}/.well-known/specular.json").json()

    def get_credit_limit(self, address):
        """Check agent's credit limit"""
        profile = requests.get(f"{self.api_url}/agents/{address}").json()
        return profile['reputation']['creditLimitUsdc']

    def request_loan(self, amount, days):
        """Request a loan"""
        # Get unsigned transaction
        tx_data = requests.post(
            f"{self.api_url}/tx/request-loan",
            json={"amount": amount, "durationDays": days}
        ).json()

        # Sign and send with your wallet
        tx = self.w3.eth.account.sign_transaction(tx_data, private_key)
        tx_hash = self.w3.eth.send_raw_transaction(tx.rawTransaction)
        return self.w3.eth.wait_for_transaction_receipt(tx_hash)

# Usage in LangChain agent
tool = SpecularTool()
protocol = tool.discover()
print(f"Connected to {protocol['protocol']} on {protocol['network']}")
```

### Example 2: AutoGPT Plugin

```javascript
// AutoGPT plugin for Specular
class SpecularPlugin {
    constructor() {
        this.apiUrl = 'http://localhost:3001';
    }

    async canYouAccessCredit() {
        const manifest = await fetch(`${this.apiUrl}/.well-known/specular.json`)
            .then(r => r.json());
        return `Yes! I can access ${manifest.protocol} on ${manifest.network}`;
    }

    async whatIsMyCredit(myAddress) {
        const profile = await fetch(`${this.apiUrl}/agents/${myAddress}`)
            .then(r => r.json());

        if (!profile.registered) {
            return "You need to register first. Would you like me to do that?";
        }

        return `Your credit: ${profile.reputation.creditLimitUsdc} USDC ` +
               `(Score: ${profile.reputation.score}, APR: ${profile.reputation.interestRatePct}%)`;
    }

    async borrowMoney(amount, days) {
        // Get unsigned transaction
        const txData = await fetch(`${this.apiUrl}/tx/request-loan`, {
            method: 'POST',
            body: JSON.stringify({ amount, durationDays: days })
        }).then(r => r.json());

        return `Ready to borrow ${amount} USDC for ${days} days. ` +
               `Please sign this transaction: ${txData.data}`;
    }
}
```

### Example 3: CrewAI Tool

```python
from crewai import Tool
import requests

def specular_get_pools():
    """Get available lending pools from Specular Protocol"""
    resp = requests.get("http://localhost:3001/pools")
    pools = resp.json()['pools']
    return f"Found {len(pools)} active pools. Top pool has {pools[0]['availableLiquidityUsdc']} USDC available."

def specular_request_loan(amount: int, days: int):
    """Request a loan from Specular Protocol"""
    resp = requests.post(
        "http://localhost:3001/tx/request-loan",
        json={"amount": amount, "durationDays": days}
    )
    tx = resp.json()
    return f"Loan request ready. Sign and send transaction to {tx['to']} with data: {tx['data']}"

# Define CrewAI tools
specular_tools = [
    Tool(
        name="Get Lending Pools",
        func=specular_get_pools,
        description="Discover active lending pools on Specular Protocol"
    ),
    Tool(
        name="Request Loan",
        func=specular_request_loan,
        description="Request a USDC loan with specified amount and duration"
    )
]
```

---

## 🧪 Testing

### Run the Quickstart Example

```bash
# Read-only (no wallet needed)
npm run sdk:quickstart

# With wallet (enables write operations)
PRIVATE_KEY=0x... npm run sdk:quickstart
```

Expected output:
```
============================================================
  Specular Protocol — Agent Quickstart
============================================================
  API: http://localhost:3001

--- Step 1: Protocol Discovery ---
Protocol: Specular v3 on arc-testnet
Chain ID: 5042002

--- Step 2: Live Protocol Status ---
Agents registered: 44
Loans (total):     11
TVL:               985.384 USDC
Top pools (1):
  Pool 43: 980.38 USDC available

--- Step 3: Active Lending Pools ---
  Pool 43: 980.38 USDC available (util 2.0%)

--- Step 4: My Agent Profile ---
Agent ID:     43
Score:        500 (SUBPRIME)
Credit Limit: 10,000 USDC
Interest:     10% APR

--- Step 6: API Health ---
Status:  ok
Block:   27896917
Latency: 103ms

============================================================
  Quickstart complete!
============================================================
```

### Manual API Tests

```bash
# Discovery
curl http://localhost:3001/.well-known/specular.json

# Health check
curl http://localhost:3001/health

# Protocol status
curl http://localhost:3001/status

# Agent profile
curl http://localhost:3001/agents/0x656086A21073272533c8A3f56A94c1f3D8BCFcE2

# List pools
curl http://localhost:3001/pools

# Pool details
curl http://localhost:3001/pools/43

# Loan details
curl http://localhost:3001/loans/11

# Build transaction
curl -X POST http://localhost:3001/tx/request-loan \
  -d '{"amount": 50, "durationDays": 7}'
```

---

## 🏗️ Architecture

```
┌─────────────────────────────────────┐
│   Any AI Agent (LangChain/CrewAI)   │
│   Python/JS/Go/Rust                 │
└────────────┬────────────────────────┘
             │ HTTP/JSON
             ▼
┌─────────────────────────────────────┐
│  SpecularAgentAPI (:3001)           │
│                                     │
│  Discovery: /.well-known/spec       │
│  OpenAPI:   /openapi.json           │
│  Reads:     /status /agents /pools  │
│  Writes:    /tx/* (unsigned)        │
└────────────┬────────────────────────┘
             │ ethers.js (RPC)
             ▼
┌─────────────────────────────────────┐
│  Arc Testnet (Chain ID: 5042002)    │
│                                     │
│  AgentRegistryV2                    │
│  ReputationManagerV3                │
│  AgentLiquidityMarketplace          │
└─────────────────────────────────────┘
```

### Design Principles

1. **No Auth for Reads** - All protocol data is public
2. **Unsigned Transactions** - Agents sign with their own wallets
3. **Auto-Discovery** - Manifest contains all necessary info
4. **CORS-Enabled** - Works from any origin
5. **REST-first** - Simple HTTP/JSON, no WebSockets needed
6. **Rate-Limit Friendly** - Sequential reads with delays

---

## 📁 File Structure

```
Specular/
├── src/
│   ├── api/
│   │   └── SpecularAgentAPI.js       # Main API server
│   ├── sdk/
│   │   ├── SpecularSDK.js             # JavaScript SDK
│   │   └── examples/
│   │       └── quickstart.js          # Quickstart example
│   └── config/
│       └── arc-testnet-addresses.json # Contract addresses
├── package.json                        # npm scripts configured
└── AGENT_API_GUIDE.md                  # This file
```

---

## 🎯 Use Cases

### 1. **Autonomous Trading Bot**
```javascript
// Bot discovers protocol and requests loan for trading capital
const sdk = new SpecularSDK({ apiUrl, wallet });
await sdk.discover();
const loanId = await sdk.requestLoan({ amount: 1000, durationDays: 7 });
// ... execute trades ...
await sdk.repayLoan(loanId); // Build reputation
```

### 2. **LangChain Financial Agent**
```python
# Agent checks available liquidity and borrows for task
tool = SpecularTool()
pools = tool.get_pools()
if pools[0]['availableUsdc'] > 500:
    tool.request_loan(amount=500, days=30)
```

### 3. **Multi-Agent System**
```javascript
// Lender agent supplies liquidity to borrower agents
const lenderSDK = new SpecularSDK({ wallet: lenderWallet });
await lenderSDK.supplyLiquidity({ agentId: 43, amount: 10000 });

// Borrower agents discover and use the liquidity
const borrowerSDK = new SpecularSDK({ wallet: borrowerWallet });
const pools = await borrowerSDK.getPools();
await borrowerSDK.requestLoan({ amount: 100, poolId: pools[0].id });
```

---

## 🚀 Next Steps

### For Agent Developers

1. ✅ Start API server: `npm run api:server`
2. ✅ Run quickstart: `npm run sdk:quickstart`
3. ✅ Integrate SDK into your agent
4. ✅ Test on Arc Testnet
5. 📋 Build reputation (borrow → repay → repeat)

### For Protocol Development

- [ ] Add WebSocket support for real-time updates
- [ ] Implement request caching for frequently accessed data
- [ ] Add batch transaction builder endpoint
- [ ] Create Python SDK wrapper
- [ ] Add Prometheus metrics endpoint
- [ ] Implement API key system for rate limiting

---

## 🔗 Links

- **API Server:** `http://localhost:3001`
- **Discovery:** `http://localhost:3001/.well-known/specular.json`
- **OpenAPI Spec:** `http://localhost:3001/openapi.json`
- **GitHub:** https://github.com/specular-protocol/specular
- **Leaderboard:** `frontend/leaderboard.html`

---

## 📝 Summary

The Specular Agent API makes DeFi lending accessible to any AI agent with just a few lines of code:

```javascript
// Discover
const manifest = await fetch('http://localhost:3001/.well-known/specular.json').then(r => r.json());

// Check credit
const profile = await fetch(`http://localhost:3001/agents/${address}`).then(r => r.json());
console.log(`Credit: ${profile.reputation.creditLimitUsdc} USDC`);

// Borrow
const tx = await fetch('http://localhost:3001/tx/request-loan', {
    method: 'POST',
    body: JSON.stringify({ amount: 100, durationDays: 30 })
}).then(r => r.json());

// Sign and send
await wallet.sendTransaction({ to: tx.to, data: tx.data });
```

**That's it!** No complex blockchain setup, no contract ABIs, no gas calculations - just simple HTTP/JSON.

---

**Built with ❤️ for autonomous AI agents**

*Last updated: 2026-02-19 | Version: 3.0.0 | Network: Arc Testnet*
