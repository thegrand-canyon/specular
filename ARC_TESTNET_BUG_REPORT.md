# Critical Bug Report: Arc Testnet Marketplace Pool Accounting

**Date:** 2026-02-19
**Severity:** CRITICAL
**Network:** Arc Testnet (Chain ID: 5042002)
**Contract:** AgentLiquidityMarketplace (0xFBF9509A8ED5cbBEFe14470CC1f6E9AB695E1D7A)
**Agent ID:** 43 (0x656086A21073272533c8A3f56A94c1f3D8BCFcE2)

---

## Issue Summary

**Pool accounting bug prevents new loans despite having liquidity.**

The `AgentPool.totalLoaned` variable is NOT being decremented when loans are repaid, causing the pool to appear fully utilized when it actually has available funds. This completely blocks new loan requests.

---

## Evidence

### Pool State (Claimed)
```
Total Liquidity:   1,000.0 USDC
Total Loaned:      1,005.0 USDC (❌ impossible - exceeds capacity!)
Available:         0.116826 USDC
Total Earned:      5.116826 USDC
Utilization:       100.50%
```

### Actual Loan State (from blockchain)
```
Total Loans Created: 30
  - Active:   1 loan  (20 USDC) - Loan #11
  - Repaid:   29 loans (1,250 USDC)
  - Defaulted: 0 loans
```

### Accounting Discrepancy
```
Pool totalLoaned:        1,005.0 USDC
Sum of active loans:     20.0 USDC
═══════════════════════════════════
DISCREPANCY:             985.0 USDC ❌
```

---

## Root Cause Analysis

### Hypothesis
The `repayLoan()` function is failing to decrement `AgentPool.totalLoaned` when loans are successfully repaid.

### Expected Behavior
```solidity
function repayLoan(uint256 loanId) external {
    // ... repayment logic ...

    // Should decrement totalLoaned:
    agentPools[poolId].totalLoaned -= loanAmount;
    agentPools[poolId].availableLiquidity += (loanAmount + interest);
}
```

### Observed Behavior
- Loans are marked as REPAID ✅
- Interest is calculated and transferred ✅
- `availableLiquidity` is updated (partially) ⚠️
- **`totalLoaned` is NOT decremented** ❌

This causes:
1. `totalLoaned` accumulates indefinitely
2. Available liquidity calculation breaks
3. New loans rejected due to "insufficient liquidity"

---

## Impact

### Immediate Impact
- **Pool is effectively frozen** - cannot issue new loans
- Despite 29 successful repayments, funds are locked
- Agent has 1000 reputation (max) but can't borrow

### Loan Request Failure
```
Requesting 100 USDC for 7 days...
❌ Error: "Insufficient pool liquidity"

Pool available: 0.116826 USDC
Pool total:     1,000 USDC
Actual free:    ~980 USDC (based on 20 USDC active loan)
```

### User Impact
- Lenders: Funds locked, can't be utilized
- Borrowers: Can't request loans despite having credit
- Protocol: No revenue from blocked loans

---

## Detailed Loan History

### Active Loans (1)
| ID | Amount | State | Start Date | End Date |
|----|--------|-------|------------|----------|
| 11 | 20 USDC | ACTIVE | 2026-02-19 18:42:55 | 2026-02-26 18:42:55 |

### Repaid Loans (29)

**First 10 Loans (20 USDC each @ 10% APR):**
| ID | Amount | Rate | Started | Ended |
|----|--------|------|---------|-------|
| 1 | 20 USDC | 10% | 2026-02-19 18:21:23 | 2026-02-26 18:21:23 |
| 2 | 20 USDC | 10% | 2026-02-19 18:21:25 | 2026-02-26 18:21:25 |
| 3 | 20 USDC | 10% | 2026-02-19 18:21:27 | 2026-02-26 18:21:27 |
| 4 | 20 USDC | 10% | 2026-02-19 18:21:29 | 2026-02-26 18:21:29 |
| 5 | 20 USDC | 10% | 2026-02-19 18:21:35 | 2026-02-26 18:21:35 |
| 6 | 20 USDC | 10% | 2026-02-19 18:21:41 | 2026-02-26 18:21:41 |
| 7 | 20 USDC | 10% | 2026-02-19 18:21:43 | 2026-02-26 18:21:43 |
| 8 | 20 USDC | 10% | 2026-02-19 18:21:49 | 2026-02-26 18:21:49 |
| 9 | 20 USDC | 10% | 2026-02-19 18:21:55 | 2026-02-26 18:21:55 |
| 10 | 20 USDC | 10% | 2026-02-19 18:21:58 | 2026-02-26 18:21:58 |

**Loans 12-21 (50 USDC each @ 10% APR):**
| ID | Amount | Rate |
|----|--------|------|
| 12-21 | 50 USDC each | 10% |

**Loans 22-26, 29-30 (50 USDC each @ 7% APR):**
| ID | Amount | Rate |
|----|--------|------|
| 22-26, 29-30 | 50 USDC each | 7% |

**Loans 27-28 (100 USDC each @ 7% APR):**
| ID | Amount | Rate |
|----|--------|------|
| 27-28 | 100 USDC each | 7% |

**Total Repaid:** 1,250 USDC principal + interest

---

## Contract Upgrade Context

From `arc-testnet-addresses.json`:
```json
{
  "agentLiquidityMarketplace": "0xFBF9509A8ED5cbBEFe14470CC1f6E9AB695E1D7A",
  "agentLiquidityMarketplace_old": "0xD1cf6E7864Bc4CbBE52aA94369dF08B106927559",
  "upgradedAt": "2026-02-19T18:12:04.186Z",
  "upgradeReason": "[SECURITY-01] Added concurrent loan limits"
}
```

