# 🎉 Specular Protocol - Deployment Complete!

The Specular Protocol is now **LIVE on Sepolia testnet** and ready for AI agents to use!

## ✅ What Was Deployed

### Smart Contracts (All Verified on Sepolia)

| Contract | Address | Status |
|----------|---------|--------|
| **AgentRegistryV2** | [`0xbd8210061bF24917Ca2F8098A1F3A4f76adA31fb`](https://sepolia.etherscan.io/address/0xbd8210061bF24917Ca2F8098A1F3A4f76adA31fb) | ✅ Deployed |
| **ReputationManagerV2** | [`0xe4D78A509daa8dc8bFB453cb76d61f1Cb1c4C3fF`](https://sepolia.etherscan.io/address/0xe4D78A509daa8dc8bFB453cb76d61f1Cb1c4C3fF) | ✅ Deployed |
| **ValidationRegistry** | [`0x77f8D49C706A566Eecc9a2C3DD6556D5be54CACE`](https://sepolia.etherscan.io/address/0x77f8D49C706A566Eecc9a2C3DD6556D5be54CACE) | ✅ Deployed |
| **MockUSDC** | [`0x771c293167AeD146EC4f56479056645Be46a0275`](https://sepolia.etherscan.io/address/0x771c293167AeD146EC4f56479056645Be46a0275) | ✅ Deployed |
| **LendingPoolV2** | [`0x5592A6d7bF1816f77074b62911D50Dad92A3212b`](https://sepolia.etherscan.io/address/0x5592A6d7bF1816f77074b62911D50Dad92A3212b) | ✅ Deployed |

### Pool Status
- **Total Liquidity**: 100,000 USDC
- **Available for Loans**: 100,000 USDC
- **Network**: Sepolia Testnet (Chain ID: 11155111)

---

## 🚀 Quick Start for AI Agents

### 1. Check Your Agent Status

```bash
npx hardhat run examples/live-sepolia-agent.js --network sepolia
```

This will:
- Show your Agent NFT ID (if registered)
- Display your reputation score (0-1000)
- Show your credit limit
- List any active loans

### 2. Mint Test USDC (for collateral)

```bash
npx hardhat run scripts/mint-usdc-sepolia.js --network sepolia
```

### 3. Request a Loan

```bash
npx hardhat run examples/request-loan-sepolia.js --network sepolia
```

### 4. Repay Your Loan (build reputation!)

```bash
npx hardhat run examples/repay-loan-sepolia.js --network sepolia
```

---

## 🏆 What Makes This Special

### ERC-8004 Compliance

This is a fully compliant implementation of **[ERC-8004: Trustless Agents](https://eips.ethereum.org/EIPS/eip-8004)**, featuring:

- **✅ Identity Registry** - Portable ERC-721 NFTs for agents
- **✅ Reputation Registry** - On-chain credit scoring with ERC-8004 feedback system
- **✅ Validation Registry** - Third-party validation of agent behavior
- **✅ Cross-Protocol Discovery** - Your agent identity works across multiple protocols

### Key Features

1. **No KYC Required** - Pure on-chain identity and reputation
2. **Portable Reputation** - Take your credit score to other protocols
3. **Trust-Based Lending** - High reputation = no collateral needed
4. **Transparent** - All reputation updates verifiable on-chain
5. **Automated** - Smart contracts handle scoring automatically

---

## 📈 How It Works

### Registration
```javascript
// Register as an agent (gets you an ERC-721 NFT)
await agentRegistry.register("ipfs://your-metadata", []);

// Initialize reputation (starts at 100)
await reputationManager.initializeReputation(agentId);
```

### Building Reputation

| Reputation Score | Credit Limit | Collateral Required |
|------------------|--------------|---------------------|
| 100-199 | 1,000 USDC | 100% (fully collateralized) |
| 200-399 | 5,000 USDC | 50% |
| 400-599 | 10,000 USDC | 25% |
| 600-799 | 25,000 USDC | 0% (trust-based!) |
| 800-1000 | 50,000 USDC | 0% (trust-based!) |

### Reputation Changes

- **On-time repayment**: +10 points (+ small bonus based on loan size)
- **Late repayment**: -5 points
- **Default**: -50 points

---

## 🧪 Example: Full Agent Workflow

```javascript
const { ethers } = require('ethers');

// 1. Setup
const provider = new ethers.JsonRpcProvider('https://ethereum-sepolia-rpc.publicnode.com');
const wallet = new ethers.Wallet('YOUR_PRIVATE_KEY', provider);

// 2. Load contracts
const agentRegistry = new ethers.Contract(
    '0xbd8210061bF24917Ca2F8098A1F3A4f76adA31fb',
    AgentRegistryV2_ABI,
    wallet
);

// 3. Register
const tx = await agentRegistry.register('ipfs://metadata', []);
await tx.wait();

// 4. Initialize reputation
const agentId = await agentRegistry.addressToAgentId(wallet.address);
await reputationManager['initializeReputation(uint256)'](agentId);

// 5. Request loan
const loanTx = await lendingPool.requestLoan(
    ethers.parseUnits('1000', 6), // 1000 USDC
    30 // 30 days
);
await loanTx.wait();

// 6. Once approved by pool manager, use the USDC!

// 7. Repay on time to build reputation
await lendingPool.repayLoan(loanId);
```

---

## 📚 Documentation

- **[SEPOLIA_USAGE.md](./SEPOLIA_USAGE.md)** - Complete usage guide
- **[README.md](./README.md)** - Project overview
- **[SEPOLIA_DEPLOYMENT.md](./SEPOLIA_DEPLOYMENT.md)** - Deployment instructions

---

## 🔧 Configuration

Your `.env` file should contain:

```env
PRIVATE_KEY=your_private_key_here
SEPOLIA_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com
ETHERSCAN_API_KEY=your_api_key_here  # optional, for verification
```

---

## 🎯 Use Cases

### 1. Autonomous Trading Agent
- Borrow USDC for trading capital
- Execute profitable trades
- Repay loan from profits
- Build reputation for larger loans

### 2. DeFi Yield Farmer
- Borrow at 5-15% APR
- Deploy to yield farms earning 20%+
- Profit from spread
- Scale up with better reputation

### 3. Arbitrage Bot
- Start with small loans (1,000 USDC)
- Execute arbitrage opportunities
- Repay quickly
- Build to 50,000 USDC credit limit

### 4. Credit Builder
- Take small loans
- Repay on time
- Improve reputation score
- Unlock trust-based lending (0% collateral)

---

## 🐛 Troubleshooting

### "Reputation not initialized"
```bash
npx hardhat run examples/live-sepolia-agent.js --network sepolia
# This will initialize it for you
```

### "Insufficient USDC for collateral"
```bash
npx hardhat run scripts/mint-usdc-sepolia.js --network sepolia
```

### "Agent not registered"
Run the live-sepolia-agent.js script first to register.

### Low ETH Balance
Get Sepolia ETH from: https://cloud.google.com/application/web3/faucet/ethereum/sepolia

---

## 🌟 Next Steps

The protocol is fully functional! You can now:

1. **Build Your Own Agents** - Use the contracts to create AI agents
2. **Integrate with Other Protocols** - ERC-8004 compliance means interoperability
3. **Contribute** - Submit PRs for improvements
4. **Deploy to Mainnet** - After thorough testing and audit

---

## 📊 Contract Stats

- **First Agent Registered**: Agent #1 (0x656086A21073272533c8A3f56A94c1f3D8BCFcE2)
- **Initial Reputation**: 100 points
- **Pool Liquidity**: 100,000 USDC
- **Network**: Sepolia (testnet)
- **ERC-8004 Compliant**: ✅ Yes

---

## 🔗 Useful Links

- **Sepolia Etherscan**: https://sepolia.etherscan.io/
- **Sepolia ETH Faucet**: https://cloud.google.com/application/web3/faucet/ethereum/sepolia
- **ERC-8004 Spec**: https://eips.ethereum.org/EIPS/eip-8004
- **Hardhat Docs**: https://hardhat.org/docs

---

## ✨ Features Demonstrated

- ✅ ERC-8004 Identity Registry (ERC-721 NFTs for agents)
- ✅ ERC-8004 Reputation Registry (credit scoring + feedback system)
- ✅ ERC-8004 Validation Registry (third-party validation)
- ✅ Decentralized lending pool
- ✅ Reputation-based loan terms
- ✅ Trust-based lending (0% collateral for high reputation)
- ✅ Automatic reputation updates
- ✅ Multi-agent support
- ✅ Full test coverage (99 tests passing)

---

**Ready to build with Specular?**

Start here: `npx hardhat run examples/live-sepolia-agent.js --network sepolia`

🚀 Happy building!
