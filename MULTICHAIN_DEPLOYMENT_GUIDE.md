# Specular Protocol - Multi-Chain Deployment Guide

**Version:** 1.0.0
**Last Updated:** 2026-02-19
**Supported Chains:** Base, Arbitrum, Optimism, Polygon, Arc Testnet

---

## 🎯 Overview

This guide covers deploying Specular Protocol to multiple EVM chains. The protocol is designed to work identically across all supported chains with minimal configuration changes.

### Supported Production Chains

| Chain | Chain ID | Type | USDC | Status |
|-------|----------|------|------|--------|
| **Base** | 8453 | L2 (OP Stack) | Native | ✅ Ready |
| **Arbitrum One** | 42161 | L2 (Optimistic) | Native | ✅ Ready |
| **Optimism** | 10 | L2 (OP Stack) | Native | ✅ Ready |
| **Polygon PoS** | 137 | Sidechain | Native | ✅ Ready |
| **Arc Testnet** | 5042002 | Testnet | Mock | ✅ Active |

---

## 🚀 Quick Start

### Prerequisites

```bash
# 1. Install dependencies
npm install

# 2. Configure environment variables
cp .env.example .env

# 3. Add your private key and API keys
PRIVATE_KEY=0x...
BASESCAN_API_KEY=...
ARBISCAN_API_KEY=...
OPTIMISM_ETHERSCAN_API_KEY=...
POLYGONSCAN_API_KEY=...
```

### Deploy to All Chains

```bash
# Dry run (test without deploying)
node scripts/deploy-all-mainnets.js --dry-run

# Deploy to all production chains
node scripts/deploy-all-mainnets.js

# Deploy to specific chains only
CHAINS=base,arbitrum node scripts/deploy-all-mainnets.js
```

### Deploy to Single Chain

```bash
# Base
npx hardhat run scripts/deploy-chain.js --network base

# Arbitrum
npx hardhat run scripts/deploy-chain.js --network arbitrum

# Optimism
npx hardhat run scripts/deploy-chain.js --network optimism

# Polygon
npx hardhat run scripts/deploy-chain.js --network polygon
```

---

## 📁 Configuration Files

### Chain Configuration (`src/config/chains.json`)

Contains all chain-specific settings:

```json
{
  "base": {
    "name": "Base",
    "chainId": 8453,
    "rpc": "https://mainnet.base.org",
    "explorer": "https://basescan.org",
    "usdc": {
      "address": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      "type": "native"
    }
  }
}
```

### Hardhat Networks (`hardhat.config.js`)

Already configured with all supported networks:

- `base` - Base mainnet
- `arbitrum` - Arbitrum One
- `optimism` - Optimism mainnet
- `polygon` - Polygon PoS
- `arcTestnet` - Arc Testnet

---

## 🛠️ Deployment Process

### Step-by-Step Deployment

#### 1. Deploy Contracts

The `deploy-chain.js` script deploys in this order:

1. **MockUSDC** (testnet only) or use existing USDC (mainnet)
2. **AgentRegistryV2** - Agent registration
3. **ReputationManagerV3** - Credit scoring
4. **AgentLiquidityMarketplace** - Lending marketplace
5. **ValidationRegistry** - ERC-8004 validation (optional)
6. **Setup permissions** - Authorize marketplace

```bash
npx hardhat run scripts/deploy-chain.js --network base
```

#### 2. Verify Contracts

```bash
# Verify all contracts
npx hardhat run scripts/verify-contracts.js --network base

# Verify specific contract
VERIFY_CONTRACT=AgentRegistryV2 npx hardhat run scripts/verify-contracts.js --network base
```

#### 3. Save Deployment Info

Addresses are automatically saved to:
```
src/config/{chain}-addresses.json
```

Example:
```json
{
  "agentRegistryV2": "0x...",
  "reputationManagerV3": "0x...",
  "agentLiquidityMarketplace": "0x...",
  "validationRegistry": "0x...",
  "usdc": "0x...",
  "network": "Base",
  "chainId": 8453,
  "deployer": "0x...",
  "deployedAt": "2026-02-19T...",
  "blockNumber": 12345678
}
```

