# Specular for xAI Grok Bot (remote MCP)

Grok Bot integrates external tools **only through remote MCP servers reachable over the public internet**. Specular's
hosted server speaks MCP Streamable HTTP, so Grok Bot can use it directly; nothing runs on xAI's side except the MCP
client.

General remote-MCP details (endpoint, tool list, custody, client snippets): [REMOTE_MCP.md](REMOTE_MCP.md).

## What to enter in the Grok Bot MCP configuration

| Field | Value |
|-------|-------|
| Server URL | `https://specular-agent-api-production.up.railway.app/mcp` |
| Transport | Streamable HTTP (stateless; SSE is not required) |
| Auth header | `Authorization: Bearer <token>` — **required** on the hosted deployment (a self-hosted instance with no `SPECULAR_MCP_TOKEN` is open). Without it every call, `tools/list` included, is `401 {"error":"missing or invalid bearer token"}` |
| Tools to allow | See below; at minimum the read tools plus `prepare_request_loan`, `prepare_repay_loan`, `simulate_transaction` |

If Grok Bot asks for an allow-list of tools, this is a sensible default:

- Read (safe, no side effects): `list_networks`, `get_protocol_status`, `check_credit_score`,
  `get_available_liquidity`, `get_pool_details`, `get_loan_status`, `get_agent_loans`, `get_lending_positions`,
  `get_transaction`
- Prepare (return unsigned transactions, no side effects): `prepare_register_agent`, `prepare_create_pool`,
  `prepare_approve_usdc`, `prepare_supply_liquidity`, `prepare_withdraw_liquidity`, `prepare_request_loan`,
  `prepare_repay_loan`, `prepare_claim_interest`, `simulate_transaction`
- Side effects: `broadcast_signed_transaction` (only relays bytes the bot's own wallet already signed)

Tool annotations are set (`readOnlyHint` on reads/prepares, `destructiveHint` on broadcast) so hosts that gate on
annotations behave correctly.

## Custody: the bot signs with its own wallet

Specular's server is **non-custodial** and public; it cannot sign for anyone and refuses to run with a private key in
its environment. So a Grok Bot that wants to *transact* (not just read) needs a wallet on the xAI side of the boundary:

0. First-loan prerequisite: the bot must be registered (`prepare_register_agent`), own a pool
   (`prepare_create_pool`) **and have USDC in that pool** (`prepare_supply_liquidity`). Loans are
   drawn from the borrower's own pool, so `request_loan` against a freshly created empty pool
   reverts. See the full sequence in [REMOTE_MCP.md](REMOTE_MCP.md#borrower-walkthrough).
1. The bot calls `prepare_request_loan` (or any `prepare_*`) with `from` = its wallet address and `simulate: true`.
   It gets back `{chainId, to, data, value:"0", gasEstimate, humanReadableSummary, warnings[], prerequisite, simulation}`.
2. Whatever signs for the bot (a key in a secure tool, an MPC/custody provider, a human approving in a wallet UI)
   signs `prerequisite` first if present (an exact-amount USDC approve), then the main transaction.
3. The signed bytes are broadcast by the signer's own RPC, **or** handed back to Specular via
   `broadcast_signed_transaction`, which relays only Specular-targeted transactions.
4. `get_transaction` returns the decoded `LoanRequested` event with the new `loanId`.

Always check `simulation.ok` before signing. In a verbatim run of the pre-supply flow the
simulation correctly reported `ok: false` with "The pool does not hold enough available USDC for
this amount"; signing anyway burned gas on a reverted transaction.

If Grok Bot has no signing capability at all, everything still works in **read + prepare** mode: the bot can explain
a user's credit position, size a loan, show projected interest, and hand the user an unsigned transaction to sign in
their own wallet. `humanReadableSummary` is written for exactly that hand-off.

## Networks

Every call must pass `network`. Tell the bot in its system prompt which one to use:

- `arc-staging`: Arc testnet, test USDC. Use this for development and demos.
- `arc-mainnet`: **real USDC**. Prepared transactions carry `realMoney: true` and a warning string.
- `base`: also real USDC, but **not enabled on the hosted deployment** — it answers
  `400 Network "base" is not enabled on this server`. Call `list_networks` to see what is live.

There is no default network and the server will error rather than guess. Note that the
*unknown-network* error text ("Valid: base, arc-staging, arc-mainnet") lists every name the code
recognises, not the names this deployment serves; `list_networks` is the authority.

## Suggested system-prompt fragment

```
You can use Specular Protocol tools to check on-chain credit, inspect liquidity pools, and prepare loan
transactions. Always pass network="arc-staging" unless the user explicitly asks for arc-mainnet
(that moves real USDC; confirm with the user first). A loan is drawn from the borrower's OWN pool,
so an agent must register, create a pool and supply USDC into it before its first loan; a request
against an empty pool reverts. Specular never signs: prepare_* tools return an
unsigned transaction. If the response has a `prerequisite`, that approve must be signed and confirmed first.
Show the user `humanReadableSummary` and any `warnings` before asking them to sign. Use simulate:true and
explain `simulation.plainLanguage` if a transaction would revert.
```

## Verifying the connection

```bash
curl -s -X POST https://specular-agent-api-production.up.railway.app/mcp \
  -H "authorization: Bearer $SPECULAR_MCP_TOKEN" \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | jq '.result.tools | length'   # 25
curl -s https://specular-agent-api-production.up.railway.app/health | jq .   # open, no token
```

Drop the `authorization` header from the first command and you get
`{"error":"missing or invalid bearer token"}` with HTTP 401 — that is the single most common
cause of a "the connector can't see any tools" report.

## Other platforms

- Meta Muse Connectors: [MUSE_CONNECTOR.md](MUSE_CONNECTOR.md) (HTTP API + OpenAPI, same capabilities).
- Instinct: there is **no public developer program or connector spec yet**, so no Specular integration path is
  documented; the REST/OpenAPI surface will be the starting point when one exists.
