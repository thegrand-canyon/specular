/**
 * LangChain.js tools for Specular Protocol.
 *
 * Drop into a LangChain agent: an agent with a private key can borrow USDC
 * against its on-chain reputation, repay, claim interest, etc. via natural
 * language.
 *
 * Usage:
 *   const { ChatAnthropic } = require('@langchain/anthropic');
 *   const { AgentExecutor, createToolCallingAgent } = require('langchain/agents');
 *   const { specularTools } = require('@specular/sdk/langchain');
 *
 *   const wallet = new ethers.Wallet(process.env.AGENT_KEY, provider);
 *   const tools = specularTools(wallet, 'base');
 *   const agent = await createToolCallingAgent({ llm: new ChatAnthropic(), tools, prompt });
 *   const executor = new AgentExecutor({ agent, tools });
 *   await executor.invoke({ input: "Borrow 100 USDC for 30 days to pay for compute" });
 */

const { SpecularQuickstart } = require('../SpecularQuickstart');

// LangChain tool factory. Returns an array of structured tools.
// Use with @langchain/core/tools DynamicStructuredTool or compatible.
function specularTools(wallet, network = 'base') {
    const sdk = new SpecularQuickstart(wallet, network);

    return [
        {
            name: 'specular_credit_info',
            description: 'Get the current credit info for this agent: reputation score, available credit limit (USDC), collateral percentage required, and interest rate APR. Use this BEFORE borrowing to know your limits.',
            schema: { type: 'object', properties: {}, required: [] },
            async invoke(_args) {
                const info = await sdk.creditInfo();
                return JSON.stringify(info);
            }
        },
        {
            name: 'specular_onboard',
            description: 'Register this agent on Specular Protocol and create their lending pool. Idempotent — safe to call repeatedly. Returns agentId and any transaction hashes for the steps performed. Most users do not need to call this directly; specular_borrow does it automatically.',
            schema: {
                type: 'object',
                properties: {
                    ipfsHash: { type: 'string', description: 'Optional metadata URI for the agent (default ipfs://agent)' }
                },
                required: []
            },
            async invoke(args) {
                const out = await sdk.onboard(args.ipfsHash);
                return JSON.stringify(out);
            }
        },
        {
            name: 'specular_borrow',
            description: 'Borrow USDC against the agent\'s on-chain reputation. Automatically handles onboarding if not yet registered. Returns loanId and tx hash. Loan must be repaid within durationDays.',
            schema: {
                type: 'object',
                properties: {
                    amount: { type: 'number', description: 'USDC amount to borrow (e.g. 100 = 100 USDC)' },
                    durationDays: { type: 'number', description: 'Loan duration in days (7-365)' }
                },
                required: ['amount', 'durationDays']
            },
            async invoke(args) {
                if (args.durationDays < 7 || args.durationDays > 365) {
                    return JSON.stringify({ error: 'durationDays must be 7-365' });
                }
                const out = await sdk.borrow(args.amount, args.durationDays);
                return JSON.stringify({
                    loanId: out.loanId,
                    txHash: out.tx,
                    explorerUrl: sdk.explorerUrl(out.tx)
                });
            }
        },
        {
            name: 'specular_repay',
            description: 'Repay an outstanding loan. Pays principal + interest from the agent\'s USDC balance. Returns tx hash.',
            schema: {
                type: 'object',
                properties: {
                    loanId: { type: 'number', description: 'ID of the loan to repay (from specular_borrow or specular_loans)' }
                },
                required: ['loanId']
            },
            async invoke(args) {
                const hash = await sdk.repay(args.loanId);
                return JSON.stringify({ txHash: hash, explorerUrl: sdk.explorerUrl(hash) });
            }
        },
        {
            name: 'specular_loans',
            description: 'List the agent\'s active and historical loans. Returns an array with loanId, amount, interest rate, state (REQUESTED/ACTIVE/REPAID/DEFAULTED), and endTime.',
            schema: { type: 'object', properties: {}, required: [] },
            async invoke(_args) {
                const loans = await sdk.loans();
                return JSON.stringify(loans);
            }
        },
        {
            name: 'specular_supply',
            description: 'Supply USDC liquidity to an agent\'s pool. The lender earns interest when the agent repays loans. Returns tx hash.',
            schema: {
                type: 'object',
                properties: {
                    agentId: { type: 'number', description: 'Agent ID to supply USDC to' },
                    amount: { type: 'number', description: 'USDC amount to supply' }
                },
                required: ['agentId', 'amount']
            },
            async invoke(args) {
                const hash = await sdk.supply(args.agentId, args.amount);
                return JSON.stringify({ txHash: hash, explorerUrl: sdk.explorerUrl(hash) });
            }
        },
        {
            name: 'specular_withdraw',
            description: 'Withdraw lender position from an agent\'s pool. Limited by pool\'s availableLiquidity. Returns tx hash.',
            schema: {
                type: 'object',
                properties: {
                    agentId: { type: 'number' },
                    amount: { type: 'number' }
                },
                required: ['agentId', 'amount']
            },
            async invoke(args) {
                const hash = await sdk.withdraw(args.agentId, args.amount);
                return JSON.stringify({ txHash: hash, explorerUrl: sdk.explorerUrl(hash) });
            }
        },
        {
            name: 'specular_claim_interest',
            description: 'Claim accrued interest as a lender from an agent\'s pool. Returns tx hash.',
            schema: {
                type: 'object',
                properties: {
                    agentId: { type: 'number' }
                },
                required: ['agentId']
            },
            async invoke(args) {
                const hash = await sdk.claim(args.agentId);
                return JSON.stringify({ txHash: hash, explorerUrl: sdk.explorerUrl(hash) });
            }
        }
    ];
}

module.exports = { specularTools };
