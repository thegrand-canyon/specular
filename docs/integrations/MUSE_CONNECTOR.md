# Specular for Meta Muse Connectors (HTTP API)

Muse Connectors are built by the developer providing an **HTTP API** plus a machine-readable description of it.
Specular's hosted server exposes exactly that: a REST surface under `/v1/` with an **OpenAPI 3.1** document at
`/openapi.json`, backed by the same handlers as the MCP tools. Point the connector at the OpenAPI file and every
capability below becomes an action.

General custody/network notes: [REMOTE_MCP.md](REMOTE_MCP.md). Grok Bot (MCP instead of REST): [GROK_BOT.md](GROK_BOT.md).

## Connector settings

| Field | Value |
|-------|-------|
| Base URL | `https://<specular-deployment>` |
| API description | `https://<specular-deployment>/openapi.json` (OpenAPI 3.1, generated from the tool registry; also committed as `mcp-server/openapi.json`) |
| Auth | Bearer token if the deployment sets `SPECULAR_MCP_TOKEN` (`Authorization: Bearer <token>`); otherwise no auth (per-IP rate limits apply) |
| Content type | `application/json` in and out |
| Health | `GET /health` |

`operationId`s in the OpenAPI file equal the MCP tool names (`check_credit_score`, `prepare_request_loan`, ...), so
one set of action descriptions works for both surfaces.

## Endpoints

Read (GET, executed server-side against public RPC):

```
GET /v1/networks
GET /v1/{network}/network
GET /v1/{network}/status
GET /v1/{network}/agents/{address}/credit
GET /v1/{network}/agents/{address}/loans?limit=
GET /v1/{network}/agents/{address}/positions
GET /v1/{network}/pools?minAvailableUsdc=&limit=
GET /v1/{network}/pools/{agentId}
GET /v1/{network}/loans/{loanId}
GET /v1/{network}/tx/{hash}
```

Write-preparation (POST, returns an unsigned transaction, no side effects):

```
POST /v1/{network}/tx/prepare/register_agent     {from, agentURI?, metadata?, simulate?}
POST /v1/{network}/tx/prepare/create_pool        {from, simulate?}
POST /v1/{network}/tx/prepare/approve_usdc       {from, amount, simulate?}
POST /v1/{network}/tx/prepare/supply_liquidity   {from, agentId, amount, simulate?}
POST /v1/{network}/tx/prepare/withdraw_liquidity {from, agentId, amount, simulate?}
POST /v1/{network}/tx/prepare/request_loan       {from, amount, durationDays, simulate?}
POST /v1/{network}/tx/prepare/repay_loan         {from, loanId, simulate?}
POST /v1/{network}/tx/prepare/claim_interest     {from, agentId, simulate?}
POST /v1/{network}/tx/simulate                   {from, to, data}
```

Relay (POST, side effect: submits bytes the caller already signed):

```
POST /v1/{network}/tx/broadcast                  {signedTransaction: "0x..."}
```

`{network}` is one of `arc-staging` (testnet, test USDC), `base` (**real USDC**), `arc-mainnet` (**real USDC**).
It is a required path segment; there is no default. Amounts are USDC display units (`12.5`), max 6 decimals.

## Custody: the connector never gets a key

Specular's API is **non-custodial**. It builds transactions, it does not sign them, and it refuses to start if a
private key is present in its environment. A Muse Connector therefore has two integration shapes:

**A. Read + prepare (no wallet on the connector side).**
The assistant reads credit, pools and loans, and prepares transactions. A `prepare_*` response contains
`humanReadableSummary`, `warnings[]` and the raw `{chainId,to,data,value:"0",gasEstimate}`; the user signs it in
their own wallet app. This needs no secrets anywhere in the connector.

**B. Read + prepare + sign with the developer's own wallet.**
The developer's backend holds the agent wallet (never Specular). Flow:

```
1. POST /v1/arc-staging/tx/prepare/request_loan {"from":"0xAGENT","amount":25,"durationDays":30,"simulate":true}
2. if response.prerequisite -> sign+send it (exact USDC approve), wait for confirmation
3. sign the main tx; either send via your own RPC, or
   POST /v1/arc-staging/tx/broadcast {"signedTransaction":"0x02f8..."}   (relayed only if it targets Specular)
4. GET /v1/arc-staging/tx/{hash} -> "confirmed" + decoded LoanRequested {loanId}
```

Approvals are always exact amounts to the Specular marketplace; the relay rejects unlimited approvals, approvals to
any other spender, native-value transfers, admin functions and anything not addressed to a Specular contract on that
network.

## Example: sizing and preparing a loan

```bash
H='content-type: application/json'
API=https://<host>

curl -s $API/v1/arc-staging/agents/0xAGENT/credit | jq '{registered, reputation, credit, wallet}'

curl -s -X POST $API/v1/arc-staging/tx/prepare/request_loan -H "$H" \
  -d '{"from":"0xAGENT","amount":25,"durationDays":30,"simulate":true}' \
  | jq '{humanReadableSummary, warnings, gasEstimate, prerequisite: .prerequisite.humanReadableSummary, simulation}'
```

A typical response for a new agent on `arc-staging` (100 % collateral tier) contains a `prerequisite` approve for
exactly the collateral amount and a `simulation.plainLanguage` explaining that the main call reverts until that
approve is mined.

## Error contract

| HTTP | Meaning |
|------|---------|
| 400 | Validation error (`{error, field?}`): bad address/checksum, amount out of range or over cap, `durationDays` outside 7-365, unknown/missing network, non-existent loan or pool, relay refused |
| 401 | Bearer token required/invalid (only when the operator configured one) |
| 413 | Body over 256 KB |
| 429 | Per-IP rate limit; `Retry-After` header |
| 502 | Upstream RPC failure; retry |

Every read includes `rpc.stale` (true when the RPC's latest block is older than 5 minutes) so the assistant can
caveat numbers.

## Other platforms

- xAI Grok Bot: [GROK_BOT.md](GROK_BOT.md) (remote MCP at `/mcp`, same capabilities).
- Instinct: **no public developer program or connector spec exists yet**, so there is no documented integration path;
  this REST/OpenAPI surface is the intended starting point once one is published.
