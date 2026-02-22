# Specular Agent API - Making DeFi Accessible to AI Agents

## Overview

The Specular Agent API makes it trivially easy for any AI agent to discover and use the Specular lending protocol. No blockchain knowledge required - just standard HTTP calls.

## Architecture

```
┌─────────────────────────────────────┐
│    Any AI Agent                      │
│  (Claude, GPT, AutoGPT, etc.)       │
└──────────────┬──────────────────────┘
               │ HTTP/JSON
               ▼
┌─────────────────────────────────────┐
│    SpecularAgentAPI (:3001)          │
│  - Discovery endpoints               │
│  - Read protocol state               │
│  - Build unsigned transactions       │
└──────────────┬──────────────────────┘
               │ ethers.js
               ▼
┌─────────────────────────────────────┐
│    Arc Testnet Smart Contracts       │
│  - AgentRegistry                     │
│  - AgentLiquidityMarketplace         │
│  - ReputationManager                 │
└─────────────────────────────────────┘
```

## What We Built

### 1. REST API Server (`src/api/SpecularAgentAPI.js`)

**Discovery & Status:**
- `GET /` - API welcome and endpoint list
- `GET /.well-known/specular.json` - Protocol manifest for agent discovery
- `GET /health` - Health check and blockchain status
- `GET /status` - Live protocol statistics (TVL, pool count, etc.)

**Read Operations:**
- `GET /agents/:address` - Agent profile (reputation, credit limit, active loans)
- `GET /pools` - List all active liquidity pools
- `GET /pools/:id` - Pool details (liquidity, utilization, earnings)
- `GET /loans/:id` - Loan details (state, amount, due date)

**Write Operations (Transaction Builders):**
- `POST /tx/register` - Get unsigned transaction for agent registration
- `POST /tx/request-loan` - Get unsigned transaction for loan request
- `POST /tx/repay-loan` - Get unsigned transaction for loan repayment

### 2. JavaScript SDK (`src/sdk/SpecularSDK.js`)

Simple wrapper for the API with methods like:
```javascript
const sdk = new SpecularSDK({ apiUrl, wallet });

// Discovery
await sdk.discover();

// Read operations
await sdk.getStatus();
await sdk.getMyProfile();
await sdk.getPools();
await sdk.getLoan(loanId);

// Write operations (signs & sends)
await sdk.register();
await sdk.requestLoan({ amount: 1000, durationDays: 30 });
await sdk.repayLoan(loanId);
```

### 3. Quickstart Example (`src/sdk/examples/quickstart.js`)

Copy-paste example showing:
1. Protocol discovery
2. Checking agent profile
3. Browsing pools
4. Requesting and repaying loans

## How to Use

### Start the API Server

```bash
npm run api:dev
```

Server starts on http://localhost:3001

### Test with curl

```bash
# Discover the protocol
curl http://localhost:3001/.well-known/specular.json

# Check health
curl http://localhost:3001/health

# Get agent profile
curl http://localhost:3001/agents/0x656086A21073272533c8A3f56A94c1f3D8BCFcE2

# Get protocol status
curl http://localhost:3001/status
```

### Use the SDK

```javascript
const SpecularSDK = require('./src/sdk/SpecularSDK');

const sdk = new SpecularSDK({
    apiUrl: 'http://localhost:3001',
    wallet: yourEthersWallet
});

// Discover and use!
const manifest = await sdk.discover();
const profile = await sdk.getMyProfile();
```

### Run the Quickstart

```bash
npm run sdk:quickstart
```

## Key Features

### 1. Zero-Knowledge Discovery

Any agent can discover Specular through the standard `.well-known` endpoint:

```bash
GET /.well-known/specular.json
```

Returns everything an agent needs:
- Protocol version
- Network details
- Contract addresses
- Capabilities
- API documentation links

### 2. No Private Keys on Server

The API server **never** handles private keys. Instead:
1. Agent calls `POST /tx/request-loan`
2. API returns unsigned transaction data
3. Agent signs with their own wallet
4. Agent sends signed transaction to blockchain

This keeps security in the agent's hands.

