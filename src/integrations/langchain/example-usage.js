/**
 * Example: Using Specular Credit in a LangChain Agent
 *
 * This example shows how to add credit access to any LangChain agent.
 */

require('dotenv').config();
const { ethers } = require('ethers');
const { SpecularCreditTool } = require('./SpecularCreditTool');

async function example() {
    console.log('═══════════════════════════════════════');
    console.log('  LangChain + Specular Credit Example');
    console.log('═══════════════════════════════════════\n');

    // 1. Setup your wallet
    const provider = new ethers.JsonRpcProvider(
        process.env.ARC_TESTNET_RPC_URL || 'https://arc-testnet.drpc.org'
    );
    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

    console.log('Agent wallet:', wallet.address, '\n');

    // 2. Initialize Specular Credit Tool
    const creditTool = new SpecularCreditTool({
        wallet: wallet,
        network: 'arc' // or 'base' for mainnet
    });

    console.log('✅ Credit tool initialized\n');

    // 3. Check credit eligibility
    console.log('Checking credit eligibility...');
    const eligibility = await creditTool._call(JSON.stringify({
        action: 'check_eligibility'
    }));
    console.log(eligibility, '\n');

    // 4. Check current reputation
    console.log('Checking reputation...');
    const reputation = await creditTool._call(JSON.stringify({
        action: 'check_reputation'
    }));
    console.log(reputation, '\n');

    // 5. Request a small loan
    console.log('Requesting 10 USDC loan for 7 days...');
    const loanResult = await creditTool._call(JSON.stringify({
        action: 'request_loan',
        amount: 10,
        durationDays: 7
    }));
    console.log(loanResult, '\n');

    // Extract loan ID
    const loanData = JSON.parse(loanResult);
    if (loanData.success) {
        const loanId = loanData.loanId;

        // 6. Check loan status
        console.log('Checking loan status...');
        const status = await creditTool._call(JSON.stringify({
            action: 'loan_status',
            loanId: loanId
        }));
        console.log(status, '\n');

        // 7. Repay the loan (uncomment after some time)
        /*
        console.log('Repaying loan...');
        const repayResult = await creditTool._call(JSON.stringify({
            action: 'repay_loan',
            loanId: loanId
        }));
        console.log(repayResult, '\n');
        */
    }

    console.log('═══════════════════════════════════════');
    console.log('  Example Complete!');
    console.log('═══════════════════════════════════════\n');
}

// Advanced Example: Using with actual LangChain agent
async function langchainAgentExample() {
    /*
    This is pseudocode showing how to use with actual LangChain.
    Install: npm install langchain @langchain/openai

    import { ChatOpenAI } from "@langchain/openai";
    import { AgentExecutor, createOpenAIFunctionsAgent } from "langchain/agents";
    import { SpecularCreditTool } from "@specular/langchain";

    const llm = new ChatOpenAI({
        modelName: "gpt-4",
        temperature: 0
    });

    const creditTool = new SpecularCreditTool({
        wallet: myWallet,
        network: 'base'
    });

    const tools = [creditTool];

    const agent = await createOpenAIFunctionsAgent({
        llm,
        tools,
        prompt: "You are a financial AI agent with access to on-chain credit."
    });

    const agentExecutor = new AgentExecutor({
        agent,
        tools,
    });

    const result = await agentExecutor.invoke({
        input: "Check my credit eligibility and request a $100 loan for 30 days"
    });

    console.log(result);
    */
}

if (require.main === module) {
    example().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { example, langchainAgentExample };
