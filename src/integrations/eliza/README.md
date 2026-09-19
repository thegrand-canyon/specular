# Specular Plugin for Eliza

Give your Eliza agents access to on-chain credit - borrow USDC based on reputation, no collateral required.

## Overview

The Specular plugin integrates [Specular Protocol](https://specular.network) into [Eliza](https://github.com/ai16z/eliza), enabling AI agents to:

- ✅ Check credit scores and limits
- ✅ Borrow USDC based on reputation (no collateral)
- ✅ Repay loans and build credit history
- ✅ Monitor loan status and due dates

**Perfect for:**
- Trading agents needing capital for opportunities
- Agents with API expenses (OpenAI, data providers)
- Treasury management and liquidity optimization
- Cross-chain operations with timing gaps

## Installation

```bash
npm install @specular/eliza-plugin
```

Or add to your `package.json`:

```json
{
  "dependencies": {
    "@specular/eliza-plugin": "^1.0.0"
  }
}
```

## Quick Start

### 1. Add to Eliza Config

```typescript
import { specularPlugin } from '@specular/eliza-plugin';

const character = {
  name: "TradingBot",
  plugins: [specularPlugin],
  // ... rest of character config
};
```

### 2. Set Environment Variables

```bash
SPECULAR_API_URL=http://api.specular.network
SPECULAR_NETWORK=base  # or 'arc' for testnet
PRIVATE_KEY=your_agent_wallet_private_key
```

### 3. Use in Conversations

```
User: What's my credit score?
Agent: Your credit score is 850/1000 (Excellent tier)...

User: Borrow 500 USDC for 30 days
Agent: ✅ Loan approved! Amount: 500 USDC...

User: Repay loan #123
Agent: ✅ Loan #123 repaid successfully!...
```

## Actions

The plugin provides four actions:

### 1. CHECK_CREDIT

Check agent's credit score and borrowing capacity.

**Trigger Phrases:**
- "What's my credit score?"
- "Check my credit"
- "Show my credit limit"
- "Can I borrow?"

**Response:**
```
Your credit score is 850/1000 (Excellent tier).
Excellent! You have top-tier credit.

Credit Limit: 2,000 USDC
Available: 1,500 USDC
Interest Rate: 5.5% APR
Active Loans: 1
```

### 2. REQUEST_LOAN

Borrow USDC based on reputation.

**Trigger Phrases:**
- "Borrow 500 USDC for 30 days"
- "Request a loan of 100 USDC"
- "I need capital for 60 days"
- "Get a 1000 USDC loan"

**Response:**
```
✅ Loan approved!

Amount: 500 USDC
Duration: 30 days
Interest: 2.26 USDC (5.5% APR)
Total to repay: 502.26 USDC

The USDC has been sent to your wallet.
```

### 3. REPAY_LOAN

Repay an active loan.

**Trigger Phrases:**
- "Repay loan #123"
- "Pay back my loan"
- "Pay off loan 456"

**Response:**
```
✅ Loan #123 repaid successfully!

Amount repaid: 500 USDC
Interest paid: 2.26 USDC
Total: 502.26 USDC

Your reputation has been updated. Keep up the good work!
```

### 4. CHECK_LOANS

View active loans and status.

**Trigger Phrases:**
- "Show my loans"
- "What loans do I have?"
- "When is my loan due?"
- "Loan status"

**Response:**
```
You have 2 active loan(s).
To check a specific loan, ask: "Check loan #123 status"
```

## Full Example

### Trading Agent with Credit

```typescript
import { specularPlugin } from '@specular/eliza-plugin';

const tradingAgent = {
  name: "ArbitrageBot",
  bio: "I find and execute arbitrage opportunities using Specular credit",
  plugins: [specularPlugin],
  modelProvider: "anthropic",
  clients: [],

  // Custom logic
  async init(runtime) {
    // Monitor for arbitrage opportunities
    setInterval(async () => {
      const opportunity = await this.scanDEXs();

      if (opportunity && opportunity.profit > 50) {
        // Check if we can borrow
        const credit = await runtime.executeAction("CHECK_CREDIT");

        if (credit.profile.credit.canBorrow) {
          // Borrow capital
          await runtime.executeAction("REQUEST_LOAN", {
            content: {
              text: `Borrow ${opportunity.capital} USDC for 1 day`
            }
          });

          // Execute trade
          await this.executeTrade(opportunity);

          // Repay immediately
          await runtime.executeAction("REPAY_LOAN", {
            content: {
              text: `Repay loan #${this.lastLoanId}`
            }
          });

          console.log(`✅ Arbitrage profit: ${opportunity.profit} USDC`);
        }
      }
    }, 30000); // Check every 30 seconds
  }
};
```

### Treasury Manager

```typescript
const treasuryAgent = {
  name: "TreasuryManager",
  bio: "I manage treasury liquidity using Specular credit",
  plugins: [specularPlugin],

  async manageTreasury(runtime) {
    const balance = await this.getBalance();

    // Borrow when balance is low
    if (balance < 1000) {
      await runtime.executeAction("REQUEST_LOAN", {
        content: {
          text: "Borrow 5000 USDC for 30 days"
        }
      });
      console.log("✅ Treasury refilled via Specular credit");
    }

    // Repay when balance recovers
    if (balance > 10000) {
      const loans = await runtime.executeAction("CHECK_LOANS");
      // Repay oldest loan
      await runtime.executeAction("REPAY_LOAN", {
        content: {
          text: "Repay loan #123"
        }
      });
    }
  }
};
```

## Configuration

### Environment Variables

| Variable | Required | Description | Default |
|----------|----------|-------------|---------|
| `SPECULAR_API_URL` | No | Specular API endpoint | `http://localhost:3001` |
| `SPECULAR_NETWORK` | No | Network (`base` or `arc`) | `base` |
| `PRIVATE_KEY` | Yes | Agent wallet private key | - |

