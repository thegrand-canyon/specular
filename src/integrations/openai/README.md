# Specular + OpenAI Function Calling

Give GPT-4 and other OpenAI models direct access to Specular Protocol's on-chain credit system.

## Quick Start

```javascript
const { SpecularOpenAI } = require('./SpecularOpenAI');
const { ethers } = require('ethers');

// Initialize with wallet
const provider = new ethers.JsonRpcProvider('https://mainnet.base.org');
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

const specular = new SpecularOpenAI({
    apiUrl: 'http://localhost:3001',
    wallet,
    network: 'base'
});

// Use with OpenAI API
const response = await openai.createChatCompletion({
    model: 'gpt-4',
    messages: messages,
    functions: SpecularOpenAI.getFunctions(),
    function_call: 'auto'
});

// If GPT-4 calls a function:
if (response.data.choices[0].message.function_call) {
    const { name, arguments: args } = response.data.choices[0].message.function_call;
    const result = await specular.executeFunction(name, JSON.parse(args));
}
```

## Available Functions

### Credit Operations

1. **`specular_check_credit`** - Check reputation and credit terms
2. **`specular_request_loan`** - Request USDC loan
3. **`specular_repay_loan`** - Repay active loan

### Information Queries

4. **`specular_get_liquidity`** - View available pools
5. **`specular_get_loan_status`** - Check loan details
6. **`specular_get_protocol_stats`** - Protocol statistics

### Agent Management

7. **`specular_register_agent`** - Register new agent

## Example Conversations

### Check Credit & Request Loan

```
User: What's my credit score?

GPT-4: [Calls specular_check_credit]
Your credit score is 850/1000 (Excellent tier). You have a
credit limit of 1,000 USDC at 5.5% APR.

User: Request a 100 USDC loan for 30 days

GPT-4: [Calls specular_request_loan]
Loan approved! Your 100 USDC has been deposited. Due date:
March 24, 2026. Total to repay: 100.45 USDC.
```

### Monitor & Repay

```
User: How's my loan doing?

GPT-4: [Calls specular_get_loan_status]
Your loan of 100 USDC is active. Due in 6 days.
Total to repay: 100.45 USDC (including 0.45 interest).

User: Repay it

GPT-4: [Calls specular_repay_loan]
Loan repaid successfully! Your reputation has been updated.
New score: 860/1000.
```

## Function Definitions

All function definitions are in `functions.json` and can be loaded with:

```javascript
const functions = SpecularOpenAI.getFunctions();
```

Use these directly in OpenAI API calls:

```javascript
const response = await openai.createChatCompletion({
    model: 'gpt-4',
    messages: yourMessages,
    functions: functions,
    function_call: 'auto'
});
```

## Configuration

### Required Environment Variables

```bash
OPENAI_API_KEY=your_openai_key_here
PRIVATE_KEY=your_ethereum_private_key_here
RPC_URL=https://mainnet.base.org
```

### Optional Configuration

```javascript
const specular = new SpecularOpenAI({
    apiUrl: 'http://localhost:3001',  // Specular API endpoint
    wallet: wallet,                    // ethers.Wallet instance
    network: 'base'                    // 'base' or 'arc'
});
```

## Full Example

See `example.js` for a complete conversation flow:

```bash
# Install dependencies
npm install openai ethers

# Set environment variables
export OPENAI_API_KEY=your_key
export PRIVATE_KEY=your_key
export RPC_URL=https://mainnet.base.org

# Run example
node example.js
```

## Integration Patterns

### Pattern 1: Autonomous Agent

```javascript
// Agent checks its own credit periodically
setInterval(async () => {
    const credit = await specular.checkCredit(wallet.address);

    if (credit.reputation.score < 500) {
        console.log('⚠️ Low credit score, focusing on repayment');
    }
}, 3600000); // Every hour
```

### Pattern 2: Conversational Interface

```javascript
// User asks questions, GPT-4 uses Specular functions
messages.push({
    role: 'user',
    content: 'Should I take out a loan for this trading opportunity?'
});

const response = await openai.createChatCompletion({
    model: 'gpt-4',
    messages,
    functions: SpecularOpenAI.getFunctions()
});
```

### Pattern 3: Automated Loan Management

```javascript
// Agent automatically manages loans
async function manageLoan() {
    const stats = await specular.getProtocolStats();
    const credit = await specular.checkCredit(wallet.address);

    if (credit.canBorrow && needsCapital()) {
        await specular.requestLoan(100, 30);
    }
}
```

## Error Handling

All functions return structured errors:

```javascript
try {
    const result = await specular.requestLoan(1000, 30);
} catch (error) {
    if (error.message.includes('not registered')) {
        // Register first
        await specular.registerAgent('My Agent');
    }
}
```

## Security Best Practices

1. **Never expose private keys**
   - Use environment variables
   - Consider using dedicated agent wallets

2. **Validate function results**
   - Check `success` field in responses
   - Handle errors gracefully

3. **Test on testnet first**
   - Use Arc Testnet before Base Mainnet
   - Set `network: 'arc'` in config

## Advanced Usage

### Custom System Prompts

```javascript
const systemPrompt = {
    role: 'system',
    content: `You are a DeFi advisor with access to Specular Protocol.

    Guidelines:
    - Only recommend loans for productive use cases
    - Warn about over-leveraging
    - Encourage building good reputation
    - Explain interest calculations clearly`
};
```

### Function Call Logging

```javascript
// Log all Specular operations
const originalExecute = specular.executeFunction.bind(specular);
specular.executeFunction = async (name, args) => {
    console.log(`📞 ${name}:`, args);
    const result = await originalExecute(name, args);
    console.log(`✅ Result:`, result);
    return result;
};
```

## Links

- **Function Definitions:** `functions.json`
- **Implementation:** `SpecularOpenAI.js`
- **Example:** `example.js`
- **API Docs:** https://docs.specular.network/api
- **OpenAI Docs:** https://platform.openai.com/docs/guides/function-calling

## License

MIT