---

## 🔍 Contract Addresses by Chain

After deployment, addresses are stored in:

```
src/config/
├── base-addresses.json
├── arbitrum-addresses.json
├── optimism-addresses.json
├── polygon-addresses.json
├── arc-testnet-addresses.json
└── all-chains-addresses.json  (unified file)
```

The unified file structure:

```json
{
  "base": {
    "agentRegistryV2": "0x...",
    "reputationManagerV3": "0x...",
    ...
  },
  "arbitrum": {
    "agentRegistryV2": "0x...",
    ...
  }
}
```

---

## 💰 Deployment Costs

### Estimated Gas Costs (per chain)

| Chain | Deployment Cost | Verification |
|-------|----------------|--------------|
| Base | ~$20-30 | Free |
| Arbitrum | ~$15-25 | Free |
| Optimism | ~$20-30 | Free |
| Polygon | ~$5-10 | Free |

**Total for all 4 chains:** ~$60-100

### Gas Price Strategies

Configured in `hardhat.config.js`:

```javascript
// EIP-1559 chains (Base, Optimism, Polygon)
{
  maxPriorityFeePerGas: ethers.parseUnits("0.001", "gwei"),
  maxFeePerGas: ethers.parseUnits("0.1", "gwei")
}

// Legacy chains (Arbitrum)
{
  gasPrice: ethers.parseUnits("0.1", "gwei")
}
```

---

## 🧪 Testing Deployments

### 1. Dry Run First

Always test with dry run:

```bash
node scripts/deploy-all-mainnets.js --dry-run
```

### 2. Deploy to Testnet

Test on Arc Testnet first:

```bash
npx hardhat run scripts/deploy-chain.js --network arcTestnet
```

### 3. Smoke Tests

After deployment, run basic tests:

```javascript
// Test agent registration
const registry = await ethers.getContractAt('AgentRegistryV2', address);
const tx = await registry.register('ipfs://metadata');
await tx.wait();

// Test marketplace
const marketplace = await ethers.getContractAt('AgentLiquidityMarketplace', address);
const poolTx = await marketplace.createAgentPool();
await poolTx.wait();
```

---

## 🔐 Security Considerations

### Private Key Management

**Never commit private keys!**

```bash
# Use environment variables
export PRIVATE_KEY=0x...

# Or use hardware wallet (Ledger/Trezor)
# Configure in hardhat.config.js
```

### Multi-Sig Deployment (Recommended)

For production, use multi-sig for deployment:

1. Deploy with deployer account
2. Transfer ownership to multi-sig (Gnosis Safe)
3. Require 2/3 or 3/5 signatures for upgrades

```javascript
// After deployment
await contract.transferOwnership(MULTISIG_ADDRESS);
```

### Verification

Always verify contracts on block explorers:
- Increases transparency
- Allows users to read contract code
- Enables better security audits

---

## 📊 Deployment Checklist

### Pre-Deployment

- [ ] Private key funded with gas on target chain
- [ ] RPC endpoints configured
- [ ] Block explorer API keys set
- [ ] Contracts compiled (`npx hardhat compile`)
- [ ] Tests passing (`npx hardhat test`)
- [ ] Dry run successful

### During Deployment

- [ ] Deploy contracts
- [ ] Verify deployment addresses
- [ ] Test basic functionality
- [ ] Verify on block explorer
- [ ] Save addresses to config

### Post-Deployment

- [ ] Transfer ownership to multi-sig
- [ ] Update documentation
- [ ] Announce on social media
- [ ] Monitor for first transactions
- [ ] Setup monitoring/alerts

---

## 🚨 Troubleshooting

### Common Issues

**1. "Insufficient funds for gas"**
```bash
# Check balance
cast balance $DEPLOYER_ADDRESS --rpc-url $RPC_URL

# Fund account with native token (ETH/MATIC)
```

**2. "Nonce too low"**
```bash
# Reset nonce in hardhat
npx hardhat clean
# Or specify nonce manually in deployment script
```

