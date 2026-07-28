# Specular SDK & Off-Chain Security Audit — July 2026

**Scope:** Off-chain surface — SDKs (`src/`, `src/sdk/`, `python/`), the x402
payment layer, scripts, and address-config integrity. **On-chain contracts
(V6) were NOT re-audited here** — they remain as of the WORLDCLASS audit
(2026-05-17); this pass confirmed no audited `.sol` changed since (see §5).

**Method:** four parallel review agents (x402 surface, SDK core JS+Python,
secret scan of tree+history, contract/config delta), every finding verified
against source, then fixed with a deterministic regression test where possible.

**Result:** 3 HIGH + 4 MEDIUM + 6 LOW findings fixed across 5 commits. Test
suite **414 → 450 passing** (+36 regression tests). Live e2e re-verified after
every behavior change (Arc: JS 35/35, Python 28/28, concurrent-load 50/50).

---

## 1. Commits

| Commit | Tier | Contents |
|--------|------|----------|
| `d88709e` | hygiene | Script exit codes, env-key cleanup, resilient receipts (pre-existing WIP) |
| `5560635` | first pass | x402 flush race, Python receipt-status check, validation NaN, secret hygiene |
| `dae127a` | HIGH | H1 blind-sign allowlist, H2 encrypted keystore, x402 F1 spend cap |
| `3d8383c` | MEDIUM | M1 config resolution, M2 exact approvals, M4 write-once retry, M5 reconnect, L9 |
| `2448310` | LOW | L2/L3 input validation, L4 Decimal, L5/L6 nonce, L8 cache freshness |

---

## 2. HIGH — wallet-drain vectors (all fixed)

### H1 — Blind-signing of API-supplied transactions
`SpecularSDK.register/requestLoan/repayLoan` signed whatever `{to, data}` the
API returned. A compromised/MITM'd API (default `apiUrl` was plaintext
`http://`) could return `approve(attacker, MAX)` or a transfer → full USDC
drain — the wallet equivalent of RCE.
**Fix:** `_assertSafeTx` — `to` must be a known Specular/USDC address (allowlist
loaded from the **in-repo** config, never the API); any token call must be
`approve()` to a known marketplace/router spender. Plus `https://` enforcement
for non-localhost and `response.ok` checks. Tests: `test/sdk/specular-sdk-blindsign.test.js`.

### H2 — Plaintext private keys on disk
`walletPersist` wrote raw private keys to tmpdir, was publicly exported, had a
path-traversal via `label`, and no opt-in gate.
**Fix:** encrypted ethers keystore (password required), `SPECULAR_ALLOW_KEY_PERSIST`
opt-in gate, label sanitized to `[A-Za-z0-9_-]`, dir ownership/perms enforced,
legacy plaintext files auto-migrated to encrypted form. Tests: `test/sdk/wallet-persist.test.js`.

### x402 F1 — Legacy client had no spend cap
`src/x402/x402Client.js._buildPaymentHeader` signed an EIP-3009 authorization
for any amount/token the server's 402 named. A hostile paywall could name the
whole balance and any token contract.
**Fix:** default 10 USDC per-payment cap (raise explicitly, `null` to opt out),
optional lifetime `maxTotalSpend`, and a `verifyingContract` pin against the
known USDC per network (blocks token substitution via `asset` or a server-
supplied `eip712Domain`). Tests: `test/sdk/x402-legacy-client-cap.test.js`.

---

## 3. MEDIUM (all fixed)

### x402 flush re-entrancy (was reported HIGH by the x402 agent)
`SpecularX402Server.flushToPool` guarded with `if (this._flushInFlight)`. When N
callers awaited one flush and it resolved, they all fell past the `if` and each
re-supplied the same residual revenue → pool over-supplied, `_earned` driven
negative (permanent accounting corruption). Live concurrent-load passed *with*
the bug — the race is timing-dependent.
**Fix:** `while` guard so exactly one drainer proceeds per pass. Deterministic
test: `test/sdk/x402-flush-race.test.js` (buggy: 19 supplies/`_earned −54`;
fixed: 2/`0`).

### M1 — CWD-relative config resolution
`SpecularQuickstart` resolved `./src/config/*.json` and artifacts against the
process CWD. An agent framework running from an untrusted workspace could shadow
the config with attacker addresses, which onboarding would then approve/transact
against. **Fix:** resolve from `__dirname` (`REPO_ROOT`). Verified: a hostile
CWD-local config is ignored.

