# Connecting to Specular over remote MCP

Specular exposes a **Model Context Protocol** server over **Streamable HTTP** so any MCP-capable host
(xAI Grok Bot, Claude, Cursor, OpenAI Agents SDK, LangGraph, custom agents, ...) can read protocol state and
build transactions without running any Specular code locally.

Source: [`mcp-server/`](../../mcp-server/) in this repo. Platform-specific notes:
[Grok Bot](GROK_BOT.md), [Meta Muse Connectors](MUSE_CONNECTOR.md).

## Endpoint

| Item | Value |
|------|-------|
| MCP URL | `https://<your-deployment>/mcp` (local dev: `http://localhost:3400/mcp`) |
| Transport | MCP **Streamable HTTP**, stateless (no session id needed; `GET /mcp` returns 405) |
| Protocol version | negotiated by the SDK (`2025-06-18` and earlier) |
| Auth | Optional `Authorization: Bearer <SPECULAR_MCP_TOKEN>`; if the operator did not set a token the endpoint is open and rate-limited per IP |
| Headers | `Content-Type: application/json`, `Accept: application/json, text/event-stream` (the spec requires both; this server also serves clients that send only `application/json`, `*/*` or no `Accept`) |
| Same tools as REST | `https://<your-deployment>/openapi.json` |

Each `POST /mcp` carries one JSON-RPC request (`initialize`, `tools/list`, `tools/call`). Responses are plain JSON
(`enableJsonResponse`), which every Streamable-HTTP client accepts.

```bash
curl -s -X POST https://specular-agent-api-production.up.railway.app/mcp \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"check_credit_score",
       "arguments":{"network":"arc-staging","address":"0x800e305A0caDdE6289dFDFEDF38218f45C06F72C"}}}'
```

## Custody model: you sign, we never touch keys

The remote server is **non-custodial**. It has no signing code path and refuses to boot if a private key is present
in its environment.

- **Read tools** query the chain for you.
- **`prepare_*` tools** return an **unsigned transaction**
  `{chainId, to, data, value:"0", gasEstimate, description, humanReadableSummary, warnings[], prerequisite, simulation}`.
  Your agent signs it with its own wallet (ethers, viem, an MPC signer, a hardware wallet, ...) and broadcasts.
- **`broadcast_signed_transaction`** relays a raw signed transaction for agents that have a key but no RPC. It is only
  accepted if the bytes decode to an allow-listed Specular call on that network (or an exact USDC `approve` to the
  Specular marketplace).
- USDC approvals are always **exact amounts**, never unlimited. When a call needs an allowance, the response includes
  the exact approve in `prerequisite`; send it first.

## Networks: always explicit

Every tool requires `network`. There is no default, because two of the three move real money.

| `network` | What | Money |
|-----------|------|-------|
| `arc-staging` | Arc testnet, V6-staging stack | test USDC (start here) |
| `base` | Base mainnet | **real USDC** |
| `arc-mainnet` | Arc mainnet | **real USDC** |

Contract addresses are pinned server-side from the repo's `src/config/*.json`; a client cannot redirect a call to
another contract.

## Tool list

Read: `list_networks`, `get_network_info`, `get_protocol_status`, `check_credit_score`, `get_available_liquidity`,
`get_pool_details`, `get_loan_status`, `get_agent_loans`, `get_lending_positions`, `get_transaction`;
V6.1-only (clear "not supported" error on older deployments): `preview_repayment` (exact amount `repayLoan` pulls now,
incl. late interest — size the repay approval from this), `can_top_up`, `get_active_loan_ids`.

Prepare (unsigned): `prepare_register_agent`, `prepare_create_pool`, `prepare_approve_usdc`, `prepare_supply_liquidity`,
`prepare_withdraw_liquidity`, `prepare_request_loan`, `prepare_repay_loan`, `prepare_claim_interest`.

Other: `simulate_transaction`, `broadcast_signed_transaction`.

Every `prepare_*` accepts `simulate: true` to dry-run from your address; reverts come back as
`simulation.revertReason` plus a plain-language `simulation.plainLanguage`.

## Borrower walkthrough

```
check_credit_score        {network, address}           -> registered? score/tier, limit, allowance
prepare_register_agent    {network, from}              -> sign+send once (skip if registered)
prepare_create_pool       {network, from}              -> sign+send once
prepare_request_loan      {network, from, amount, durationDays, simulate:true}
                          -> if `prerequisite` present: sign+send it, wait for it to mine
                          -> sign+send the loan tx
get_transaction           {network, hash}              -> LoanRequested event carries loanId
prepare_repay_loan        {network, from, loanId, simulate:true} before the due date -> approve prerequisite, then repay
```

Lenders use `get_available_liquidity` -> `prepare_supply_liquidity` -> later `prepare_claim_interest` /
`prepare_withdraw_liquidity`.

## Client snippets

**MCP TypeScript SDK**

```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const client = new Client({ name: 'my-agent', version: '1.0.0' });
await client.connect(new StreamableHTTPClientTransport(new URL('https://specular-agent-api-production.up.railway.app/mcp'), {
  requestInit: { headers: { Authorization: 'Bearer <token-if-required>' } },
}));
const prepared = await client.callTool({ name: 'prepare_request_loan',
  arguments: { network: 'arc-staging', from: wallet.address, amount: 25, durationDays: 30, simulate: true } });
const tx = prepared.structuredContent;           // {to,data,value,gasEstimate,prerequisite,...}
if (tx.prerequisite) await (await wallet.sendTransaction({ to: tx.prerequisite.to, data: tx.prerequisite.data })).wait();
await wallet.sendTransaction({ to: tx.to, data: tx.data, gasLimit: BigInt(tx.gasEstimate) });
```

