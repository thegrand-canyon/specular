# 🚀 Ready to Deploy - Final Checklist

**Status:** Ready to deploy to production
**Target Chains:** Base, Arbitrum, Optimism, Polygon
**Estimated Time:** 30-45 minutes
**Estimated Cost:** $60-100 in gas

---

## ✅ Pre-Deployment Checklist

### 1. **Fund Deployer Address**

You need gas on all 4 chains (ETH on L2s, MATIC on Polygon):

| Chain | Minimum | Recommended | Bridge URL |
|-------|---------|-------------|------------|
| **Base** | 0.01 ETH | 0.02 ETH | https://bridge.base.org |
| **Arbitrum** | 0.01 ETH | 0.02 ETH | https://bridge.arbitrum.io |
| **Optimism** | 0.01 ETH | 0.02 ETH | https://app.optimism.io/bridge |
| **Polygon** | 0.02 MATIC | 0.05 MATIC | https://wallet.polygon.technology/bridge |

**Total:** ~0.04 ETH + 0.02 MATIC (~$100-150 at current prices)

**Check your balances:**
```bash
export PRIVATE_KEY=0x...
node scripts/check-balances.js
```

### 2. **Get Block Explorer API Keys** (All Free)

Sign up and get API keys from:

- **Basescan:** https://basescan.org/myapikey
- **Arbiscan:** https://arbiscan.io/myapikey
- **Optimism Etherscan:** https://optimistic.etherscan.io/myapikey
- **Polygonscan:** https://polygonscan.com/myapikey

### 3. **Set Environment Variables**

Create/update your `.env` file:

```bash
# Deployer private key
PRIVATE_KEY=0x...

# Block explorer API keys
BASESCAN_API_KEY=...
ARBISCAN_API_KEY=...
OPTIMISM_ETHERSCAN_API_KEY=...
POLYGONSCAN_API_KEY=...

# Optional: Custom RPC endpoints (use public RPCs if not set)
# BASE_RPC_URL=https://...
# ARBITRUM_RPC_URL=https://...
# OPTIMISM_RPC_URL=https://...
# POLYGON_RPC_URL=https://...
```

### 4. **Verify Setup**

```bash
# Check balances
node scripts/check-balances.js

# Dry run
node scripts/deploy-all-mainnets.js --dry-run

# Compile contracts
npx hardhat compile
```

---

## 🎯 Deployment Steps

### Step 1: Deploy Contracts

**Option A: Deploy to all chains (recommended)**
```bash
node scripts/deploy-all-mainnets.js
```

**Option B: Deploy one at a time (safer)**
```bash
# Start with cheapest chain (Polygon)
npx hardhat run scripts/deploy-chain.js --network polygon

# Then others
npx hardhat run scripts/deploy-chain.js --network base
npx hardhat run scripts/deploy-chain.js --network arbitrum
npx hardhat run scripts/deploy-chain.js --network optimism
```

**Expected Output:**
```
╔══════════════════════════════════════════════════╗
║   Specular Protocol - Mainnet Deployments       ║
╚══════════════════════════════════════════════════╝

📋 Deploying to ALL production chains:
  1. Base (chainId: 8453)
  2. Arbitrum One (chainId: 42161)
  3. Optimism (chainId: 10)
  4. Polygon PoS (chainId: 137)

⚠️  WARNING: Deploying to production chains!
Press Ctrl+C to cancel, or wait 5 seconds...

[Deployment progress for each chain...]

═════════════════════════════════════════
  DEPLOYMENT SUMMARY
═════════════════════════════════════════
Total Chains: 4
Successful:   4 ✅
Failed:       0 ❌

✅ ALL DEPLOYMENTS SUCCESSFUL!
```

### Step 2: Verify Contracts (Wait 2-3 minutes after deployment)

```bash
# Verify on each chain
npx hardhat run scripts/verify-contracts.js --network base
npx hardhat run scripts/verify-contracts.js --network arbitrum
npx hardhat run scripts/verify-contracts.js --network optimism
npx hardhat run scripts/verify-contracts.js --network polygon
```

**Note:** Verification may fail initially. Wait 2-3 minutes and retry if needed.

### Step 3: Check Deployed Addresses

Addresses are saved to:
```
src/config/
├── base-addresses.json
├── arbitrum-addresses.json
├── optimism-addresses.json
├── polygon-addresses.json
└── all-chains-addresses.json  (unified)
```

View unified addresses:
```bash
cat src/config/all-chains-addresses.json | json_pp
```

---

## 🧪 Post-Deployment Testing

### Test on Each Chain

```bash
# Example: Test on Polygon
CHAIN=polygon node scripts/test-deployment.js

# Or test all
node scripts/test-all-deployments.js
```

### Manual Smoke Test

1. **Register test agent:**
   ```javascript
   const registry = await ethers.getContractAt('AgentRegistryV2', address);
   await registry.register('ipfs://test');
   ```

