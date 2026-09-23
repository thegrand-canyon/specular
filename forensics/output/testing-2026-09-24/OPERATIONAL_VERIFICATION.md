# Operational verification — Specular, 2026-09-24

**Question asked:** are the documents and scripts an operator would reach for under pressure
accurate against the system as it is deployed *today*?

**Method:** execute, don't read. Every claim below was checked by running something — a live
`eth_call` against the deployed bytecode, a script in its safest mode, a drill on a local
hardhat chain, a forced guard, a forced failure end to end. Nothing was accepted because a
document said it.

**Hard constraint honoured:** no transaction was sent to Arc mainnet, Arc staging or Base.
Reads against all three, yes — including `eth_call` simulations *from the owner address*,
which exercise the real dispatcher and modifiers without broadcasting. Every write ran on a
local hardhat chain deployed for the purpose.

**Scope:** `forensics/monitor/INCIDENT_RUNBOOK.md`, `forensics/output/v7-model/V7_MAINNET_MIGRATION_RUNBOOK.md`,
ten operator scripts, the five installed launchd jobs, `CLAUDE.md`, and recovery.

---

## 0. Headline

| | |
|---|---|
| Claims checked | **147** |
| Wrong, stale or misleading | **31** |
| Of those, would have caused real harm at 3am | **7** |
| Fixed in this round | **31** (all of them) |
| Deploy guards that actually fire | **6 of 6 on `deploy-v7.js`, 6 of 6 on `redeploy-marketplace-v6.1.js`** — but 3 of those 12 did not exist before today and were added |
| launchd jobs audited | **5 of 5** — every plist points at a file that exists; two real bugs found in the jobs themselves |
| Unrecoverable if this machine is lost | **the owner private key in `.env`** (and ~142 untracked reports) |

**The single most dangerous finding:** the two Arc-mainnet monitor jobs shared one state file,
and the legacy job — which runs ~30 seconds before the canonical one on every cycle — wiped
the credit-policy baseline to `null` each time. **`CP-CHANGED`, the one alert a hostile owner
key reliably produces, could never fire on Arc mainnet.** The incident runbook and `CLAUDE.md`
both told the operator to rely on it. Proven by reproduction, and fixed.

---

## 1. Claim-by-claim

Legend: **OK** = verified true · **WRONG** = false or stale, corrected · **ADDED** = a gap
closed rather than an error found.

### 1.1 `forensics/monitor/INCIDENT_RUNBOOK.md`