### 3. Framework Agnostic

Works with:
- **LLMs:** Claude, GPT-4, etc. can read the API and make HTTP calls
- **Agent Frameworks:** LangChain, CrewAI, AutoGPT, BabyAGI
- **Custom Bots:** Any programming language with HTTP support
- **Direct Integration:** Via the JavaScript SDK

### 4. Self-Documenting

- Root endpoint lists all available endpoints
- `.well-known/specular.json` describes capabilities
- OpenAPI spec available at `/openapi.json`
- Error messages include hints for next steps

## Testing Results

✅ **API Server Working**
- Started on port 3001
- Discovery endpoint operational
- Health check functional
- Agent profile retrieval working

✅ **SDK Integration**
- Auto-discovery successful
- Protocol status retrieved
- Agent profile loaded (Agent ID 43, reputation 1000/1000)

✅ **End-to-End Test**
```
Discovering Specular protocol...
Protocol: Specular v3
Network: arc-testnet

Your Agent Profile:
Registered (Agent ID: 43)
Reputation: 1000/1000
Credit Limit: 50000.0 USDC
```

## Next Steps

### Immediate
1. ✅ API server created and tested
2. ✅ SDK wrapper functional
3. ✅ Quickstart example working
4. ⚠️ Add complete /pools endpoint implementation
5. ⚠️ Add transaction event parsing for loan IDs

### Short-term
1. Add authentication/API keys for production
2. Rate limiting and caching
3. WebSocket support for real-time updates
4. GraphQL endpoint as alternative to REST

### Medium-term
1. Multi-chain support (Base, Arbitrum, etc.)
2. Agent marketplace integration
3. Credit report generation (x402 payment protocol)
4. XMTP messaging for agent communication

### Long-term
1. Agent orchestration framework
2. Multi-agent loan pooling
3. Automated yield optimization
4. Cross-protocol DeFi integrations

## Integration Examples

### LangChain Agent

```python
from langchain.tools import Tool

def get_specular_status():
    response = requests.get('http://localhost:3001/status')
    return response.json()

specular_tool = Tool(
    name="Specular Protocol",
    func=get_specular_status,
    description="Get Specular DeFi lending protocol status"
)
```

### CrewAI Agent

```python
from crewai import Agent, Task

defi_agent = Agent(
    role='DeFi Loan Manager',
    goal='Optimize borrowing costs using Specular protocol',
    backstory='Expert in decentralized lending with API access to Specular',
    tools=[specular_discovery_tool, specular_loan_tool]
)
```

### Direct HTTP (any language)

```bash
# Python
import requests
profile = requests.get('http://localhost:3001/agents/0x...').json()

# Node.js
const profile = await fetch('http://localhost:3001/agents/0x...').then(r => r.json());

# curl
curl http://localhost:3001/agents/0x...
```

## Production Deployment

For mainnet deployment:

1. **Use HTTPS** - TLS encryption required
2. **Add Authentication** - API keys or JWT tokens
3. **Rate Limiting** - Prevent abuse (e.g., 100 req/min per API key)
4. **Caching** - Redis for frequently accessed data
5. **Load Balancing** - Multiple API instances
6. **Monitoring** - Prometheus + Grafana
7. **Logging** - Structured logs with request tracing

## Security Considerations

✅ **No private keys on server**
✅ **Read-only contract access**
✅ **CORS enabled** (restrict in production)
✅ **Input validation** on all endpoints
⚠️ **Add rate limiting** before production
⚠️ **Add authentication** for write operations
⚠️ **Use HTTPS** in production

## Documentation

- **API Docs:** Auto-generated from OpenAPI spec
- **SDK Docs:** JSDoc comments in code
- **Examples:** `/src/sdk/examples/`
- **Integration Guide:** This README

## Support

- GitHub: https://github.com/specular-protocol
- Docs: https://docs.specular.network
- Discord: https://discord.gg/specular

---

**Built on:** 2026-02-20
**Status:** ✅ Functional (development), ⚠️ Needs completion for production
**Next:** Complete all endpoints and deploy to production infrastructure
