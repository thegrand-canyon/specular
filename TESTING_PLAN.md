# P2P Marketplace Testing & Refinement Plan

**Date:** February 15, 2026
**Status:** 🧪 Testing Phase
**Goal:** Deploy, test, and refine P2P marketplace before mainnet

---

## Testing Phases

### Phase 1: Deployment ⏳

**Command:**
```bash
npx hardhat run scripts/deploy-liquidity-marketplace.js --network sepolia
```

**Expected Output:**
```
🚀 Deploying Agent Liquidity Marketplace

Deployer: 0x...
Using:
  AgentRegistry: 0xbd8210061bF24917Ca2F8098A1F3A4f76adA31fb
  ReputationManagerV3: 0x7B0535B5fba88e10b064030943f88FEb4F6Ce715
  MockUSDC: 0x771c293167AeD146EC4f56479056645Be46a0275

⏳ Deploying AgentLiquidityMarketplace...
✅ AgentLiquidityMarketplace deployed to: 0x...

⚙️  Authorizing marketplace in ReputationManagerV3...
✅ Marketplace authorized

✅ Deployment Complete!
```

**What to Check:**
- [ ] Deployment succeeds without errors
- [ ] Contract address is saved to `sepolia-addresses.json`
- [ ] Authorization transaction succeeds
- [ ] Gas costs reasonable (< 0.01 ETH)

**Potential Issues:**
- ❌ "Insufficient funds" → Need Sepolia ETH
- ❌ "Already authorized" → Script can handle this, just continue
- ❌ "Contract creation failed" → Check contract compiles

---

### Phase 2: Agent Pool Creation ⏳

**Command:**
```bash
npx hardhat run scripts/create-agent-pools.js --network sepolia
```

**Expected Output:**
```
🏊 Creating Agent Liquidity Pools

📋 Agent: Alice
   Address: 0x...
   Agent ID: 2
   Creating pool...
   ✅ Pool created!

📋 Agent: Bob
   Address: 0x...
   Agent ID: 3
   Creating pool...
   ✅ Pool created!

[... Carol and Dave ...]

✅ Agent Pools Created!
```

**What to Check:**
- [ ] All 4 agent pools created successfully
- [ ] Each agent can only create one pool
- [ ] Pool creation emits events
- [ ] Gas costs reasonable (< 0.005 ETH per pool)

**Potential Issues:**
- ❌ "Pool already exists" → Expected if already created
- ❌ "Not a registered agent" → Agent needs to be in AgentRegistry
- ❌ Transaction reverts → Check agent has ETH for gas

---

### Phase 3: P2P Lending Full Cycle ⏳

**Command:**
```bash
npx hardhat run scripts/test-p2p-lending.js --network sepolia
```

**Expected Output:**
```
🔬 Testing P2P Liquidity Marketplace

TEST 1: Supply Liquidity to Alice's Pool
💰 Lender supplying 10000 USDC to Alice's pool...
✅ Liquidity supplied!

📊 Alice's Pool State:
   Total Liquidity: 10000 USDC
   Available: 10000 USDC
   Lender Count: 1

TEST 2: Alice Requests Loan from Her Pool
📋 Loan Request:
   Amount: 5000 USDC
   Duration: 30 days
   Collateral Requirement: 100%

✅ Loan disbursed! ID: 1

TEST 3: Alice Repays Loan
💵 Repayment Breakdown:
   Principal: 5000 USDC
   Interest: ~41.09 USDC
   Platform Fee: 0.41 USDC
   Lender Interest: 40.68 USDC
   Total: 5041.09 USDC

✅ Loan repaid!

TEST 4: Supply Liquidity to Bob's Pool
✅ Liquidity supplied to Bob!

TEST 5: Claim Earned Interest
💰 Amount claimed: 40.68 USDC

✅ P2P Marketplace Testing Complete!
```

**What to Check:**
- [ ] Lender can supply liquidity to agent pool
- [ ] Agent can borrow from their own pool
- [ ] Collateral handling works correctly
- [ ] Interest calculations accurate
- [ ] Interest distributed proportionally to lenders
- [ ] Platform fee (1%) collected correctly
- [ ] Lender can claim earned interest
- [ ] Multi-agent support works

**Key Metrics to Validate:**
- Interest rate matches reputation (100 rep = 15% APR)
- Interest calculation: `(principal * rate * duration) / 365 days`
- Platform fee: 1% of interest
- Lender gets: 99% of interest

**Potential Issues to Watch For:**
- ❌ Interest calculation incorrect
- ❌ Interest distribution doesn't add up
- ❌ Platform fee not collected
- ❌ Collateral not returned on repayment
- ❌ Pool liquidity tracking off
- ❌ Gas costs too high

---

### Phase 4: Browse Agent Pools ⏳

**Command:**
```bash
npx hardhat run scripts/browse-agent-pools.js --network sepolia
```

**Expected Output:**
```
🔍 Browsing Agent Liquidity Pools

📋 AVAILABLE AGENT POOLS

🤖 Alice (Agent #2)
   📊 Pool Stats:
      Total Liquidity:    15000.00 USDC
      Available:          10000.00 USDC
      Currently Loaned:   5000.00 USDC
      Total Earned:       40.68 USDC
      Utilization:        33.3%
      Lenders:            1

   🎯 Agent Profile:
      Reputation:         100/1000
      Credit Limit:       1000 USDC
      Interest Rate:      15% APR
      Collateral Req:     100%

   💰 Lender Returns:
      Total Earned:       40.68 USDC
      Est. APY:           ~14.85%

   📈 Investment Score:
      ⭐⭐⭐ Average
      Low reputation • Proven earnings • Community trust

[... Bob, Carol, Dave ...]

📊 MARKETPLACE SUMMARY
   Active Pools:       4
   Total Liquidity:    25000 USDC
   Currently Loaned:   5000 USDC
   Total Earned:       40.68 USDC
   Avg Utilization:    20%

🏆 TOP AGENT:
   Alice with 15000 USDC liquidity
```

