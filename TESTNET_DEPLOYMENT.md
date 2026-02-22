# 🧪 Testnet Deployment Guide

**Purpose:** Test multi-chain deployment on testnets before mainnet launch
**Cost:** $0 (all testnet tokens are FREE from faucets)
**Time:** 20-30 minutes
**Chains:** Base Sepolia, Arbitrum Sepolia, Optimism Sepolia, Polygon Amoy

---

## 🎯 Why Test on Testnets?

✅ **Validate deployment scripts** - Ensure everything works before spending real money
✅ **Test cross-chain functionality** - Verify contracts work on all chains
✅ **Practice the process** - Get comfortable with deployment flow
✅ **Zero cost** - All testnet tokens are free from faucets
✅ **Build confidence** - Know everything works before mainnet

---

## 📋 Quick Start

### 1. **Get Testnet Tokens** (FREE - 5-10 minutes)

Visit these faucets to get FREE testnet tokens:

| Testnet | Faucet URL | Token Needed |
|---------|-----------|--------------|
| **Base Sepolia** | https://portal.cdp.coinbase.com/products/faucet | SepoliaETH |
| **Arbitrum Sepolia** | https://faucet.quicknode.com/arbitrum/sepolia | SepoliaETH |
| **Optimism Sepolia** | https://app.optimism.io/faucet | SepoliaETH |
| **Polygon Amoy** | https://faucet.polygon.technology | AmoyMATIC |

**Amount needed per chain:** 0.01-0.02 tokens (very small amount)

### 2. **Set Environment Variables**

```bash
export PRIVATE_KEY=0x...  # Your deployer private key
```

**Block explorer API keys are optional for testnets** (but recommended for verification)

### 3. **Check Balances**

```bash
node scripts/check-testnet-balances.js
```

**Expected output:**
```
══════════════════════════════════════════════════════════════════════
  TESTNET BALANCE CHECK
══════════════════════════════════════════════════════════════════════

Deployer Address: 0x...

✅ Base Sepolia               0.050000 ETH
✅ Arbitrum Sepolia           0.050000 ETH
✅ Optimism Sepolia           0.050000 ETH
✅ Polygon Amoy               0.050000 MATIC

──────────────────────────────────────────────────────────────────────
Testnets Ready: 4/4

✅ All testnets funded and ready!
```

### 4. **Deploy to All Testnets**

```bash
node scripts/deploy-all-testnets.js
```

**Or deploy one at a time:**

```bash
# Start with Base Sepolia
npx hardhat run scripts/deploy-chain.js --network baseSepolia

# Then others
npx hardhat run scripts/deploy-chain.js --network arbitrumSepolia
npx hardhat run scripts/deploy-chain.js --network optimismSepolia
npx hardhat run scripts/deploy-chain.js --network polygonAmoy
```

### 5. **Verify Contracts** (Optional but recommended)

```bash
# Wait 2-3 minutes after deployment, then:
npx hardhat run scripts/verify-contracts.js --network baseSepolia
npx hardhat run scripts/verify-contracts.js --network arbitrumSepolia
npx hardhat run scripts/verify-contracts.js --network optimismSepolia
npx hardhat run scripts/verify-contracts.js --network polygonAmoy
```

---

## 📊 Testnet Configurations

### Base Sepolia

- **Chain ID:** 84532
- **RPC:** https://sepolia.base.org
- **Explorer:** https://sepolia.basescan.org
- **Test USDC:** 0x036CbD53842c5426634e7929541eC2318f3dCF7e
- **Faucet:** https://portal.cdp.coinbase.com/products/faucet

### Arbitrum Sepolia

- **Chain ID:** 421614
- **RPC:** https://sepolia-rollup.arbitrum.io/rpc
- **Explorer:** https://sepolia.arbiscan.io
- **Test USDC:** 0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d
- **Faucet:** https://faucet.quicknode.com/arbitrum/sepolia

### Optimism Sepolia

- **Chain ID:** 11155420
- **RPC:** https://sepolia.optimism.io
- **Explorer:** https://sepolia-optimism.etherscan.io
- **Test USDC:** 0x5fd84259d66Cd46123540766Be93DFE6D43130D7
- **Faucet:** https://app.optimism.io/faucet

### Polygon Amoy

- **Chain ID:** 80002
- **RPC:** https://rpc-amoy.polygon.technology
- **Explorer:** https://amoy.polygonscan.com
- **Test USDC:** 0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582
- **Faucet:** https://faucet.polygon.technology

---

## 🧪 Testing Workflow

### Step-by-Step Testing Plan

1. **Deploy to All Testnets** ✅
   ```bash
   node scripts/deploy-all-testnets.js
   ```

2. **Check Deployed Addresses** ✅
   ```bash
   cat src/config/all-testnets-addresses.json
   ```

3. **Test Agent Registration** on each chain
   ```javascript
   const registry = await ethers.getContractAt('AgentRegistryV2', address);
   await registry.register('ipfs://test-metadata');
   ```

4. **Test Pool Creation**
   ```javascript
   const marketplace = await ethers.getContractAt('AgentLiquidityMarketplace', address);
   await marketplace.createAgentPool();
   ```

