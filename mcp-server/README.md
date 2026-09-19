# Specular Agent Server (MCP + REST)

The integration surface third-party agent platforms use to talk to Specular Protocol:
on-chain credit for AI agents (borrow USDC against reputation, or lend into agent pools).

One TypeScript codebase, two transports, one tool set:

| Entry | Transport | Who uses it |
|-------|-----------|-------------|
| `dist/http.js` (`npm start`) | **MCP Streamable HTTP** at `POST /mcp` **+ REST** under `/v1/` **+ OpenAPI 3.1** at `/openapi.json` | Remote hosts: xAI Grok Bot (remote MCP), Meta Muse Connectors (HTTP API), any agent framework |
| `dist/index.js` (`npm run start:stdio`) | MCP over stdio | Claude Desktop / local agent hosts |

Platform guides: [`docs/integrations/REMOTE_MCP.md`](../docs/integrations/REMOTE_MCP.md),
[`GROK_BOT.md`](../docs/integrations/GROK_BOT.md), [`MUSE_CONNECTOR.md`](../docs/integrations/MUSE_CONNECTOR.md).

## Custody model (read this first)

**The hosted server never holds, receives, or uses a private key.**

- **Read tools** run server-side against the public RPC of the network you name.
- **Write tools** (`prepare_*`) return a *prepared, unsigned* transaction:
  `{chainId, to, data, value:"0", gasEstimate, description, humanReadableSummary, warnings[]}`.
  The agent signs it with **its own wallet** and broadcasts it (itself, or via `broadcast_signed_transaction`).
- **Approvals are exact** (never `MaxUint256`) and only ever to the Specular marketplace. When a call needs an
  allowance the response includes the exact `approve` as `prerequisite`.
- `broadcast_signed_transaction` relays raw signed bytes **only** if they decode to an allow-listed call on a Specular
  contract of that network (or an exact USDC `approve` to the marketplace). Everything else is rejected.
- The remote server **refuses to start** if `SPECULAR_PRIVATE_KEY` is in its environment.
- The stdio server can optionally sign locally, but only when `SPECULAR_LOCAL_SIGNER=1` **and** a key are set
  (default off). The key never leaves that local process.

## Networks (explicit, no default)

Every tool and route takes `network`. There is deliberately no default because two of the three move real money.

| `network` | Chain | chainId | Money | Address source |
|-----------|-------|---------|-------|----------------|
| `arc-staging` | Arc testnet, V6-staging stack | 5042002 | test USDC | `src/config/arc-testnet-v6-addresses.json` |
| `base` | Base mainnet, V6 canonical | 8453 | **REAL USDC** | `src/config/base-addresses.json` |
| `arc-mainnet` | Arc mainnet, V6 | 5042 | **REAL USDC** | `src/config/arc-mainnet-addresses.json` |

Addresses are resolved only from those repo files, never from request input. RPC URLs can be overridden with
`SPECULAR_RPC_BASE` / `SPECULAR_RPC_ARC_STAGING` / `SPECULAR_RPC_ARC_MAINNET`. Restrict a deployment with
`SPECULAR_ENABLED_NETWORKS=arc-staging`.

## Tools / routes

| Tool | Kind | REST |
|------|------|------|
| `list_networks` | read | `GET /v1/networks` |
| `get_network_info` | read | `GET /v1/{network}/network` |
| `get_protocol_status` | read | `GET /v1/{network}/status` |
| `check_credit_score` | read | `GET /v1/{network}/agents/{address}/credit` |
| `get_available_liquidity` | read | `GET /v1/{network}/pools?minAvailableUsdc=&limit=` |
| `get_pool_details` | read | `GET /v1/{network}/pools/{agentId}` |
| `get_loan_status` | read | `GET /v1/{network}/loans/{loanId}` |
| `get_agent_loans` | read | `GET /v1/{network}/agents/{address}/loans` |
| `get_lending_positions` | read | `GET /v1/{network}/agents/{address}/positions` |
| `get_transaction` | read | `GET /v1/{network}/tx/{hash}` |
| `prepare_register_agent` | prepare | `POST /v1/{network}/tx/prepare/register_agent` |
| `prepare_create_pool` | prepare | `POST /v1/{network}/tx/prepare/create_pool` |
| `prepare_approve_usdc` | prepare | `POST /v1/{network}/tx/prepare/approve_usdc` |
| `prepare_supply_liquidity` | prepare | `POST /v1/{network}/tx/prepare/supply_liquidity` |
| `prepare_withdraw_liquidity` | prepare | `POST /v1/{network}/tx/prepare/withdraw_liquidity` |
| `prepare_request_loan` | prepare | `POST /v1/{network}/tx/prepare/request_loan` |
| `prepare_repay_loan` | prepare | `POST /v1/{network}/tx/prepare/repay_loan` |
| `prepare_claim_interest` | prepare | `POST /v1/{network}/tx/prepare/claim_interest` |
| `simulate_transaction` | simulate | `POST /v1/{network}/tx/simulate` |
| `broadcast_signed_transaction` | broadcast | `POST /v1/{network}/tx/broadcast` |