**Python (raw JSON-RPC)**

```python
import requests, json
r = requests.post('https://specular-agent-api-production.up.railway.app/mcp', json={
  'jsonrpc': '2.0', 'id': 1, 'method': 'tools/call',
  'params': {'name': 'get_protocol_status', 'arguments': {'network': 'arc-staging'}}},
  headers={'Accept': 'application/json, text/event-stream'})
print(r.json()['result']['structuredContent'])
```

## Operational details

- **Rate limits**: per-IP sliding window (default 120/min; broadcast 20/min). `429` carries `Retry-After`.
- **Body limit**: 256 KB. **CORS**: configurable allow-list.
- **Staleness**: every read includes `rpc.ageSeconds`/`rpc.stale` (latest block older than 5 minutes -> `stale: true` and a warning).
- **Amount caps**: 100,000 USDC per prepared/relayed call (operator-configurable), loans capped at 50,000 USDC.
- **Errors**: tool errors (bad address, unknown loan, ...) come back as `isError: true` with `{error, field?}`; protocol errors (unknown tool, malformed `tools/call` params) are JSON-RPC `-32602`, unknown methods `-32601`. REST answers HTTP 400/401/429/502 with `{error}`; **503 + `Retry-After`** when the server is at its concurrency cap *or* when a network's upstream RPC endpoints are all cold (`{error, network, retryAfterSeconds}`); **504 + `Retry-After`** when a request exceeds the server's time budget. Retry on 503/504 after the hinted delay; they are always fast and never a hang.
- **Upstream resilience**: each network is served from a list of RPC endpoints with health-aware failover, exponential backoff and automatic recovery, plus a per-network circuit breaker. Reads are cached (chain head ~2 s, `eth_call` ~4 s, a `REPAID`/`DEFAULTED` loan or a mined transaction ~5 min) and identical concurrent reads share one upstream call. A cached body is labelled `cached: true` with `cacheAgeMs`, and `rpc.ageSeconds`/`rpc.stale` are always recomputed for the moment you read them. Anything that must be live — a nonce, a relay, a `pending` tag, an unmined receipt — is never cached.
- **Batches**: a JSON-RPC batch is answered with an array (even when only one member produces a response); an empty batch is `-32600`.
- **Simulation**: `simulation.ok: false` always means the EVM reverted. An upstream RPC failure is an HTTP 502 / tool error, never a fabricated `revertReason`.
- **`can_top_up` is advisory**: the deployed marketplace's `canTopUp()` view is off by one block, so the server also evaluates the corrected predicate and returns the conservative answer with `onChainView`, `correctedPredicate`, `viewDisagrees` and `warnings[]`. A loan can also start between your check and your transaction. Simulate `supply_liquidity` immediately before signing.
- **Session**: stateless; no `Mcp-Session-Id` is issued and any sent is ignored. `Mcp-Protocol-Version` is honoured (`2024-11-05` … `2025-11-25`; other values get 400).
- **Health**: `GET /health` (per-network RPC status, plus an `upstream` summary: cache hit rates and, per network, whether the circuit is open and how many endpoints are healthy). `GET /rpc-health` gives the full picture — per-endpoint state / consecutive failures / last error class, circuit state with a retry hint, and both cache layers' counters. Neither route makes an upstream call, and neither publishes RPC credentials. **Discovery**: `GET /` and `GET /openapi.json`.

## Self-hosting

```bash
cd mcp-server && npm install && npm run build
SPECULAR_ENABLED_NETWORKS=arc-staging SPECULAR_MCP_TOKEN=<random> PORT=3400 npm start
```

or `docker build -f mcp-server/Dockerfile .` from the repo root (Railway config in `mcp-server/railway.json`).
Full env reference: [`mcp-server/.env.example`](../../mcp-server/.env.example).

RPC endpoints are configured per network and accept a **comma-separated failover list**; a single URL still works:

```bash
SPECULAR_RPC_ARC_MAINNET="https://rpc.mainnet.arc.io,https://arc-rpc.publicnode.com"
SPECULAR_RPC_ARC_STAGING="https://rpc.testnet.arc.io,https://arc-testnet-rpc.publicnode.com"
```

Leaving them unset uses the verified public defaults. Tuning knobs (all optional):
`SPECULAR_REQUEST_DEADLINE_MS` (20 s overall budget per request), `SPECULAR_RPC_TIMEOUT_MS` (8 s per attempt),
`SPECULAR_RPC_MAX_ATTEMPTS` (3), `SPECULAR_RPC_FAILURE_THRESHOLD` (2), `SPECULAR_RPC_BACKOFF_MS` /
`SPECULAR_RPC_BACKOFF_MAX_MS` (1 s → 30 s), `SPECULAR_RPC_CACHE` / `SPECULAR_RPC_COALESCE` (on),
`SPECULAR_RPC_CACHE_{HEAD,CALL,STATIC,IMMUTABLE}_MS`, `SPECULAR_READ_CACHE{,_MS,_IMMUTABLE_MS}`.
A keyed/paid endpoint is safe to configure: credentials are never echoed — `/v1/networks` and `/rpc-health`
reduce an operator-configured endpoint to `scheme://host/`.