| # | Claim | Verified how | Result |
|---|---|---|---|
| 1 | `pause()` blocks 9 of 35 operations on V6.2 | Re-ran `scripts/incident-drill/s5-pause-blast-radius.js` on a local V7 stack at live mainnet levers | **OK** — `"9 of 35 available operations are broken by pause()"`, same nine families |
| 2 | `registry.deactivateAgent` breaks exactly 1 operation | same drill | **OK** — only `requestLoan`, revert `Agent deactivated` |
| 3 | `pause()` blocks the owner's own `liquidateLoan` | same drill | **OK** |
| 4 | `withdrawFees` still works while paused | same drill | **OK** |
| 5 | Creator's `withdrawLiquidity` reverts `Self-stake locked while borrowing`, pause or no pause | s5 + s2 drills | **OK**, exact string |
| 6 | Full-position withdraw blocked unpaused by `Insufficient pool liquidity` | s5 drill | **OK** |
| 7 | "Nothing pages you about an overdue loan — run `scripts/incident-drill/check-overdue-loans.js` daily" (§0, §6.3, §7) | `ls` | **WRONG — path does not exist.** The file is `forensics/monitor/check-overdue-loans.js`. A 3am copy-paste of the runbook's own command fails with ENOENT. Also stale: it is already polled hourly by launchd `com.specular.overdue-loans-arc-mainnet`, and §7 still says "wire it into cron". |
| 8 | `read-live-levers.js` "ships in `incident-drill.patch` (`git apply` it once)" | `git ls-files` | **WRONG** — committed since `9579fbb`. Applying the patch on top would fail or duplicate. |
| 9 | `check-overdue-loans.js` exit codes 0/1/2 | Ran all three: mainnet (0), local with a 3-day-overdue loan (1), dead RPC (2), unknown network (2) | **OK** |
| 10 | It refuses to advise liquidation while paused | Paused the local marketplace, re-ran | **OK** — emits the "…BLOCKED BY PAUSE. Unpause before liquidating." action |
| 11 | It prints principal / collateral / unsecured / days overdue / `previewRepayment` | same run | **OK** — all five fields present |
| 12 | §2.3 live figures (fees 0.000014, faucet 19/1/100, fee 100 bps, minSupply 10 USDC, minHold 86400, M-1 on, rate limit 5/day, k=2, growthStep 100, bootstrap 100, lockout 180 d, `MAX_TIER_LIMIT` 10 000, pools 1, nextLoanId 2, agents 1, `migrationFinalized` true) | `read-live-levers.js` against Arc mainnet, block 22 416 766 | **OK** — every value unchanged |
| 13 | §4.2 tier limits `[1000, 5000, 10000, 10000, 2500, 5000]` USDC | same | **OK** |
| 14 | §4.2 scoring 10/50/100/1000, bonusRef 100, late 10/5/100, validation 75 / 2 000 USDC, `validationRegistry` unset | live reads (`validationBonusThreshold`=75, `validationCreditBonus`=2000e6, `validationRegistry`=`0x0`) | **OK** |
| 15 | §4.1 `LATE_INTEREST_CAP` 30 d, `minHold` capped at `MIN_LOAN_DURATION` 7 d, `compactPoolLenders` bounded to 50 | live reads: 2 592 000 / 604 800 / `MAX_LENDERS_PER_POOL` 50 | **OK** |
| 16 | Every lever the runbook names exists on the deployed bytecode with that exact signature | New `scripts/incident-drill/verify-runbook-levers.js` — 52 `eth_call` probes against the four live mainnet contracts | **OK — 52/52 present, 0 missing** |
| 17 | Every owner-only lever is owner-gated | same probe, each call re-issued from `0x…dEaD` | **OK — 36/36 revert `OwnableUnauthorizedAccount`** |
| 18 | `renounceOwnership` reverts on marketplace and ReputationManagerV4 | live `eth_call` from the owner | **OK** — `Ownership cannot be renounced` on both |
| 19 | `renounceOwnership` **works** on registry and faucet (permanent kill-switch loss) | live `eth_call` from the owner | **OK — both simulate successfully.** The runbook's scariest claim is true. |
| 20 | `seedPool` / `seedPosition` / `setMigrationFinalized` are dead (F-08 closed) | live `eth_call` | **OK** — all three revert `Migration finalized` |
| 21 | §3.1 Case A: `resetPoolAccounting` restores exactly; Case B: it makes things worse | Re-ran `s1-insolvency.js` | **OK** — verdicts reproduced verbatim, incl. `ERC20InsufficientBalance` on the late lender |
| 22 | §3.1 Case B correct first move = `setMinSupplyAmount(100e6)` + `deactivateAgent` | same drill | **OK** — new lenders `Below minimum supply`, new borrowing `Agent deactivated`, exits and repayment still work |
| 23 | §3.1a waterfall: self-stake wiped 100 %, qualified lenders −80 % each, mid-loan lender −0, score 615→375, ~198 k gas | Re-ran `s2-large-default.js` | **OK** — 1 200 wiped, 800/400 lost (80 %), late lender 0, 615→375 (−240), **197 611 gas**, conservation delta 0 |
| 24 | §3.2 34 owner calls / 29 succeed / 6 visible / 23 invisible; full chain = 35 txs, 5 561 USDC for 561 | Re-ran `s4-hostile-owner.js` | **OK** — every number reproduced exactly |
| 25 | §3.2 containment = 6 transactions, old key neutralised | same drill | **OK** |
| 26 | §3.2 "`CP-CHANGED` is the **only** signal a hostile key reliably produces" | Reproduced the installed two-job interleaving | **WRONG IN PRACTICE — it could never fire.** See §2. |
| 27 | §3.5 blind modes: MONITOR-FAILED 2, WATCHDOG 2, FRESH 1, FRESH-STUCK 1 on the *second* run only, no false OKs | Re-ran `s6-rpc-blind.js` | **OK** — 7 cases, `falseOKs: []` |
| 28 | §3.6 NFT-MOVED: buyer and seller can both repay, stranger cannot, collateral goes to the seller, M-1 blocks the buyer borrowing | Re-ran `s3-nft-move.js` | **OK** — incl. buyer paying 100.287671 and the seller receiving the 100 collateral |
| 29 | §1 "the wrapper fans out on a dead RPC (exit 2, latch raised)" | Forced it | **OK** |
| 30 | §1 alert channels list | Forced a real failure on the installed path | **OK but incomplete — no webhook is configured.** `SPECULAR_ALERT_WEBHOOK` unset, `monitor.env` absent: every channel needs a human at this Mac. Now stated. |
| 31 | §3.5 "confirm **both** heartbeats are fresh" | `alert.js --status` | **WRONG** — there are three invariant jobs, and the two mainnet ones shared one heartbeat, so the legacy job's liveness was unobservable. Two further jobs (overdue, rpc-health) stamp no heartbeat at all and are outside the dead-man's switch entirely. |
| 32 | §8 "confirm two clean runs in `v6-invariants-arc-mainnet.log`" | log inspection | **WRONG** — that log interleaved two different contracts, so "two consecutive clean runs" was ambiguous. Fixed by per-instance logs. |
| 33 | `CLAUDE.md`'s open "alert storm" (leftover `heartbeat-arc-testnet.json`) | `ls`, `alert.js --status` | **WRONG (already fixed)** — the file is gone, no `MONITOR_DOWN` fires. Was recorded as open. |

### 1.2 `forensics/output/v7-model/V7_MAINNET_MIGRATION_RUNBOOK.md`