**3. "Contract verification failed"**
```bash
# Ensure exact compiler version matches
# Check constructor arguments are correct
# Wait 1-2 minutes after deployment before verifying
```

**4. "RPC rate limit exceeded"**
```bash
# Use private RPC endpoints:
# - Alchemy
# - Infura
# - QuickNode
```

---

## 📜 Deployment Scripts Reference

### Main Scripts

| Script | Purpose | Usage |
|--------|---------|-------|
| `deploy-chain.js` | Deploy to single chain | `npx hardhat run scripts/deploy-chain.js --network base` |
| `deploy-all-mainnets.js` | Deploy to all chains | `node scripts/deploy-all-mainnets.js` |
| `verify-contracts.js` | Verify on explorer | `npx hardhat run scripts/verify-contracts.js --network base` |

### Helper Scripts

```bash
# Check deployment status
node scripts/check-deployments.js

# Update unified addresses file
node scripts/update-unified-addresses.js

# Export ABIs
npx hardhat export-abi
```

---

## 🌐 Chain-Specific Notes

### Base

- Fast block times (~2s)
- Low fees (~$0.01-0.05)
- Coinbase ecosystem
- Use Basescan for verification

### Arbitrum

- Largest L2 by TVL
- Slightly higher fees than Base
- Use Arbiscan for verification
- Legacy gas pricing (not EIP-1559)

### Optimism

- OP Stack reference implementation
- Similar to Base (both OP Stack)
- Use Optimistic Etherscan
- Strong DeFi ecosystem

### Polygon

- Sidechain (not L2)
- Cheapest fees (~$0.01)
- Requires MATIC for gas
- Large ecosystem

---

## 📈 Post-Deployment

### Update API Discovery

The API automatically discovers deployed contracts:

```json
GET /.well-known/specular.json
{
  "chains": {
    "base": {
      "chainId": 8453,
      "contracts": {
        "agentRegistryV2": "0x...",
        ...
      }
    }
  }
}
```

### Update Frontend

Update `frontend/leaderboard.html` with chain selector:

```html
<select id="chain-selector">
  <option value="base">Base</option>
  <option value="arbitrum">Arbitrum</option>
  <option value="optimism">Optimism</option>
  <option value="polygon">Polygon</option>
</select>
```

### Monitoring

Setup monitoring for:
- New agent registrations
- Loan requests/repayments
- Pool liquidity changes
- Contract events

---

## 🎯 Next Steps

After successful deployment:

1. **Announce Launch**
   - Twitter/X
   - Discord
   - Documentation site

2. **Seed Initial Liquidity**
   - Create agent pools
   - Supply initial USDC
   - Test full loan cycle

3. **Setup Monitoring**
   - Tenderly alerts
   - Block explorer tracking
   - API monitoring

4. **Community Engagement**
   - Example agents
   - Tutorial videos
   - Developer workshops

---

## 📞 Support

**Issues during deployment?**

1. Check [troubleshooting section](#-troubleshooting)
2. Review deployment logs
3. Check block explorer for failed transactions
4. Open GitHub issue with error details

---

## 📝 Appendix

### Environment Variables Template

```bash
# Required
PRIVATE_KEY=0x...

# RPC URLs (optional - uses public RPCs by default)
BASE_RPC_URL=https://...
ARBITRUM_RPC_URL=https://...
OPTIMISM_RPC_URL=https://...
POLYGON_RPC_URL=https://...

# Block Explorer API Keys (required for verification)
BASESCAN_API_KEY=...
ARBISCAN_API_KEY=...
OPTIMISM_ETHERSCAN_API_KEY=...
POLYGONSCAN_API_KEY=...
```

### Useful Commands

```bash
# Compile contracts
npx hardhat compile

# Run tests
npx hardhat test

# Check network connection
npx hardhat run scripts/check-network.js --network base

# Export ABIs
npx hardhat export-abi --dest abis/

# Clean artifacts
npx hardhat clean
```

---

**Built with ❤️ for multi-chain DeFi**

*Last updated: 2026-02-19 | Version: 1.0.0 | Chains: Base, Arbitrum, Optimism, Polygon*
