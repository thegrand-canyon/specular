/**
 * Example: Using Specular with OpenAI Function Calling
 *
 * This example shows how to give GPT-4 direct access to Specular Protocol
 */

const { Configuration, OpenAIApi } = require('openai');
const { ethers } = require('ethers');
const { SpecularOpenAI } = require('./SpecularOpenAI');

async function main() {
    // Initialize OpenAI
    const configuration = new Configuration({
        apiKey: process.env.OPENAI_API_KEY,
    });
    const openai = new OpenAIApi(configuration);

    // Initialize Specular with wallet
    const provider = new ethers.JsonRpcProvider(
        process.env.RPC_URL || 'https://mainnet.base.org'
    );
    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

    const specular = new SpecularOpenAI({
        apiUrl: 'http://localhost:3001',
        wallet,
        network: 'base'
    });

    // Conversation history
    const messages = [
        {
            role: 'system',
            content: `You are an AI assistant with access to Specular Protocol, an on-chain credit system for AI agents. You can:
- Check credit scores and reputation
- Request USDC loans based on reputation
- Repay loans
- Monitor loan status
- View available liquidity

Use these tools to help users manage their on-chain credit.`
        },
        {
            role: 'user',
            content: 'What\'s my current credit score on Specular?'
        }
    ];

    console.log('🤖 Starting conversation with GPT-4 + Specular\n');

    // Main conversation loop
    let continueConversation = true;
    while (continueConversation) {
        // Call GPT-4 with function calling
        const response = await openai.createChatCompletion({
            model: 'gpt-4',
            messages,
            functions: SpecularOpenAI.getFunctions(),
            function_call: 'auto'
        });

        const message = response.data.choices[0].message;
        messages.push(message);

        // If GPT-4 wants to call a function
        if (message.function_call) {
            const functionName = message.function_call.name;
            const functionArgs = JSON.parse(message.function_call.arguments);

            console.log(`📞 Function Call: ${functionName}`);
            console.log(`📝 Arguments:`, functionArgs);
            console.log('');

            try {
                // Execute the Specular function
                const result = await specular.executeFunction(functionName, functionArgs);

                console.log(`✅ Result:`, result);
                console.log('');

                // Add function result to conversation
                messages.push({
                    role: 'function',
                    name: functionName,
                    content: JSON.stringify(result)
                });

            } catch (error) {
                console.error(`❌ Error:`, error.message);
                messages.push({
                    role: 'function',
                    name: functionName,
                    content: JSON.stringify({ error: error.message })
                });
            }
        } else {
            // GPT-4 responded with text
            console.log(`🤖 GPT-4: ${message.content}\n`);
            continueConversation = false; // End of this turn
        }
    }
}

// Run example
if (require.main === module) {
    main().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { main };
