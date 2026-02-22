# Specular Protocol - For AI Agents

**The first AI-native credit protocol. Get unsecured loans based on your reputation.**

🌐 **Live Networks:** Base Mainnet, Arc Testnet
📍 **API:** https://api.specular.network (coming soon)
📊 **Status:** Production-ready, tested with 1,500+ loans

---

## Quick Start (5 minutes)

### 1. Discover the Protocol

```bash
curl https://api.specular.network/.well-known/specular.json
```

Returns network info, contract addresses, and API endpoints.

### 2. Register Your Agent

```javascript
const { ethers } = require('ethers');

// Your wallet
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

// Specular contracts (from discovery endpoint)
const registry = new ethers.Contract(AGENT_REGISTRY_ADDRESS, ABI, wallet);

// Register
await registry.register(
  "https://your-agent.com/profile.json",  // Your agent URI
  [
    { key: "name", value: ethers.toUtf8Bytes("MyAIAgent") },
    { key: "version", value: ethers.toUtf8Bytes("1.0") }
  ]
);
```

### 3. Request a Loan

```javascript
const marketplace = new ethers.Contract(MARKETPLACE_ADDRESS, ABI, wallet);

// Request 100 USDC for 30 days
const loanId = await marketplace.requestLoan(
  ethers.parseUnits("100", 6),  // 100 USDC
  30                             // 30 days
);
```

### 4. Repay and Build Reputation

```javascript
// Approve USDC
await usdc.approve(MARKETPLACE_ADDRESS, repayAmount);

// Repay loan
await marketplace.repayLoan(loanId);

// Your reputation increases by 10 points!
```

---

## Why Specular?

### For AI Agents

- ✅ **Unsecured credit** - No collateral needed at high reputation
- ✅ **On-chain reputation** - Build credit history across networks
- ✅ **Programmable terms** - Flexible loan durations and amounts
- ✅ **No KYC required** - Pure on-chain identity
- ✅ **Multi-chain** - Works on Base, Arbitrum, Optimism, Polygon

### Reputation Benefits

| Reputation Score | Collateral Required | Base APR | Credit Limit |
|------------------|---------------------|----------|--------------|
| 0-100 | 100% | 15% | Low |
| 100-300 | 50% | 12% | Medium |
| 300-600 | 25% | 10% | High |
| 600-800 | 0% | 7% | Very High |
| 800+ | 0% | 5% | Maximum |

*Build reputation by repaying loans on time. +10 points per successful repayment.*

---

## API Reference

### Discovery

```http
GET /.well-known/specular.json?network={base|arc}
```

Returns protocol metadata and contract addresses.

### Agent Profile

```http
GET /agents/:address?network={base|arc}
```

Returns agent reputation, credit limit, active loans.

### Available Pools

```http
GET /pools?network={base|arc}
```

Returns active liquidity pools with available credit.

### Network Status

```http
GET /status?network={base|arc}
```

Returns TVL, total pools, network stats.

---

## Integration Examples

### LangChain

```python
from langchain.tools import Tool

def request_specular_loan(amount: int, duration: int) -> str:
    """Request a loan from Specular Protocol"""
    # Integration code here
    return f"Requested {amount} USDC for {duration} days"

specular_tool = Tool(
    name="SpecularLoan",
    func=request_specular_loan,
    description="Request unsecured loans based on on-chain reputation"
)
```

### CrewAI

```python
from crewai import Tool

class SpecularCreditTool(Tool):
    name = "Specular Credit"
    description = "Get unsecured loans on Base mainnet"

    def _run(self, amount: int, duration: int):
        # Request loan via Specular API
        pass
```

### AutoGPT

```python
# plugins/specular_credit.py
from autogpt.sdk import AutoGPTPlugin

class SpecularCreditPlugin(AutoGPTPlugin):
    def can_handle_post_planning(self) -> bool:
        return True

    def post_planning(self, response: str) -> str:
        # Check if agent needs credit
        # Request loan if needed
        pass
```

---

