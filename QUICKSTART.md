# Specular Protocol - Quick Start Guide

Get started with Specular in under 5 minutes!

## Prerequisites

- Node.js v18+ (tested with v22)
- Arc Testnet RPC access (default: https://arc-testnet.drpc.org)
- Test wallet with ETH and USDC

## Installation

```bash
cd /Users/peterschroeder/Specular
npm install
```

## Quick Test

### 1. Run a Single Agent (Borrow → Work → Repay)

```bash
# Set your private key and run
PRIVATE_KEY=0x... \
FEE_RECIPIENT=0x... \
ARC_TESTNET_RPC_URL=https://arc-testnet.drpc.org \
AGENT_CYCLES=1 \
AGENT_LOAN_USDC=20 \
node src/agents/run-agent.js
```

**What happens:**
1. Agent registers (if not already)
2. Creates lending pool (if not exists)
3. Requests 20 USDC loan with collateral
4. Runs market intelligence + x402 credit check
5. Repays loan with interest
6. Reputation score increases by +10

### 2. Run Two Agents (Borrower + Lender)

```bash
BORROWER_KEY=0x... \
LENDER_KEY=0x... \
FEE_RECIPIENT=0x... \
ARC_TESTNET_RPC_URL=https://arc-testnet.drpc.org \
AGENT_CYCLES=3 \
AGENT_LOAN_USDC=15 \
LENDER_SUPPLY=500 \
node src/agents/run-agents.js
```

**What happens:**
1. Borrower agent runs loan cycles
2. Lender agent supplies 500 USDC to borrower's pool
3. Lender monitors earnings in real-time
4. XMTP notifications sent on borrow/repay/supply
5. Both agents operate autonomously in parallel

### 3. Track Reputation Progress

```bash
AGENT_ADDRESS=0x... \
ARC_TESTNET_RPC_URL=https://arc-testnet.drpc.org \
node src/test-suite/track-reputation.js
```

**Output:**
```
  Score:               40
  Tier:                UNRATED (0)
  Credit Limit:        1000.0 USDC
  Interest Rate:       15%
  Collateral Required: 100%

  +16 repayments → 200 (HIGH_RISK)
  +36 repayments → 400 (MEDIUM_RISK)
  +56 repayments → 600 (LOW_RISK)
  +76 repayments → 800 (EXCELLENT)
```

### 4. View Pool Analytics

```bash
ARC_TESTNET_RPC_URL=https://arc-testnet.drpc.org \
node src/test-suite/analyze-pools.js
```

**Output:**
```
  Active Pools:    30
  Total TVL:       720,500 USDC
  Total Loaned:    3,995 USDC
  Total Earned:    281.97 USDC
  Avg Utilization: 2.0%
```

### 5. Run Stress Test (10+ cycles)

```bash
PRIVATE_KEY=0x... \
FEE_RECIPIENT=0x... \
ARC_TESTNET_RPC_URL=https://arc-testnet.drpc.org \
CYCLES=10 \
LOAN_AMOUNT=20 \
node src/test-suite/stress-test.js
```

---

## API Usage

### Start the Agent API

```bash
FEE_RECIPIENT=0x... \
ARC_TESTNET_RPC_URL=https://arc-testnet.drpc.org \
node src/api/SpecularAgentAPI.js
```

Access at: `http://localhost:3001`

### Discover Protocol

```bash
curl http://localhost:3001/.well-known/specular.json | jq
```

### Get Agent Profile

```bash
curl http://localhost:3001/agents/0x656086A21073272533c8A3f56A94c1f3D8BCFcE2 | jq
```

### View All Pools

```bash
curl http://localhost:3001/pools | jq
```

### Get Loan Transaction Calldata

```bash
curl -X POST http://localhost:3001/tx/request-loan \
  -H "Content-Type: application/json" \
  -d '{"amount": 20, "durationDays": 7}' | jq
```

---

## SDK Usage

```javascript
const { SpecularSDK } = require('./src/sdk/SpecularSDK');
const { ethers } = require('ethers');

const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
const sdk = new SpecularSDK({
    apiUrl: 'http://localhost:3001',
    wallet,
});

// Discover protocol
const manifest = await sdk.discover();

// Get your profile
const profile = await sdk.getAgentProfile(wallet.address);

// Register
if (!profile.registered) {
    await sdk.register({ name: 'MyAgent' });
}

// Create pool
await sdk.createPool();

// Request loan
await sdk.requestLoan({
    amount: 100,         // 100 USDC
    durationDays: 7,
    poolId: 43,
});

// Repay loan
await sdk.repayLoan(loanId);

// Supply liquidity
await sdk.supplyLiquidity({
    agentId: 43,
    amount: 500,
});
```

---

## Contract Addresses (Arc Testnet)

```javascript
{
  "agentRegistryV2": "0x741C03c0d95d2c15E479CE1c7E69B3196d86faD7",
  "reputationManagerV3": "0x94F2fa47c4488202a46dAA9038Ed9C9c4c07467F",
  "mockUSDC": "0xf2807051e292e945751A25616705a9aadfb39895",
  "agentLiquidityMarketplace": "0xD1cf6E7864Bc4CbBE52aA94369dF08B106927559",
  "depositRouter": "0x5592AaFDdd1f73F5D7547e664f3513C409FB9796",
  "validationRegistry": "0xD97AeE70866b0feF43A4544475A5De4c061eCcea"
}
```

---

## Reputation Tiers

| Tier | Score Range | Collateral | Interest Rate | Credit Limit |
|------|-------------|------------|---------------|--------------|
| **UNRATED** | 0-199 | 100% | 15% | 1,000 USDC |
| **HIGH_RISK** | 200-399 | 100% | 15% | 1,000 USDC |
| **MEDIUM_RISK** | 400-599 | 25% | 10% | Higher |
| **LOW_RISK** | 600-799 | 0% | 7% | Higher |
| **EXCELLENT** | 800-1000 | 0% | 5% | Highest |

**Score Changes:**
- On-time repayment: +10 points
- Default: -50 points (scaled by loan size)
- Initial score: 100 points

---

## Troubleshooting

### "Not registered" error

```bash
# Register first
curl -X POST http://localhost:3001/tx/register \
  -H "Content-Type: application/json" \
  -d '{"name": "MyAgent"}'
# Then sign and send the returned transaction
```

### "Pool not active" error

```bash
# Create pool first
curl -X POST http://localhost:3001/tx/create-pool
# Then sign and send the returned transaction
```

### "Insufficient allowance" error

- SDK automatically approves USDC
- If using raw contracts, approve marketplace before transactions
- For loans: approve 150% of loan amount (covers collateral)
- For repayment: SDK automatically approves principal + interest

### XMTP "10/10 installations" error

- V3 clients limited to 10 installations per inbox
- Use different wallet or revoke old installations
- Agent falls back to NoopMessenger gracefully (no crashes)

---

## Next Steps

1. **Build Custom Agents**
   - Extend `AutonomousAgent` class
   - Implement custom trading/market strategies
   - Integrate with external APIs

2. **Add Monitoring**
   - Track pool utilization
   - Monitor reputation growth
   - Alert on high-risk situations

3. **Scale Testing**
   - Run 50+ cycle stress tests
   - Test multiple agents in parallel
   - Simulate high pool utilization

4. **Integrate Frontend**
   - See `/frontend` directory
   - Portfolio dashboard at `/portfolio`
   - Real-time pool stats

---

## Resources

- **API Docs:** `http://localhost:3001/openapi.json`
- **Contract ABIs:** `/abis` directory
- **Test Scripts:** `/src/test-suite`
- **Examples:** `/src/sdk/examples`
- **Test Report:** `TEST_REPORT.md`

---

**Questions?** Check `TEST_REPORT.md` for detailed testing results and known issues.
