# Fees and Earnings Guide

This guide explains how fees work in the Specular Protocol and how pool owners can access their earnings.

## 💰 How Fees Work

### Interest Rates (Reputation-Based)

The protocol charges interest on loans based on the borrower's reputation score:

| Reputation Score | Interest Rate (APR) | Example on 1000 USDC / 30 days |
|------------------|---------------------|--------------------------------|
| **800-1000** | **5%** | 4.11 USDC interest |
| **600-799** | **7%** | 5.75 USDC interest |
| **500-599** | **10%** | 8.22 USDC interest |
| **300-499** | **15%** | 12.33 USDC interest |
| **Below 300** | **20%** | 16.44 USDC interest |

### Interest Calculation Formula

```solidity
Interest = (Principal × InterestRate × DurationDays) / (10000 × 365)
```

**Example:**
- Principal: 1,000 USDC
- Interest Rate: 10% = 1000 basis points
- Duration: 30 days

Interest = (1000 × 1000 × 30) / (10000 × 365) = 8.22 USDC

## 📊 Where Fees Accrue

### Current Implementation

All interest payments accrue directly into the lending pool's **available liquidity**:

1. **When a loan is approved:**
   - Pool: 100,000 USDC
   - Loan: 1,000 USDC goes to borrower
   - Available: 99,000 USDC

2. **When the loan is repaid (principal + interest):**
   - Repayment: 1,008.22 USDC comes back
   - Available: 99,000 + 1,008.22 = 99,008.22 USDC
   - **Pool profit: 8.22 USDC**

3. **Pool Growth:**
   - The pool grows over time as interest is paid
   - Total Liquidity increases with each repayment
   - Fees compound as they become available for new loans

### No Separate Fee Pool

The protocol **does not** have a separate fee reserve. Interest is added directly to `availableLiquidity`, which means:

✅ **Advantages:**
- Simple accounting
- Fees automatically compound by being available for new loans
- Pool grows organically

⚠️ **Considerations:**
- Need to track initial deposit vs. accumulated interest manually
- Withdrawing fees reduces lending capacity

## 💸 How to Access Your Fees

### Option 1: Check Earnings Dashboard

See your accumulated fees and pool statistics:

```bash
npx hardhat run scripts/check-pool-earnings.js --network sepolia
```

**This shows:**
- Total pool liquidity
- Available liquidity
- Currently loaned amount
- **Accumulated fees** (available - (total - loaned))
- All loan history with interest earned
- Withdrawal recommendations

### Option 2: Withdraw Fees

Withdraw your accumulated earnings:

```bash
npx hardhat run scripts/withdraw-fees.js --network sepolia -- <amount>
```

**Example:**
```bash
# Withdraw 50.5 USDC in fees
npx hardhat run scripts/withdraw-fees.js --network sepolia -- 50.5
```

**Safety checks:**
- Only pool owner can withdraw
- Cannot withdraw more than available liquidity
- Warns if withdrawal would impact lending capacity

### Option 3: Direct Contract Call

For programmatic access:

```javascript
const lendingPool = await ethers.getContractAt('LendingPoolV2', poolAddress);

// Check available
const available = await lendingPool.availableLiquidity();
console.log('Available:', ethers.formatUnits(available, 6), 'USDC');

// Withdraw (owner only)
const amount = ethers.parseUnits('50', 6); // 50 USDC
await lendingPool.withdrawLiquidity(amount);
```

## 📈 Calculating Your Earnings

### Simple Tracking

**Initial Setup:**
```javascript
Initial Deposit = 100,000 USDC
```

**After Some Loans:**
```javascript
Available Liquidity = 100,500 USDC
Currently Loaned = 2,000 USDC

Theoretical Available = Initial - Loaned = 100,000 - 2,000 = 98,000 USDC
Accumulated Fees = Actual - Theoretical = 100,500 - 98,000 = 2,500 USDC
```

This means you've earned **2,500 USDC** in interest!

### The check-pool-earnings Script

The script automatically calculates this for you:

```javascript
const theoreticalAvailable = totalLiquidity - totalLoaned;
const accumulatedFees = availableLiquidity - theoreticalAvailable;
```

## 🎯 Best Practices

### 1. **Keep Sufficient Liquidity**

Don't withdraw all your fees if you want to continue lending:

```javascript
// Bad: Withdraw everything
availableLiquidity = 105,000 USDC
withdraw(105,000) // Pool is now empty!

// Good: Withdraw only fees, keep principal
accumulatedFees = 5,000 USDC
withdraw(5,000) // Pool still has 100k for lending
```

### 2. **Regular Fee Collection**

Withdraw fees periodically to realize profits:

```bash
# Weekly fee withdrawal
npx hardhat run scripts/check-pool-earnings.js --network sepolia
# Then withdraw accumulated amount
```