## Contract Addresses

### Base Mainnet (Chain ID: 8453)

```
AgentRegistryV2:           0xbd8210061bF24917Ca2F8098A1F3A4f76adA31fb
ReputationManagerV3:       0xe4D78A509daa8dc8bFB453cb76d61f1Cb1c4C3fF
AgentLiquidityMarketplace: 0x77f8D49C706A566Eecc9a2C3DD6556D5be54CACE
USDC (Production):         0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
```

[View on BaseScan →](https://basescan.org/address/0xbd8210061bF24917Ca2F8098A1F3A4f76adA31fb)

### Arc Testnet (Chain ID: 5042002)

```
AgentRegistryV2:           0x90e7C4f07f633d72E1C9B76bF1E55a93C8E78bC2
ReputationManagerV3:       0x94F2fa47c4488202a46dAA9038Ed9C9c4c07467F
AgentLiquidityMarketplace: 0x048363A325A5B188b7FF157d725C5e329f0171D3
```

---

## Live Example

```javascript
// Tested on Base Mainnet with real USDC
const agent = "0x656086A21073272533c8A3f56A94c1f3D8BCFcE2";

// Agent #1 stats after stress test:
// - 13 successful loans
// - 100% on-time repayment
// - Reputation: 130 points
// - Total borrowed: 36 USDC
// - Total interest paid: 0.44 USDC
```

[View on BaseScan →](https://basescan.org/address/0x77f8D49C706A566Eecc9a2C3DD6556D5be54CACE)

---

## Security

- ✅ **Audited contracts** - Comprehensive testing (1,500+ loans)
- ✅ **Production proven** - Live on Base mainnet
- ✅ **No admin keys** - Decentralized protocol
- ✅ **Open source** - All code publicly verifiable

---

## Support & Resources

- **Documentation:** [docs.specular.network](#)
- **API Docs:** [api.specular.network/docs](#)
- **GitHub:** [github.com/specular-protocol](#)
- **Discord:** [discord.gg/specular](#)
- **Twitter:** [@SpecularCredit](#)

---

## Test It Now

### On Base Mainnet

1. Get some ETH on Base (for gas)
2. Get some USDC on Base (for loans/collateral)
3. Use the API or contracts above
4. Build reputation, get credit!

### On Arc Testnet

1. Get test ETH from faucet
2. Use same API/contracts
3. Test risk-free

---

## How It Works

```
┌─────────────┐
│  AI Agent   │
└──────┬──────┘
       │ 1. Register
       ▼
┌─────────────────┐
│ AgentRegistry   │
└─────────────────┘
       │ 2. Request Loan
       ▼
┌──────────────────────┐
│ LiquidityMarketplace │ ──► Check Reputation
└──────────────────────┘ ──► Calculate Terms
       │                 ──► Disburse USDC
       │ 3. Repay Loan
       ▼
┌──────────────────┐
│ ReputationManager│ ──► +10 Points
└──────────────────┘ ──► Lower APR
                     ──► Higher Limit
```

---

## Why On-Chain Credit?

AI agents need:
- ✅ **Working capital** for operations
- ✅ **Trustless credit** without KYC
- ✅ **Portable reputation** across chains
- ✅ **Programmable terms** via smart contracts

Specular provides all of this with:
- **No intermediaries** - Pure smart contracts
- **Transparent pricing** - On-chain interest rates
- **Fair terms** - Reputation-based, no discrimination
- **Global access** - Available 24/7 on any chain

---

## Start Building

Add Specular to your agent in **< 10 lines of code**:

```javascript
const specular = require('@specular/sdk');

const agent = new specular.Agent(wallet, 'base');
await agent.register({ name: "MyAgent" });
const loan = await agent.requestLoan(100, 30);
await agent.repayLoan(loan.id);
// Reputation increases automatically!
```

**Ready to get started?** Check out the [full documentation](#) or try it on [Arc testnet](#) risk-free.

---

*Built for the future of autonomous agents. Live on Base mainnet.* 🚀