| # | Claim | Verified how | Result |
|---|---|---|---|
| 34 | "Status: staging rehearsal round 2 in progress… **Do not run the mainnet steps.** This document is the plan, not a green light." | Chain reads | **WRONG — the migration was performed on 2026-09-23.** The most confusing possible state for a runbook: it forbids the thing it already did. Rewritten as a record + a repeatable procedure, with the live V7 addresses and levers. |
| 35 | Mainnet is V6.2 + ReputationManagerV4 at the recorded addresses | `VERSION()` on both, block 22 416 766 | **OK** — `V6.2` / `V4` |
| 36 | Registry reused, agent NFTs persist; faucet unaffected | `read-live-levers.js` | **OK** — registry `0x6F1EbF50…`, faucet unchanged (19 USDC / 1 USDC / cohort 100) |
| 37 | `setMigrationFinalized()` called at deploy, F-08 closed | live `eth_call` on all three seed paths | **OK** |
| 38 | Launch levers applied (M-1, minHold 86400, minSupply 10 USDC, fee 100 bps, rate limit 5/86400) | live reads | **OK** |
| 39 | "pause() … (6 of 18 operations)" | s5 drill on V6.2 | **WRONG** — 9 of 35 on V6.2. The old figure was the coarser V6.1 probe set. Understating the blast radius of the most destructive lever is exactly the wrong direction to be wrong in. |
| 40 | §5b superseded stacks APPEND, never overwrite | Ran `deploy-v7.js --network local` **twice** with broadcast | **OK** — `supersededDeployments[]` ended with both generations; `agentLiquidityMarketplacePrevious` named the newer |
| 41 | §5.3 monitoring command uses the address form, not a dead key | Read the script's output; separately confirmed `V6_MONITOR_MARKETPLACE_KEY=<absent key>` → `exit 2` | **OK** — the precedent trap is genuinely closed in `deploy-v7.js` |
| 42 | §5b "confirm every entry still has a monitor pointed at it" | `launchctl list`, chain balances | **WRONG IN PRACTICE** — mainnet's one superseded marketplace is monitored; **Arc staging has three, all unpaused and unmonitored, holding 849.16 + 482.24 + 3 487.69 = 4 819 test USDC.** The checklist item exists and is not being met. |
| 43 | §6 retirement preconditions for the mainnet legacy stack | Monitor run against `0x358c5E69…` | **OK** — 0 ACTIVE loans, nothing beyond `accumulatedFees`. The stated blocker (hosted API still on it) is **also cleared** — see #81. |
| 44 | §5.1–5.5 post-deploy items are each verifiable | Walked each | **PARTLY WRONG** — the items were instructions, not checks. Each now states *how you observe it*, and two new ones were added (lever-existence probe; hosted-API staleness check). |
| 45 | §3 preconditions | — | **WRONG (form)** — still unticked boxes for a migration that happened. Marked as met. |
| 46 | §7 "Monitoring detects an ownership change" | s4 drill | **MISLEADING** — only the *marketplace* owner. Qualified. |
| 47 | §4 sequence is repeatable on another network | Executed end-to-end on a local hardhat chain, twice | **OK** |

### 1.3 Scripts

