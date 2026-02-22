# 🚰 Alternative Testnet Faucets (No Mainnet ETH Required)

**Your Address:** `0x656086A21073272533c8A3f56A94c1f3D8BCFcE2`

These faucets don't require mainnet ETH balance!

---

## Strategy: Get Sepolia ETH First, Then Bridge

Most L2 testnets accept bridged Sepolia ETH. This is often easier than individual faucets.

### Step 1: Get Sepolia ETH

**Option A: Alchemy Faucet** (Recommended - No requirements)
- URL: https://www.alchemy.com/faucets/ethereum-sepolia
- Paste address: `0x656086A21073272533c8A3f56A94c1f3D8BCFcE2`
- Amount: 0.5 ETH
- No mainnet balance needed!

**Option B: QuickNode Faucet**
- URL: https://faucet.quicknode.com/ethereum/sepolia
- Login with GitHub/Twitter
- Amount: 0.1 ETH

**Option C: Sepolia PoW Faucet**
- URL: https://sepolia-faucet.pk910.de/
- Mine testnet ETH (takes ~5-10 min)
- No requirements at all!

---

### Step 2: Bridge Sepolia ETH to L2s

Once you have Sepolia ETH, bridge it to each L2:

#### Base Sepolia
🌉 **Bridge:** https://bridge.base.org/deposit
1. Connect wallet
2. Select "Ethereum Sepolia" → "Base Sepolia"
3. Bridge 0.02 ETH
4. Wait ~3 minutes

#### Arbitrum Sepolia
🌉 **Bridge:** https://bridge.arbitrum.io/
1. Connect wallet
2. Select "Sepolia" → "Arbitrum Sepolia"
3. Bridge 0.02 ETH
4. Wait ~10 minutes

#### Optimism Sepolia
🌉 **Bridge:** https://app.optimism.io/bridge/deposit
1. Connect wallet
2. Select "Sepolia" → "Optimism Sepolia"
3. Bridge 0.02 ETH
4. Wait ~3 minutes

---

## Alternative: Individual Faucets (No Mainnet ETH)

### Base Sepolia

**Alchemy Faucet** (Best option)
- URL: https://www.alchemy.com/faucets/base-sepolia
- No mainnet ETH required
- Amount: 0.1 ETH

**Coinbase Faucet** (If you have Coinbase account)
- URL: https://portal.cdp.coinbase.com/products/faucet
- Login with Coinbase
- Amount: 0.1 ETH

---

### Arbitrum Sepolia

**QuickNode Faucet**
- URL: https://faucet.quicknode.com/arbitrum/sepolia
- Login with Twitter/GitHub
- Amount: 0.1 ETH

**Alchemy Faucet**
- URL: https://www.alchemy.com/faucets/arbitrum-sepolia
- No requirements
- Amount: 0.1 ETH

---

### Optimism Sepolia

**Alchemy Faucet** (Recommended)
- URL: https://www.alchemy.com/faucets/optimism-sepolia
- No mainnet ETH required
- Amount: 0.1 ETH

**QuickNode Faucet**
- URL: https://faucet.quicknode.com/optimism/sepolia
- Login with social
- Amount: 0.1 ETH

---

### Polygon Amoy

**Official Faucet** (Works without mainnet ETH)
- URL: https://faucet.polygon.technology
- Just solve CAPTCHA
- Amount: 0.5 MATIC

**Alchemy Faucet**
- URL: https://www.alchemy.com/faucets/polygon-amoy
- No requirements
- Amount: 0.5 MATIC

---

## 🎯 Recommended Approach

**Easiest Path (10 minutes):**

1. **Alchemy Sepolia Faucet**
   - Get 0.5 Sepolia ETH
   - https://www.alchemy.com/faucets/ethereum-sepolia

2. **Bridge to L2s** (or use Alchemy faucets directly)
   - Base: https://www.alchemy.com/faucets/base-sepolia
   - Arbitrum: https://www.alchemy.com/faucets/arbitrum-sepolia
   - Optimism: https://www.alchemy.com/faucets/optimism-sepolia

3. **Polygon Faucet**
   - https://faucet.polygon.technology
   - Or https://www.alchemy.com/faucets/polygon-amoy

---

## ✅ Verification

After getting tokens, check balances:

```bash
PRIVATE_KEY=0x4fd4d9c9340c0dcd1f4845483e488afde4c69685f9ff5deec756fbfc1afb02ac node scripts/check-testnet-balances.js
```

Expected:
```
✅ Base Sepolia               0.100000 ETH
✅ Arbitrum Sepolia           0.100000 ETH
✅ Optimism Sepolia           0.100000 ETH
✅ Polygon Amoy               0.500000 MATIC

Testnets Ready: 4/4
```

---

## 🚀 Ready to Deploy!

Once all funded:
```bash
node scripts/deploy-all-testnets.js
```

---

*Alchemy faucets are the easiest - no mainnet ETH required!*
