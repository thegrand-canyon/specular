# Arc Testnet Deployment Guide

## 🌟 What is Arc Network?

**Arc** is Circle's open Layer 1 blockchain, purpose-built for stablecoin finance. The testnet is expected to launch the mainnet in 2026.

### Key Features:
- ✅ **USDC as Native Gas** - No ETH needed! Gas fees are paid in USDC
- ✅ **Low, Predictable Fees** - Dollar-denominated gas costs
- ✅ **Built for Stablecoins** - Optimized for USDC-based applications
- ✅ **Circle-backed** - Official blockchain from Circle (USDC issuer)

---

## 📋 Network Details

| Property | Value |
|----------|-------|
| Network Name | Arc Testnet |
| Chain ID | 5042002 |
| RPC URL | https://rpc.testnet.arc.network |
| Native Token | USDC (18 decimals) |
| Explorer | https://testnet.arcscan.app |
| Faucet | https://faucet.circle.com |

---

## 🚰 Step 1: Get Testnet USDC

Arc testnet uses **USDC as the native gas token**, so you need USDC (not ETH) to deploy and interact with contracts.

### Get USDC from Faucet:

1. **Go to Circle's Faucet:**
   ```
   https://faucet.circle.com
   ```

2. **Select Network:**
   - Choose "Arc Testnet" from the dropdown

3. **Enter Your Wallet Address:**
   ```
   0x656086A21073272533c8A3f56A94c1f3D8BCFcE2
   ```

4. **Request USDC:**
   - Click "Request Testnet USDC"
   - You'll receive testnet USDC for gas

5. **Verify Balance:**
   ```bash
   npx hardhat run scripts/check-arc-balance.js --network arcTestnet
   ```

### Expected Faucet Amount:
- Typically: 10-100 USDC per request
- Enough for: Multiple contract deployments and transactions

---

## 🛠️ Step 2: Deploy Contracts

Once you have USDC from the faucet:

```bash
npx hardhat run scripts/deploy-arc-testnet.js --network arcTestnet
```

### What Gets Deployed:

1. **AgentRegistry** - Registers all AI agents
2. **ReputationManagerV3** - Tracks credit scores
3. **MockUSDC** - ERC-20 USDC for pool liquidity (6 decimals)
4. **AgentLiquidityMarketplace** - Main lending marketplace

### Deployment Time:
- Expected: 2-3 minutes
- Transactions are fast on Arc testnet

---

## 💰 Gas Costs on Arc

### Why Arc is Different:

**Traditional Chains (Ethereum, Base, etc.):**
- Gas token: ETH
- Prices: Fluctuate with ETH price
- Cost predictability: Low

**Arc Network:**
- Gas token: USDC
- Prices: Always in dollars
- Cost predictability: High ✅

### Example Costs:

| Operation | Estimated Cost |
|-----------|---------------|
| Deploy Marketplace | ~$0.10-0.50 USDC |
| Create Agent | ~$0.02 USDC |
| Request Loan | ~$0.03 USDC |
| Repay Loan | ~$0.03 USDC |

**Total Deployment:** < $2 USDC for full platform

---

## 🔧 Configuration

Arc testnet is already configured in your `hardhat.config.js`:

```javascript
arcTestnet: {
  url: "https://rpc.testnet.arc.network",
  accounts: [PRIVATE_KEY],
  chainId: 5042002,
  gasPrice: "auto"
}
```

---

## 📱 Add Arc to MetaMask

### Automatic (Recommended):

1. Go to: https://chainlist.org/chain/1244
2. Click "Connect Wallet"
3. Click "Add to MetaMask"

### Manual:

1. Open MetaMask
2. Click network dropdown → "Add Network"
3. Enter details:
   - **Network Name:** Arc Testnet
   - **RPC URL:** https://rpc.testnet.arc.network
   - **Chain ID:** 5042002
   - **Currency Symbol:** USDC
   - **Block Explorer:** https://testnet.arcscan.app

---

## 🎯 Testing on Arc

### After Deployment:

1. **Create Test Agents:**
   ```bash
   # Modify script to use arc-testnet-addresses.json
   npx hardhat run scripts/create-few-agents.js --network arcTestnet
   ```

2. **Set Up Pools:**
   ```bash
   npx hardhat run scripts/setup-test-pools.js --network arcTestnet
   ```