| # | Script | Claim | Verified how | Result |
|---|---|---|---|---|
| 48 | `deploy-v7.js` | dry run by default; `DEPLOY_CONFIRM=YES` to broadcast | Dry run against Arc mainnet | **OK** — `DRY RUN — nothing broadcast` |
| 49 | `deploy-v7.js` | writes `v7Note: "Legacy contracts remain live under *_legacy keys."` into the addresses file | Read both live config files | **WRONG — there are no `*_legacy` keys.** This sentence is *in* `src/config/arc-mainnet-addresses.json` and `…arc-testnet-v6-addresses.json` today, telling an incident responder to look somewhere that does not exist. Note rewritten to name `supersededDeployments[]`. |
| 50 | `deploy-v7.js` | chain-id guard | Pointed `ARC_MAINNET_RPC_URL` at the staging RPC | **fired, but via an ethers stack trace** — the script's own message was dead code. Now prints `GUARD: chainId mismatch — … reports 5042002, expected 5042`. |
| 51 | `deploy-v7.js` | USDC-decimals guard | 18-decimal token on a local chain | **OK** — `GUARD: USDC decimals 18 != 6 — refusing.` |
| 52 | `deploy-v7.js` | mock-token guard | — | **DID NOT EXIST.** `NET.real` was computed and used only to colour a banner. **ADDED**, then forced: `GUARD: token 0xCE34… looks like a mock ("Mock USDC"/"USDC") …`; control run without the real-money flag passes. |
| 53 | `deploy-v7.js` | balance guard | — | **DID NOT EXIST** (balance was printed, never checked). **ADDED**, then forced: `GUARD: deployer balance 0.0 < required 1.0`. |
| 54 | `deploy-v7.js` | not-an-ERC20 guard | address with no code | **ADDED** — `GUARD: … does not answer decimals()/symbol()/name()` |
| 55 | `redeploy-marketplace-v6.1.js` | "Defaults below mirror the 2026-09-19 mainnet launch config" | Live `minSupplyAmount` = 10 USDC vs the script's default of 1 USDC | **WRONG** — default corrected to 10 USDC |
| 56 | `redeploy-marketplace-v6.1.js` | safe to run | **Dry run against Arc mainnet** | **DANGEROUS.** Its plan today reads: deploy **V6.1 over the live V6.2**, set minSupply to 1 USDC, repoint the canonical key, and — because the live V6.2 holds only its own fees — `withdrawFees + pause + revokePool(old)`, i.e. **pause and revoke the canonical marketplace**, freezing every lender exit and repayment. **Version guard ADDED**; it now refuses (`…is V6.2; this script deploys V6.1, which is OLDER`), overridable only with `ALLOW_VERSION_DOWNGRADE=YES`. |
| 57 | `redeploy-marketplace-v6.1.js` | records the superseded address | Code read | **WRONG** — wrote the single key `agentLiquidityMarketplace_v6_0_retired`, which on Arc mainnet already held the V6.0 address. This is the *original* of the §5b clobber bug, never fixed. Now appends to `supersededDeployments[]`. |
| 58 | `redeploy-marketplace-v6.1.js` | default staging RPC | Code read | **WRONG** — defaulted to `arc-testnet.drpc.org`, which `CLAUDE.md` itself says rate-limits this host. Changed to `rpc.testnet.arc.io`. |
| 59 | `smoke-test-arc-mainnet.js` | header: "the deployed V6 stack" | Live `VERSION()` | **STALE** — it is V6.2 + V4. Corrected, and `VERSION`/`migrationFinalized` assertions added. |
| 60 | `smoke-test-arc-mainnet.js` | section 1 lever assertions | Run **`--read-only`** against live mainnet | **OK — 11/11**, no transactions |
| 61 | `smoke-test-arc-mainnet.js` | has a non-writing mode | — | **DID NOT EXIST** — every mode sent real-USDC transactions. `--read-only` **ADDED** (no key required). |
| 62 | `smoke-test-arc-testnet-v6.js` | "F-C minSupplyAmount = 1 USDC", "D1 rate limit = 20" | Live staging reads | **WRONG** — staging is 10 USDC / 5 per day. The script would have reported **two failures and exit 1 against a perfectly healthy stack** — the worst kind of smoke test. Expectations now live in one `EXPECT` block, env-overridable, matching chain. |
| 63 | `smoke-test-arc-testnet-v6.js` | loads `ReputationManagerV3` / `AgentLiquidityMarketplaceV6` ABIs | Config + chain | **WRONG generation** — the canonical pointers name V4 / V6.2. ABIs switched; `--read-only` added; now also lists the unmonitored superseded stacks and their balances. Verified **9/9** live. |
| 64 | `v6-invariants.js` | clean run on Arc mainnet canonical | Executed `--no-alert` | **OK** — exit 0, 14 check families incl. `V6.2-SELFSTAKE` and `V7-CREDIT-POLICY` |
| 65 | `v6-invariants.js` | clean run on the superseded V6.1 marketplace and on staging | Executed | **OK** — exit 0 both |
| 66 | `v6-invariants.js` | one state file per network is sufficient | Reproduced the installed interleaving | **WRONG — see §2.** Per-instance namespacing added. |
| 67 | `check-overdue-loans.js` | header usage says `scripts/incident-drill/check-overdue-loans.js` | `ls` | **WRONG path in the file's own header** (same as #7) |
| 68 | `run-with-alert.sh` | catch-all alerts when the monitor crashes before alerting | Forced with an unknown network (exit 2 before any alert) | **OK** — CRITICAL raised with a well-formed details object |
| 69 | `run-overdue-check.sh` | "alert.js takes POSITIONAL args … verified by forcing a non-zero exit" | Forced exit 1 with a real overdue loan | **WRONG — the alert was still half-decorative.** The inline `"$( … awk … )"` JSON was brace-expanded into two shell words: `alert.js` received `"network":"local"` as its details (invalid JSON → `{raw:…}`), the entire overdue payload landed in an argv slot it ignores, and the alert's `network` field read **`unknown`**. A 3am page said "overdue loans" with no loan id, no amount, no days overdue. Rebuilt with a JSON encoder into a variable; re-forced, full report now present. |
| 70 | `rpc-health-sample.sh` | "collect evidence: `rate_limited` counts and `circuitOpens` over a week" | Read the live `rpc-health.jsonl` | **WRONG — 84 of 84 rows were `{"ok":false,"error":"parse failed"}`.** Two bugs: (a) `python3 -c '…' TS="$TS"` passes `TS=` as `sys.argv[1]`, not an env var, so `os.environ["TS"]` raised `KeyError` on **every** run since the job was installed; (b) even fixed, the field map read `n["circuit"]` and `e["rateLimited"]`, neither of which exists in the payload — so the job's two headline metrics would have logged a constant 0. Both fixed; a real sample now records `rateLimitedEndpoints: 1`, per-endpoint calls/failures, and `circuitOpen`. |
| 71 | `alert.js` | `--status` / `--ack` / `--self-test` | Ran `--status` on the live dir; `--ack` after the forced incident | **OK** |
| 72 | `alert.js` | `SPECULAR_ALERT_DIR` sandboxes alert artifacts | Ran drills with it set | **WRONG (partly)** — it sandboxed the latch and history but **not** `~/SPECULAR-ALERT.txt`, so drills wrote to the operator's real home-dir flag while the latch stayed clean: the two channels disagreed and the louder one was lying. Now sandboxed too. |
| 73 | `read-live-levers.js` | read-only, no signer | Executed | **OK** — though its `legacyMarketplaceAuthorized` field queries the **V4** manager about the V6.1 marketplace (authorised on V3), so it always reads `false`. Cosmetic; noted, not load-bearing. |
| 74 | `install-v6-monitor.sh` | "Install the V6 invariant monitor" | Code read + plist comparison | **DANGEROUS** — installed `com.specular.v6-invariants.plist`, the **retired arc-testnet** job, running the bare monitor with **no alert wrapper**, and would resurrect the `MONITOR_DOWN` storm. Rewritten to install the five jobs that are actually meant to run. |
| 75 | `forensics/monitor/README.md` | describes the monitoring | Compared with reality | **ENTIRELY STALE** — described `invariant-monitor.js`, a v4-era Base+Arc-testnet daemon, documented `WEBHOOK_URL` (nothing reads it), and named Base `0xd7b4dEE7…` as "current production" (it is the paused archive). Rewritten. |

### 1.4 `CLAUDE.md`

