# Multi-Chain Deployment Strategy

**Date:** February 15, 2026
**Status:** 📋 Planning Phase
**Target Chains:** Base, Arbitrum, Optimism, Polygon, Ethereum

---

## Executive Summary

Specular Protocol will deploy across 5 major EVM-compatible chains to maximize accessibility for AI agents and liquidity providers. This document outlines the deployment strategy, chain-specific considerations, and execution plan.

**Recommended Deployment Order:**
1. ✅ **Sepolia Testnet** (Complete)
2. 🎯 **Base** (Primary Launch - Recommended)
3. **Arbitrum** (High Volume)
4. **Optimism** (Ecosystem Growth)
5. **Polygon** (Low Cost)
6. **Ethereum Mainnet** (Final - Premium Tier)

---

## Chain Comparison

| Chain | Gas Cost | Block Time | Security | DeFi Ecosystem | Recommendation |
|-------|----------|------------|----------|----------------|----------------|
| **Base** | Very Low | 2s | High (OP Stack) | Growing | ✅ **Primary Launch** |
| **Arbitrum** | Very Low | ~0.25s | High (Rollup) | Mature | ✅ High Priority |
| **Optimism** | Low | 2s | High (OP Stack) | Mature | ✅ High Priority |
| **Polygon** | Very Low | 2s | Medium (Sidechain) | Large | ✅ Mass Market |
| **Ethereum** | High | 12s | Highest | Largest | 🔒 Premium Tier |

---

## Chain-Specific Configurations

### 1. Base (Optimism Stack)

**Why First:**
- Coinbase-backed, growing ecosystem
- Lowest friction for onboarding
- Strong developer community
- Best cost/security ratio

**Configuration:**
```javascript
base: {
  url: process.env.BASE_RPC_URL || "https://mainnet.base.org",
  chainId: 8453,
  accounts: [process.env.PRIVATE_KEY],
  gasPrice: "auto",
  verify: {
    etherscan: {
      apiKey: process.env.BASESCAN_API_KEY
    }
  }
}
```

**Recommended Initial Limits:**
- Max Auto-Approve: 10,000 USDC
- Initial Pool Liquidity: 50,000 USDC
- Max Manual Approve: 50,000 USDC

**USDC Contract:** `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` (Native USDC)

---

### 2. Arbitrum One

**Why Second:**
- Largest L2 by TVL
- Very active DeFi ecosystem
- Extremely low gas costs
- Fast finality

**Configuration:**
```javascript
arbitrum: {
  url: process.env.ARBITRUM_RPC_URL || "https://arb1.arbitrum.io/rpc",
  chainId: 42161,
  accounts: [process.env.PRIVATE_KEY],
  gasPrice: "auto",
  verify: {
    etherscan: {
      apiUrl: "https://api.arbiscan.io",
      apiKey: process.env.ARBISCAN_API_KEY
    }
  }
}
```

**Recommended Limits:**
- Max Auto-Approve: 25,000 USDC
- Initial Pool Liquidity: 100,000 USDC
- Max Manual Approve: 100,000 USDC

**USDC Contract:** `0xaf88d065e77c8cC2239327C5EDb3A432268e5831` (Native USDC)

---

### 3. Optimism

**Why Third:**
- Mature OP Stack ecosystem
- Similar to Base (code reusability)
- Strong DeFi presence
- Retroactive funding potential

**Configuration:**
```javascript
optimism: {
  url: process.env.OPTIMISM_RPC_URL || "https://mainnet.optimism.io",
  chainId: 10,
  accounts: [process.env.PRIVATE_KEY],
  gasPrice: "auto",
  verify: {
    etherscan: {
      apiUrl: "https://api-optimistic.etherscan.io",
      apiKey: process.env.OPTIMISM_ETHERSCAN_API_KEY
    }
  }
}
```

**Recommended Limits:**
- Max Auto-Approve: 25,000 USDC
- Initial Pool Liquidity: 100,000 USDC

**USDC Contract:** `0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85` (Native USDC)

---

### 4. Polygon PoS