3. **Test Lending:**
   - Request loans
   - Repay loans
   - Test reputation changes

### View Contracts:

```bash
# Check marketplace
https://testnet.arcscan.app/address/YOUR_MARKETPLACE_ADDRESS

# View transactions
https://testnet.arcscan.app/address/0x656086A21073272533c8A3f56A94c1f3D8BCFcE2
```

---

## 🔍 Verification on Arcscan

After deployment, verify your contracts:

```bash
npx hardhat verify --network arcTestnet YOUR_CONTRACT_ADDRESS
```

**Note:** Contract verification may not be available yet on Arc testnet. Check Arcscan documentation for updates.

---

## 💡 Special Considerations

### USDC Decimals:

**Important:** Arc has two types of USDC:

1. **Native USDC (Gas)** - 18 decimals
   - Used for: Gas fees, native transfers
   - Get from: Circle faucet

2. **ERC-20 USDC (Our MockUSDC)** - 6 decimals
   - Used for: Pool liquidity, loans
   - Deployed by: Our script

### Why This Matters:

```javascript
// Native USDC (gas) - 18 decimals
const gasCost = ethers.parseEther('0.1'); // 0.1 USDC for gas

// Pool USDC - 6 decimals
const loanAmount = ethers.parseUnits('1000', 6); // 1000 USDC loan
```

---

## 🆚 Arc vs Other Testnets

| Feature | Sepolia | Base Testnet | Arc Testnet |
|---------|---------|--------------|-------------|
| Gas Token | ETH | ETH | USDC ✅ |
| Predictable Costs | ❌ No | ❌ No | ✅ Yes |
| Dollar-Denominated | ❌ No | ❌ No | ✅ Yes |
| Faucet Availability | ⭐⭐⭐ | ⭐⭐ | ⭐⭐⭐ |
| Transaction Speed | Medium | Fast | Fast |
| Best For | General EVM | L2 testing | Stablecoin apps ✅ |

---

## 🐛 Troubleshooting

### "Insufficient funds for gas"

**Solution:** Get more USDC from faucet
```
https://faucet.circle.com
```

### "Network not responding"

**Solution:** Check RPC status
```bash
curl https://rpc.testnet.arc.network \
  -X POST \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}'
```

### "Nonce too high"

**Solution:** Reset MetaMask
1. Settings → Advanced
2. Clear activity tab data
3. Reconnect to Arc testnet

---

## 📚 Resources

### Official Links:
- **Arc Network:** https://www.arc.network/
- **Documentation:** https://docs.arc.network/
- **Faucet:** https://faucet.circle.com
- **Explorer:** https://testnet.arcscan.app
- **Blog:** https://www.arc.network/blog/

### Technical Resources:
- **ChainList:** https://chainlist.org/chain/1244
- **ThirdWeb:** https://thirdweb.com/arc-testnet
- **Alchemy RPC:** https://www.alchemy.com/rpc/arc-testnet

---

## ✅ Quick Command Reference

```bash
# Check balance (USDC, not ETH!)
npx hardhat run scripts/check-arc-balance.js --network arcTestnet

# Deploy contracts
npx hardhat run scripts/deploy-arc-testnet.js --network arcTestnet

# View dashboard
npx hardhat run scripts/show-dashboard.js --network arcTestnet

# Create agents
npx hardhat run scripts/create-few-agents.js --network arcTestnet

# Test features
npx hardhat run scripts/test-liquidity-withdrawal.js --network arcTestnet
```

---

## 🎉 Why Test on Arc?

1. **Dollar-Denominated Costs** - Know exactly how much operations cost
2. **No ETH Volatility** - Gas prices don't fluctuate with crypto markets
3. **Future-Ready** - Arc mainnet launches 2026, early adopters benefit
4. **Circle-Backed** - Built by USDC issuer, strong ecosystem
5. **Perfect for Stablecoin Apps** - Your lending protocol is ideal for Arc!

---

**Last Updated:** February 16, 2026
**Arc Testnet Chain ID:** 5042002
**Your Wallet:** 0x656086A21073272533c8A3f56A94c1f3D8BCFcE2

---

**Ready to deploy?** Get USDC from the faucet and run the deployment script! 🚀
