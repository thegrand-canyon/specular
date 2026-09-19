# Specular Natural Language Interface

Interact with Specular Protocol using plain English instead of API calls.

## Overview

The Natural Language Interface allows agents and users to interact with Specular's credit system conversationally. No need to learn API endpoints - just ask questions and give commands naturally.

## Quick Start

```javascript
const { NaturalLanguageInterface } = require('./NaturalLanguageInterface');
const { ethers } = require('ethers');

const provider = new ethers.JsonRpcProvider('https://mainnet.base.org');
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

const nli = new NaturalLanguageInterface({
    specularApiUrl: 'http://localhost:3001',
    wallet
});

// Ask questions naturally
const result = await nli.process("What's my credit score?");
console.log(result.response);
// "Your credit score is 850/1000 (Excellent tier). Excellent! You have top-tier credit."
```

## Supported Queries

### Credit Queries

```javascript
// Check credit score
await nli.process("What's my credit score?");
await nli.process("Show my credit rating");
await nli.process("Check my credit");

// Check credit limit
await nli.process("What's my credit limit?");
await nli.process("How much can I borrow?");
await nli.process("Show my limit");

// Check interest rate
await nli.process("What's my interest rate?");
await nli.process("Show my rate");

// Check borrowing eligibility
await nli.process("Can I borrow 500 USDC?");
await nli.process("Am I able to get a loan for 1000 USDC?");
```

### Loan Operations

```javascript
// Request a loan
await nli.process("Request a 100 USDC loan for 30 days");
await nli.process("Borrow 500 USDC for 60 days");
await nli.process("I need a loan of 250 USDC");

// Repay a loan
await nli.process("Repay loan #123");
await nli.process("Pay back loan #456");
await nli.process("Pay off my loan");

// Check loan status
await nli.process("Check loan #123 status");
await nli.process("Show loan #456 details");
await nli.process("What's my loan status?");

// Check due dates
await nli.process("When is my loan due?");
await nli.process("When are my loans due?");
```

### Liquidity & Protocol Stats

```javascript
// Check available liquidity
await nli.process("Show available liquidity");
await nli.process("How much liquidity is there?");
await nli.process("Check available capital");

// List lending pools
await nli.process("Show all pools");
await nli.process("List lending pools");

// Protocol statistics
await nli.process("Show protocol stats");
await nli.process("What are the system statistics?");
```

### Help

```javascript
await nli.process("help");
await nli.process("What can you do?");
await nli.process("How do I use this?");
```

## Response Format

All responses include:

```javascript
{
    success: true/false,      // Whether the operation succeeded
    response: "...",           // Natural language response
    data: { ... }             // Optional structured data
}
```

### Success Response Example

```javascript
{
    success: true,
    data: { score: 850, tier: 'Excellent' },
    response: "Your credit score is 850/1000 (Excellent tier). Excellent! You have top-tier credit."
}
```

### Error Response Example

```javascript
{
    success: false,
    response: "You need to register first to check your credit limit.",
    error: "Not registered"
}
```

## Examples

### Example 1: Check Credit Score

```javascript
const result = await nli.process("What's my credit score?");

// Response:
// {
//     success: true,
//     data: { score: 850, tier: 'Excellent' },
//     response: "Your credit score is 850/1000 (Excellent tier). Excellent! You have top-tier credit."
// }
```

### Example 2: Request a Loan

```javascript
const result = await nli.process("Request a 500 USDC loan for 30 days");

// Response:
// {
//     success: true,
//     data: { amount: 500, duration: 30, interest: 2.26, total: 502.26, receipt: {...} },
//     response: "✅ Loan approved!\n\nAmount: 500 USDC\nDuration: 30 days\nInterest: 2.26 USDC\n..."
// }
```

### Example 3: Check Eligibility