**Why Fourth:**
- Largest user base
- Lowest gas costs
- High transaction throughput
- Mass market appeal

**Configuration:**
```javascript
polygon: {
  url: process.env.POLYGON_RPC_URL || "https://polygon-rpc.com",
  chainId: 137,
  accounts: [process.env.PRIVATE_KEY],
  gasPrice: "auto",
  verify: {
    etherscan: {
      apiUrl: "https://api.polygonscan.com",
      apiKey: process.env.POLYGONSCAN_API_KEY
    }
  }
}
```

**Recommended Limits:**
- Max Auto-Approve: 10,000 USDC
- Initial Pool Liquidity: 50,000 USDC

**USDC Contract:** `0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359` (Native USDC)

**⚠️ Note:** Polygon is a sidechain, not a rollup. Consider slightly more conservative limits initially.

---

### 5. Ethereum Mainnet

**Why Last:**
- Highest gas costs
- Premium tier for high-value agents
- Maximum security
- Launch only after proven success on L2s

**Configuration:**
```javascript
mainnet: {
  url: process.env.MAINNET_RPC_URL || "https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY",
  chainId: 1,
  accounts: [process.env.PRIVATE_KEY],
  gasPrice: "auto",
  verify: {
    etherscan: {
      apiKey: process.env.ETHERSCAN_API_KEY
    }
  }
}
```

**Recommended Limits:**
- Max Auto-Approve: 50,000 USDC
- Initial Pool Liquidity: 500,000 USDC
- Require multi-sig ownership

**USDC Contract:** `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` (Native USDC)

---

## Contract Deployment Order

For each chain, deploy in this exact order:

1. **MockUSDC** (Testnet only - use native USDC on mainnet)
2. **AgentRegistryV2**
3. **ReputationManagerV3**
4. **ValidationRegistry** (if needed)
5. **LendingPoolV3**
6. **AgentLiquidityMarketplace**

**Post-Deployment:**
1. Authorize LendingPoolV3 in ReputationManagerV3
2. Authorize AgentLiquidityMarketplace in ReputationManagerV3
3. Verify all contracts on block explorer
4. Transfer ownership to multi-sig (mainnet)
5. Deposit initial liquidity
6. Run smoke tests

---

## Multi-Chain Architecture

### Option 1: Independent Deployments (Recommended)

Each chain has completely independent contracts:
- ✅ Simpler architecture
- ✅ No cross-chain dependencies
- ✅ Each chain can have different parameters
- ✅ No bridge risk
- ❌ Reputation doesn't transfer between chains
- ❌ Agents must register on each chain separately

**Implementation:**
- Deploy full stack on each chain
- Each chain has separate ReputationManagerV3
- Agent addresses are same across chains (same wallet)
- Agent IDs may differ per chain

### Option 2: Cross-Chain Reputation (Future)

Use LayerZero or similar for reputation synchronization:
- ✅ Unified reputation across chains
- ✅ Better UX for agents
- ❌ Added complexity
- ❌ Cross-chain message costs
- ❌ New attack vectors

**Recommendation:** Start with Option 1, evaluate Option 2 after 6 months

---

## Deployment Scripts

### Universal Deployment Script

