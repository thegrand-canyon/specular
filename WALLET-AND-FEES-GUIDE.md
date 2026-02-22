# Wallet & Platform Fees Guide

## 💼 Your Wallet Information

**Wallet Address:**
```
0x656086A21073272533c8A3f56A94c1f3D8BCFcE2
```

**Private Key Location:**
- Stored in: `/Users/peterschroeder/Specular/.env`
- Variable: `PRIVATE_KEY=0x...`

**What This Wallet Controls:**
- ✅ Platform fee recipient (collects 1% of interest)
- ✅ Contract owner (can pause/unpause)
- ✅ Deployer of all contracts

---

## 🔐 How to Access Your Wallet

### Option 1: MetaMask (Recommended)

1. **Install MetaMask** (if you haven't):
   - Chrome: https://metamask.io/download/
   - Firefox/Brave: Same link

2. **Import Your Account**:
   - Open MetaMask
   - Click account icon (top right)
   - Select "Import Account"
   - Choose "Private Key"
   - Paste your private key (from `.env` file)
   - Click "Import"

3. **Add Sepolia Network** (if not already added):
   - Click network dropdown
   - Click "Add Network"
   - Select "Sepolia" from list

4. **Add USDC Token**:
   - In MetaMask, click "Import tokens"
   - Paste token address: `0x771c293167AeD146EC4f56479056645Be46a0275`
   - Symbol: USDC
   - Decimals: 6
   - Click "Add"

### Option 2: View on Block Explorer

**Sepolia Testnet:**
```
https://sepolia.etherscan.io/address/0x656086A21073272533c8A3f56A94c1f3D8BCFcE2
```

**Base Mainnet** (after deployment):
```
https://basescan.org/address/0x656086A21073272533c8A3f56A94c1f3D8BCFcE2
```

---

## 💰 How to Withdraw Platform Fees

### Method 1: Automated Script (Easiest)

```bash
# Check fees and automatically withdraw all
npx hardhat run scripts/check-and-withdraw-fees.js --network sepolia
```

**What this script does:**
- Shows accumulated fees in contract
- Shows your current USDC balance
- Withdraws all fees to your wallet
- Updates both balances

### Method 2: Manual Withdrawal

If you want to withdraw a specific amount:

```javascript
// In scripts/ create custom script:
const marketplace = await ethers.getContractAt('AgentLiquidityMarketplace', address);
const amount = ethers.parseUnits('10', 6); // Withdraw 10 USDC
await marketplace.withdrawFees(amount);
```

### Method 3: Direct Contract Call

Using Etherscan contract interface:
1. Go to: https://sepolia.etherscan.io/address/0xf47620e1b2B33E264013Fad5D77AE9DC2b16B5C8#writeContract
2. Click "Connect to Web3"
3. Find `withdrawFees` function
4. Enter amount (in 6 decimals, e.g., 1000000 = 1 USDC)
5. Click "Write"

---

## 📊 Platform Fee Economics

### How Fees Are Collected

**Fee Structure:**
- Platform takes: **1% of interest**
- Lenders receive: **99% of interest**

**Example from Alice's Loan:**
```
Loan: 500 USDC for 30 days at 15% APR
Total Interest: 6.164383 USDC
├─ Platform Fee (1%): 0.061643 USDC → Your Wallet ✅
└─ Lender Share (99%): 6.102740 USDC → Alice's Pool
```

### Fee Accumulation

Fees accumulate in the contract as loans are repaid:
- ✅ Fees are stored in `accumulatedFees` variable
- ✅ Only owner can withdraw
- ✅ Can withdraw partial or full amount
- ✅ Safe withdrawal (uses ReentrancyGuard)

### Checking Accumulated Fees

**Via Script:**
```bash
npx hardhat run scripts/check-and-withdraw-fees.js --network sepolia
```

**Via Contract:**
```javascript
const accumulatedFees = await marketplace.accumulatedFees();
console.log(`Fees: ${ethers.formatUnits(accumulatedFees, 6)} USDC`);
```

---

## 💳 Your Current Holdings

### Sepolia Testnet (as of last update)
- **ETH:** 2.44 ETH (for gas fees)
- **USDC:** 1,798,335.68 USDC
- **Fees Earned:** 0.061643 USDC (withdrawn)

### Base Mainnet
- **ETH:** 0.005 ETH (ready for deployment)
- **USDC:** Not deployed yet

### Contract Addresses

**Sepolia Testnet:**
- AgentLiquidityMarketplace: `0xf47620e1b2B33E264013Fad5D77AE9DC2b16B5C8`
- MockUSDC: `0x771c293167AeD146EC4f56479056645Be46a0275`
- AgentRegistry: `0xbd8210061bF24917Ca2F8098A1F3A4f76adA31fb`
- ReputationManagerV3: `0x7B0535B5fba88e10b064030943f88FEb4F6Ce715`

---

## 🔒 Security Best Practices

### ✅ DO:
- Keep private key in `.env` file (already gitignored)
- Back up `.env` file securely (encrypted cloud storage)
- Use hardware wallet (Ledger/Trezor) for mainnet
- Create separate wallet for production vs testing
- Regularly withdraw fees to cold storage

### ❌ DON'T:
- Never commit `.env` to git
- Never share private key with anyone
- Don't post private key in Discord/Telegram
- Don't use same wallet for mainnet with large amounts
- Don't store private key in plain text on cloud

### Recommendations for Production:
1. **Use Multi-sig Wallet** for contract ownership
   - Gnosis Safe on Base
   - Requires multiple signatures to withdraw fees

2. **Separate Hot/Cold Wallets**
   - Hot wallet: Small amount for operations
   - Cold wallet: Hardware wallet for fee storage

3. **Regular Fee Withdrawals**
   - Don't let fees accumulate to large amounts
   - Withdraw to cold storage weekly/monthly

---

## 🚨 If You Lose Access

### If Private Key Is Lost:
- ❌ **Cannot recover** - wallet and funds are lost
- This is why backups are critical!

### If Private Key Is Compromised:
1. **Immediately:**
   - Transfer all ETH to new wallet
   - Withdraw all USDC to new wallet
   - Withdraw all accumulated fees

2. **Contract Migration:**
   - Transfer contract ownership to new wallet
   - Use `transferOwnership(newAddress)` function
   - New wallet becomes fee recipient

---

## 📞 Quick Reference Commands

### Check Fee Balance
```bash
npx hardhat run scripts/check-and-withdraw-fees.js --network sepolia
```

### Withdraw All Fees
```bash
# Same command (auto-withdraws if fees available)
npx hardhat run scripts/check-and-withdraw-fees.js --network sepolia
```

### Check Your USDC Balance
```bash
npx hardhat run scripts/check-usdc-balance.js --network sepolia
```

### View on Etherscan
```bash
open "https://sepolia.etherscan.io/address/0x656086A21073272533c8A3f56A94c1f3D8BCFcE2"
```

---

## 🎯 Future: Mainnet Deployment

When you deploy to Base mainnet:

1. **Fees will be in real USDC** (not testnet tokens)
2. **Same withdrawal process** applies
3. **Use hardware wallet** recommended
4. **Consider multi-sig** for large operations

Your Base mainnet wallet already has 0.005 ETH ready for deployment!

---

**Last Updated:** February 16, 2026
**Network:** Sepolia Testnet
**Status:** Fees Withdrawn Successfully ✅