```javascript
const result = await nli.process("Can I borrow 1000 USDC?");

// Response if eligible:
// {
//     success: true,
//     data: { amount: 1000, duration: 30, interest: 4.52, total: 1004.52, rate: 5.5 },
//     response: "Yes! You can borrow 1000 USDC for 30 days.\nInterest rate: 5.5% APR\n..."
// }

// Response if not eligible:
// {
//     success: false,
//     data: { requested: 1000, available: 500 },
//     response: "Unfortunately, no. Your available credit is 500 USDC, but you're asking for 1000 USDC..."
// }
```

## Integration Patterns

### Pattern 1: Chatbot

```javascript
// Build a conversational agent
class SpecularChatbot {
    constructor(wallet) {
        this.nli = new NaturalLanguageInterface({
            specularApiUrl: 'http://localhost:3001',
            wallet
        });
    }

    async chat(userMessage) {
        const result = await this.nli.process(userMessage);
        return result.response;
    }
}

const bot = new SpecularChatbot(wallet);
const response = await bot.chat("What's my credit score?");
console.log(response);
```

### Pattern 2: CLI Tool

```javascript
// Command-line interface
const readline = require('readline');
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

const nli = new NaturalLanguageInterface({ specularApiUrl, wallet });

rl.on('line', async (input) => {
    const result = await nli.process(input);
    console.log(result.response);
});
```

### Pattern 3: Discord/Telegram Bot

```javascript
// Discord bot integration
client.on('messageCreate', async (message) => {
    if (message.author.bot) return;

    const result = await nli.process(message.content);
    await message.reply(result.response);
});
```

### Pattern 4: Voice Assistant

```javascript
// Integrate with speech recognition
const recognition = new SpeechRecognition();

recognition.onresult = async (event) => {
    const transcript = event.results[0][0].transcript;
    const result = await nli.process(transcript);

    // Speak response
    const utterance = new SpeechSynthesisUtterance(result.response);
    speechSynthesis.speak(utterance);
};
```

## Running the Example

### Demo Mode (Pre-scripted Queries)

```bash
# Set environment variables
export PRIVATE_KEY=your_private_key
export RPC_URL=https://mainnet.base.org

# Run demo
node example.js
```

Output:
```
🤖 Specular Natural Language Interface

👤 User: What's my credit score?

🤖 Specular: Your credit score is 850/1000 (Excellent tier). Excellent! You have top-tier credit.

------------------------------------------------------------

👤 User: Can I borrow 500 USDC?

🤖 Specular: Yes! You can borrow 500 USDC for 30 days.
Interest rate: 5.5% APR
Interest cost: 2.26 USDC
Total to repay: 502.26 USDC

Say "Request a 500 USDC loan for 30 days" to proceed.

------------------------------------------------------------
```

### Interactive Mode

```bash
# Run interactive mode
node example.js interactive

# Or shorthand:
node example.js i
```

Output:
```
🤖 Specular Natural Language Interface
Type your questions or commands. Type "exit" to quit.

You: What's my credit score?

Specular: Your credit score is 850/1000 (Excellent tier). Excellent! You have top-tier credit.

You: Request a 100 USDC loan for 30 days

Specular: ✅ Loan approved!

Amount: 100 USDC
Duration: 30 days
Interest: 0.45 USDC
Total to repay: 100.45 USDC

The USDC has been sent to your wallet. Please repay by the due date to maintain your reputation.

You: exit
Goodbye!
```

## Intent Detection

The interface uses pattern matching to understand natural language:

```javascript
// Example patterns
patterns = {
    creditScore: /(?:what'?s|show|check) (?:my )?credit (?:score|rating)/i,
    requestLoan: /(?:request|get|borrow) (?:a )?loan/i,
    // ... more patterns
}
```

### Adding Custom Patterns

You can extend the interface with custom patterns:

```javascript
class CustomNLI extends NaturalLanguageInterface {
    constructor(config) {
        super(config);

        // Add custom pattern
        this.patterns.customQuery = /my custom pattern/i;
    }

    async process(input) {
        const intent = this.detectIntent(input);

        if (intent === 'customQuery') {
            return await this.handleCustomQuery(input);
        }

        return super.process(input);
    }

    async handleCustomQuery(input) {
        // Custom logic
        return {
            success: true,
            response: "Custom response"
        };
    }
}
```