```javascript
// scripts/deploy-multichain.js
const { ethers } = require('hardhat');
const fs = require('fs');

async function deployToChain(networkName) {
    console.log(`\n🚀 Deploying to ${networkName}\n`);

    const [deployer] = await ethers.getSigners();
    const chainId = await ethers.provider.getNetwork().then(n => n.chainId);

    // Get USDC address for chain
    const usdcAddresses = {
        8453: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',  // Base
        42161: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', // Arbitrum
        10: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',    // Optimism
        137: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',   // Polygon
        1: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'      // Ethereum
    };

    const usdcAddress = usdcAddresses[chainId];

    // Deploy AgentRegistry
    const AgentRegistry = await ethers.getContractFactory('AgentRegistryV2');
    const agentRegistry = await AgentRegistry.deploy();
    await agentRegistry.waitForDeployment();

    // Deploy ReputationManager
    const ReputationManager = await ethers.getContractFactory('ReputationManagerV3');
    const reputationManager = await ReputationManager.deploy(
        await agentRegistry.getAddress()
    );
    await reputationManager.waitForDeployment();

    // Deploy LendingPool
    const LendingPool = await ethers.getContractFactory('LendingPoolV3');
    const lendingPool = await LendingPool.deploy(
        await agentRegistry.getAddress(),
        await reputationManager.getAddress(),
        usdcAddress
    );
    await lendingPool.waitForDeployment();

    // Deploy AgentLiquidityMarketplace
    const Marketplace = await ethers.getContractFactory('AgentLiquidityMarketplace');
    const marketplace = await Marketplace.deploy(
        await agentRegistry.getAddress(),
        await reputationManager.getAddress(),
        usdcAddress
    );
    await marketplace.waitForDeployment();

    // Authorize pools
    await reputationManager.authorizePool(await lendingPool.getAddress());
    await reputationManager.authorizePool(await marketplace.getAddress());

    // Save addresses
    const addresses = {
        chainId: Number(chainId),
        network: networkName,
        agentRegistry: await agentRegistry.getAddress(),
        reputationManagerV3: await reputationManager.getAddress(),
        lendingPool: await lendingPool.getAddress(),
        agentLiquidityMarketplace: await marketplace.getAddress(),
        usdcToken: usdcAddress
    };

    fs.writeFileSync(
        `src/config/${networkName}-addresses.json`,
        JSON.stringify(addresses, null, 2)
    );

    console.log(`✅ Deployment to ${networkName} complete!`);
    return addresses;
}

module.exports = { deployToChain };
```

---

## Gas Optimization for Multi-Chain

### Critical Optimizations

1. **Remove unused `agentIdByAddress` mapping** (saves ~20k gas per init)
2. **Cache storage reads** in loops
3. **Use `calldata` instead of `memory` for external function params**
4. **Pack struct variables** to minimize storage slots
5. **Batch operations** where possible

### Chain-Specific Considerations

**Ethereum Mainnet:**
- Optimize every SSTORE operation
- Consider EIP-1559 for fee management
- Use flashbots for deployment to avoid MEV

**L2s (Base, Arbitrum, Optimism):**
- L1 data costs matter more than execution
- Minimize calldata size
- Batch operations to amortize L1 costs

**Polygon:**
- Execution gas matters
- Can be less aggressive on calldata optimization
- Watch for state bloat

---

## Security Considerations

### Pre-Deployment Checklist

- [ ] Professional security audit completed
- [ ] All Medium+ findings addressed
- [ ] Emergency pause functionality tested
- [ ] Owner controls tested
- [ ] Access control verified
- [ ] Integration tests passing on all chains

### Multi-Sig Requirements

**Mainnet (Required):**
- Gnosis Safe with 3-of-5 signatures
- Signers: 3 team members + 2 advisors
- Functions requiring multi-sig:
  - `pause()` / `unpause()`
  - `authorizePool()`
  - `revokePool()`
  - Configuration changes
  - Fund withdrawals

**L2s (Recommended):**
- 2-of-3 multi-sig
- Can use EOA initially with timelock
- Upgrade to multi-sig within 30 days

---

## Liquidity Strategy

### Initial Liquidity Per Chain

| Chain | Initial Liquidity | Source | Rationale |
|-------|------------------|---------|-----------|
| Base | 50,000 USDC | Protocol treasury | Primary launch |
| Arbitrum | 100,000 USDC | Protocol + partners | Largest market |
| Optimism | 100,000 USDC | Protocol + partners | Mature DeFi |
| Polygon | 50,000 USDC | Protocol treasury | Mass market |
| Ethereum | 500,000 USDC | Institutional partners | Premium tier |

**Total Required:** 800,000 USDC

### Liquidity Bootstrapping

**Phase 1: Protocol-Owned Liquidity (Days 1-30)**
- Deploy with protocol treasury funds
- Conservative limits
- Manual approval only
- Build reputation with small loans

**Phase 2: Community Liquidity (Days 31-90)**
- Enable auto-approve
- Increase limits gradually
- Activate AgentLiquidityMarketplace
- Incentivize early lenders

