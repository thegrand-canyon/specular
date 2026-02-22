# Specular Protocol - Autonomous Bot System 🤖

## Overview
The bot system consists of autonomous agents and lenders that operate the Specular Protocol without human intervention. Bots demonstrate real-world usage patterns and stress-test the protocol.

## Bot Types

### 1. Autonomous Agent Bot (`src/bots/AutonomousAgentBot.js`)

**What it does:**
- Registers as an agent on the protocol
- Initializes reputation (starts at 100)
- Creates a liquidity pool
- Requests loans automatically
- Repays loans on time
- Builds reputation over time
- Tracks all activity

**Strategy Parameters:**
```javascript
{
    loanAmount: 1000,        // USDC per loan
    loanDuration: 30,        // Days
    repaymentDelay: 0,       // Days to wait before repaying
    targetLoans: 5,          // Number of loans to complete
    poolLiquidity: 10000     // Initial pool size
}
```

**Lifecycle:**
1. Register agent → Get agent ID
2. Initialize reputation (100 points)
3. Create liquidity pool
4. Loop:
   - Request loan (with collateral if needed)
   - Repay loan immediately
   - Reputation increases (+10 per on-time repayment)
   - Repeat until target loans completed

### 2. Lender Bot (`src/bots/LenderBot.js`)

**What it does:**
- Finds high-reputation agents
- Supplies liquidity to their pools
- Monitors returns and interest earnings
- Tracks all positions
- Can rebalance across agents

**Strategy Parameters:**
```javascript
{
    totalCapital: 50000,      // Total USDC to deploy
    diversification: 4,       // Number of agents to fund
    minAgentReputation: 100,  // Only fund agents with rep >= 100
    rebalanceInterval: 60000  // Check positions every 60s
}
```

**Lifecycle:**
1. Scan protocol for qualified agents
2. Sort agents by reputation
3. Diversify capital across top N agents
4. Monitor loop:
   - Check each position
   - Track interest earned
   - Log pool utilization
   - Rebalance if needed

## Running Bots

### Full Simulation
Launches multiple agent and lender bots:
```bash
npx hardhat run scripts/run-bot-simulation-arc.js --network arcTestnet
```

**This creates:**
- 3 Autonomous Agent Bots (Alpha, Beta, Gamma)
- 2 Lender Bots (Omega, Sigma)

**What happens:**
1. **Phase 1**: Agent bots register and create pools
2. **Phase 2**: Lender bots supply liquidity
3. **Phase 3**: Agent bots start borrowing and repaying
4. **Result**: Full protocol simulation with reputation building

### Individual Bot Usage

**Run a single agent bot:**
```javascript
const { AutonomousAgentBot } = require('./src/bots/AutonomousAgentBot');
const { ethers } = require('hardhat');

const bot = new AutonomousAgentBot({
    name: 'MyAgent',
    provider: ethers.provider,
    wallet: myWallet,
    contracts: arcAddresses,
    strategy: {
        loanAmount: 500,
        targetLoans: 3
    }
});

await bot.start();
```

**Run a single lender bot:**
```javascript
const { LenderBot } = require('./src/bots/LenderBot');

const bot = new LenderBot({
    name: 'MyLender',
    provider: ethers.provider,
    wallet: myWallet,
    contracts: arcAddresses,
    strategy: {
        totalCapital: 20000,
        diversification: 3
    }
});

await bot.start();
```

## Monitoring

### Real-Time Dashboard
Watch all protocol activity live:
```bash
npx hardhat run scripts/monitor-arc-protocol.js --network arcTestnet
```

**Dashboard shows:**
- Total agents and active pools
- Total liquidity and borrowed amounts
- Utilization rate
- Platform fees collected
- Active loans
- Top agents by reputation
- Live event stream (registrations, loans, repayments, reputation updates)

**Auto-refreshes every 30 seconds**

## Bot Simulation Results

After running the simulation, results are saved to `bot-simulation-results.json`:

```json
{
  "timestamp": "2026-02-16T...",
  "network": "Arc Testnet",
  "agents": [
    {
      "name": "AgentBot-Alpha",
      "agentId": 9,
      "reputation": 130,
      "loansCompleted": 3,
      "totalBorrowed": 1500,
      "totalRepaid": 1523.97
    },
    ...
  ],
  "lenders": [
    {
      "name": "LenderBot-Omega",
      "totalSupplied": 30000,
      "totalEarned": 45.82,
      "positions": {...}
    },
    ...
  ]
}
```

## Example Simulation Flow

