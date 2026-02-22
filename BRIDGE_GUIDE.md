# 🌉 How to Bridge Testnet ETH - Step by Step

**Your Address:** `0x656086A21073272533c8A3f56A94c1f3D8BCFcE2`

---

## Step 1: Get Sepolia ETH (Start Here!)

### Option A: PoW Faucet (No Requirements - Recommended)

🔗 **URL:** https://sepolia-faucet.pk910.de/

**Instructions:**
1. Visit the URL
2. Paste address: `0x656086A21073272533c8A3f56A94c1f3D8BCFcE2`
3. Click "Start Mining"
4. **Leave the tab open** for 5-10 minutes (it mines in browser)
5. You'll see the balance increasing
6. When you have ~0.1 ETH, click "Stop Mining"
7. Click "Claim Rewards"
8. Wait ~1 minute for the transaction to confirm

**Result:** You'll have 0.1 Sepolia ETH in your wallet

---

### Option B: QuickNode (Requires GitHub/Twitter Login)

🔗 **URL:** https://faucet.quicknode.com/ethereum/sepolia

1. Click "Continue with GitHub" or "Continue with Twitter"
2. Authorize the app
3. Paste address: `0x656086A21073272533c8A3f56A94c1f3D8BCFcE2`
4. Click "Continue"
5. Wait ~30 seconds

**Result:** You'll have 0.1 Sepolia ETH

---

## Step 2: Bridge Sepolia ETH to L2 Testnets

Once you have Sepolia ETH, you'll bridge it to each L2 testnet.

### 🔷 Bridge to Base Sepolia

🌉 **Bridge URL:** https://bridge.base.org/deposit

**Instructions:**
1. Visit https://bridge.base.org/deposit
2. Click "Connect Wallet"
3. Connect MetaMask (or your wallet)
4. **Make sure wallet is on "Sepolia" network** (not mainnet!)
5. You should see:
   - From: Sepolia
   - To: Base Sepolia
6. Enter amount: `0.02` (ETH)
7. Click "Deposit ETH"
8. Confirm transaction in MetaMask
9. Wait ~2-3 minutes for bridge to complete

**Check Balance:**
- Switch wallet to "Base Sepolia" network
- You should see 0.02 ETH

---

### 🔵 Bridge to Arbitrum Sepolia

🌉 **Bridge URL:** https://bridge.arbitrum.io/

**Instructions:**
1. Visit https://bridge.arbitrum.io/
2. Click "Connect Wallet"
3. Connect your wallet
4. At the top, select networks:
   - From: **Sepolia** (not Ethereum mainnet!)
   - To: **Arbitrum Sepolia**
5. Enter amount: `0.02` ETH
6. Click "Move funds to Arbitrum Sepolia"
7. Confirm transaction
8. Wait ~5-10 minutes (Arbitrum is slower than Base/OP)

**Check Balance:**
- Switch wallet to "Arbitrum Sepolia"
- You should see 0.02 ETH

---

### 🔴 Bridge to Optimism Sepolia

🌉 **Bridge URL:** https://app.optimism.io/bridge/deposit

**Instructions:**
1. Visit https://app.optimism.io/bridge/deposit
2. Click "Connect Wallet"
3. Connect your wallet
4. Make sure you see:
   - From: Sepolia
   - To: Optimism Sepolia
5. Enter amount: `0.02` ETH
6. Click "Deposit"
7. Confirm transaction
8. Wait ~2-3 minutes

**Check Balance:**
- Switch wallet to "Optimism Sepolia"
- You should see 0.02 ETH

---

### 🟣 Get Polygon Amoy (Different - No Bridge Needed)

Polygon Amoy uses MATIC, not ETH. Get it directly from faucet:

🚰 **Faucet URL:** https://faucet.polygon.technology

**Instructions:**
1. Visit https://faucet.polygon.technology
2. Select network: **Polygon Amoy**
3. Paste address: `0x656086A21073272533c8A3f56A94c1f3D8BCFcE2`
4. Select token: **MATIC**
5. Complete CAPTCHA
6. Click "Submit"
7. Wait ~1-2 minutes

**Result:** You'll have 0.5 MATIC on Polygon Amoy

---

## 🔍 How to Switch Networks in MetaMask

If you need to add these networks to MetaMask:

### Add Base Sepolia
1. Open MetaMask
2. Click network dropdown (top)
3. Click "Add Network"
4. Click "Add network manually"
5. Enter:
   - Network Name: `Base Sepolia`
   - RPC URL: `https://sepolia.base.org`
   - Chain ID: `84532`
   - Currency Symbol: `ETH`
   - Block Explorer: `https://sepolia.basescan.org`
6. Click "Save"

### Add Arbitrum Sepolia
- Network Name: `Arbitrum Sepolia`
- RPC URL: `https://sepolia-rollup.arbitrum.io/rpc`
- Chain ID: `421614`
- Currency Symbol: `ETH`
- Block Explorer: `https://sepolia.arbiscan.io`

### Add Optimism Sepolia
- Network Name: `Optimism Sepolia`
- RPC URL: `https://sepolia.optimism.io`
- Chain ID: `11155420`
- Currency Symbol: `ETH`
- Block Explorer: `https://sepolia-optimism.etherscan.io`

### Add Polygon Amoy
- Network Name: `Polygon Amoy`
- RPC URL: `https://rpc-amoy.polygon.technology`
- Chain ID: `80002`
- Currency Symbol: `MATIC`
- Block Explorer: `https://amoy.polygonscan.com`

---

## ✅ Verify You Have Everything

After bridging, check balances:

```bash
PRIVATE_KEY=0x4fd4d9c9340c0dcd1f4845483e488afde4c69685f9ff5deec756fbfc1afb02ac node scripts/check-testnet-balances.js
```

**You should see:**
```
✅ Base Sepolia               0.020000 ETH
✅ Arbitrum Sepolia           0.020000 ETH
✅ Optimism Sepolia           0.020000 ETH
✅ Polygon Amoy               0.500000 MATIC

Testnets Ready: 4/4

✅ All testnets funded and ready!
```

---

## 🚀 Ready to Deploy!

Once all 4 testnets show ✅, run:

```bash
node scripts/deploy-all-testnets.js
```

---

## 📝 Summary (TL;DR)

1. **Get Sepolia ETH** → https://sepolia-faucet.pk910.de/ (mine for 10 min)
2. **Bridge to Base** → https://bridge.base.org/deposit (0.02 ETH)
3. **Bridge to Arbitrum** → https://bridge.arbitrum.io/ (0.02 ETH)
4. **Bridge to Optimism** → https://app.optimism.io/bridge/deposit (0.02 ETH)
5. **Get Polygon MATIC** → https://faucet.polygon.technology (direct faucet)
6. **Verify** → `node scripts/check-testnet-balances.js`
7. **Deploy** → `node scripts/deploy-all-testnets.js`

---

## 🆘 Troubleshooting

**"Wrong network" error when bridging:**
- Make sure your wallet is on **Sepolia** (not Ethereum mainnet)
- Check the "From" network shows "Sepolia"

**"Insufficient funds" when bridging:**
- You need Sepolia ETH first (Step 1)
- Make sure you have at least 0.1 Sepolia ETH

**Bridge taking too long:**
- Base/Optimism: 2-3 minutes is normal
- Arbitrum: 5-10 minutes is normal
- Wait patiently, it will arrive!

**Can't find network in MetaMask:**
- Use "Add network manually" section above
- Or visit Chainlist: https://chainlist.org/ (search for "Sepolia")

---

*Total time: ~20-30 minutes including mining*
*Total cost: $0 (all free!)*