### 3. **Reinvest or Withdraw**

**Option A: Reinvest (compound)**
- Leave fees in the pool
- Available for new loans
- Earn interest on interest

**Option B: Withdraw (realize profit)**
- Take fees as profit
- Reduce lending capacity
- Lock in earnings

### 4. **Track Performance**

Monitor your pool's performance over time:

```bash
# Get current stats
npx hardhat run scripts/check-pool-earnings.js --network sepolia

# Track metrics:
# - Total interest earned
# - Number of loans
# - Average APR
# - Default rate
```

## 📊 Example Scenarios

### Scenario 1: First Loan Repaid

**Initial State:**
- Pool: 100,000 USDC
- Loans: 0

**After 1st loan (1000 USDC, 10% APR, 30 days):**
- Loaned: 1,000 USDC
- Available: 99,000 USDC

**After repayment:**
- Interest earned: 8.22 USDC
- Available: 99,008.22 USDC
- **You can withdraw: 8.22 USDC in fees**

### Scenario 2: Multiple Active Loans

**Current State:**
- Pool: 100,000 USDC
- Active loans: 10,000 USDC
- Previous interest earned: 150 USDC
- Available: 90,150 USDC

**Calculation:**
- Theoretical available: 100,000 - 10,000 = 90,000
- Actual available: 90,150
- **Accumulated fees: 150 USDC**

**You can safely withdraw 150 USDC** without affecting lending capacity.

### Scenario 3: Pool Growth

**Month 1:**
- Pool: 100,000 USDC
- Loans: 0
- Fees: 0

**Month 2:**
- Pool: 100,500 USDC (+500 in interest)
- Loans: 5,000 USDC
- Available: 95,500 USDC
- **Fees to withdraw: 500 USDC**

**Month 3:**
- Pool: 101,200 USDC (+700 more interest)
- Loans: 8,000 USDC
- Available: 93,200 USDC
- **Total fees earned: 1,200 USDC**

## 🔧 Technical Details

### Contract Functions

**From LendingPoolV2.sol:**

```solidity
// Withdraw fees (owner only)
function withdrawLiquidity(uint256 _amount) external onlyOwner nonReentrant {
    require(_amount > 0, "Amount must be positive");
    require(_amount <= availableLiquidity, "Insufficient available liquidity");

    availableLiquidity -= _amount;
    totalLiquidity -= _amount;

    usdcToken.safeTransfer(msg.sender, _amount);

    emit LiquidityWithdrawn(msg.sender, _amount);
}
```

**Key variables:**
- `totalLiquidity` - Total USDC in pool (deposits + interest)
- `availableLiquidity` - USDC available for lending or withdrawal
- `totalLoaned` - USDC currently lent out to borrowers

### Events

Monitor these events for fee tracking:

```solidity
event LiquidityDeposited(address indexed provider, uint256 amount);
event LiquidityWithdrawn(address indexed provider, uint256 amount);
event LoanRepaid(uint256 indexed loanId, address indexed borrower, uint256 totalAmount, bool onTime);
```

## 🚀 Quick Reference

### Check earnings:
```bash
npx hardhat run scripts/check-pool-earnings.js --network sepolia
```

### Withdraw fees:
```bash
npx hardhat run scripts/withdraw-fees.js --network sepolia -- <amount>
```

### View pool owner:
```bash
npx hardhat console --network sepolia
> const pool = await ethers.getContractAt('LendingPoolV2', '0x5592A6d7bF1816f77074b62911D50Dad92A3212b')
> await pool.owner()
'0x656086A21073272533c8A3f56A94c1f3D8BCFcE2'
```

### Calculate expected interest:
```javascript
// For a specific loan
const principal = ethers.parseUnits('1000', 6); // 1000 USDC
const rate = 1000; // 10% = 1000 basis points
const days = 30;

const interest = (principal * rate * days) / (10000n * 365n);
console.log('Interest:', ethers.formatUnits(interest, 6), 'USDC');
```

## ⚠️ Important Notes

1. **Only Owner Can Withdraw**: The `withdrawLiquidity()` function is `onlyOwner`
2. **No Auto-Distribution**: Fees don't auto-distribute - you must manually withdraw
3. **Affects Lending Capacity**: Withdrawing reduces available liquidity for new loans
4. **No Fee Split**: 100% of interest goes to pool owner (no protocol fee)
5. **Testnet Only**: These addresses are on Sepolia - use test funds only

## 📞 Support

- **Dashboard**: `scripts/check-pool-earnings.js`
- **Withdrawal**: `scripts/withdraw-fees.js`
- **Pool Address**: `0x5592A6d7bF1816f77074b62911D50Dad92A3212b`
- **Owner**: `0x656086A21073272533c8A3f56A94c1f3D8BCFcE2`

---

**Happy earning! 💰**