```
🤖 LAUNCHING BOT SIMULATION ON ARC

Creating Agent Bots...
  AgentBot-Alpha ready
  AgentBot-Beta ready
  AgentBot-Gamma ready

Creating Lender Bots...
  LenderBot-Omega ready
  LenderBot-Sigma ready

--- Phase 1: Agent Bots Register & Create Pools ---
  [AgentBot-Alpha]: Registering agent...
  [AgentBot-Alpha]: ✅ Registered as Agent ID: 9
  [AgentBot-Alpha]: ⭐ Initializing reputation...
  [AgentBot-Alpha]: ✅ Reputation initialized: 100
  [AgentBot-Alpha]: 🏊 Creating liquidity pool...
  [AgentBot-Alpha]: ✅ Pool created
  ...

--- Phase 2: Lender Bots Supply Liquidity ---
  [LenderBot-Omega]: 🔍 Searching for agents...
  [LenderBot-Omega]: Found 3 qualified agents
  [LenderBot-Omega]: Agent 9 (Rep: 100): Supplying 10,000 USDC...
  [LenderBot-Omega]: ✅ Liquidity supplied
  ...

--- Phase 3: Running Autonomous Operations ---
  [AgentBot-Alpha]: 🔄 Starting loan cycle (target: 3 loans)...
  [AgentBot-Alpha]: --- LOAN #1 ---
  [AgentBot-Alpha]: 💰 Requesting loan of 500 USDC...
  [AgentBot-Alpha]: ✅ Loan approved: ID 1
  [AgentBot-Alpha]: 💸 Repaying loan #1...
  [AgentBot-Alpha]: ✅ Loan repaid!
  [AgentBot-Alpha]: ⭐ Reputation: 100 → 110 (+10)
  ...

SIMULATION COMPLETE - FINAL REPORT

AGENT BOTS:
  AgentBot-Alpha:
    Agent ID: 9
    Reputation: 130
    Loans Completed: 3
    Total Borrowed: 1500 USDC
    Total Repaid: 1523.97 USDC

LENDER BOTS:
  LenderBot-Omega:
    Total Supplied: 30,000 USDC
    Total Earned: 45.82 USDC
    Active Positions: 3
```

## Bot Features

### Autonomous Operation
- Bots run completely autonomously
- No human intervention required
- Self-sufficient (handle gas, approvals, transactions)
- Error recovery and retry logic

### Realistic Behavior
- Agent bots mimic real borrower behavior
- Lender bots mimic institutional lender strategies
- Proper collateral handling
- On-time repayments build reputation

### Comprehensive Logging
- Every action is logged with timestamp
- Full state tracking
- Results saved to JSON

### Configurable Strategies
- Customize loan amounts, durations, targets
- Adjust lender diversification and capital
- Fine-tune risk parameters

## Testing Scenarios

### 1. Reputation Building
Agent starts at 100 reputation, completes 5 loans, reaches 150 reputation:
```javascript
strategy: { targetLoans: 5, loanAmount: 1000 }
// Result: Reputation 100 → 150 (5 loans × +10 each)
```

### 2. Collateral Requirements
Low reputation agents (< 500) need 100% collateral:
```javascript
// Agent with rep 100 borrows 1000 USDC
// Needs 1000 USDC collateral (100%)
// After 3 repayments (rep 130), still needs 100% collateral
```

### 3. Lender Diversification
Lender bot spreads 40,000 USDC across 4 agents:
```javascript
strategy: { totalCapital: 40000, diversification: 4 }
// Result: 10,000 USDC per agent
```

### 4. Interest Earnings
Lenders earn interest on all active loans:
```javascript
// Supplied: 30,000 USDC
// After 9 loans (3 agents × 3 loans each)
// Earned: ~45 USDC in interest
```

## Advanced Usage

### Custom Bot Strategies

**Aggressive Agent** (high volume, fast loans):
```javascript
strategy: {
    loanAmount: 2000,
    loanDuration: 7,  // Short-term loans
    targetLoans: 10,
    repaymentDelay: 0
}
```

**Conservative Lender** (high quality only):
```javascript
strategy: {
    totalCapital: 100000,
    diversification: 2,  // Only top 2 agents
    minAgentReputation: 500,  // High rep required
    rebalanceInterval: 10000  // Check frequently
}
```

### Multi-Chain Bot (Future)
When CCTP bridges are deployed:
```javascript
// Bot deposits from Ethereum, lends on Arc
const bot = new CrossChainLenderBot({
    sourceChain: 'ethereum',
    destinationChain: 'arc',
    bridgeVia: 'cctp'
});
```

## Why Bots Are Valuable

1. **Testing**: Stress-test the protocol under realistic load
2. **Liquidity**: Bots bootstrap initial protocol liquidity
3. **Demonstration**: Show how agents interact in real-time
4. **Monitoring**: Track protocol behavior at scale
5. **Education**: Learn protocol mechanics through bot code

## Troubleshooting

**Bot fails to register:**
- Ensure wallet has gas (USDC on Arc)
- Check agent isn't already registered

**Bot can't borrow:**
- Verify pool has liquidity
- Check collateral requirements
- Ensure reputation is initialized

**Lender bot finds no agents:**
- Make sure agent bots registered first
- Check minAgentReputation threshold
- Verify pools are active

## Next Steps

1. Run the full simulation on Arc
2. Watch the monitoring dashboard
3. Analyze results in bot-simulation-results.json
4. Deploy CCTP bridge and test cross-chain bots
5. Scale up to 10+ bots for stress testing

---

🤖 **The bot system transforms Specular Protocol from a static smart contract into a living, breathing autonomous lending ecosystem!**
