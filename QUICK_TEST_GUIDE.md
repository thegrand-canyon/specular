# Quick Testing Guide - P2P Marketplace

**Goal:** Deploy and test P2P marketplace on Sepolia in ~10 minutes

---

## Step-by-Step Commands

### 1. Deploy Marketplace (1-2 minutes)

```bash
cd /Users/peterschroeder/Specular
npx hardhat run scripts/deploy-liquidity-marketplace.js --network sepolia
```

**Expected:** Contract deployed, address saved to `sepolia-addresses.json`

---

### 2. Run Automated Test Suite (5-7 minutes)

```bash
npx hardhat run scripts/run-all-p2p-tests.js --network sepolia
```

**This automatically tests:**
- ✅ Contract deployment
- ✅ Create agent pools (Alice, Bob)
- ✅ Supply 10,000 USDC to Alice's pool
- ✅ Alice requests 5,000 USDC loan
- ✅ Interest calculation verification
- ✅ Alice repays loan with interest
- ✅ Interest distributed to lender
- ✅ Lender claims earned interest

**Expected Output:**
```
📊 P2P MARKETPLACE TEST REPORT

📈 Summary:
   Total Tests:    9
   ✅ Passed:      9
   ❌ Failed:      0
   Success Rate:   100%

✅ All tests passed!
```

---

### 3. Browse Agent Pools (optional)

```bash
npx hardhat run scripts/browse-agent-pools.js --network sepolia
```

**View:** All agent pools with metrics, ratings, and performance

---

## What to Watch For

### ✅ Good Signs
- All transactions confirm in < 30 seconds
- No "execution reverted" errors
- Interest calculations match expectations
- Gas costs < 250k per operation
- Test report shows 100% pass rate

### 🔴 Red Flags
- Transactions revert consistently
- Interest calculations off by > 1%
- Gas costs > 500k
- State inconsistencies (liquidity doesn't match)
- Lender can't claim interest

---

## If Tests Fail

### Common Issues & Fixes

**"Insufficient funds"**
```bash
# Get Sepolia ETH from faucet
# https://sepoliafaucet.com/
```

**"Already initialized"**
- Pools already exist, this is OK
- Tests will skip creation and continue

**"Amount exceeds credit limit"**
- Test agent reputation too low
- Reduce loan amount or increase reputation

**"Interest calculation mismatch"**
- 🚨 THIS IS CRITICAL - Document exact values
- Check: principal, rate, duration
- Manual formula: `(principal * rate * days) / (10000 * 365)`

**Gas costs too high**
- Compare against benchmarks in test report
- If > 2x expected, investigate contract optimization

---

## After All Tests Pass

### Option A: Additional Testing (Recommended)

Test edge cases manually:

```bash
npx hardhat console --network sepolia
```

```javascript
// Test: Withdraw liquidity
const marketplace = await ethers.getContractAt('AgentLiquidityMarketplace', 'ADDRESS')
const position = await marketplace.getLenderPosition(2, 'YOUR_ADDRESS')
await marketplace.withdrawLiquidity(2, position.amount / 2n) // Withdraw 50%

// Test: Multiple lenders
const testAgents = require('./test-agents.json')
const bob = testAgents[1]
const bobWallet = new ethers.Wallet(bob.privateKey, ethers.provider)
const usdc = await ethers.getContractAt('MockUSDC', 'USDC_ADDRESS')
await usdc.approve('MARKETPLACE_ADDRESS', ethers.parseUnits('5000', 6))
await marketplace.supplyLiquidity(2, ethers.parseUnits('5000', 6)) // Bob funds Alice

// Test: Platform fee collection
const fees = await marketplace.accumulatedFees()
console.log('Platform fees:', ethers.formatUnits(fees, 6))
```

### Option B: Deploy to Base Sepolia (Next Step)

```bash
# Deploy to Base testnet
npx hardhat run scripts/deploy-multichain.js --network baseSepolia

# Run same tests
npx hardhat run scripts/run-all-p2p-tests.js --network baseSepolia
```

### Option C: Go to Base Mainnet (If Confident)

```bash
# ⚠️ REAL MONEY - Make sure tests passed perfectly

# Deploy to Base mainnet
npx hardhat run scripts/deploy-multichain.js --network base

# Verify contracts
npx hardhat verify --network base <addresses...>

# Deposit 50,000 USDC liquidity
# Transfer to multi-sig
```

---

## Success Metrics

### Testnet Success
- [ ] All automated tests pass (9/9)
- [ ] Interest calculations accurate within 0.1%
- [ ] Gas costs reasonable (< 250k average)
- [ ] No state inconsistencies
- [ ] Lenders can deposit, earn, and withdraw

### Ready for Mainnet
- [ ] Testnet tests passed on 2+ networks (Sepolia + Base Sepolia)
- [ ] Manual edge case testing complete
- [ ] Security audit findings addressed
- [ ] Multi-sig wallet created
- [ ] Liquidity secured (50k+ USDC)

---

## Test Report

After running `run-all-p2p-tests.js`, check:

**File:** `p2p-test-report.json`

```json
{
  "summary": {
    "total": 9,
    "passed": 9,
    "failed": 0,
    "successRate": "100%"
  },
  "tests": [
    {
      "name": "Contract deployed",
      "status": "pass",
      "details": { "gasUsed": 123456 }
    }
    // ... more tests
  ]
}
```

---

## Quick Reference

| Command | Purpose | Time |
|---------|---------|------|
| `deploy-liquidity-marketplace.js` | Deploy contract | 1-2 min |
| `run-all-p2p-tests.js` | Automated testing | 5-7 min |
| `browse-agent-pools.js` | View pools | 1 min |
| `test-p2p-lending.js` | Manual detailed test | 5 min |

**Total Testing Time:** ~10-15 minutes

---

## Next Steps Decision Tree

```
All tests pass?
├─ YES → Deploy to Base Sepolia
│         └─ Tests pass → Deploy to Base Mainnet
│                         └─ Success → Expand to Arbitrum, Optimism, Polygon
│
└─ NO → Document issues
        ├─ Interest calculation wrong → FIX IMMEDIATELY (critical)
        ├─ Gas too high → Optimize contract
        ├─ State inconsistency → Debug liquidity tracking
        └─ Access control bypass → Security issue, fix before mainnet
```

---

**Ready? Run the first command!**

```bash
npx hardhat run scripts/deploy-liquidity-marketplace.js --network sepolia
```

Then let me know:
1. Did deployment succeed?
2. What's the contract address?
3. Any errors or warnings?

---

**Good luck! 🚀**
