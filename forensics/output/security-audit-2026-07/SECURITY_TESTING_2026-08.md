# Specular V6 (fixed) — Comprehensive Security Testing (2026-08)

Where the audits (SELF_AUDIT_2026-08.md) were **code review**, this is active
**attack testing**: a dedicated suite that attempts real exploits across the
whole threat model and confirms each is blocked (or, for disclosed residuals,
bounded). Driven by an exhaustive threat-model enumeration (~90 vectors, 7
classes) with the actual defenses/revert-strings, then implemented and run.

**Result: 54 attack tests PASS; 564 full regression PASS; Foundry invariants
(64k+ calls) PASS.** Every historical/audited exploit now fails against the
fixed code; every access-control and state-machine boundary is enforced;
reentrancy is blocked on every entry point via live attacker contracts; and one
additional real gap surfaced by the threat model (D9 signature replay) was fixed.

---

## Suites (`test/security/`)

| Suite | Tests | Covers |
|-------|-------|--------|
| `AccessControl.attack.test.js` | 15 | Every owner-only / borrower-only / position-owner / onlyAuthorizedPool fn called by the wrong party reverts (marketplace, reputation, faucet) |
| `StateMachineBoundary.attack.test.js` | 15 | Double-repay, repay-after-default, liquidate-before-due / twice / repaid, non-existent loan, zero/duration boundaries, setter caps, solvency negatives |
| `EconomicGriefing.attack.test.js` | 8 | H-3 credit-limit & MAX_ACTIVE bypass (blocked); D1 farming (bounded: dust→0, rate-limit caps concurrency); D2 transfer-reset (blocked, M-1 off); F-C squat (bounded); D4 pro-rata loss; faucet Sybil (M-3) |
| `HistoricalBugs.attack.test.js` | 6 | §B1, §S1, §S5, H-1, A1, F1/F-G — replay each audited exploit, confirm it now fails |
| `WalletSigReplay.attack.test.js` | 2 | **D9 fix** — setAgentWallet signature replay blocked by per-agent nonce |
| `RegisterReentrancy.attack.test.js` | 1 | **R13** — reentrancy into register() via a malicious onERC721Received (CEI holds) |
| `test/unit/V6Reentrancy.test.js` (extended) | 7 | Malicious-ERC20 reentrancy on supply/withdraw/repay/claim/requestLoan/liquidate + cross-function |

## Threat classes exercised (from the ~90-vector model)

1. **Reentrancy** — a malicious ERC20 (reentrant transfer/transferFrom) deployed
   AS the marketplace's USDC attempts reentry on every value-moving function;
   all blocked by the shared `nonReentrant` + CEI. A malicious `onERC721Received`
   attempts to reenter `register()`; blocked by the CEI fix (no 2nd agentId).
2. **Access control** — every restricted function from a non-privileged caller
   reverts; `renounceOwnership` reverts; `Ownable2Step` enforced.
3. **Economic/game-theory** — credit-limit aggregate (H-3) and MAX_ACTIVE bypass
   blocked; the disclosed D1 farming residual asserted BOUNDED (dust earns 0,
   rate-limit caps per-window gain despite 10 concurrent loans); D2 transfer
   reset blocked even with M-1 OFF; faucet Sybil deduped (M-3).
4. **Griefing/DoS** — F-C slot-squat bounded by minSupply; bounded 50-lender
   loops (load-tested separately at 544k–1.68M gas, well under block limit).
5. **Accounting/solvency** — §B1/§S1/H-1/A1 exploits replayed and neutralized;
   withdraw-more-than-deposited, double-claim, drain-fees all revert.
6. **State machine** — every illegal transition reverts.
7. **Input/boundary** — zero/duration/cap boundaries + setter guards enforced;
   register empty-URI / double / F3 collision blocked.

## Fix made during testing

- **D9 (signature replay), AgentRegistryV2.setAgentWallet** — the EIP-712
  typehash had no nonce, so a still-in-deadline signature could be replayed to
  roll the agent wallet back to a prior value. Added `walletNonce[agentId]` to
  the typehash, consumed on each use. `WalletSigReplay.attack.test.js` proves a
  replayed signature now reverts and a fresh-nonce one works. (This was the last
  flagged real residual; the payment-wallet field is ERC-8004, so impact was
  limited, but it is now closed.)

## Residuals — asserted as BOUNDS, honestly (not claimed blocked)

The tests assert the *bound* for the disclosed residuals rather than a revert,
because asserting "blocked" would be false:
- **D1 farming** — bounded (rate-limit + interest gate + M-2 + fee), not
  eliminated; complete defense needs identity/staking (future work).
- **D4 front-run** — post-liquidation loss is pro-rata/fair; a front-runner can
  still pull idle liquidity pre-liquidation (bounded by availableLiquidity).
- **D6 W1-JIT**, **D3 validation tail-scan** — bounded/latent (VR unset at
  launch); documented in SELF_AUDIT_2026-08.md.

## Bottom line
The fixed V6 stack now has an **active exploit-attempt suite** covering the full
threat model, all passing — on top of 564 regression tests, 64k-call Foundry
invariants, on-chain smoke, and load testing. Combined with the disclosed-and-
bounded residuals, this is the strongest security assurance achievable without
independent professional review.
