/**
 * OpenAI Functions / Assistants API tool definitions for Specular Protocol.
 *
 * Drop into an OpenAI Assistant or chat-completions request as `tools`.
 * Each tool, when the model picks it, returns a JSON args object — pass to
 * the matching SDK method.
 *
 * Usage with OpenAI Node SDK:
 *   const { specularFunctions, executeSpecularFunction } = require('@specular/sdk/openai');
 *   const sdk = new SpecularQuickstart(wallet, 'base');
 *   const completion = await openai.chat.completions.create({
 *       model: 'gpt-4o',
 *       messages: [{ role: 'user', content: 'Borrow 50 USDC for 14 days' }],
 *       tools: specularFunctions(),
 *   });
 *   for (const call of completion.choices[0].message.tool_calls || []) {
 *       const result = await executeSpecularFunction(sdk, call.function.name, JSON.parse(call.function.arguments));
 *       // Feed `result` back to the model in the next turn
 *   }
 */

function specularFunctions() {
    return [
        {
            type: 'function',
            function: {
                name: 'specular_credit_info',
                description: "Get the agent's Specular credit info: reputation score, credit limit (USDC), collateral percentage required, and interest rate APR. Call this BEFORE borrowing to know your limits.",
                parameters: { type: 'object', properties: {}, required: [] }
            }
        },
        {
            type: 'function',
            function: {
                name: 'specular_onboard',
                description: 'Register the agent on Specular Protocol + create their lending pool. Idempotent. Usually unnecessary — specular_borrow handles onboarding automatically.',
                parameters: {
                    type: 'object',
                    properties: {
                        ipfs_hash: { type: 'string', description: 'Optional metadata URI (default ipfs://agent)' }
                    },
                    required: []
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'specular_borrow',
                description: "Borrow USDC against the agent's on-chain reputation. Auto-onboards if needed. The agent should later call specular_repay to settle the loan.",
                parameters: {
                    type: 'object',
                    properties: {
                        amount: { type: 'number', description: 'USDC amount to borrow (e.g. 100 = 100 USDC)' },
                        duration_days: { type: 'number', description: 'Loan duration in days (7-365)' }
                    },
                    required: ['amount', 'duration_days']
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'specular_repay',
                description: "Repay an active Specular loan. Pays principal + interest from the agent's USDC balance.",
                parameters: {
                    type: 'object',
                    properties: {
                        loan_id: { type: 'number', description: 'Loan ID returned by specular_borrow' }
                    },
                    required: ['loan_id']
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'specular_loans',
                description: "List the agent's active and historical loans (id, amount, rate, state, endTime).",
                parameters: { type: 'object', properties: {}, required: [] }
            }
        },
        {
            type: 'function',
            function: {
                name: 'specular_claim_initial_credit',
                description: 'If an initial-credit faucet is configured for the agent network, claim the one-time grant to bootstrap the first loan cycle.',
                parameters: { type: 'object', properties: {}, required: [] }
            }
        }
    ];
}

/**
 * Execute a function call against the SDK. Returns a string suitable for
 * tool_result in the next message.
 */
async function executeSpecularFunction(sdk, name, args) {
    args = args || {};
    try {
        switch (name) {
            case 'specular_credit_info':
                return JSON.stringify(await sdk.creditInfo());
            case 'specular_onboard':
                return JSON.stringify(await sdk.onboard(args.ipfs_hash));
            case 'specular_borrow':
                if (!Number.isInteger(args.duration_days) || args.duration_days < 7 || args.duration_days > 365)
                    return JSON.stringify({ error: 'duration_days must be an integer 7-365' });
                return JSON.stringify(await sdk.borrow(args.amount, args.duration_days));
            case 'specular_repay':
                return JSON.stringify({ txHash: await sdk.repay(args.loan_id) });
            case 'specular_loans':
                return JSON.stringify(await sdk.loans());
            case 'specular_claim_initial_credit':
                // Direct contract call; SDK doesn't currently wrap this
                throw new Error('Not implemented in JS SDK yet; use direct AgentCreditFaucet.claim()');
            default:
                return JSON.stringify({ error: `Unknown function: ${name}` });
        }
    } catch (e) {
        return JSON.stringify({ error: e.shortMessage || e.message });
    }
}

module.exports = { specularFunctions, executeSpecularFunction };
