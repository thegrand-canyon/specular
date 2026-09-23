# Specular for Meta Muse Connectors (HTTP API)

Muse Connectors are built by the developer providing an **HTTP API** plus a machine-readable description of it.
Specular's hosted server exposes exactly that: a REST surface under `/v1/` with an **OpenAPI 3.1** document at
`/openapi.json`, backed by the same handlers as the MCP tools. Point the connector at the OpenAPI file and every
capability below becomes an action.

General custody/network notes: [REMOTE_MCP.md](REMOTE_MCP.md). Grok Bot (MCP instead of REST): [GROK_BOT.md](GROK_BOT.md).

## Connector settings

| Field | Value |
|-------|-------|
| Base URL | `https://specular-agent-api-production.up.railway.app` |
| API description | `https://specular-agent-api-production.up.railway.app/openapi.json` (OpenAPI 3.1, generated from the tool registry; also committed as `mcp-server/openapi.json`) |
| Auth | **Required on the hosted deployment**: `Authorization: Bearer <token>`. A self-hosted instance with no `SPECULAR_MCP_TOKEN` is open (per-IP rate limits apply) |
| Content type | `application/json` in and out |
| Health | `GET /health` (open, no token — as are `GET /`, `/openapi.json` and `/rpc-health`) |

> **Configure the bearer token even though the OpenAPI document says it is optional.** The
> generated spec declares `security: [{bearerAuth: []}, {}]`; the empty alternative advertises
> "no auth also works", which is false on the hosted deployment. A connector built straight from
> the document with no credential gets `401 {"error":"missing or invalid bearer token"}` on every
> `/v1/` call.

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

`{network}` is one of `arc-staging` (testnet, test USDC) or `arc-mainnet` (**real USDC**) on the hosted
deployment; `base` (**real USDC**) is a known name but is **not enabled** there and answers
`400 Network "base" is not enabled on this server`. `GET /v1/networks` is the authority on what a
deployment serves — the unknown-network error's "Valid: …" list is the set of names the code knows,
not the set it serves. `{network}` is a required path segment; there is no default.

Amounts are USDC **display** units (`12.5` means 12.5 USDC), max 6 decimals, accepted as a JSON number
or a decimal string. Passing base units (`25000000` for 25 USDC) is rejected, but with a per-call-cap
message rather than a units hint — if you see "exceeds this server's per-call cap", check your units first.

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
0. one-time, before the first loan (a loan is drawn from the agent's OWN pool):
   POST /v1/arc-staging/tx/prepare/register_agent   {"from":"0xAGENT"}            -> sign+send
   POST /v1/arc-staging/tx/prepare/create_pool      {"from":"0xAGENT"}            -> sign+send
   POST /v1/arc-staging/tx/prepare/supply_liquidity {"from":"0xAGENT","agentId":N,"amount":120}
                                                    -> sign+send `prerequisite`, then the supply tx
1. POST /v1/arc-staging/tx/prepare/request_loan {"from":"0xAGENT","amount":25,"durationDays":30,"simulate":true}
   -> check simulation.ok BEFORE signing; ok:false means the EVM reverted and signing wastes gas
2. if response.prerequisite -> sign+send it (exact USDC approve), wait for confirmation
3. sign the main tx; either send via your own RPC, or
   POST /v1/arc-staging/tx/broadcast {"signedTransaction":"0x02f8..."}   (relayed only if it targets Specular)
4. GET /v1/arc-staging/tx/{hash} -> "confirmed" + decoded LoanRequested {loanId}
5. GET /v1/arc-staging/loans/{loanId}/repayment -> the exact total repayLoan will pull
   POST /v1/arc-staging/tx/prepare/repay_loan {"from":"0xAGENT","loanId":N,"simulate":true}
```

Step 0 is not optional. `GET /v1/{network}/status` reports
`parameters.borrowRestrictedToPoolCreator: true`: only the pool's creator may borrow from it and the
principal comes out of that pool's `availableLiquidity`, so a brand-new agent with an empty pool
cannot borrow. At the 100 %-collateral starting tier, moving `X` USDC needs `X` in the pool plus `X`
of collateral in the wallet. The pool creator is exempt from `parameters.minSupplyUsdc`; other
lenders are not. A creator's own position is first-loss self-stake and cannot be withdrawn while the
agent has outstanding principal (claiming interest still works).

Reputation caveat: a loan repaid sooner than `parameters.minHoldForReputationRewardSeconds`
(86,400 s today) is recorded as not-on-time — no score gain **and no credit-ladder growth**. The API
returns no warning about this, so a connector that repays immediately will see the agent's limit
sit at the bootstrap 100 USDC forever.

Approvals are always exact amounts to the Specular marketplace; the relay rejects unlimited approvals, approvals to
any other spender, native-value transfers, admin functions and anything not addressed to a Specular contract on that
network.

## Example: sizing and preparing a loan

```bash
API=https://specular-agent-api-production.up.railway.app
AUTH="authorization: Bearer $SPECULAR_MCP_TOKEN"     # required; omit it and every call is 401
H='content-type: application/json'

curl -s -H "$AUTH" $API/v1/arc-staging/agents/0xAGENT/credit | jq '{registered, reputation, credit, wallet}'

curl -s -X POST $API/v1/arc-staging/tx/prepare/request_loan -H "$AUTH" -H "$H" \
  -d '{"from":"0xAGENT","amount":25,"durationDays":30,"simulate":true}' \
  | jq '{humanReadableSummary, warnings, gasEstimate, prerequisite: .prerequisite.humanReadableSummary, simulation}'
```

A typical response for a new agent on `arc-staging` (100 % collateral tier) contains a `prerequisite` approve for
exactly the collateral amount and a `simulation.plainLanguage` explaining that the main call reverts until that
approve is mined.

## Error contract

| HTTP | Meaning |
|------|---------|
| 400 | Validation error (`{error, field?}`): bad address/checksum, amount out of range or over cap, `durationDays` outside 7-365, unknown/disabled network, non-existent loan or pool, relay refused |
| 401 | `{"error":"missing or invalid bearer token"}` — always, on the hosted deployment, for `/v1/` and `/mcp` |
| 413 | Body over 256 KB |
| 429 | Per-IP rate limit (120/min; 20/min for broadcast); `Retry-After` header and `{"error":"rate limit exceeded; retry in Ns"}` |
| 502 | Upstream RPC failure; retry |
| 503 | Concurrency cap reached, or every upstream RPC for that network is cold; `Retry-After` + `{error, network, retryAfterSeconds}` |
| 504 | Request exceeded the server's 20 s budget; `Retry-After`. Fast and explicit, never a hang |

A `prepare_*` call whose transaction **would revert** is still HTTP **200**: the refusal arrives as
`simulation.ok: false` with `simulation.revertReason`, `simulation.plainLanguage` and `warnings[]`.
Treat a 200 with `simulation.ok === false` as a failure and surface `plainLanguage` — do not sign it.

Every read includes `rpc.stale` (true when the RPC's latest block is older than 5 minutes) so the assistant can
caveat numbers.

## Other platforms

- xAI Grok Bot: [GROK_BOT.md](GROK_BOT.md) (remote MCP at `/mcp`, same capabilities).
- Instinct: **no public developer program or connector spec exists yet**, so there is no documented integration path;
  this REST/OpenAPI surface is the intended starting point once one is published.