5. **Test Reputation**
   ```javascript
   const reputation = await ethers.getContractAt('ReputationManagerV3', address);
   const score = await reputation.getReputationScore(agentAddress);
   // Should be 100 (initial score)
   ```

6. **Get Test USDC** from faucets (if available)
   - Most testnet USDC tokens have faucets
   - Mint test USDC for testing loans

7. **Test Full Loan Cycle** (if USDC available)
   - Supply liquidity to pool
   - Request loan
   - Repay loan
   - Check reputation increase

---

## 📁 After Deployment

Addresses are saved to:

```
src/config/
├── baseSepolia-addresses.json
├── arbitrumSepolia-addresses.json
├── optimismSepolia-addresses.json
├── polygonAmoy-addresses.json
├── arc-testnet-addresses.json (existing)
└── all-testnets-addresses.json (unified)
```

**Unified file structure:**

```json
{
  "baseSepolia": {
    "agentRegistryV2": "0x...",
    "reputationManagerV3": "0x...",
    "agentLiquidityMarketplace": "0x...",
    "validationRegistry": "0x...",
    "mockUSDC": "0x...",
    "network": "Base Sepolia",
    "chainId": 84532
  },
  "arbitrumSepolia": { ... },
  "optimismSepolia": { ... },
  "polygonAmoy": { ... }
}
```

---

## ✅ Testnet Success Criteria

### Before moving to mainnet, verify:

- [ ] Deployed successfully to all 4 testnets
- [ ] All contracts verified on block explorers
- [ ] Agent registration works on all chains
- [ ] Pool creation works on all chains
- [ ] Reputation scoring works correctly
- [ ] Multi-chain SDK/API works
- [ ] No deployment errors or issues

---

## 🔧 Useful Commands

```bash
# Check testnet balances
node scripts/check-testnet-balances.js

# Dry run (no actual deployment)
node scripts/deploy-all-testnets.js --dry-run

# Deploy to specific testnets only
CHAINS=baseSepolia,arbitrumSepolia node scripts/deploy-all-testnets.js

# Compile contracts first
npx hardhat compile

# View deployed addresses
cat src/config/all-testnets-addresses.json | json_pp
```

---

## 🚨 Troubleshooting

### "Insufficient funds"

**Solution:** Get more testnet tokens from faucets (links above)

### "Network error" or "RPC timeout"

**Solutions:**
- Wait a moment and try again (public RPCs can be slow)
- Try deploying one chain at a time
- Check if testnet is experiencing issues

### "Verification failed"

**Solutions:**
- Wait 2-3 minutes after deployment before verifying
- Check constructor arguments match deployment
- Try manual verification on block explorer UI

### Deployment hangs or takes too long

**Solutions:**
- Public testnet RPCs can be slow, be patient
- Deploy one chain at a time instead of all at once
- Check testnet status on block explorer

---

## 🎯 After Successful Testnet Deployment

### What You've Validated:

✅ **Deployment scripts work** - Ready for mainnet
✅ **Contract configurations correct** - All chains deploy successfully
✅ **Multi-chain setup works** - Same contracts on all chains
✅ **Verification process works** - Can verify on all explorers
✅ **Workflow is smooth** - Know what to expect on mainnet

### Next Steps:

1. **Test thoroughly** - Register agents, create pools, etc.
2. **Document learnings** - Note any issues encountered
3. **Prepare for mainnet** - Get API keys, fund addresses
4. **Launch with confidence** - You've tested everything!

---

## 📊 Comparison: Testnets vs. Mainnets

| Aspect | Testnets | Mainnets |
|--------|----------|----------|
| **Cost** | $0 (free tokens) | $60-100 (gas fees) |
| **Tokens** | From faucets | Need to purchase/bridge |
| **Risk** | Zero | Real money at stake |
| **Speed** | May be slower | Usually faster |
| **Purpose** | Testing & validation | Production deployment |
| **Users** | Developers only | Real users |

---

## 🎓 Learning Points

### What This Tests:

1. **Script Functionality**
   - Deployment scripts work correctly
   - Error handling works
   - Address saving works

2. **Contract Compatibility**
   - Solidity 0.8.20 compiles on all chains
   - No chain-specific issues
   - Gas estimates are reasonable

3. **Chain Configuration**
   - RPC endpoints are correct
   - Explorer APIs work
   - Gas price strategies are appropriate

4. **Multi-Chain Process**
   - Sequential deployment works
   - Verification process works
   - Address management works

---

## 🚀 Ready to Test!

**Follow these steps:**

1. Get FREE testnet tokens from faucets (5-10 min)
2. Set PRIVATE_KEY environment variable
3. Check balances: `node scripts/check-testnet-balances.js`
4. Deploy: `node scripts/deploy-all-testnets.js`
5. Verify: Run verification scripts
6. Test: Register agent, create pool, check reputation

**Total time:** 20-30 minutes
**Total cost:** $0 (completely free!)

---

*Testnet Deployment Guide | Last Updated: 2026-02-19*