## Advanced Features

### Multi-Turn Conversations

Track conversation context:

```javascript
class ConversationalNLI extends NaturalLanguageInterface {
    constructor(config) {
        super(config);
        this.context = {};
    }

    async process(input) {
        // Check for follow-up questions
        if (input.toLowerCase() === 'yes' && this.context.pendingAction) {
            return await this.executePendingAction();
        }

        return super.process(input);
    }

    async handleRequestLoan(input) {
        const result = await super.handleRequestLoan(input);

        // Save context for follow-up
        if (result.success) {
            this.context.lastLoan = result.data;
        }

        return result;
    }
}
```

### LLM Integration

Enhance with GPT-4 or Claude for better understanding:

```javascript
const OpenAI = require('openai');
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

class LLMEnhancedNLI extends NaturalLanguageInterface {
    async process(input) {
        // First try pattern matching
        const intent = this.detectIntent(input);

        if (intent !== 'unknown') {
            return super.process(input);
        }

        // Fall back to LLM for complex queries
        const completion = await openai.chat.completions.create({
            model: "gpt-4",
            messages: [
                {
                    role: "system",
                    content: "You are a Specular credit system interface. " +
                            "Parse user queries about credit, loans, and protocol stats. " +
                            "Extract intent and parameters."
                },
                { role: "user", content: input }
            ],
            functions: [
                {
                    name: "specular_query",
                    description: "Process Specular credit query",
                    parameters: {
                        type: "object",
                        properties: {
                            intent: { type: "string" },
                            amount: { type: "number" },
                            duration: { type: "number" },
                            loanId: { type: "number" }
                        }
                    }
                }
            ]
        });

        // Process LLM-extracted parameters
        const functionCall = completion.choices[0].message.function_call;
        if (functionCall) {
            const params = JSON.parse(functionCall.arguments);
            return await this.processWithParams(params);
        }

        return super.process(input);
    }
}
```

## Localization

Add multi-language support:

```javascript
class MultilingualNLI extends NaturalLanguageInterface {
    constructor(config) {
        super(config);

        this.translations = {
            en: {
                creditScore: "Your credit score is {score}/1000",
                // ... more translations
            },
            es: {
                creditScore: "Tu puntuación de crédito es {score}/1000",
                // ... more translations
            }
        };

        this.language = config.language || 'en';
    }

    translate(key, params) {
        let text = this.translations[this.language][key];
        for (const [param, value] of Object.entries(params)) {
            text = text.replace(`{${param}}`, value);
        }
        return text;
    }
}
```

## Error Handling

The interface provides helpful error messages:

```javascript
// Not registered
"You need to register first to check your credit limit."

// Insufficient credit
"Unfortunately, no. Your available credit is 500 USDC, but you're asking for 1000 USDC."

// Max loans reached
"You've reached the maximum number of active loans (3). Please repay an existing loan first."

// Missing parameters
"Please specify an amount. For example: 'Request a 100 USDC loan for 30 days'"
```

## Testing

```javascript
const assert = require('assert');

// Test credit score query
const result = await nli.process("What's my credit score?");
assert(result.success);
assert(result.data.score >= 0 && result.data.score <= 1000);

// Test loan request
const loanResult = await nli.process("Request a 100 USDC loan for 30 days");
assert(loanResult.success);
assert(loanResult.data.amount === 100);
assert(loanResult.data.duration === 30);
```

## Performance

- **Pattern Matching:** <1ms per query
- **With API Calls:** 100-500ms (depends on network)
- **With LLM Enhancement:** 1-3 seconds (OpenAI API)

## Security

- Never log user inputs containing private keys
- Validate all extracted parameters
- Rate limit requests to prevent abuse
- Sanitize responses before displaying

## Support

- **Specular Docs:** https://docs.specular.network
- **Specular API:** http://localhost:3001
- **Discord:** https://discord.gg/specular
- **Twitter:** https://twitter.com/SpecularFi

## License

MIT