### M2 — Unlimited `MaxUint256` approvals (JS + Python)
Both SDKs granted an unbounded USDC allowance on onboard, so a single
marketplace bug (cf. this contract's own §B1/§S1 history) could drain the whole
balance forever. **Fix:** exact just-in-time approvals per op — borrow approves
the exact required collateral, repay the exact principal+interest (interest is
fixed at `loan.duration`, not time-accruing, so the client figure matches to the
base unit), supply the exact amount. Added `revokeApproval()`/`revoke_approval()`.

### M4 — Write-retry re-broadcast
`ContractManager.callContract` retried the whole call on any error, so a
transient `result.wait()` RPC failure re-broadcast a second write (duplicate
loan/approval). **Fix:** branch on `stateMutability` — reads retry wholesale;
writes send **once** and poll the receipt by hash on transient wait failure;
on-chain reverts are terminal. Tests: `test/sdk/contract-manager-retry.test.js`.

### M5 — EventListener had no reconnect (+ L9)
A dropped WS silently stops event delivery while `isListening` stays true — a
lender bot watching `LoanDefaulted` goes blind. **Fix:** block heartbeat +
watchdog; on provider `error` or a stall, re-subscribe and backfill missed
events via `queryFilter` from the last seen block. **L9:** `stop()` called
`removeAllListeners()` on shared contracts (killing other code's subscriptions)
— now removes only our own handlers. Tests: `test/sdk/event-listener-reconnect.test.js`.

---

## 4. LOW (all fixed)

| # | Issue | Fix |
|---|-------|-----|
| L1 | `validation.js` accepted NaN/float | `Number.isFinite`/`Number.isInteger` (commit `5560635`) |
| L2 | `Quickstart.borrow` no input validation, unit hazard | Authoritative validation at the choke point |
| L3 | LLM wrappers' `if (d<7\|\|d>365)` bypassed by NaN | `Number.isInteger` guards in all 3 wrappers |
| L4 | Python `int(amount*1e6)` truncates (19.99→19989999) | `Decimal` helper `_usdc_units` |
| L5/L6 | Nonce from `'latest'` races on rapid sends | `'pending'` (Python `_send` + SpecularAgent ×2) |
| L8 | StateManager shared `lastUpdate`, per-key TTL wrong | Per-key timestamps stamped on refresh |

---

## 5. Contract & config integrity

- **No audited `.sol` changed since the WORLDCLASS deploy (2026-05-17).** Working
  tree clean for contracts. The three fixes are present in `AgentLiquidityMarketplaceV6.sol`:
  §B1 `isInPoolLenders` gate, §S1 `claimInterest` decrements `availableLiquidity`,
  §S5 `activeLoanCount` O(1) counter.
- **Only post-audit contract:** `AgentCreditFaucet.sol` (deployed 2026-05-22,
  Arc + Base). Standalone, does not modify audited contracts. Low-risk
  (Ownable+ReentrancyGuard, SafeERC20, CEI, per-agent claim dedup, 100 USDC cap)
  but **outside WORLDCLASS scope — include in the external audit.**
- **Config:** Arc/Base configs point at correct V6 addresses. Fixed drift in
  untracked `src/integrations/langchain/config.js` and `src/moltbook/*.js`, which
  pointed Base at the paused v4 `0xd7b4…1C8f` → repointed to canonical V6.

---

## 6. Secrets

- `.env` correctly gitignored; current production key found only in `.env`.
- **ACTION REQUIRED — rotate `MOLTBOOK_API_KEY`.** The live key was hardcoded as
  a fallback (removed, now env-only) but is **already in public git history**
  (commit `a8efbf8`). Removing the code does not revoke it — rotate Moltbook-side.
- `.gitignore` gaps closed: singular `*-wallet.json` key dumps, `moltbook-posts/`,
  `test-results/`.
- 15 historical test keys + the known-compromised `0x6560…FcE2` remain in public
  history; treat all as permanently burned (never fund/reuse).

---

## 7. Remaining (documented, NOT fixed)

**x402 lower-severity (LOW/INFO):**
- F3 — client auto-borrows up to `maxPayment` before learning the price (capital
  inefficiency; real spend still capped). Use `previewPaymentRequirements`.
- F4 — `stub` mode serves the resource + books phantom revenue with no
  verification; it's the default on facilitator-less networks (arc). Gate behind
  an explicit opt-in before any production-adjacent use.
- F5 — `resource` derived from client `Host` headers (only matters if a
  downstream facilitator replay-keys on it).
- F6 — unauthenticated `/__specular_x402/stats` leaks wallet/pool/revenue; 500s
  echo raw `e.message`. Gate + generic error body.
- F7 — `facilitator` mode trusts remote `success` with no on-chain confirmation
  (mitigated: default facilitator is base-sepolia only; Base mainnet self-settles).

**SDK:**
- L7 — repayment uses a client-side interest figure + exact approve. Safe today
  (interest fixed at `loan.duration`), but non-zero→non-zero approve would break
  on USDT-like tokens if the marketplace ever accepts one.

**Ops:**
- **P4 Base mainnet journey** un-runnable: secure wallet has ~0.0000085 ETH on
  Base, needs ~0.0005 ETH gas.

---

*Generated with Claude Code. All fixes carry regression tests under `test/sdk/`.*
