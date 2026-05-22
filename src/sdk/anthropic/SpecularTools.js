/**
 * Anthropic Tool Use API tool definitions for Specular Protocol.
 *
 * For direct Claude integration via the Messages API (no LangChain dependency).
 *
 * Usage:
 *   const Anthropic = require('@anthropic-ai/sdk');
 *   const { specularAnthropicTools, executeSpecularAnthropicTool } = require('@specular/sdk/anthropic');
 *   const client = new Anthropic();
 *   const sdk = new SpecularQuickstart(wallet, 'base');
 *   const resp = await client.messages.create({
 *       model: 'claude-3-5-sonnet-20241022', max_tokens: 1024,
 *       tools: specularAnthropicTools(),
 *       messages: [{ role: 'user', content: 'Check credit, borrow 50 USDC for 14 days.' }],
 *   });
 *   // For each tool_use block: executeSpecularAnthropicTool(sdk, block.name, block.input)
 */

function specularAnthropicTools() {
    return [
        { name: 'specular_credit_info', description: "Get the agent's Specular credit info: reputation score, credit limit USDC, collateral pct, interest rate APR. Call BEFORE borrowing.", input_schema: { type: 'object', properties: {}, required: [] } },
        { name: 'specular_onboard', description: 'Register the agent on Specular + create lending pool. Idempotent. Usually unnecessary — specular_borrow handles it.', input_schema: { type: 'object', properties: { ipfs_hash: { type: 'string' } }, required: [] } },
        { name: 'specular_borrow', description: "Borrow USDC against the agent's reputation. Auto-onboards.", input_schema: { type: 'object', properties: { amount: { type: 'number', description: 'USDC amount' }, duration_days: { type: 'integer', description: '7-365' } }, required: ['amount', 'duration_days'] } },
        { name: 'specular_repay', description: "Repay an active loan. Pulls principal+interest from agent's USDC.", input_schema: { type: 'object', properties: { loan_id: { type: 'integer' } }, required: ['loan_id'] } },
        { name: 'specular_loans', description: "List agent's loans (active + historical).", input_schema: { type: 'object', properties: {}, required: [] } },
        { name: 'specular_claim_initial_credit', description: 'Claim one-time initial-credit grant from Specular faucet (if active).', input_schema: { type: 'object', properties: {}, required: [] } }
    ];
}

async function executeSpecularAnthropicTool(sdk, name, args) {
    args = args || {};
    try {
        switch (name) {
            case 'specular_credit_info': return JSON.stringify(await sdk.creditInfo());
            case 'specular_onboard':     return JSON.stringify(await sdk.onboard(args.ipfs_hash));
            case 'specular_borrow':
                if (args.duration_days < 7 || args.duration_days > 365) return JSON.stringify({ error: 'duration_days must be 7-365' });
                return JSON.stringify(await sdk.borrow(args.amount, args.duration_days));
            case 'specular_repay':       return JSON.stringify({ txHash: await sdk.repay(args.loan_id) });
            case 'specular_loans':       return JSON.stringify(await sdk.loans());
            case 'specular_claim_initial_credit': throw new Error('Use AgentCreditFaucet.claim() directly');
            default: return JSON.stringify({ error: `Unknown tool: ${name}` });
        }
    } catch (e) { return JSON.stringify({ error: e.shortMessage || e.message }); }
}

module.exports = { specularAnthropicTools, executeSpecularAnthropicTool };
