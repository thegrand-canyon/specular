# 🚰 Get FREE Testnet Tokens

**Your Deployer Address:** `0x656086A21073272533c8A3f56A94c1f3D8BCFcE2`

**Time Required:** 5-10 minutes
**Cost:** $0 (completely FREE!)

---

## 📋 Quick Checklist

Visit each faucet and request tokens for your deployer address:

### 1. Base Sepolia (Need: 0.01 ETH)
**Current Balance:** 0.005794 ETH ❌ (need more)

🚰 **Faucet:** https://portal.cdp.coinbase.com/products/faucet

**Steps:**
1. Visit the faucet URL
2. Connect your wallet OR paste address: `0x656086A21073272533c8A3f56A94c1f3D8BCFcE2`
3. Select "Base Sepolia" network
4. Click "Request tokens"
5. Wait ~30 seconds for tokens to arrive

**Amount:** 0.1 ETH (more than enough!)

---

### 2. Arbitrum Sepolia (Need: 0.01 ETH)
**Current Balance:** 0.000000 ETH ❌

🚰 **Faucet:** https://faucet.quicknode.com/arbitrum/sepolia

**Steps:**
1. Visit the faucet URL
2. Connect wallet with Twitter/GitHub OR enter address
3. Paste: `0x656086A21073272533c8A3f56A94c1f3D8BCFcE2`
4. Click "Continue"
5. Wait ~1 minute for tokens

**Amount:** 0.1 ETH

---

### 3. Optimism Sepolia (Need: 0.01 ETH)
**Current Balance:** 0.000000 ETH ❌

🚰 **Faucet:** https://app.optimism.io/faucet

**Steps:**
1. Visit the faucet URL
2. Connect your wallet (MetaMask, WalletConnect, etc.)
3. Ensure wallet is on Optimism Sepolia network
4. Click "Request tokens"
5. Wait ~30 seconds

**Alternative:** https://faucet.quicknode.com/optimism/sepolia
- Paste: `0x656086A21073272533c8A3f56A94c1f3D8BCFcE2`

**Amount:** 0.1-1 ETH

---

### 4. Polygon Amoy (Need: 0.02 MATIC)
**Current Balance:** 0.000000 MATIC ❌

🚰 **Faucet:** https://faucet.polygon.technology

**Steps:**
1. Visit the faucet URL
2. Select "Polygon Amoy" network
3. Paste address: `0x656086A21073272533c8A3f56A94c1f3D8BCFcE2`
4. Complete CAPTCHA
5. Click "Submit"
6. Wait ~1-2 minutes

**Amount:** 0.1 MATIC

---

## ✅ Verification

After getting tokens from all faucets, run this command to verify:

```bash
PRIVATE_KEY=0x4fd4d9c9340c0dcd1f4845483e488afde4c69685f9ff5deec756fbfc1afb02ac node scripts/check-testnet-balances.js
```

**Expected output:**
```
✅ Base Sepolia               0.100000 ETH
✅ Arbitrum Sepolia           0.100000 ETH
✅ Optimism Sepolia           0.100000 ETH
✅ Polygon Amoy               0.100000 MATIC

Testnets Ready: 4/4

✅ All testnets funded and ready!
```

---

## 🚨 Troubleshooting

### "Faucet is rate limited"
- **Solution:** Try again in 24 hours OR use alternative faucet
- **Alternative Base:** https://www.alchemy.com/faucets/base-sepolia
- **Alternative Arbitrum:** https://www.alchemy.com/faucets/arbitrum-sepolia
- **Alternative Optimism:** https://www.alchemy.com/faucets/optimism-sepolia

### "Need to verify Twitter/GitHub"
- Some faucets require social verification to prevent abuse
- Quick to setup (1-2 minutes)
- Only needed once

### "Transaction failed"
- Make sure you're on the correct network
- Try refreshing the page
- Check if you already claimed recently (24h cooldown)

---

## ⚡ Quick Links Summary

| Network | Faucet URL |
|---------|-----------|
| **Base Sepolia** | https://portal.cdp.coinbase.com/products/faucet |
| **Arbitrum Sepolia** | https://faucet.quicknode.com/arbitrum/sepolia |
| **Optimism Sepolia** | https://app.optimism.io/faucet |
| **Polygon Amoy** | https://faucet.polygon.technology |

---

## 🚀 After Getting Tokens

Once all 4 testnets are funded, you're ready to deploy!

Run:
```bash
node scripts/deploy-all-testnets.js
```

This will deploy Specular Protocol to all 4 testnets automatically.

**Total deployment time:** ~10-15 minutes
**Total cost:** $0 (using testnet tokens)

---

*Remember: Testnet tokens have NO value. They're FREE for testing!*
