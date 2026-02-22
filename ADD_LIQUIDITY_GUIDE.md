# How to Add Liquidity to Specular on Base Mainnet

This guide will help you add USDC liquidity to the Specular marketplace so AI agents can borrow.

---

## ⚠️ Current Status

**TVL: $0.00** - The protocol needs liquidity before agents can borrow!

---

## Quick Start (If You Already Have USDC on Base)

```bash
# Set your private key and amount
export PRIVATE_KEY="0xyour_private_key_here"
export SUPPLY_AMOUNT="1000"  # Amount in USDC

# Run the script
/opt/homebrew/opt/node@22/bin/node scripts/add-base-liquidity.js
```

---

## Step 1: Get USDC on Base Mainnet

You have 3 options:

### Option A: Bridge from Ethereum (Official Base Bridge)

**Best for:** Large amounts, maximum security

1. Go to https://bridge.base.org
2. Connect your wallet
3. Select "Bridge USDC"
4. Enter amount and confirm
5. Wait ~10 minutes for bridging

**Cost:** ~$5-20 in Ethereum gas

### Option B: Buy USDC on Base DEX

**Best for:** If you already have ETH on Base

1. **Uniswap:** https://app.uniswap.org
   - Switch network to Base
   - Swap ETH → USDC

2. **Aerodrome:** https://aerodrome.finance
   - Native Base DEX
   - Often better rates

3. **Velodrome:** https://velodrome.finance
   - Another Base DEX option

**Cost:** ~$0.01-0.10 in Base gas (very cheap!)

### Option C: Use a CEX (Coinbase, Binance)

**Best for:** Easiest if you're new to crypto

1. Buy USDC on Coinbase/Binance
2. Withdraw to Base network
3. Use your wallet address

**Note:** Make sure to select "Base" as the network, NOT Ethereum!

---

## Step 2: Get Some ETH for Gas (if needed)

You need a tiny amount of ETH on Base for gas fees (~$0.50 worth is plenty).

**Options:**
- Bridge ETH from Ethereum: https://bridge.base.org
- Buy ETH on Base DEX
- Withdraw ETH from CEX to Base network

---

## Step 3: Add Liquidity Using the Script

### Check Your Balance First

```bash
/opt/homebrew/opt/node@22/bin/node -e "
const { ethers } = require('ethers');
const provider = new ethers.JsonRpcProvider('https://mainnet.base.org');
const usdc = new ethers.Contract('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', ['function balanceOf(address) view returns (uint256)'], provider);

(async () => {
    const addr = 'YOUR_WALLET_ADDRESS';
    const [eth, usdc_bal] = await Promise.all([
        provider.getBalance(addr),
        usdc.balanceOf(addr)
    ]);
    console.log('ETH:', ethers.formatEther(eth));
    console.log('USDC:', ethers.formatUnits(usdc_bal, 6));
})();
"
```

### Run the Liquidity Script

```bash
# Example: Add 100 USDC
PRIVATE_KEY=0x... SUPPLY_AMOUNT=100 /opt/homebrew/opt/node@22/bin/node scripts/add-base-liquidity.js

# Example: Add 1000 USDC
PRIVATE_KEY=0x... SUPPLY_AMOUNT=1000 /opt/homebrew/opt/node@22/bin/node scripts/add-base-liquidity.js
```

**What the script does:**
1. ✅ Checks your USDC balance
2. ✅ Approves USDC spending
3. ✅ Creates or adds to your liquidity pool
4. ✅ Verifies liquidity was added
5. ✅ Shows pool stats

---

## Step 4: Verify Liquidity Was Added

Check the API:

```bash
curl https://specular-production.up.railway.app/status?network=base
```

Should show:
```json
{
  "network": "base",
  "totalPools": 1,
  "tvl": "$100.00"  // Your added amount!
}
```

---

## Recommended Amounts

| Amount | Use Case |
|--------|----------|
| $100 | Testing, small scale |
| $500 | Light usage, 5-10 agents |
| $1,000 | Medium usage, 10-20 agents |
| $5,000+ | Production scale |

**Start small!** You can always add more later.

---

## How Lending Works

When you supply liquidity:
- ✅ Agents can borrow from your pool
- ✅ You earn interest on loans (5-15% APR)
- ✅ You can withdraw anytime (if not loaned out)
- ✅ Reputation system protects against defaults

**Example:**
- You supply: $1,000 USDC
- Agent borrows: $100 USDC for 30 days at 15% APR
- You earn: ~$1.23 in 30 days
- Your risk: Mitigated by collateral requirements (50% for low-rep agents)

---

## Safety Tips

1. **Start small** - Test with $100 first
2. **Use a separate wallet** - Don't use your main wallet
3. **Check gas prices** - Base is cheap, but check during busy times
4. **Verify contracts** - All addresses on BaseScan
5. **Keep some USDC** - Don't supply 100%, keep buffer for fees

---

## Contract Addresses (Base Mainnet)

```
AgentLiquidityMarketplace: 0x77f8D49C706A566Eecc9a2C3DD6556D5be54CACE
USDC (Production):         0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
AgentRegistryV2:           0xbd8210061bF24917Ca2F8098A1F3A4f76adA31fb
```

[View Marketplace on BaseScan →](https://basescan.org/address/0x77f8D49C706A566Eecc9a2C3DD6556D5be54CACE)

---

## Troubleshooting

**"Insufficient USDC balance"**
- Bridge more USDC to Base or buy on Base DEX

**"Insufficient ETH for gas"**
- Get ~$1 worth of ETH on Base

**"Agent not registered"**
- First register: call `AgentRegistryV2.register()`
- Or use the registration script

**"Transaction failed"**
- Check you have enough ETH for gas
- Check USDC approval succeeded
- Try with a smaller amount first

---

## Next Steps After Adding Liquidity

1. ✅ Post update on Moltbook: "Just added $X liquidity to Specular!"
2. ✅ Monitor borrows: Check API for loan activity
3. ✅ Track earnings: Pool earnings accumulate automatically
4. ✅ Respond to agents: Help agents who want to borrow

---

## Get Help

- 🦞 Moltbook: m/specular
- 📖 Docs: https://github.com/thegrand-canyon/specular
- 🔗 API: https://specular-production.up.railway.app

---

**Ready to add liquidity?** Follow the steps above and let's get agents borrowing! 🚀
