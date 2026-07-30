# Specular Comprehensive Security Audit — Round 2 (2026-07)

Second comprehensive wave: **new scopes** not covered in round 1 — Solidity
contracts at source level, frontend/browser, the API server, and dependencies —
plus a fresh full-SDK/x402 re-audit of HEAD. Four parallel review agents +
adversarial reproduction. This round found a **CRITICAL on-chain bug** the
WORLDCLASS audit missed.

**Testing wave:** unit **472 passing** (+7 this round), live on Arc: JS 35/35,
Python 28/28, concurrent-load 50/50, all agent templates + x402 loop.

---

## Fixed + committed this round

| # | Sev | Area | Finding | Commit |
|---|-----|------|---------|--------|
| **H-1** | **CRITICAL** | contract | Interest routed to fees (rounding dust + `qualifiedTotal==0`) was double-counted — §S1 phantom liquidity **reintroduced** via the W1 code. `availableLiquidity` inflated permanently; eventual pool insolvency. | `b6a192d` |
| **H-2** | HIGH | contract | `withdrawLiquidity` never freed a lender's slot → supply→withdraw from 50 addrs permanently occupies `MAX_LENDERS_PER_POOL`, locking out all future lenders. | `7c5cd6a` |
| F1 (XSS) | HIGH | frontend | Stored XSS via attacker-controlled on-chain agent name, executing for every leaderboard visitor. | `42f83ff` |
| F2 (XSS) | MED | frontend | XSS via unescaped API credit-report / tier strings. | `42f83ff` |
| F3 | HIGH (pre-prod) | frontend | Landing Privy mock returned `Wallet.createRandom()` as a user signer. | `42f83ff` |
| x402 #4 | MED | SDK | Each 402 retry signed a new independently-settleable EIP-3009 auth (up to `maxRetries × maxPayment` per request). Now one auth per request. | `61c3c0d` |
| EL #3 | nit | SDK | Dead-code fallback in dedup key. | `61c3c0d` |

All carry regression tests (`test/unit/V6InterestSolvency.test.js`,
`V6LenderSlotReclaim.test.js`, updated `V6PropertyFuzz`, and `test/sdk/*`).

### H-1 detail (the critical)
`repayLoan` adds the full `lenderInterest` to `pool.availableLiquidity` (line
362) to back lenders' `earnedInterest` claims; `claimInterest` decrements
`availableLiquidity` when paying each lender (§S1 fix). But `_distributeInterest`
routed interest to `accumulatedFees` in two paths **without** decrementing
`availableLiquidity` — rounding dust (every multi-lender repay) and the whole
`lenderInterest` when no lender qualifies. Since `withdrawFees` moves USDC out
but never touches `availableLiquidity`, the routed amount was counted twice.
Reproduced: solvency invariant `USDC_balance ≥ Σ availableLiquidity + fees`
failed by exactly the dust; fixed by decrementing `availableLiquidity` on both
fee-routing paths.

---

## Verified NOT fixed — require an owner decision

### Contracts (need fix + redeploy + migration — a major operation)
The two contract fixes above are **source-only**; the deployed Arc V6 and Base V6
bytecode still contain H-1/H-2. These, plus the below, argue for a re-audit +
redeploy before further mainnet exposure:

- **H-3 (HIGH) — credit limit is per-loan, not aggregate.** `requestLoan` checks
  `amount ≤ creditLimit` per loan and `activeLoans < 10`, but `calculateCreditLimit`
  never subtracts outstanding principal → a 0-collateral agent can hold 10 × limit
  (up to 250k USDC) unsecured. **Not fixed** — the fix (track outstanding principal
  and check the aggregate) changes credit semantics; wanted a design decision.
- **M-1 — agent NFT transfer resells reputation + borrowing rights** against
  lenders' liquidity. **M-2 — cheap reputation farming** (flat +10 per repay, no
  min hold time) enables H-3. **M-3 — faucet Sybil**: register→claim→transfer NFT→
  re-register drains the faucet's USDC. **M-4 — socialized-loss ordering** on
  default DoSes the last withdrawer. All verified; none fixed.
- LOW: L-1 `notifyRefill` event spoofing, L-2 validationRegistry can DoS
  `requestLoan`, L-3 init-score doc mismatch (100 vs documented 0).

### Dependencies (need an upgrade decision)
`npm audit`: **82 vulns (2 critical, 20 high, 41 moderate, 19 low)**, all with
fixes. **Do NOT run `npm audit fix --force`** — npm's suggested fixes for the
prod chains (`x402`, `@xmtp/xmtp-js`) are semver-major *downgrades*. The safe
non-major `npm audit fix` clears `protobufjs` (critical, xmtp chain), `axios`
(high, x402 chain), `handlebars` (critical, dev/coverage) and others. Python
`requirements.txt` is unpinned (`>=`) — recommend pinning + a lockfile.

### Remaining LOW SDK (from the fresh HEAD re-audit)
- #1 borrow-collateral TOCTOU (rep drop between off-chain read and on-chain pull
  → revert; fail-safe). #2 residual allowance after a failed op (bounded, not a
  drain). #5 `totalSpent` counts unsettled auths. #6 Python `onboard()` lacks the
  JS RPC-propagation polling. #7 stats bearer-token compared non-constant-time.

---

## Checked and clean
- **Contracts:** reentrancy (nonReentrant + CEI, USDC has no transfer hooks),
  access control on every state-changer, loan state machine (no double-repay /
  early-liquidate / re-disburse), §S5 counter, migration helpers, fee bounds.
- **Frontend/API:** no private keys in browser code, no eval/child_process, no
  SSRF (network param whitelisted), server holds no keys and returns only
  unsigned calldata, SIWA verifies signer + on-chain ownership, tx-builder input
  validation solid.
- **Secrets:** `.env` gitignored + untracked; no live keys/API-keys/credentialed
  RPC URLs in the tree; this session's new files clean; `.gitignore` additions
  verified. (MOLTBOOK key still history-only, pending owner rotation.)
- **Supply chain:** no git-URL deps, no install lifecycle scripts, no typosquats,
  lockfile present.

---

## Open owner actions (carried forward)
1. **Rotate `MOLTBOOK_API_KEY`** (public git history).
2. **Fund the Base secure wallet** (~0.0005 ETH) — unblocks P4 + owner txs.
3. **Decide the contract path**: re-audit + redeploy V6 with H-1/H-2 (fixed in
   source) and H-3/M-1..M-4 (needs design), then migrate Arc + Base.
4. **Decide the dependency upgrade** (safe non-major `npm audit fix` + retest).

*Round-1 report: `SDK_SECURITY_AUDIT_2026-07.md`. All fixes tested; suite 472 passing.*