### Runtime Settings

Access via `runtime.getSetting(key)`:

```typescript
const apiUrl = runtime.getSetting('SPECULAR_API_URL');
const network = runtime.getSetting('SPECULAR_NETWORK');
const privateKey = runtime.getSetting('PRIVATE_KEY');
```

## Networks

### Base Mainnet (Production)
- Chain ID: 8453
- RPC: https://mainnet.base.org
- USDC: 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913

**Set:** `SPECULAR_NETWORK=base`

### Arc Testnet (Development)
- Chain ID: 5042002
- RPC: https://arc-testnet.drpc.org
- USDC: 0xf2807051e292e945751A25616705a9aadfb39895

**Set:** `SPECULAR_NETWORK=arc`

## Reputation System

Agents build credit through behavior:

| Score Range | Tier | Collateral | Interest Rate |
|-------------|------|------------|---------------|
| 900-1000 | Excellent | 0% | 5.5% APR |
| 800-899 | Very Good | 0% | 6.5% APR |
| 700-799 | Good | 0% | 8.5% APR |
| 600-699 | Fair | 10% | 10.5% APR |
| <600 | Building | 25% | 15% APR |

**Score Changes:**
- On-time repayment: +10 points
- Early repayment: +5 points
- Late repayment: -5 points
- Default: -50 points

## Use Cases

### 1. Flash Arbitrage
```
Agent spots opportunity → borrows capital → executes trade →
repays loan → keeps profit (< 1 minute)
```

### 2. API Expense Management
```
Agent runs low on API credits → borrows USDC → buys credits →
generates revenue → repays loan
```

### 3. Treasury Optimization
```
Agent keeps minimal balance → borrows when opportunities arise →
maximizes capital efficiency → repays from profits
```

### 4. Cross-Chain Operations
```
Agent needs liquidity on new chain → borrows on Chain A →
bridges → uses capital → returns → repays
```

## Error Handling

The plugin handles common errors gracefully:

### Not Registered
```
You're not registered with Specular yet. Register first to access credit.
```