**Hypothesis:** The bug was introduced during the upgrade that added concurrent loan limits. The repayment logic may have been modified incorrectly.

---

## Reproduction Steps

1. Deploy AgentLiquidityMarketplace on Arc Testnet
2. Create agent pool with 1,000 USDC liquidity
3. Request and repay a loan (e.g., 20 USDC)
4. Check pool state: `agentPools[poolId].totalLoaned`
5. **Observe:** `totalLoaned` is NOT decremented after repayment
6. Repeat loan cycle
7. **Observe:** `totalLoaned` accumulates, exceeding total liquidity
8. **Result:** New loans rejected despite available funds

---

## Recommended Fixes

### Option 1: Fix Repayment Logic (Preferred)
```solidity
function repayLoan(uint256 loanId) external nonReentrant {
    Loan storage loan = loans[loanId];
    require(loan.state == LoanState.ACTIVE, "Loan not active");
    require(msg.sender == loan.borrower, "Not borrower");

    uint256 interest = calculateInterest(loan);
    uint256 totalRepayment = loan.amount + interest;

    // Transfer repayment
    usdc.transferFrom(msg.sender, address(this), totalRepayment);

    // Update pool accounting ✅ ADD THIS
    AgentPool storage pool = agentPools[loan.poolId];
    pool.totalLoaned -= loan.amount;  // ← CRITICAL FIX
    pool.availableLiquidity += loan.amount;
    pool.totalEarned += interest;

    // Update loan state
    loan.state = LoanState.REPAID;

    emit LoanRepaid(loanId, loan.amount, interest);
}
```

### Option 2: Reset Pool State (Emergency)
If contract is not upgradeable, manually reset corrupted pools:
```solidity
function resetPoolAccounting(uint256 poolId) external onlyOwner {
    // Recalculate totalLoaned from active loans
    uint256 actualLoaned = 0;
    for (uint i = 1; i <= loanIdCounter; i++) {
        if (loans[i].poolId == poolId && loans[i].state == LoanState.ACTIVE) {
            actualLoaned += loans[i].amount;
        }
    }
    agentPools[poolId].totalLoaned = actualLoaned;
    agentPools[poolId].availableLiquidity =
        agentPools[poolId].totalLiquidity - actualLoaned;
}
```

---

## Testing Protocol

### Before Fix
```bash
# Should fail due to bug
node scripts/arc-detailed-loan-audit.js
# Expected: Discrepancy of 985 USDC

node scripts/comprehensive-arc-test.js
# Expected: "Insufficient pool liquidity" error
```

### After Fix
```bash
# Should pass
node scripts/arc-detailed-loan-audit.js
# Expected: No discrepancy, totalLoaned = 20 USDC

node scripts/comprehensive-arc-test.js
# Expected: Loan request succeeds
```

---

## Comparison: Base Sepolia (Working)

For comparison, Base Sepolia marketplace is functioning correctly:

```
Network: Base Sepolia
Marketplace: 0x5194D976F2f1B59C0500cDe1e54A362d9BB9124B

Agent Pool:
  Total Liquidity:   10,000.0 USDC
  Available:         9,900.895069 USDC
  Total Loaned:      100.0 USDC ✅
  Utilization:       1.0%

Active Loans:       1 (100 USDC)
Repaid Loans:       2 (250 USDC)

✅ Pool accounting matches active loans
✅ New loans succeed
✅ Reputation updates work (+10 per on-time repayment)
```

---

## Recommendations

### Immediate Actions
1. **Halt new deployments** of buggy marketplace contract
2. **Deploy fixed contract** to Arc testnet
3. **Migrate pools** to new contract or reset accounting
4. **Add unit tests** specifically for totalLoaned accounting

### Medium-term Actions
1. **Audit all pool state** across Arc testnet
2. **Review upgrade process** to prevent similar bugs
3. **Add accounting invariant checks** in tests
4. **Implement pool health monitoring**

### Long-term Actions
1. **Formal verification** of pool accounting logic
2. **Automated testing** of all state transitions
3. **Circuit breakers** to detect accounting anomalies
4. **Upgrade to proxy pattern** for easier fixes

---

## Files for Investigation

### Contract Files
1. `contracts/core/AgentLiquidityMarketplace.sol`
   - Check `repayLoan()` function (lines ~400-450)
   - Verify `totalLoaned` decrement logic
   - Compare with working Base Sepolia version

2. `test/unit/AgentLiquidityMarketplace.test.js`
   - Add test case: "should decrement totalLoaned on repayment"
   - Add test case: "totalLoaned should never exceed totalLiquidity"

### Deployment Records
1. `deployments/arc-testnet/AgentLiquidityMarketplace.json`
   - Transaction hash of buggy deployment
   - Deployment timestamp: 2026-02-19T18:12:04.186Z
   - Deployer: 0x656086A21073272533c8A3f56A94c1f3D8BCFcE2

---

## Status

- **Identified:** 2026-02-19
- **Severity:** CRITICAL
- **Affected Networks:** Arc Testnet
- **Status:** OPEN
- **Assigned:** TBD
- **Priority:** P0 (blocks all new loans)

---

## Contact

For questions or additional information:
- Report generated by: Comprehensive Arc Test Suite
- Test artifacts: `arc-testnet-results.json`, `arc-detailed-loan-audit.js`
- Contract addresses: `src/config/arc-testnet-addresses.json`