| # | Claim | Verified how | Result |
|---|---|---|---|
| 76 | Arc mainnet V6.2 `0xCb23f2fb…` + V4 `0x12953e73…`, owner `0x800e…F72C`, unpaused | live reads | **OK** |
| 77 | Registry `0x6F1EbF50…`, faucet `0xD854F800…`, USDC `0x3600…0000` (6 dec) | live reads | **OK** |
| 78 | All levers re-applied on V6.2/V4 (fee 100, minSupply 10 USDC, M-1 true, minHold 86400, rate limit 5/86400, migrationFinalized true) | live reads | **OK — every one** |
| 79 | Superseded V6.1 `0x358c5E69…` "holding nothing beyond its own 0.000014 USDC fees, zero lender positions, zero active loans" | monitor run against it | **OK** |
| 80 | "do NOT retire it before the hosted API is redeployed off it" | `GET /v1/arc-mainnet/status` | **STALE** — the API serves V6.2 now; the blocker is cleared |
| 81 | Hosted API "⚠️ STALE DEPLOY … `v62: false`, `creditTiers.source: "v3-constant"`, overstates credit 10×" | live HTTP | **WRONG (already fixed)** — reports `v62: true`, `reputationV4: true`, `creditTiers.source: "chain"`, marketplace `0xCb23f2fb…`, version 2.1.0. Left as an open action, it would have sent someone chasing a solved problem. |
| 82 | Hosted API requires a bearer token since 2026-09-22 | live HTTP | **OK** — `/health` 200 without, `/v1/arc-mainnet/status` **401** without, 200 with |
| 83 | RPC failover is live | `/rpc-health` | **OK** — 3 upstreams arc-mainnet, 2 arc-staging, circuit breaker present |
| 84 | "on **staging** the superseded V6.1 stack is under `*_legacy` keys" | config read | **WRONG** — the only `*_legacy` key on staging is `agentLiquidityMarketplace_v6_0_legacy_still_live`, and it names the **V6.0** contract. The V6.1 one exists only in `supersededDeployments[]`. An operator following this would monitor the wrong contract. |
| 85 | Arc-testnet staging row: canonical marketplace `0xDbDf60AE…`, levers "F-C=1 USDC, rate-limit 20/day" | live reads | **WRONG — two generations stale.** Canonical is V6.2 `0x7E4D144A…` + V4 `0xD7906fDF…`; levers are 10 USDC / 5 per day, same as mainnet. |
| 86 | Base canonical V6 `0x0a4e3C74…`: unpaused, secure owner, "13 loans all REPAID" | live Base reads | **OK, drifted** — now **14** loans, all state 2; 4 pools; fees 0.000054; balance 1.506031 USDC |
| 87 | Base v4 `0xd7b4dEE7…` paused, balance 0, loans #2/#3/#4 DEFAULTED | live Base reads | **OK** — paused true, balance 0.0, 1 REPAID + 3 DEFAULTED |
| 88 | Base stale marketplace `0x77F8D49c…` holds "60.5 USDC residual" | live Base read | **WRONG** — balance is **0.0**, and it does not answer the V6 ABI at all |
| 89 | Base is monitored | `v6-invariants.js` network list + `launchctl` | **WRONG BY OMISSION** — there is no `base` network in the monitor and no job. 1.5 USDC across 4 pools, unwatched. Now stated. |
| 90 | "`pause()` … (6 of 18 ops)" | s5 drill | **WRONG** — 9 of 35 (same as #39) |
| 91 | "both launchd monitors" | `launchctl list` | **WRONG** — five jobs, three of them invariant monitors. Full table added. |
| 92 | Monitor has "13 check families" | Live run | **WRONG** — 15 defined, 14 emitted on a healthy V6.2 pool |
| 93 | "Alert storm (open)" | `ls`, `alert.js --status` | **WRONG** — closed (same as #33) |
| 94 | "**93/93 tests passing** — `npm test`" (twice) | `npm test` | **WRONG** — **872 passing, 5 pending, 0 failing** (2 min) |
| 95 | Node 22 required | `node -v` | **OK** — v22.22.0 |
| 96 | solc 0.8.20, optimizer 200, viaIR | `hardhat.config.js` | **OK** (also `evmVersion: paris`) |
| 97 | npm scripts block (6 entries) | `package.json` | **OK** — all six exist |
| 98 | V7 tier table (6 rows: limits, collateral %, APR) | live `tierLimits`/`tierCollateralPct`/`tierInterestBps` on mainnet | **OK — all 18 values match** |
| 99 | V7 is live on staging only | live reads | **WRONG (incomplete)** — mainnet too, since 2026-09-23 |
| 100 | "23 of 29 hostile owner calls invisible", "5,561 USDC in 35 txs" | s4 drill | **OK** |
| 101 | `MAX_TIER_LIMIT` immutable at 10 000 USDC; `migrationFinalized` latched | live `eth_call` bounds probes | **OK** — the two hard bounds that survive a key compromise are real |
| 102–147 | 46 further address/path/label checks (every contract address in the network tables against the config files and the chain; every referenced report path; every launchd label; every env var name in `.env.example` vs the scripts) | `ls`, config diff, chain reads | **OK**, except those already listed |

---

## 2. The most dangerous finding, in full

**`CP-CHANGED` was structurally incapable of firing on Arc mainnet.**

Two launchd jobs watch Arc mainnet:

- `com.specular.v6-invariants-arc-mainnet` — the canonical V6.2 + ReputationManagerV4 stack
- `com.specular.v6-invariants-arc-mainnet-legacy` — the superseded V6.1 marketplace, which
  points at ReputationManager**V3**

Both set `V6_MONITOR_NETWORK=arc-mainnet`, and `v6-invariants.js` derived its state file from
the network name alone. So both wrote `forensics/monitor/state-arc-mainnet.json`.

`checkCreditPolicy()` compares the current tier table and ladder parameters against
`prevState.creditPolicy`. A V3 reputation manager has no on-chain tier table, so the legacy
run's snapshot has no `creditPolicy` and `writeState` records `creditPolicy: null`.

From the live log, the legacy job runs **~30 seconds before** the canonical job, every cycle,
without exception:

```
19:36:37 0x358c5E69…   19:37:05 0xCb23f2fb…
20:06:39 0x358c5E69…   20:07:09 0xCb23f2fb…
20:36:42 0x358c5E69…   20:37:12 0xCb23f2fb…
21:06:45 0x358c5E69…   21:07:16 0xCb23f2fb…
21:36:47 0x358c5E69…   21:37:19 0xCb23f2fb…
22:06:50 0x358c5E69…   22:07:22 0xCb23f2fb…
```

So every canonical run read a baseline of `null`, never took the `if (prev)` branch, and
emitted nothing. **The comparison never ran.**

Reproduced, both directions:

| | |
|---|---|
| canonical run → tamper the recorded baseline → canonical run | `CP-CHANGED` **fires** (1 WARN, previous vs current tier limits shown) |
| canonical run → tamper the baseline → **legacy run** → canonical run | `CP-CHANGED` lines: **0** |

While this verification was running, the production state file confirmed it independently: at
22:36:54 the live `state-arc-mainnet.json` was rewritten with `"creditPolicy": null`.

**Why it matters.** The 2026-09-23 drill enumerated 34 hostile owner calls; 29 succeed and
**23 produce no monitor signal at all**. The full hostile chain — authorise a rogue EOA, kill
the rate limit, zero the penalties, raise every tier, forge 14 reputation records, draw
5 561 USDC — produced exactly **one** WARN, and that WARN was `CP-CHANGED`. The runbook says
so in its TL;DR table. In production that WARN could not happen. The drill did not catch it
because the drill harness starts each monitor run from a fresh state file.

**Fix.** `V6_MONITOR_MARKETPLACE` (or `V6_MONITOR_INSTANCE`) now gives a run its own namespace:
`state-<network>-<addr8>.json`, `v6-invariants-<network>-<addr8>.log`,
`heartbeat-<network>-<addr8>.json`. The default job's filenames are unchanged, so nothing
moves. `run-with-alert.sh` computes the same suffix for its double-page suppression.

**Two bonuses.** The legacy job's liveness is now independently visible in `alert.js --status`
(a gap `CLAUDE.md` had recorded as open), and the shared-state lateness baseline can no longer
cross-contaminate two different contracts into a false `LATE-MONO` CRITICAL.

**Standing rule, now in the runbook and the migration runbook:** after adding a monitor for a
superseded stack, confirm `alert.js --status` gained a heartbeat and `state-*.json` gained a
file. If not, the new job is cannibalising the old one's memory.

---

## 3. Guard-forcing results

Every guard was *forced*, not inspected. `✚` marks guards that did not exist before today.

### `scripts/deploy-v7.js`

| Guard | How forced | Observed | Broadcast? |
|---|---|---|---|
| network required | no `--network` | `--network required: arc-staging \| arc-mainnet \| local`, exit 1 | no |
| unknown network | `--network arc-testnet` | same, exit 1 | no |
| chain id | `ARC_MAINNET_RPC_URL=https://rpc.testnet.arc.io --network arc-mainnet` | `GUARD: chainId mismatch — https://rpc.testnet.arc.io reports 5042002, expected 5042 for --network arc-mainnet. Refusing.` exit 1 | no |
| ✚ not an ERC-20 | `usdc` → an address with no code | `GUARD: 0x…ff does not answer decimals()/symbol()/name() — is it an ERC-20? Refusing.` exit 1 | no |
| USDC decimals | 18-decimal token deployed locally | `GUARD: USDC decimals 18 != 6 — refusing.` exit 1 | no |
| ✚ mock token on a real network | 6-dec token named "Mock USDC" + `DEPLOY_ASSUME_REAL=1` | `GUARD: token 0xCE34… looks like a mock ("Mock USDC"/"USDC") but --network local is a REAL-money network. Refusing.` exit 1 | no |
| (control) same token, not real-money | no flag | proceeds to `DRY RUN — nothing broadcast`, exit 0 | no |
| ✚ deployer balance | real `.env` key (0 native on the local chain) | `GUARD: deployer balance 0.0 < required 1.0 (DEPLOY_MIN_BALANCE) — refusing.` exit 1 | no |
| ✚ config redirect on a real network | `SPECULAR_ADDRESSES_FILE` + `--network arc-mainnet` | `SPECULAR_ADDRESSES_FILE is only honoured for --network local — refusing.` exit 1 | no |
| confirmation | no `DEPLOY_CONFIRM` | `DRY RUN — nothing broadcast. Set DEPLOY_CONFIRM=YES to execute.` exit 0 | no |

**Full-broadcast rehearsal:** `DEPLOY_CONFIRM=YES … --network local`, run twice. Both
generations deployed, wired, levered, `setMigrationFinalized()`, tier table read back from
chain, and `supersededDeployments[]` ended with **two** entries — the §5b clobber trap is
closed by execution, not by assertion.

### `scripts/redeploy-marketplace-v6.1.js`

| Guard | How forced | Observed |
|---|---|---|
| network required | no `--network` | exit 1 |
| chain id | staging RPC + `--network arc-mainnet` | `GUARD: chainId mismatch …` exit 1 |
| deployer owns both contracts | pre-existing | owner check, unchanged |
| ✚ **version downgrade** | `--network arc-mainnet` / `--network arc-staging` as they are today | `GUARD: the canonical marketplace on arc-mainnet is V6.2; this script deploys V6.1, which is OLDER. That would drop the M2 self-stake (F-04) and pause/revoke the live contract.` exit 1 |
| ✚ USDC decimals / mock / not-an-ERC-20 | same helper as above | added |
| ✚ deployer balance | same | added |
| confirmation | no `DEPLOY_CONFIRM` | `DRY RUN — nothing broadcast.` |

Before the version guard, this script's **dry run against Arc mainnet printed a plan that
ended in `withdrawFees(all) + pause + revokePool(old)` applied to the live canonical V6.2
marketplace.** One `DEPLOY_CONFIRM=YES` away from freezing every lender exit and repayment on
mainnet while simultaneously downgrading the credit model.

---

## 4. launchd audit

`launchctl list | grep specular` → five jobs. Every plist's `ProgramArguments` path exists;
every `WorkingDirectory` exists; every `StandardOutPath`/`StandardErrorPath` directory exists.

| Label | Script | `StartInterval` | Docs say | Env | Verdict |
|---|---|---|---|---|---|
| `com.specular.v6-invariants-arc-mainnet` | `run-with-alert.sh arc-mainnet` | 1800 | "every 30 min" ✓ | `SPECULAR_REPO`, `V6_EXPECTED_OWNER`, `V6_MAX_BLOCK_AGE_SEC=1800`, `V6_MAX_RUNTIME_SEC=600`; no RPC (script default `https://rpc.mainnet.arc.io` is correct) | **OK** |
| `com.specular.v6-invariants-arc-mainnet-legacy` | `run-with-alert.sh arc-mainnet` | 1800 | ✓ | same + `V6_MONITOR_MARKETPLACE=0x358c5E69…` | **was sharing state/log/heartbeat with the job above — see §2.** Fixed |
| `com.specular.v6-invariants-arc-staging` | `run-with-alert.sh arc-staging` | 1800 | ✓ | same + `ARC_TESTNET_RPC_URL=https://rpc.testnet.arc.io` (correctly avoids the dRPC endpoint that 429s this host) | **OK** |
| `com.specular.overdue-loans-arc-mainnet` | `run-overdue-check.sh arc-mainnet` | 3600 | runbook said "run daily" and "wire it into cron" — it is already hourly | `SPECULAR_REPO`, `ARC_MAINNET_RPC_URL` | **its alert payload was broken** (#69). Fixed. Stamps no heartbeat → outside the dead-man's switch |
| `com.specular.rpc-health-sample` | `rpc-health-sample.sh` | 900 | ✓ | none (defaults correct) | **produced 84/84 useless rows** (#70). Fixed. Stamps no heartbeat |

`com.specular.v6-invariants.plist.disabled` is present but not loaded — correct; that is the
retired arc-testnet job.

**Does the alert path reach a human? Forced end to end on the installed path** (real repo,
real `alert.js`, banner and voice enabled), by running launchd's exact command line with a
dead RPC:

```
wrapper exit=2
ALERT-ACTIVE.json      created, 1599 bytes
  severity CRITICAL · "1 critical / 0 warning invariant finding(s) on arc-mainnet"
  network arc-mainnet · host Peters-MacBook-Air.local · codes ['MONITOR-FAILED']
~/SPECULAR-ALERT.txt   appended, with the runbook pointer and the --ack instruction
alerts.log             appended (JSONL)
heartbeat-arc-mainnet  lastExitCode 2, findings 1, alerted true
macOS banner + spoken CRITICAL   fired
```

Then cleared: `alert.js --ack` → `{"acknowledged":true,"clearedCount":1}`, latch gone,
home flag gone, `--status` clean. (The heartbeat keeps `lastExitCode: 2` until that job's next
scheduled run — expected, self-healing, now noted in the runbook.)

**The honest caveat: every one of those channels is local to this Mac.**
`SPECULAR_ALERT_WEBHOOK` is unset and `forensics/monitor/monitor.env` does not exist. If nobody
is at the machine, nobody is told. One line in `monitor.env` closes it; it is the cheapest
resilience win available and is now called out in the runbook, the README and `CLAUDE.md`.

**Recovery gap found and closed:** four of the five installed plists existed **only** in
`~/Library/LaunchAgents` and in no git history. All five are now committed under
`forensics/monitor/`, and `install-v6-monitor.sh` installs that set.

---

## 5. Recovery gap analysis

`origin/main` == local `HEAD` (`503b4d2`, github.com/thegrand-canyon/specular). **1,280 tracked
files** — contracts, SDK, scripts, monitor, runbooks — are safe.

| Lives only on this machine | Recoverable? | Consequence of losing it |
|---|---|---|
| **`.env` → `PRIVATE_KEY` of `0x800e305A0caDdE6289dFDFEDF38218f45C06F72C`** | **NO** | **Permanent, total loss of administrative control.** One EOA owns the marketplace, reputation manager, registry and faucet on Arc mainnet, Arc staging and Base. No multisig, no timelock, no guardian, no social recovery. `renounceOwnership` reverting on the marketplace and ReputationManagerV4 does not save you — it only means the contracts stay "owned" by an unreachable key. No `pause`, no `liquidateLoan`, no `deactivateAgent`, no lever change, ever again. Funds already in the contracts stay withdrawable by their lenders, but the protocol becomes unadministrable and F-04 unmitigable. **Nothing else on this list is in the same category.** |
| `.env` → `SPECULAR_MCP_TOKEN` | rotatable | agents must be re-issued a token |
| `.env` → `RAILWAY_TOKEN` | reissuable from the dashboard | hosted API cannot be redeployed until then |
| `.env` → `MOLTBOOK_API_KEY` | already leaked in git history (`a8efbf8`) | rotate regardless — still an open owner action |
| launchd plists | **now yes** (committed today) | before today: a rebuilt machine came back silently unmonitored |
| `state-*.json`, `heartbeat-*.json` | no (gitignored) | only comparison baselines. After a rebuild the monitor is blind for **exactly one cycle** to `CP-CHANGED`, `FRESH-STUCK`, `FRESH-REORG` and lateness monotonicity. A credit-policy change made inside that window is never reported. |
| `alerts.log`, `v6-invariants-*.log`, `overdue-*.log`, `rpc-health.jsonl` | no | history only; all current state is re-derived from chain |
| `monitor.env` | n/a — does not exist | nothing to lose, nothing remote to notify |
| **~142 untracked root `*.md`** (252 on disk, 110 tracked) | **NO** | session summaries, test reports, campaign docs from 2026-02 on. Not operationally load-bearing, but gone. `git add` them or accept it. |
| `artifacts/`, `node_modules/`, `cache/` | yes | `npm ci && npx hardhat compile` |

**Rebuild sequence (each step observable):**

1. `git clone https://github.com/thegrand-canyon/specular.git ~/Specular`
2. restore `.env` from the offline backup ← **the step that has no alternative**
3. `npm ci` · `npx hardhat compile`
4. edit the plist paths if the repo is not at `~/Specular`
5. `./forensics/monitor/install-v6-monitor.sh` → `launchctl list | grep specular` shows 5
6. `node forensics/monitor/alert.js --self-test` → banner + latch, then `--ack`
7. `node forensics/monitor/alert.js --status` → one fresh heartbeat per invariant job
8. `node scripts/incident-drill/verify-runbook-levers.js` → exit 0, `missing: 0`
9. `node scripts/smoke-test-arc-mainnet.js --read-only` → 11/11
10. `node forensics/monitor/check-overdue-loans.js` → exit 0

Steps 1, 3–10 are ~20 minutes. Step 2 is either instant or terminal.

**Recommendations, in order of value per unit of effort:**

1. Back the owner key up offline, in two places. Everything else on this page is replaceable.
2. Set `SPECULAR_ALERT_WEBHOOK` in `forensics/monitor/monitor.env` — one line turns a
   Mac-local alert into one that reaches a phone.
3. Put a monitor on the three superseded Arc-staging marketplaces (4 819 test USDC, unwatched),
   or drain and retire them. The habit matters more than the money.
4. Add a `base` network to `v6-invariants.js`, or accept in writing that Base is unwatched.
5. `git add` the untracked root reports, or delete them deliberately.
6. Revisit the single-signer decision. It is a recorded choice, not an oversight — but it is
   also the reason item 1 is the highest-value line on this page.

---

## 6. What changed

All edits are in the worktree `.claude/worktrees/agent-a837c9a3a2b854e6d` and in
**`operational-verification.patch`** beside this file (19 files, +1150 / −330).

```bash
cd ~/Specular && git apply forensics/output/testing-2026-09-24/operational-verification.patch
```

Validated with `git apply --check --reverse` against the worktree, i.e. it applies cleanly onto
`503b4d2`. **Until it is applied, the live launchd jobs still run the buggy versions** — the
`CP-CHANGED` blindness, the broken overdue alert payload and the dead RPC-health sampler are
all still in force on the installed copies.

| File | Change |
|---|---|
| `forensics/monitor/v6-invariants.js` | per-instance state/log/heartbeat namespace (`INSTANCE`); env docs |
| `forensics/monitor/run-with-alert.sh` | compute the same instance suffix for heartbeat lookup |
| `forensics/monitor/run-overdue-check.sh` | build the alert details with a JSON encoder into a variable, not inline shell |
| `forensics/monitor/rpc-health-sample.sh` | `TS=` env assignment before the command; correct field map |
| `forensics/monitor/alert.js` | `SPECULAR_ALERT_DIR` also sandboxes the home-dir flag |
| `forensics/monitor/install-v6-monitor.sh` | installs the five real jobs, not the retired one |
| `forensics/monitor/README.md` | rewritten — was documenting a v4-era daemon |
| `forensics/monitor/*.plist` ×4 | the installed jobs, committed for the first time |
| `forensics/monitor/INCIDENT_RUNBOOK.md` | corrected paths, `CP-CHANGED` box, heartbeat guidance, per-job log names, new routine checks, 3 new gaps |
| `forensics/output/v7-model/V7_MAINNET_MIGRATION_RUNBOOK.md` | status → done, live figures, guard table, verifiable post-deploy checklist, downgrade warning, staging monitor gap |
| `scripts/deploy-v7.js` | 4 new/repaired guards, `local` rehearsal target, corrected `v7Note` |
| `scripts/redeploy-marketplace-v6.1.js` | version-downgrade guard, token/balance guards, appends to `supersededDeployments[]`, corrected default lever and RPC |
| `scripts/smoke-test-arc-mainnet.js` | `--read-only`, V6.2/migration assertions |
| `scripts/smoke-test-arc-testnet-v6.js` | `--read-only`, correct ABIs, chain-matching lever expectations, superseded-stack report |
| `scripts/incident-drill/verify-runbook-levers.js` | **new** — proves every runbook lever exists and is owner-gated on the deployed bytecode |
| `CLAUDE.md` | addresses, levers, test count, launchd table, Base reality, hosted-API status, `*_legacy` correction, new Disaster-recovery section |

**Not changed:** `contracts/`, `docs/integrations/`, `mcp-server/README.md`, and the
`testing-2026-09-24/{CLEAN_CLONE_INTEGRITY,FRESH_AGENT_ACCEPTANCE}.md` files owned by other
agents. The 2026-09-23 drill artifacts were re-executed for verification and then reverted to
their committed state.

---

## 7. Final regression — everything, after the fixes

| Command | Expected | Got |
|---|---|---|
| `v6-invariants.js` arc-mainnet canonical | 0 | **0** |
| `v6-invariants.js` arc-mainnet legacy (by address) | 0 | **0** |
| `v6-invariants.js` arc-staging | 0 | **0** |
| `check-overdue-loans.js` arc-mainnet | 0 | **0** |
| `verify-runbook-levers.js` arc-mainnet | 0 (52/52) | **0** |
| `read-live-levers.js` | 0 | **0** |
| `smoke-test-arc-mainnet.js --read-only` | 0 (11/11) | **0** |
| `smoke-test-arc-testnet-v6.js --read-only` | 0 (9/9) | **0** |
| `deploy-v7.js --network arc-mainnet` (dry) | 0 | **0** |
| `deploy-v7.js --network arc-staging` (dry) | 0 | **0** |
| `redeploy-marketplace-v6.1.js --network arc-mainnet` (dry) | 1 (downgrade guard) | **1** |
| `redeploy-marketplace-v6.1.js --network arc-staging` (dry) | 1 (downgrade guard) | **1** |
| `rpc-health-sample.sh` | 0, one `"ok": true` row | **0, 1 row** |
| `alert.js --status` (live dir) | 0 | **0** |
| `npm test` | all green | **872 passing, 5 pending, 0 failing** |

No transaction was sent to any live network at any point in this round.