**What to Check:**
- [ ] All pool stats accurate
- [ ] Utilization calculated correctly: `(loaned / total) * 100`
- [ ] APY estimation reasonable
- [ ] Investment scores make sense
- [ ] Marketplace summary accurate

---

## Refinement Areas to Focus On

### 1. Interest Calculation Accuracy

**Test Cases:**
```javascript
// Should verify:
- 1000 USDC, 15% APR, 30 days = 12.32 USDC interest
- 5000 USDC, 15% APR, 30 days = 61.64 USDC interest
- 1000 USDC, 5% APR, 365 days = 50 USDC interest
```

**How to verify:**
```javascript
interest = (principal * rateBPS * durationSeconds) / (10000 * 365 days)
```

### 2. Interest Distribution

**Test Case:** 2 lenders in same pool
- Lender A: 6000 USDC (60%)
- Lender B: 4000 USDC (40%)
- Total interest: 100 USDC

**Expected:**
- Lender A gets: 60 USDC
- Lender B gets: 40 USDC

**How to test:** Modify test script to add second lender

### 3. Edge Cases

**Test scenarios:**
- [ ] Agent with 0 liquidity tries to borrow
- [ ] Lender tries to withdraw more than available
- [ ] Loan request exceeds available liquidity
- [ ] Multiple concurrent loans from same pool
- [ ] Loan default scenario (requires time manipulation)

### 4. Gas Optimization

**Measure gas for:**
- Supply liquidity: Target < 100k gas
- Request loan: Target < 200k gas
- Repay loan: Target < 250k gas
- Claim interest: Target < 80k gas

### 5. Security Checks

**Verify:**
- [ ] Only authorized pools can update reputation
- [ ] Owner can pause marketplace
- [ ] Platform fee can't exceed 5%
- [ ] No reentrancy vulnerabilities
- [ ] Safe math (Solidity 0.8.20 handles this)

---

## Issues to Look For

### High Priority 🔴

1. **Interest calculation errors**
   - Off by even 0.01% is problematic
   - Should match exactly with manual calculation

2. **Interest distribution errors**
   - Sum of lender shares must equal total interest
   - Rounding errors should be minimal

3. **State inconsistencies**
   - `availableLiquidity + totalLoaned` should equal pool liquidity
   - Lender position sum should match pool total

4. **Access control bypasses**
   - Non-agents can't create pools
   - Non-lenders can't claim interest

### Medium Priority 🟡

5. **Gas inefficiencies**
   - Interest distribution loops could be expensive
   - Multiple SSTORE operations

6. **UX issues**
   - Unclear error messages
   - Missing events
   - Poor pool browsing experience

### Low Priority 🟢

7. **Code quality**
   - Unused variables
   - Missing natspec comments
   - Inconsistent naming

---

## Test Execution Checklist

### Before Testing
- [ ] Compile contracts: `npx hardhat compile`
- [ ] Check deployer has Sepolia ETH (0.1 ETH recommended)
- [ ] Verify test agents exist in `test-agents.json`
- [ ] Verify test agents have USDC

### During Testing
- [ ] Run each script in order
- [ ] Take notes on any errors or warnings
- [ ] Record gas costs for each operation
- [ ] Screenshot any interesting outputs
- [ ] Save transaction hashes

### After Testing
- [ ] Document all issues found
- [ ] Prioritize issues (High/Medium/Low)
- [ ] Create refinement plan
- [ ] Implement fixes
- [ ] Re-test

---

## Success Criteria

### Minimum Viable (Must Have)
- [x] Contract deploys successfully
- [ ] Agents can create pools
- [ ] Lenders can supply liquidity
- [ ] Agents can borrow from their pools
- [ ] Loans can be repaid
- [ ] Interest distributed correctly
- [ ] No critical bugs

### Production Ready (Should Have)
- [ ] All edge cases handled
- [ ] Gas costs reasonable
- [ ] Interest calculations perfect
- [ ] All security checks pass
- [ ] Good UX (clear errors, events)
- [ ] Pool browsing works well

### Polished (Nice to Have)
- [ ] Advanced analytics
- [ ] Batch operations
- [ ] Partial repayments
- [ ] Loan refinancing

---

## Refinement Workflow

After identifying issues:

1. **Categorize**: High/Medium/Low priority
2. **Fix**: Make code changes
3. **Test locally**: `npx hardhat test`
4. **Re-deploy**: Deploy updated contract
5. **Re-test**: Run all tests again
6. **Verify**: Confirm issue resolved

---

## Next Steps After Testing

### If All Tests Pass ✅
1. Deploy to Base Sepolia testnet
2. Run same tests on Base Sepolia
3. Plan Base mainnet launch

### If Issues Found 🔧
1. Document all issues
2. Prioritize fixes
3. Implement fixes
4. Re-test on Sepolia
5. Repeat until clean

---

**Ready to start testing!** Run the first command and let me know what happens.

```bash
npx hardhat run scripts/deploy-liquidity-marketplace.js --network sepolia
```
