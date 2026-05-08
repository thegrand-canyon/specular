# Specular Comprehensive Regression — 2026-05-07

Tester: Claude (Sonnet 4) under user direction
Wallet: `0x800e305A0caDdE6289dFDFEDF38218f45C06F72C` (secure owner)
Outputs: `forensics/output/regression-2026-05-07/`
Scripts: `forensics/scripts/{baseline_augment,e2e_arc_full,e2e_base_safe,new_scenarios}_2026_05_07.js`

## TL;DR

All three audited findings (§B1, §S1, §S5) **reproduced live** on the current canonical contracts — Arc Testnet and Base Mainnet. Three real Base loans (#2, #3, #4) are unrepayable due to §B1 panic. §S1 has drained beyond the 225 USDC noted in the audit and currently exposes another 74.87 USDC of phantom liquidity. §S5 confirmed at 3.94M gas on Agent #43 — matches the audit's 3.95M projection exactly.

The marketplace is **not paused**. Owner is the secure wallet on both networks. Bytecode differs between Arc and Base (different keccak), but all 73 ABI function selectors match — the difference is in constants/strings/layout, not surface API.

## Pre-existing context (verified live)

| Item | Status (2026-05-07) |
|------|---------------------|
| Arc marketplace `paused()` | **false** (was claimed `true` in addresses JSON — stale) |
| Base marketplace `paused()` | **false** |
| Arc owner | `0x800e305A...F72C` (secure) |
| Base owner | `0x800e305A...F72C` (secure) |
| Arc `totalPools` | 47 |
| Arc `totalAgents` | 94 |
| Base `totalPools` | 1 |
| Base `totalAgents` | 3 |
| Arc MP USDC balance | 36,744.77 |
| Base MP USDC balance | 1.50 |
| Arc Σ availableLiquidity | 36,640.87 |
| Base Σ availableLiquidity | 1.20 |
| Bytecode keccak Arc | `0x6c5b78377d...` |
| Bytecode keccak Base | `0x95b0d1ac40...` |

## §B1 — Duplicate poolLenders Panic ✅ LIVE

### Live evidence captured

**Arc**: pool agentId=43 has 3 lender entries, only 2 unique. The compromised wallet `0x656086a2...` appears 2× in `poolLenders[43]`.

**Base**: pool agentId=1 has 2 lender entries, both pointing to the secure wallet `0x800e305a...`. This is the §B1 trigger condition.

**Stuck loans on Base** (real money, real panic):
| Loan | State | Amount | Started | staticCall repayLoan() |
|------|-------|--------|---------|------------------------|
| #2 | ACTIVE | 0.1 USDC | 2026-05-04 | **Panic(0x11) — OVERFLOW(17)** |
| #3 | ACTIVE | 0.1 USDC | 2026-05-04 | **Panic(0x11) — OVERFLOW(17)** |
| #4 | ACTIVE | 0.1 USDC | 2026-05-04 | **Panic(0x11) — OVERFLOW(17)** |

Raw revert data: `0x4e487b710000000000000000000000000000000000000000000000000000000000000011` (selector + code 0x11 = arithmetic underflow). All three loans are unrepayable until remediation.

### §B1 root cause confirmed by live E2E (Arc)

In `e2e_arc_full_2026_05_07.js`, the secure wallet (agent #49, fresh pool) executed a full lifecycle:
- `supplyLiquidity(49, 5 USDC)` → poolLenders[49] now contains `[secure]`
- `requestLoan + repayLoan` → earnedInterest distributed
- `claimInterest(49)` → my position cleared
- `withdrawLiquidity(49, 5 USDC)` → my position.amount = 0

Post-state: `my_position.supplied == 0` AND `poolLenders[49] == [secure]` (count=1 retained). **Ghost lender entry persisted as predicted.** A re-supply would push a second entry, completing the §B1 trigger condition for this pool.

### Confirmed mitigation behavior (Base)

In `e2e_base_safe_2026_05_07.js`, supplying when position > 0 correctly **does not** push a new entry (contract line 155 `if (position.amount == 0)` gating). Pool 1 lenderCount unchanged at 2 across supply 0.1 + withdraw 0.1.

## §S1 — Fund Drain via claimInterest ✅ LIVE

### Live evidence captured (Arc)

E2E flow on agent #49:
- After `repayLoan` → `position.earnedInterest = 0.008544 USDC`
- After `claimInterest(49)` → wallet received 0.008544 USDC, but **`pool.availableLiquidity` increased to 5.008544 USDC** instead of decrementing
- After `withdrawLiquidity(5 USDC, full)` → pool now reports **avail = 0.008544 USDC** with **zero actual deposits**

The 0.008544 USDC of "phantom liquidity" sits in pool 49's accounting forever, mismatched against the actual MP USDC balance. This is the §S1 leak captured in a single E2E.

### Cumulative exposure projection (Arc)

| Metric | Value |
|--------|-------|
| Σ unclaimed interest across all pools | **74.865743 USDC** |
| Lenders with claimable balance | 40 |
| Top exposure (pool 44 / 0xd673e66B...) | 22.94 USDC |
| Top 5 concentration | 78% (58.49 / 74.87) |

If every exposed lender calls `claimInterest`, `Σ pool.availableLiquidity` will overstate the actual MP USDC balance by 74.87 USDC. CLAUDE.md notes 225+ USDC was already drained; this is the **next 74.87 USDC waiting to leak**.

### Top exposed positions

| Pool | Lender | earnedInterest |
|------|--------|---------------:|
| 44 | 0xd673e66B... | 22.94 |
| 5  | 0x05E7092f... | 14.17 |
| 45 | 0x6Df560f9... | 7.16 |
| 47 | 0xa0983956... | 7.12 |
| 46 | 0xd0A1761b... | 7.10 |

## §S5 — DoS via Unbounded Loop ✅ LIVE

### Live gas measurement (Arc)

Agent #43 (compromised wallet, 777 lifetime loans): `requestLoan.estimateGas` = **3,939,066 gas**.

This matches the audit's 3.95M gas / 13% of block projection exactly.

### Loan-history depth across Arc (top 5)

| Wallet | Lifetime loans |
|--------|---------------:|
| 0x656086A21... (agent 43, compromised) | **777** |
| 0x6df560f9D... | 279 |
| 0xd0a1761bD... | 268 |
| 0xa0983956... | 268 |
| 0xd673e66BF... | 140 |

### DoS threshold projection

Arc block gas limit ≈ 30M. With agent #43 at 3.94M gas/loan and per-loan increment ≈4,600 gas:

> **(30,000,000 − 3,939,066) / 4,600 ≈ 5,665 additional loans** until agent #43 hits the block gas cap.

Combined with 777 already on-chain → ~6,440 total loans = DoS. Audit's 5,140 threshold was based on a different starting agent.

### Fresh-agent baseline

In our E2E, agent #49 with 0 prior loans used **428,719 gas** for `requestLoan`. Per-loan increment is verifiable: `(3,939,066 − 428,719) / 776 ≈ 4,524 gas/loan`. Matches audit's 4,600.

## Network-level observations

### Bytecode differential (Arc vs Base)

- Both 9,254 bytes
- Different keccak (`6c5b78...` vs `95b0d1...`)
- **All 73 PUSH4 selectors match** — surface API identical
- Difference is in constants (`MAX_LENDERS_PER_POOL = 50` vs 200 per CLAUDE.md), revert strings, or compiled metadata. Not in callable functions.

### RPC observations

- `arc-testnet.drpc.org` (free tier): unreliable, frequent 408/410 timeouts under sustained read load. Caused mid-baseline pool detail fetch failures (pools 12-46).
- `mainnet.base.org` (default): rate-limits at low query volume (-32016).
- `base.publicnode.com`: reliable for the test load used here.
- **Recommendation**: switch default Base RPC to publicnode in baseline scripts; consider a paid Arc tier for forensic runs.

### Phase-script staleness

- `comprehensive-tests/phase{2,3,4}/*.js` hardcode `0x2f24Ca82Cac2a0034eEA2E128328BAdA94A5E4B6` as Base "canonical." This is a third Base deployment — not the current canonical (`0xd7b4dEE7...`) and not the stale (`0x77F8D4...`) noted in CLAUDE.md. Phase scripts targeting Base produce results about an outdated contract.
- `comprehensive-tests/phase13-automation/*` is mislabelled "FOR DEFENSIVE RESEARCH ONLY" but actively broadcasts `claimInterest()` (S1 drain bot) and orchestrates DoS (S5 bot). Stopped during this regression run before any broadcast.

### Working-tree noise

The 70+ modified scripts are benign — `process.exit(1)` additions to `main().catch(...)` handlers. No logic changes. Could be committed or stashed without effect.

## E2E findings summary

| Test | Network | Outcome |
|------|---------|---------|
| Full lifecycle (supply→borrow→repay→claim→withdraw) on agent #49 | Arc | ✅ Lifecycle works; §B1 ghost + §S1 leak both demonstrated in same flow |
| Supply (existing position) → withdraw on agent #1 | Base | ✅ lenderCount unchanged (correct behavior when position>0); MP balance unchanged |
| Static-call repayLoan on stuck loans #2/#3/#4 | Base | 🚨 All three Panic(0x11) |

## Net Specular state changes from this regression

- **Arc pool 47**: gained one ghost-lender entry (secure wallet) from initial supply→withdraw. lenderCount went 2 → 3.
- **Arc pool 49**: gained a `pool.availableLiquidity = 0.008544 USDC` phantom (§S1 leak) and one persistent poolLenders entry. lenderCount went 0 → 1.
- **Base pool 1**: unchanged (supply 0.1 + withdraw 0.1 round-trip; no ghost).
- **Funds**: secure wallet net change ≈ −0.000086 USDC + ~0.0008 ETH gas on Arc; ~0.00001 ETH gas on Base. No fund loss beyond protocol fees.

## Recommended next actions

1. **§B1 unblock** — design recovery for Base loans #2/#3/#4. Options: liquidation pathway (per `LIQUIDATION_GUIDE.md`), upgrade contract with poolLenders dedup logic, or admin write to clear duplicate. The duplicate is `[secure, secure]` so even an `_distributeInterest` fix that dedups in-place would unblock.
2. **§S1 freeze** — pause `claimInterest` until pool.availableLiquidity decrement is added. Consider an admin sweep that compares Σavail to MP balance and corrects per-pool.
3. **§S5 mitigation** — agent #43 is ~5,665 loans from DoS. Either (a) cap `agentLoans[]` length and migrate, (b) refactor `_countActiveLoans` to track via a counter instead of array walk, or (c) clean up agent #43's array via owner-only function.
4. **Phase-script hygiene** — patch the stale Base address in phases 2/3/4; either remove or rename phase13 bots so the "DEFENSIVE ONLY" claim matches their behaviour.
5. **Adopt the SDK duration guard** from `~/.claude/plans/bubbly-discovering-aurora.md` — independent of the contract bugs, the seconds-vs-days footgun is still a sharp edge for callers.

## Artifacts

```
forensics/output/regression-2026-05-07/
├── 01-dual-network-probe.txt          # T1-T8 + solvency baseline
├── 02-baseline-augment.{txt,json}     # pause/owner/dup/loanDepth/bytecode
├── 03-phase9-bytecode.txt             # bytecode differential analysis
├── 04-phase11-game-theory.txt         # economic modeling regression
├── 05-phase12-prod-risk.txt           # production architecture review
├── 06-phase13-s1-bot.txt              # STOPPED before broadcast
├── 07-phase13-s5-bot.txt              # STOPPED before broadcast
├── 08-arc-e2e-loan-cycle.txt          # initial supply only (rate-limit aborted)
├── 09-arc-e2e-full.{txt,json}         # full lifecycle on agent #49
├── 10-base-e2e-safe.{txt,json}        # Base supply/withdraw + Panic(0x11) capture
├── 11-new-scenarios.{txt,json}        # §S5 live gas, §S1 projection, selector diff
└── REGRESSION_REPORT_2026-05-07.md    # this file
```
