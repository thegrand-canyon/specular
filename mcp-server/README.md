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
| `arc-staging` | Arc testnet, **V6.2 / V7 stack** | 5042002 | test USDC | `src/config/arc-testnet-v6-addresses.json` |
| `arc-mainnet` | Arc mainnet, **V6.2 / V7 stack** | 5042 | **REAL USDC** | `src/config/arc-mainnet-addresses.json` |
| `base` | Base mainnet, V6 canonical | 8453 | **REAL USDC** | `src/config/base-addresses.json` |

Addresses are resolved only from those repo files, never from request input. Restrict a deployment with
`SPECULAR_ENABLED_NETWORKS=arc-staging`. The hosted deployment runs
`SPECULAR_ENABLED_NETWORKS=arc-mainnet,arc-staging`, so `base` there returns
`400 Network "base" is not enabled on this server`. `GET /v1/networks` reports what a given instance
actually serves, including each network's live `marketplaceVersion` — prefer it (and
`get_protocol_status.capabilities`) over this table, which is a snapshot.

### RPC endpoints and failover

`SPECULAR_RPC_BASE` / `SPECULAR_RPC_ARC_STAGING` / `SPECULAR_RPC_ARC_MAINNET` accept a **comma-separated list**
in preference order. The single-URL form still works (it is just a one-element list):

```bash
SPECULAR_RPC_ARC_MAINNET="https://rpc.mainnet.arc.io,https://arc-rpc.publicnode.com"
```