2. **Create pool:**
   ```javascript
   const marketplace = await ethers.getContractAt('AgentLiquidityMarketplace', address);
   await marketplace.createAgentPool();
   ```

3. **Check reputation:**
   ```javascript
   const reputation = await ethers.getContractAt('ReputationManagerV3', address);
   const score = await reputation.getReputationScore(agentAddress);
   console.log(`Score: ${score}`); // Should be 100 (initial)
   ```

---

## 🔒 Security - Transfer to Multi-Sig

**CRITICAL:** Transfer ownership to multi-sig immediately after deployment!

### Setup Gnosis Safe on Each Chain

1. Create multi-sig at: https://safe.global

| Chain | Safe URL |
|-------|----------|
| Base | https://app.safe.global/home?safe=base:... |
| Arbitrum | https://app.safe.global/home?safe=arb1:... |
| Optimism | https://app.safe.global/home?safe=oeth:... |
| Polygon | https://app.safe.global/home?safe=matic:... |

2. **Recommended:** 2/3 or 3/5 multi-sig

### Transfer Ownership Script

```javascript
// scripts/transfer-to-multisig.js
const MULTISIG_ADDRESSES = {
  base: "0x...",      // Your Gnosis Safe address on Base
  arbitrum: "0x...",  // Your Gnosis Safe address on Arbitrum
  optimism: "0x...",  // Your Gnosis Safe address on Optimism
  polygon: "0x..."    // Your Gnosis Safe address on Polygon
};

// Transfer ownership of all contracts
await registry.transferOwnership(MULTISIG_ADDRESSES[chain]);
await reputation.transferOwnership(MULTISIG_ADDRESSES[chain]);
await marketplace.transferOwnership(MULTISIG_ADDRESSES[chain]);
```

---

## 📊 Deployment Summary Template

After deployment, document everything:

```markdown
## Specular Protocol - Production Deployment

**Date:** 2026-02-19
**Deployer:** 0x...
**Chains:** Base, Arbitrum, Optimism, Polygon

### Contract Addresses

#### Base (Chain ID: 8453)
- AgentRegistryV2: 0x...
- ReputationManagerV3: 0x...
- AgentLiquidityMarketplace: 0x...
- ValidationRegistry: 0x...

#### Arbitrum (Chain ID: 42161)
- AgentRegistryV2: 0x...
- ReputationManagerV3: 0x...
- AgentLiquidityMarketplace: 0x...
- ValidationRegistry: 0x...

[etc for Optimism and Polygon]

### Verification Status
- [x] Base - All contracts verified
- [x] Arbitrum - All contracts verified
- [x] Optimism - All contracts verified
- [x] Polygon - All contracts verified

### Multi-Sig Setup
- [x] Created Gnosis Safes on all chains
- [x] Transferred ownership
- [x] Tested multi-sig transactions

### Testing
- [x] Smoke tests passed on all chains
- [x] Agent registration works
- [x] Pool creation works
- [x] Reputation tracking works

### Next Steps
- [ ] Seed initial liquidity
- [ ] Setup monitoring
- [ ] Announce launch
- [ ] Create example agents
```

---

## 🚨 Emergency Procedures

### If Deployment Fails

1. **Check error message** - often gas-related or RPC issue
2. **Verify balances** - ensure enough gas
3. **Try again** - transient RPC errors are common
4. **Deploy individually** - if multi-chain fails, deploy one by one

### If Verification Fails

1. **Wait 2-3 minutes** - block explorer needs time to index
2. **Check constructor args** - must match exactly
3. **Verify compiler version** - must match deployment (0.8.20)
4. **Manual verification** - use block explorer UI if script fails

### Pause Contracts

```javascript
// In emergency, pause the marketplace
await marketplace.pause();

// Unpause when ready
await marketplace.unpause();
```

---

## 📞 Support

**Issues?**

1. Check logs for specific error
2. Review [troubleshooting guide](MULTICHAIN_DEPLOYMENT_GUIDE.md#-troubleshooting)
3. Check block explorer for transaction status
4. Ensure all prerequisites met

---

## ✅ Final Confirmation

Before deploying, confirm:

- [ ] Deployer funded on all 4 chains (check with `node scripts/check-balances.js`)
- [ ] Block explorer API keys obtained and set in `.env`
- [ ] Contracts compiled (`npx hardhat compile`)
- [ ] Dry run successful (`node scripts/deploy-all-mainnets.js --dry-run`)
- [ ] Gnosis Safe addresses ready for ownership transfer
- [ ] Team ready to monitor deployment
- [ ] Announcement prepared for post-launch

---

## 🚀 Ready to Deploy!

Once all checkboxes above are ✅, run:

```bash
node scripts/deploy-all-mainnets.js
```

**Good luck! 🎉**

---

*Deployment Guide | Last Updated: 2026-02-19*