All `prepare_*` calls take `from` (the agent's own wallet) and optional `simulate: true`, which runs
`eth_call` + `estimateGas` from that address and translates any revert into plain language
(e.g. `ERC20InsufficientAllowance(...)` becomes "The marketplace is not approved to pull enough USDC ... send the
exact-amount approve in `prerequisite` first").

Every read result includes `rpc: {blockNumber, blockTimestamp, ageSeconds, stale}`; `stale` is set (with a warning)
when the latest block is older than 5 minutes.

### The sign-with-your-own-wallet flow

```
1. GET  /v1/arc-staging/agents/0xYOU/credit              -> registered? score, limit, allowance
2. POST /v1/arc-staging/tx/prepare/request_loan
        {"from":"0xYOU","amount":25,"durationDays":30,"simulate":true}
        -> { to, data, value:"0", gasEstimate, warnings[], prerequisite: {approve tx}|null, simulation:{ok,...} }
3. sign + send `prerequisite` (if present) with your wallet; wait for it to mine
4. sign + send the main tx  (or POST the raw signed hex to /v1/arc-staging/tx/broadcast)
5. GET  /v1/arc-staging/tx/{hash}                          -> decoded LoanRequested event with the loanId
6. before the due date: POST .../tx/prepare/repay_loan {"from":"0xYOU","loanId":N,"simulate":true}
```

Minimal ethers v6 client for step 3/4:

```js
const tx = await fetch(`${API}/v1/arc-staging/tx/prepare/request_loan`, { method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ from: wallet.address, amount: 25, durationDays: 30, simulate: true }) }).then(r => r.json());
if (tx.prerequisite) await (await wallet.sendTransaction({ to: tx.prerequisite.to, data: tx.prerequisite.data, value: 0 })).wait();
const sent = await wallet.sendTransaction({ to: tx.to, data: tx.data, value: 0, gasLimit: BigInt(tx.gasEstimate) });
```

## Run it

```bash
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"   # Node 22
cd mcp-server
npm install
npm run build                                       # tsc + regenerates openapi.json (+ refreshes abi/ from hardhat artifacts if present)
SPECULAR_ENABLED_NETWORKS=arc-staging PORT=3400 npm start
# -> http://localhost:3400/  (MCP: POST /mcp, REST: /v1, OpenAPI: /openapi.json, health: /health)
```

Quick check:

```bash
curl -s localhost:3400/v1/arc-staging/status | jq .
curl -s -X POST localhost:3400/mcp -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | jq '.result.tools[].name'
```

### Environment

See [`.env.example`](.env.example). Highlights: `PORT`, `SPECULAR_ENABLED_NETWORKS`, `SPECULAR_MCP_TOKEN`
(optional bearer; when unset, everything is open and rate-limited per IP), `SPECULAR_RATE_LIMIT_PER_MIN` (120),
`SPECULAR_BROADCAST_LIMIT_PER_MIN` (20), `SPECULAR_ALLOWED_ORIGINS`, `SPECULAR_BODY_LIMIT` (256kb),
`SPECULAR_MAX_AMOUNT_USDC` (100,000 per call; loans capped at 50,000), `LOG_LEVEL`.

Logs are JSON lines on stdout: method, path, status, latency, IP, MCP method/tool name. No headers, bodies, keys or tokens.

### Docker / Railway

Build from the **repo root** (the image copies `src/config/*.json`):

```bash
docker build -f mcp-server/Dockerfile -t specular-agent-api .
docker run -p 3400:3400 -e SPECULAR_ENABLED_NETWORKS=arc-staging specular-agent-api
```

`mcp-server/railway.json` points Railway at that Dockerfile with `/health` as the healthcheck; set the env vars above
as service variables (never `SPECULAR_PRIVATE_KEY`).

### Claude Desktop (stdio)

```json
{
  "mcpServers": {
    "specular": {
      "command": "node",
      "args": ["/path/to/Specular/mcp-server/dist/index.js"],
      "env": { "SPECULAR_ENABLED_NETWORKS": "arc-staging" }
    }
  }
}
```

Without a key, Claude gets the same non-custodial tools (it will hand you unsigned transactions). To let the local
process sign, add `"SPECULAR_LOCAL_SIGNER": "1"` and `"SPECULAR_PRIVATE_KEY": "0x..."`; this exposes one extra tool,
`local_sign_and_broadcast`, which signs a prepared tx and relays it through the same allow-list validator. Use a
dedicated agent wallet and test on `arc-staging` first.

## Tests

```bash
npm test               # build + unit + integration (37 tests)
npm run test:unit      # offline: encode/decode round-trips, broadcast validator, validation
npm run test:integration   # boots the HTTP server against Arc testnet V6-staging; reads + prepare/simulate only, never broadcasts
```

## Layout

```
src/networks.ts   network registry; addresses from ../src/config/*.json; bundled ABIs
src/chain.ts      read-only providers, RPC staleness check
src/validate.ts   address / amount / duration / string validation and caps
src/reads.ts      read tool implementations
src/prepare.ts    unsigned tx builder, exact-approve prerequisites, revert translation, simulate
src/broadcast.ts  signed-tx allow-list validator + relay
src/tools.ts      single tool registry (schemas, handlers, REST bindings)
src/mcp.ts        MCP Server factory shared by stdio + HTTP
src/http.ts       Express app: /mcp (Streamable HTTP), /v1 REST, /openapi.json, auth, rate limit, logging
src/index.ts      stdio entry
src/openapi.ts    OpenAPI 3.1 generator (openapi.json is committed)
abi/              contract ABIs (refresh: node scripts/extract-abis.mjs)
test/             node:test suites
```

## Security notes

- Inherits the 2026-07 SDK audit posture: exact approvals, no `eval`, `ethers.getAddress` on every address, numeric
  clamping, bounded strings, no secrets in logs, RPC staleness warnings.
- `arc-mainnet` and `base` responses carry a `realMoney: true` flag and a warning string on every prepared tx.
- Admin functions (`pause`, `withdrawFees`, `seedPool`, NFT transfers, ...) are never prepared or relayed.

License: MIT