**Phase 3: Scale (Days 91+)**
- Remove most limits
- Full auto-approve
- Cross-chain expansion
- Institutional partnerships

---

## Deployment Timeline

### Week 1: Preparation
- [ ] Complete security audit
- [ ] Fix all findings
- [ ] Set up multi-sig wallets
- [ ] Prepare deployment scripts
- [ ] Test on all testnets

### Week 2: Base Launch
- [ ] Deploy to Base mainnet
- [ ] Verify contracts
- [ ] Initialize with 50k USDC
- [ ] Test with 5 pilot agents
- [ ] Monitor for 48 hours

### Week 3: L2 Expansion
- [ ] Deploy to Arbitrum
- [ ] Deploy to Optimism
- [ ] Deploy to Polygon
- [ ] Verify all contracts
- [ ] Cross-chain testing

### Week 4: Marketing & Onboarding
- [ ] Announce multi-chain support
- [ ] Onboard 50+ agents
- [ ] Process 100+ loans across chains
- [ ] Gather feedback

### Month 2: Ethereum Mainnet
- [ ] Complete additional audit
- [ ] Set up 3-of-5 multi-sig
- [ ] Deploy to Ethereum
- [ ] Premium tier marketing

---

## Monitoring & Maintenance

### Per-Chain Monitoring

**Automated Alerts:**
- Pool utilization > 90%
- Liquidation opportunities
- Failed transactions
- Gas price spikes
- Contract interactions from unknown addresses

**Dashboard Metrics:**
- Total Value Locked per chain
- Loan count per chain
- Default rate per chain
- Average interest earned
- Agent count per chain

### Cross-Chain Analytics

- Total protocol TVL
- Chain with highest volume
- Chain with best performance
- Chain migration patterns

---

## Emergency Procedures

### Chain-Specific Emergency Pause

Each chain operates independently:
- Can pause one chain without affecting others
- Multi-sig can trigger emergency pause
- 24-hour review period before unpause

### Migration Plan

If critical bug discovered:
1. Pause all affected chains immediately
2. Deploy fixed contracts
3. Migrate liquidity to new contracts
4. Migrate agent data
5. Resume operations

---

## Cost Estimates

### Deployment Costs (Gas)

| Chain | Estimated Deployment Cost | Notes |
|-------|--------------------------|-------|
| Base | ~$50-100 | Very low gas |
| Arbitrum | ~$50-100 | Very low gas |
| Optimism | ~$50-100 | Very low gas |
| Polygon | ~$10-20 | Lowest gas |
| Ethereum | ~$5,000-10,000 | High gas, optimize timing |

**Total Deployment:** ~$5,200-10,400

### Operational Costs (Monthly)

- Transaction monitoring: ~$50/month
- RPC nodes: ~$200/month (can use public initially)
- Verification APIs: Free (within limits)
- Multi-sig operations: ~$100-500/month

---

## Post-Deployment Checklist

For each chain:

- [ ] All contracts deployed
- [ ] All contracts verified on block explorer
- [ ] Reputation manager authorized both pools
- [ ] Initial liquidity deposited
- [ ] Owner transferred to multi-sig (mainnet)
- [ ] Emergency pause tested
- [ ] Smoke tests passed
- [ ] Monitoring alerts configured
- [ ] Documentation updated with addresses
- [ ] Announcement published

---

## Next Steps

1. **This Week:**
   - Complete P2P marketplace testing on Sepolia
   - Set up RPC endpoints for all target chains
   - Create testnet deployments for Base, Arbitrum, Optimism

2. **Next Week:**
   - Security audit review
   - Multi-sig wallet setup
   - Prepare mainnet deployment scripts

3. **Week 3:**
   - Deploy to Base mainnet
   - Monitor and iterate

---

**Strategy Prepared By:** Claude Opus 4.5
**Date:** February 15, 2026
**Status:** Ready for Execution

🎯 **Recommended Next Action:** Deploy and test P2P marketplace on Sepolia, then proceed with Base testnet deployment.