With no override the server uses a verified public list per network (dRPC is deliberately last — it 429s this
project's egress after moderate use):

| `network` | Default endpoint list |
|-----------|-----------------------|
| `arc-mainnet` | `rpc.mainnet.arc.io`, `arc-rpc.publicnode.com`, `arc.drpc.org` |
| `arc-staging` | `rpc.testnet.arc.io`, `arc-testnet-rpc.publicnode.com` |
| `base` | `mainnet.base.org`, `base-rpc.publicnode.com` |

`GET /v1/networks` and `/rpc-health` report the endpoint list an instance is actually using
(the hosted deployment currently shows 3 for `arc-mainnet` and 2 for `arc-staging`).
Note that the public Arc endpoints rate-limit fairly aggressively on burst writes: a client
broadcasting its own transactions through `rpc.testnet.arc.io` can see `-32005 rate limit
exceeded` after a handful of back-to-back sends. That is upstream, not the Specular server.

Selection is health-aware. A 429 takes an endpoint out of rotation immediately; any other failure takes it out
after `SPECULAR_RPC_FAILURE_THRESHOLD` consecutive failures. A cold endpoint backs off exponentially
(`SPECULAR_RPC_BACKOFF_MS` → `SPECULAR_RPC_BACKOFF_MAX_MS`), is retried half-open when the backoff elapses, and
returns to full health on the first success — no operator action needed. When **every** endpoint for a network is
cold the circuit is open and reads fail immediately with `503` + `Retry-After` and a plain
`Network "…" is temporarily unavailable` message, instead of queueing behind a dead upstream.

Endpoint URLs are never published with credentials: `/v1/networks` and `/rpc-health` show a well-known public
default verbatim and reduce anything operator-configured to `scheme://host/`.

### Caching and coalescing

Reads are cached twice, both short by default and both fully switchable:

| Layer | Key | TTL | Env |
|-------|-----|-----|-----|
| JSON-RPC | `network + method + params` | chain head 2 s, `eth_call` on `latest` 4 s, block-pinned/`eth_chainId`/`eth_getCode` 1 h, mined tx/receipt 5 min | `SPECULAR_RPC_CACHE`, `SPECULAR_RPC_CACHE_HEAD_MS`, `SPECULAR_RPC_CACHE_CALL_MS`, `SPECULAR_RPC_CACHE_STATIC_MS`, `SPECULAR_RPC_CACHE_IMMUTABLE_MS` |
| Read route | `tool + arguments` | 3 s, but 5 min for an answer that can never change (a `REPAID`/`DEFAULTED` loan, a mined `get_transaction`) | `SPECULAR_READ_CACHE`, `SPECULAR_READ_CACHE_MS`, `SPECULAR_READ_CACHE_IMMUTABLE_MS` |

Nothing that must be live is cached: `eth_sendRawTransaction`, `eth_getTransactionCount` (nonce) and a `pending`
block tag always reach the chain, and a *null* receipt is never cached (a freshly broadcast tx stays visible).
A cached body is labelled `cached: true` with `cacheAgeMs`, and its `rpc.ageSeconds` / `rpc.stale` are recomputed
from the cached block timestamp so staleness never under-reports.

Identical concurrent reads share one in-flight upstream call (`SPECULAR_RPC_COALESCE`), so N simultaneous callers
asking the same question cost one upstream call, not N.

### Bounded waits

Every `/v1` and `/mcp` request runs inside `SPECULAR_REQUEST_DEADLINE_MS` (20 s). Each upstream attempt is clamped
to `min(SPECULAR_RPC_TIMEOUT_MS, remaining budget)`, and a backstop answers `504` + `Retry-After` if a handler
overruns. No request can sit on a hung upstream for minutes.

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
| `preview_repayment` | read | `GET /v1/{network}/loans/{loanId}/repayment` (V6.1 only: exact amount `repayLoan` pulls now, incl. late interest) |
| `can_top_up` | read | `GET /v1/{network}/pools/{agentId}/can-top-up/{lender}` (V6.1 only) |
| `get_active_loan_ids` | read | `GET /v1/{network}/agents/{agentId}/active-loans` (V6.1 only) |
| `required_self_stake` | read | `GET /v1/{network}/agents/{agentId}/required-self-stake?additionalAmount=` (**V6.2 only**: first-loss capital the agent must hold in its own pool before borrowing more) |
| `get_self_stake` | read | `GET /v1/{network}/agents/{agentId}/self-stake` (**V6.2 only**: the creator's own position and whether it is locked) |
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

Every `/v1/` and `/mcp` call below needs `Authorization: Bearer <SPECULAR_MCP_TOKEN>` on the hosted
deployment. Only `GET /`, `/health`, `/openapi.json` and `/rpc-health` are open.

**A loan comes out of the borrower's own pool.** `get_protocol_status` reports
`parameters.borrowRestrictedToPoolCreator: true`: only the pool creator may borrow from it, and the
principal is drawn from that pool's `availableLiquidity`. Steps 0a–0c are therefore mandatory before
a first loan — `request_loan` against a freshly created, empty pool reverts.

```
0a. POST /v1/arc-staging/tx/prepare/register_agent   {"from":"0xYOU"}  -> sign+send (once)
0b. POST /v1/arc-staging/tx/prepare/create_pool      {"from":"0xYOU"}  -> sign+send (once)
0c. POST /v1/arc-staging/tx/prepare/supply_liquidity {"from":"0xYOU","agentId":N,"amount":120}
        -> sign+send `prerequisite` (exact approve), then the supply tx.
           The pool CREATOR is exempt from parameters.minSupplyUsdc; other lenders are not.
1.  GET  /v1/arc-staging/agents/0xYOU/credit              -> registered? score, limit, allowance
2.  POST /v1/arc-staging/tx/prepare/request_loan
        {"from":"0xYOU","amount":25,"durationDays":30,"simulate":true}
        -> { to, data, value:"0", gasEstimate, warnings[], prerequisite: {approve tx}|null, simulation:{ok,...} }
        -> STOP if simulation.ok is false; the tx would revert. `amount` must be <= BOTH the pool's
           availableLiquidity and credit.creditLimitUsdc (a fresh agent's is the ladder bootstrap,
           100 USDC, not the tier limit).
3.  sign + send `prerequisite` (if present) with your wallet; wait for it to mine
4.  sign + send the main tx  (or POST the raw signed hex to /v1/arc-staging/tx/broadcast)
5.  GET  /v1/arc-staging/tx/{hash}                          -> decoded LoanRequested event with the loanId
6.  GET  /v1/arc-staging/loans/{loanId}/repayment           -> exact total repayLoan will pull
7.  before the due date: POST .../tx/prepare/repay_loan {"from":"0xYOU","loanId":N,"simulate":true}
```

At the 100 %-collateral starting tier, borrowing `X` USDC needs `X` sitting in the pool **and** `X`
of collateral in the wallet — budget ~`2X`. On a V6.2/V7 network, once an agent reaches a tier below
100 % collateral, `required_self_stake` / `get_self_stake` gate borrowing separately from the credit
limit; check them before sizing the loan.

**Repay timing changes what the repay is worth.** A loan repaid sooner than
`parameters.minHoldForReputationRewardSeconds` (86,400 s on current deployments) is passed to the
reputation manager as `onTime=false`: no score bonus and **no credit-ladder growth**
(`maxRepaidPrincipal` is not updated), so the agent's limit stays at the bootstrap. No API response
warns about this today. Hold the loan past that window before repaying if the run is meant to build
credit.

Minimal ethers v6 client for step 3/4:

```js
const AUTH = { 'content-type': 'application/json', authorization: `Bearer ${process.env.SPECULAR_MCP_TOKEN}` };
const tx = await fetch(`${API}/v1/arc-staging/tx/prepare/request_loan`, { method: 'POST',
  headers: AUTH,
  body: JSON.stringify({ from: wallet.address, amount: 25, durationDays: 30, simulate: true }) }).then(r => r.json());
if (tx.simulation && tx.simulation.ok === false) throw new Error(tx.simulation.plainLanguage);
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
# -> http://localhost:3400/  (MCP: POST /mcp, REST: /v1, OpenAPI: /openapi.json,
#    health: /health, upstream RPC health: /rpc-health)
```

Quick check:

```bash
# local dev with no SPECULAR_MCP_TOKEN set -> no Authorization header needed
curl -s localhost:3400/v1/arc-staging/status | jq .
curl -s localhost:3400/rpc-health | jq '.status, .networks[].endpoints[] | {endpoint, state, consecutiveFailures}'
curl -s -X POST localhost:3400/mcp -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | jq '.result.tools[].name'   # 25 tools
```

Against the hosted deployment add `-H "authorization: Bearer $SPECULAR_MCP_TOKEN"` to the `/v1/`
and `/mcp` calls; `/rpc-health` needs no token.

### Environment

See [`.env.example`](.env.example). Highlights: `PORT`, `SPECULAR_ENABLED_NETWORKS`, `SPECULAR_MCP_TOKEN`
(bearer token; when unset, everything is open and rate-limited per IP — the hosted deployment sets it,
so `/v1/` and `/mcp` are 401 without it while `GET /`, `/health`, `/openapi.json` and `/rpc-health`
stay open. Note the generated `openapi.json` declares `security: [{bearerAuth: []}, {}]`, advertising
auth as optional even when it is enforced), `SPECULAR_RATE_LIMIT_PER_MIN` (120),
`SPECULAR_BROADCAST_LIMIT_PER_MIN` (20), `SPECULAR_ALLOWED_ORIGINS`, `SPECULAR_BODY_LIMIT` (256kb),
`SPECULAR_MAX_AMOUNT_USDC` (100,000 per call), `SPECULAR_MAX_LOAN_USDC` (50,000 — an OFFLINE sanity bound on an encoded loan principal, **not** a credit limit: the tier table is on-chain and owner-settable on ReputationManagerV4, read it from `get_protocol_status.creditTiers`), `SPECULAR_TIER_TABLE_CACHE_MS` (60,000), `SPECULAR_TRUST_PROXY` (Railway: 2; verify
the access log's `ip` is the real client), `SPECULAR_MAX_INFLIGHT` (64; excess requests get 503 + `Retry-After`),
`SPECULAR_HEALTH_CACHE_MS` (10s), `LOG_LEVEL`.

Upstream resilience (all optional, sensible defaults):

| Variable | Default | Meaning |
|----------|---------|---------|
| `SPECULAR_RPC_*` | see the table above | comma-separated endpoint list per network (single URL still works) |
| `SPECULAR_RPC_TIMEOUT_MS` | `8000` | per-upstream-attempt timeout (was 15 s; lowered so failover fits inside the request deadline) |
| `SPECULAR_RPC_MAX_ATTEMPTS` | `3` | total upstream attempts for one JSON-RPC call, walking the endpoint ring |
| `SPECULAR_REQUEST_DEADLINE_MS` | `20000` | overall budget for one `/v1` or `/mcp` request; `0` disables |
| `SPECULAR_RPC_FAILURE_THRESHOLD` | `2` | consecutive non-429 failures before an endpoint goes cold (a 429 is immediate) |
| `SPECULAR_RPC_BACKOFF_MS` | `1000` | first cold window; doubles per cold cycle |
| `SPECULAR_RPC_BACKOFF_MAX_MS` | `30000` | cold-window ceiling |
| `SPECULAR_RPC_CACHE` | `1` | JSON-RPC response cache on/off |
| `SPECULAR_RPC_COALESCE` | `1` | share one in-flight upstream call between identical concurrent reads |
| `SPECULAR_RPC_CACHE_HEAD_MS` | `2000` | TTL for chain head / gas / estimate |
| `SPECULAR_RPC_CACHE_CALL_MS` | `4000` | TTL for `eth_call` against `latest` |
| `SPECULAR_RPC_CACHE_STATIC_MS` | `3600000` | TTL for block-pinned data, `eth_chainId`, `eth_getCode` |
| `SPECULAR_RPC_CACHE_IMMUTABLE_MS` | `300000` | TTL for a mined transaction / receipt |
| `SPECULAR_READ_CACHE` | `1` | read-route cache on/off |
| `SPECULAR_READ_CACHE_MS` | `3000` | TTL for live read routes |
| `SPECULAR_READ_CACHE_IMMUTABLE_MS` | `300000` | TTL for a terminal loan or a mined `get_transaction` |

`GET /rpc-health` reports all of it live: per endpoint state / consecutive failures / last error class / last error
time / call counts, per network whether the circuit is open plus a retry hint, and both caches' hit rates. It makes
no upstream call and publishes no credentials.

Logs are JSON lines on stdout: method, path, status, latency, resolved client IP plus the raw `X-Forwarded-For` chain,
MCP method/tool name. No other headers, no bodies, keys or tokens.

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
npm test               # build + unit + integration (incl. test/*.hardening.* from the 2026-09-20 review)
npm run test:unit      # offline: encode/decode round-trips, broadcast validator, validation
npm run test:integration   # boots the HTTP server against Arc testnet V6-staging; reads + prepare/simulate only, never broadcasts
```

## Layout

```
src/networks.ts   network registry; addresses from ../src/config/*.json; bundled ABIs
src/chain.ts      read-only providers, RPC staleness check
src/rpc.ts        resilient JSON-RPC transport: endpoint failover, health/backoff, circuit breaker, cache, coalescing
src/cache.ts      TTL cache + single-flight with counters (used by rpc.ts and the read routes)
src/deadline.ts   per-request deadline propagated through AsyncLocalStorage
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
- Relay accepts only the **canonical** ABI encoding of an allow-listed call (calldata with trailing bytes is rejected).
- Upstream RPC calls are bounded (per-attempt timeout + an overall request deadline); excess concurrency is shed
  with 503; `/health` is cached; reads are cached and coalesced so a caller cannot amplify into the RPC quota.
- Multi-endpoint failover with a per-network circuit breaker: a dead or throttling provider degrades into a fast,
  explicit `503`/`504` with `Retry-After`, never a multi-minute hang.
- Operator RPC URLs are never echoed with credentials (`rpcUrl` shows the origin only when overridden).
- Client-facing errors carry no library internals: ethers' `(code=…, version=…, buffer=…)` detail blocks,
  URLs and host:port are stripped on both the REST and the MCP error channels.
- `simulate_transaction` reports a revert only when the EVM produced one; an upstream RPC failure is a
  502, never a fabricated `revertReason`.
- JSON-RPC: batch replies are always arrays, an empty batch is `-32600`, and a malformed `tools/call`
  is `-32602` — inside a batch as well as on its own; no zod issue lists reach clients.
- `can_top_up` is **advisory**: the deployed marketplace's `canTopUp()` view is off by one block, so the
  server also evaluates the corrected predicate and returns the conservative answer plus `warnings`
  (`onChainView`, `correctedPredicate`, `viewDisagrees`). `prepare_supply_liquidity` carries the same
  warnings. Simulate immediately before signing.
- Admin functions (`pause`, `withdrawFees`, `seedPool`, NFT transfers, ...) are never prepared or relayed.

License: MIT
