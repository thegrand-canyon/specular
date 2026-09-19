/**
 * Example: Using the Natural Language Interface
 *
 * This shows how to interact with Specular using plain English
 */

const { ethers } = require('ethers');
const { NaturalLanguageInterface } = require('./NaturalLanguageInterface');

async function main() {
    // Setup wallet
    const provider = new ethers.JsonRpcProvider(
        process.env.RPC_URL || 'https://mainnet.base.org'
    );
    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

    // Create natural language interface
    const nli = new NaturalLanguageInterface({
        specularApiUrl: 'http://localhost:3001',
        wallet
    });

    console.log('🤖 Specular Natural Language Interface\n');
    console.log('Talk to your credit system in plain English!\n');
    console.log('=' .repeat(60) + '\n');

    // Example conversation
    const queries = [
        "What's my credit score?",
        "Can I borrow 500 USDC?",
        "Show available liquidity",
        "Request a 100 USDC loan for 30 days",
        "When are my loans due?",
        "Show protocol stats"
    ];

    for (const query of queries) {
        console.log(`👤 User: ${query}\n`);

        const result = await nli.process(query);

        if (result.success) {
            console.log(`🤖 Specular: ${result.response}\n`);
        } else {
            console.log(`❌ Error: ${result.response}\n`);
        }

        console.log('-'.repeat(60) + '\n');

        // Wait a bit between queries
        await new Promise(resolve => setTimeout(resolve, 1000));
    }

    console.log('✅ Demo complete!');
}

// Interactive mode
async function interactive() {
    const readline = require('readline');

    const provider = new ethers.JsonRpcProvider(
        process.env.RPC_URL || 'https://mainnet.base.org'
    );
    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

    const nli = new NaturalLanguageInterface({
        specularApiUrl: 'http://localhost:3001',
        wallet
    });

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    console.log('🤖 Specular Natural Language Interface');
    console.log('Type your questions or commands. Type "exit" to quit.\n');

    const askQuestion = () => {
        rl.question('You: ', async (input) => {
            input = input.trim();

            if (input.toLowerCase() === 'exit') {
                console.log('Goodbye!');
                rl.close();
                return;
            }

            if (!input) {
                askQuestion();
                return;
            }

            const result = await nli.process(input);
            console.log(`\nSpecular: ${result.response}\n`);

            askQuestion();
        });
    };

    askQuestion();
}

// Run based on mode
const mode = process.argv[2] || 'demo';

if (mode === 'interactive' || mode === 'i') {
    interactive().catch((e) => { console.error(e); process.exit(1); });
} else {
    main().catch((e) => { console.error(e); process.exit(1); });
}