### Insufficient Credit
```
Insufficient credit. You can borrow up to 500 USDC, but requested 1000 USDC.
```

### Max Loans Reached
```
You've reached the maximum number of active loans (3).
Please repay an existing loan first.
```

### Loan Not Active
```
Loan #123 is repaid, not active.
```

## Provider

The plugin includes a provider for direct SDK access:

```typescript
import { specularProvider } from '@specular/eliza-plugin';

// In your agent
const sdk = await specularProvider.get(runtime);

// Use SDK methods
const profile = await sdk.getProfile(sdk.address);
const loan = await sdk.getLoan(123);
```

## Testing

### Unit Tests

```bash
npm test
```

### Integration Tests

```bash
# Start local Specular API
npm run api:server

# Run integration tests
npm run test:integration
```

### Test on Arc Testnet

```bash
SPECULAR_NETWORK=arc PRIVATE_KEY=your_test_key npm start
```

## Development

### Build

```bash
npm run build
```

### Watch Mode

```bash
npm run dev
```

### Clean

```bash
npm run clean
```

## Examples

Full working examples in `/examples`:

- **arbitrage-agent** - Flash arbitrage bot
- **treasury-manager** - Autonomous treasury management
- **api-agent** - API expense management
- **trading-bot** - General trading with credit

Run examples:

```bash
cd examples/arbitrage-agent
npm install
npm start
```

## Advanced Usage

### Custom Action Triggers

Extend the plugin with custom triggers:

```typescript
import { specularPlugin, requestLoanAction } from '@specular/eliza-plugin';

// Add custom trigger phrase
requestLoanAction.similes.push('GIMME_MONEY');

const character = {
  plugins: [specularPlugin],
  // ...
};
```

### Action Hooks

Hook into action lifecycle:

```typescript
const customRequestLoan = {
  ...requestLoanAction,
  handler: async (runtime, message, state, options, callback) => {
    // Pre-processing
    console.log('About to request loan');

    // Call original handler
    await requestLoanAction.handler(runtime, message, state, options, callback);

    // Post-processing
    console.log('Loan request complete');
  }
};
```

### Access SDK Directly

For advanced use cases:

```typescript
import { SpecularSDK } from '@specular/eliza-plugin';

const sdk = new SpecularSDK({
  apiUrl: 'http://api.specular.network',
  network: 'base',
  privateKey: process.env.PRIVATE_KEY
});

const profile = await sdk.getProfile(sdk.address);
console.log(`Credit Score: ${profile.reputation.score}`);
```

## Security

- ✅ Non-custodial (agent keeps keys)
- ✅ Audited smart contracts
- ✅ Transparent interest rates
- ✅ No hidden fees
- ✅ Instant repayment (no lock-up)
- ✅ Built-in safety limits

**Best Practices:**
1. Use dedicated agent wallets
2. Store private keys securely (environment variables)
3. Test on Arc Testnet first
4. Monitor reputation score regularly
5. Repay loans on time
6. Set reasonable loan amounts

## Troubleshooting

### "Wallet required for loan requests"
**Solution:** Set `PRIVATE_KEY` environment variable

### "Failed to get profile"
**Solution:** Check `SPECULAR_API_URL` is correct and API is running

### "Agent not registered"
**Solution:** Register agent first using the API or SDK

### High gas costs
**Solution:** Use Base mainnet (lower gas) or batch operations

## Support

- **Documentation:** https://docs.specular.network/eliza
- **Discord:** https://discord.gg/specular
- **Twitter:** https://twitter.com/SpecularFi
- **GitHub Issues:** https://github.com/specular-finance/specular/issues
- **Email:** support@specular.network

## Contributing

We welcome contributions!

```bash
git clone https://github.com/specular-finance/specular
cd specular/src/integrations/eliza
npm install
npm run dev
```

Submit PRs to: https://github.com/specular-finance/specular

## License

MIT

---

**Built with ❤️ by Specular Protocol**
