# Clean-clone integrity check — Specular `main`

**Question asked:** does `main` build and pass from a fresh `git clone`, with none of the
accumulated state in the developer's working directory?

**Answer:** yes. Every build step and every test suite passes from a clean clone on a machine
holding nothing but Node 22 (and, optionally, Foundry and Python). Zero clean-clone-only
test failures were found. The problems that *were* found are documentation and hygiene
problems, plus two untracked directories that the reports cite as their own evidence.

| | |
|---|---|
| Commit tested | `503b4d21a009aef9c140ff820be3c1c95088bb7b` — *"Untrack four analyser dumps carried in from the 2026-05 audit package (#2)"*, 2026-09-23 14:17:42 -0700 |
| Branch | `main` (confirmed via `git branch --show-current`) |
| Clone | `git clone --branch main https://github.com/thegrand-canyon/specular.git /tmp/specular-clean` — 21 MB, 163 top-level entries, no submodule recursion |
| Host | macOS 15.6 (darwin 25.6.0), Node v22.22.0, npm 10.9.4, forge 1.7.1, Python 3.14.4 |
| Verdict | **`main` is usable by someone who is not the author.** |

Three independent clones were used, to separate concerns:

* `/tmp/specular-clean` — the full run (install → compile → all suites → scripts).
* `/tmp/specular-mcponly` — a second pristine clone used to prove `mcp-server` builds and
  tests **without** the root `artifacts/`, and to prove `npm ci` (what CI uses) works.
* `/tmp/patch-verify` — a third pristine clone, used only to verify the attached patch applies.

---

## 1. Build log summary

| Step | Command | Result | Notes |
|---|---|---|---|
| 1 | `git clone --branch main …` | ✅ | Succeeds. `lib/forge-std` is a submodule and is **empty** after a plain clone — this turns out not to matter (see step 5). |
| 2 | `npm install` (root) | ✅ 1095 packages, 18 s | 24 `npm warn deprecated` lines (glob 7/10, uuid 9, `@xmtp/xmtp-js`, `@metamask/sdk*`, `@walletconnect/*`, `@safe-global/safe-gateway-typescript-sdk`, `@paulmillr/qr`, `@xmtp/consent-proof-signature`). `npm audit`: **74 vulnerabilities (19 low, 42 moderate, 13 high)** — all transitive, none blocking. |
| 2b | `npm ci` (root, second clone) | ✅ 574 packages | `package-lock.json` is in sync with `package.json`; the CI path works. |
| 3 | `npx hardhat compile` | ✅ **55 Solidity files, 33 s**, evm target `paris` | Exactly **one** warning: `AgentLiquidityMarketplace.sol:464` `getActiveAgents()` — *"Function state mutability can be restricted to pure"*. No errors. Downloads solc 0.8.20 on first run (needs network). |
| 4 | `cd mcp-server && npm install` | ✅ 116 packages, 0.5 s, **0 vulnerabilities** | |
| 5 | `cd mcp-server && npm run build` | ✅ | `prebuild` runs `scripts/extract-abis.mjs`, `build` runs `tsc && node dist/gen-openapi.js`. No TS errors. Wrote `openapi.json`. |

**Network / global-tool dependencies of the build**

* Network is required for `npm install` (registry) and for hardhat's **first** `compile`
  (it downloads the solc 0.8.20 binary into `~/.cache/hardhat-nodejs`). Nothing else in the
  build reaches the network.
* No global tool is needed to build. `forge` is needed only for `test/foundry/`; `python3`
  only for `python/`; `slither` is needed by **nothing** in the build or test path — it only
  regenerates the analyser dumps that commit `503b4d2` deliberately untracked, and the
  human-readable `.txt` summaries beside them are committed.

---

## 2. Suite-by-suite results

All numbers are from `/tmp/specular-clean` at `503b4d2`.

| Suite | Command | Pass | Fail | Pending | Exit |
|---|---|---|---|---|---|
| **Root, all of `test/**/*.js`** | `npm test` | **872** | **0** | 5 | 0 |
| ├ `test/unit` | `npx hardhat test test/unit/*.js` | 320 | 0 | 0 | 0 |
| ├ `test/integration` | " | 17 | 0 | 0 | 0 |
| ├ `test/api` | " | 39 | 0 | 0 | 0 |
| ├ `test/security` | " | 47 | 0 | 0 | 0 |
| ├ `test/v2` | " | 99 | 0 | 0 | 0 |
| ├ `test/v3` | " | 24 | 0 | 1 | 0 |
| ├ `test/v7` | " | 95 | 0 | 0 | 0 |
| ├ `test/sdk` | " | 76 | 0 | 0 | 0 |
| ├ `test/sdk-robustness` | " | 65 | 0 | 0 | 0 |
| ├ `test/sdk-v7` | " | 28 | 0 | 0 | 0 |
| ├ `test/audit-2026-09` | " | 26 | 0 | 4 | 0 |
| └ `test/audit-2026-09-fixes` | " | 36 | 0 | 0 | 0 |
| **Foundry** | `forge test` | **56** (9 suites) | 0 | 0 | 0 |
| **MCP server** | `cd mcp-server && npm test` | **151** | 0 | 0 | 0 |
| **Python SDK** | `pytest python/tests` | **35** | 0 | 0 | 0 |
| **SDK type test** | `npm run test:types` | ✅ (tsc, no output) | 0 | — | 0 |
| **CI's extra step** | `npx mocha test/api/*.test.js` | 39 | 0 | 0 | 0 |

The twelve per-directory runs sum to **872 passing / 5 pending — exactly** the `npm test`
total, so `hardhat test` covers every `test/` subdirectory and nothing is silently skipped.

`forge test` breakdown: 9 suites — `V6Invariants`, `V61Invariants`, `V61Gas`, `V7Invariants`,
`V7Gas`, `V7Dos`, `V7ScaleFixes`, `V7Storage`, `V7Soak` (`test_soak()` alone burns 8.42 G gas,
which is why `foundry.toml` raises `gas_limit`). 56/56 pass in ~10 s. **Zero** solc warnings
from forge.

Python: 35 passed in 5.4 s, from both `python/` and the repo root (`pytest python/tests`);
no editable install needed.

---

## 3. Clean-clone-only failures

**No test fails in a clean clone that passes in the working directory.** The candidates
called out in the brief were each checked and each is clean:

| Suspected | Verdict |
|---|---|
| `mcp-server/abi/*.json` regenerated from a non-existent `artifacts/` | **Not a problem.** All five ABIs are tracked, and `extract-abis.mjs` explicitly falls back to the bundled copy when `artifacts/` is absent (`abi: 0 file(s) refreshed`), exiting non-zero only if *both* are missing. Proven in `/tmp/specular-mcponly`: full build + 151/151 tests with no root `npm install` and no `hardhat compile`. |
| Regenerated ABIs drifting from the tracked ones | **Not a problem.** After `hardhat compile` + `npm run build`, `git status` in the clone was **empty** — the committed ABIs are byte-identical to what the current contracts produce. |
| `src/config/*.json` address files | **Present and tracked** — all 11, including `arc-mainnet-addresses.json`, which is what the monitors and the agent server read. |
| `forensics/monitor/*` runtime state | **Not a problem.** `state-*.json` / `heartbeat-*.json` are gitignored and the monitor creates them on first run; the "block strictly newer than last run" check degrades gracefully when no prior state exists. |
| hardhat `artifacts/` / `cache/` | Correctly ignored, regenerated by `compile`. |
| Foundry `lib/` submodule | See F-1 below — a non-issue in practice. |

Four real findings, none of them a test failure:

### F-1 (informational) — `forge test` needs the root `npm install` first
`foundry.toml` remaps `@openzeppelin/` into `node_modules/`. In a clone with no root
`npm install`, `forge test` **auto-installs** the `lib/forge-std` submodule (so the missing
submodule is self-healing) and then dies with 40+ lines of
`"…/node_modules/@openzeppelin/contracts/access/Ownable.sol": No such file or directory`.
Running `npm ci` first and re-running gave 56/56.

*Root cause:* build-step ordering is undocumented — nothing in `README.md`, `CLAUDE.md` or
`foundry.toml` says forge depends on the npm tree.
*Minimal fix:* one line in the README prerequisites (in the attached patch).

### F-2 (real gap) — `scripts/sim/` is untracked, and the V7 validation report cites it as its evidence
`forensics/output/v7-model/V7_DESIGN_AND_VALIDATION.md` — the document behind the entire V7
credit model — says its §3/§4 results come from `scripts/sim/run-v7-model.js`, its §6.4/§6.5
gas numbers from `scripts/sim/gas-v62-vs-v61.js`, and lists
`scripts/sim/lib/{harness,strategies}.js` in its "artifacts" table, with
*"Reproduce with `npx hardhat run scripts/sim/run-v7-model.js`"*. **`scripts/sim/` does not
exist on `main`.** It exists only in the working directory, `?? scripts/sim/` — never
`git add`ed (it is *not* gitignored; only its `out/slither-v7.json` is).

The V6-era predecessor `forensics/output/testing-2026-09-20/economic-sim/` *is* tracked, so a
reader can see the shape of the harness but cannot reproduce a single V7 number.
`contracts/sim/ReputationManagerV4Sim.sol`, which the harness deploys, *is* tracked — so the
repo has the contract but not the driver.

*Root cause:* never committed.
*Minimal fix:* `git add scripts/sim/run-v7-model.js scripts/sim/gas-v62-vs-v61.js scripts/sim/lib/*.js`
plus the small result JSONs (`out/{v7-model,gas-and-size,storage-rmv4,storage-v62}.json`;
`out/slither-v7-new-contracts.json` is 10 MB and already covered by the ignore policy).
Checked for secrets: no hardcoded keys, no `PRIVATE_KEY` reads. 2.3 k lines total.

### F-3 (real gap) — `scripts/e2e/` is untracked and is cited by five tracked reports
`scripts/e2e/{_lib,s1…s9}.js` (+ `s9-python-parity.py`) are referenced by
`forensics/output/testing-2026-09-20/E2E_STAGING_TEST_REPORT.md`,
`HOSTED_SERVER_TEST_REPORT.md`, `CONTRACTS_V6.1_TEST_REPORT.md`,
`forensics/output/v7-model/V7_E2E_STAGING_REPORT.md` and `V7_SCALE_FIXES.md`, and by
`v7-scale-fixes.patch`. None of them is on `main`.

Mitigating: the **V7** successor `scripts/e2e-v7/` (14 files, `_lib.js` + `v1…v9`) **is**
tracked and self-contained — its only local `require` is `./_lib`, so nothing tracked is
*broken* by the absence. The loss is reproducibility of the V6.1/staging reports, not a
runtime break. `_lib.js` reads `process.env.PRIVATE_KEY`; no hardcoded secrets.

*Minimal fix:* `git add scripts/e2e/` (or delete the stale references from the five reports
if the suite is superseded by `e2e-v7/`).

### F-4 (hygiene) — the documented local-dev flow dirties a tracked file
`npm run deploy:local` → `scripts/deploy.js` **overwrites the tracked**
`src/config/contractAddresses.json` with the hardhat-node addresses. A newcomer following
the documented local flow ends step 5 with ` M src/config/contractAddresses.json` and no
idea whether that is theirs to commit. (`forge test` likewise leaves an untracked `out/` —
see the patch.)

*Minimal fix:* either gitignore the `localhost` block's file or have `deploy.js` write
`src/config/local-addresses.json` (which `scripts/op-resilience/deploy-local.js` already
uses, and which the monitor's `local` target already reads). The patch takes the smaller
step of ignoring the foundry output and the generated `local-addresses.json`; the
`contractAddresses.json` overwrite is left for a decision, since other code reads that file.

---

## 4. Scripts verified running from the clean clone (read-only, zero transactions)

| Script | Result |
|---|---|
| `V6_MONITOR_NETWORK=arc-mainnet node forensics/monitor/v6-invariants.js --no-alert` | ✅ **exit 0, 0 critical, 0 warn.** Block 22,416,680. All 14 checks OK (B1, S1, S5, SOLVENCY, POOL, LOAN, CONTROL, FEES, V6.1-PENDING, V6.2-SELFSTAKE, V7-CREDIT-POLICY, V6.1-QUALIFIED, V6.1-LATENESS, F-01-NFT). Owner confirmed `0x800e305A…F72C`, `paused: false`, marketplace `0xCb23f2fb…71be`. |
| `node forensics/monitor/check-overdue-loans.js` | ✅ 1 loan scanned, 0 overdue, `"action": "nothing to do"`. |
| `node scripts/deploy-v7.js --network arc-mainnet` | ✅ **DRY RUN — nothing broadcast.** Prints the plan (deploy `ReputationManagerV4` ~3,418,416 gas → `V6.2` → `authorizePool` → levers → `setMigrationFinalized`), verifies USDC is 6-decimal, then stops: *"Set DEPLOY_CONFIRM=YES to execute."* The gate is `const DRY = process.env.DEPLOY_CONFIRM !== 'YES'` and the broadcast path is behind a further 5-second countdown. |
| `cd mcp-server && node dist/http.js` | ✅ Listens, 25 tools registered, `GET /health` → `{"status":"ok","version":"2.1.0",…,"endpointsUp":3,"endpointsTotal":3}` against arc-mainnet. |
| `npx hardhat node` + `npm run deploy:local` | ✅ Full local stack deploys (AgentRegistry, ReputationManager, LendingPool, MockUSDC), ABIs exported to `abis/`. See F-4 for the side effect. |

**`.env` requirements — measured, not assumed.** A throwaway random key was generated in the
clone (`0x220D0eD3…11c3`, never funded, never used); the real `PRIVATE_KEY` was never copied.

* **Need no `.env` at all:** `v6-invariants.js` and `check-overdue-loans.js` — verified by
  moving `.env` aside and re-running; both still exit 0, falling back to the public RPC
  defaults baked into their `NETWORKS` tables.
* **Need `PRIVATE_KEY`, but an unfunded one is enough:** `scripts/deploy-v7.js`. Without it,
  it throws `INVALID_ARGUMENT / invalid private key` at `new ethers.Wallet(…)` on line 55 —
  i.e. it refuses to *dry run* without a key, which is a small papercut (the dry run needs
  no signer) but not a safety problem. With the throwaway key it dry-ran fine and reported
  `balance 0.0`.
* **Refuse to run without a funded key:** nothing in this set. Only the actual broadcast
  path (`DEPLOY_CONFIRM=YES`) and the `scripts/e2e*` on-chain scenarios need funds; none was
  exercised.

No transaction was sent to any network at any point.

---

## 5. Repo hygiene a new contributor hits

**`.gitignore`** — excludes nothing the build needs. Verified two ways: `git status` in the
clone was empty after a full build, and every explicitly-ignored path was grepped for
references in tracked files. The only ignored path referenced by tracked code is
`scripts/security-audit.js` (mentioned in docs only). Two gaps, both in the patch:
`out/` and `broadcast/` (foundry output) are **not** ignored, so `forge test` leaves an
untracked directory; and `src/config/local-addresses.json`, written by
`scripts/op-resilience/deploy-local.js`, is not ignored either.

One tracked file that should probably not be: **`.x402-nonces.json`** — runtime nonce state,
committed at the repo root.

**`.env.example`** — complete enough to fill in. Covers `PRIVATE_KEY`, every RPC, the
explorer keys, the 2026-07 security flags with prose, the Arc-mainnet deploy levers, and
points at `mcp-server/.env.example` for the server. Missing (all optional, all documented in
the scripts' own headers): the `V6_MONITOR_*` family and `SPECULAR_ALERT_WEBHOOK`.

**`README.md` — the weakest artifact in the repo, and the first thing a newcomer reads.**
Four concrete defects, all fixed in the patch:

1. *"Deploy locally: `npx hardhat run scripts/deploy-local.js`"* — **that file does not
   exist.** The working command is `npm run deploy:local` (→ `scripts/deploy.js`) against a
   running `npx hardhat node`.
2. **Every Base mainnet address is wrong.** README lists registry `0xbd821006…`, reputation
   `0xe4D78A50…`, marketplace `0x77f8D49C706A566Eecc9a2C3DD6556D5be54CACE`. The tracked
   `src/config/base-addresses.json` says `0xb9996de0…`, `0xf19b1780…`,
   `0x0a4e3C745aB95aceb45B05C28D89fe4Db8815F9a`. `CLAUDE.md` separately flags a
   `0x77F8D49c…` Base marketplace as *"stale … ignore"*. A newcomer copying the README
   points at the wrong contracts. Arc mainnet — the actual live V7 deployment — is not
   mentioned at all.
3. The reputation tier table contradicts the live on-chain V7 table (README: *"Score 500-699:
   25% collateral"*; the deployed `ReputationManagerV4` policy read by the monitor is
   `tierLimits [1000, 5000, 10000, 10000, 2500, 5000]`, `maxTierLimit 10000`).
4. *"✅ No admin keys in core contracts"* is false — the owner can pause, retune the tier
   table and every economic lever, and hold `accumulatedFees`.

It also never mentions Node 22, Foundry, `mcp-server/`, `python/`, or `.env`.

**`CLAUDE.md`** — accurate about the V6 era and wrong about the present. It claims
***"93/93 tests passing — run with `npm test`"*** in two places; the real number is **872
passing / 5 pending**. Its deployment table stops at Base V6 / Arc testnet V6-staging and
contains no row for the live **Arc mainnet V6.2 + ReputationManagerV4** stack
(`0xCb23f2fb…71be`, deployed 2026-09-23) that `src/config/arc-mainnet-addresses.json`, the
monitors and the agent server all target. Contributor-visible but not build-breaking; left
out of the patch because it is the author's own working file.

**CI (`.github/workflows/test.yml`)** — exists, uses `npm ci` + Node 22, and runs
`npx hardhat compile`, `npx hardhat test`, `npx mocha test/api/*.test.js`. All three
reproduce green here. But it covers **only** the root hardhat suite: `mcp-server` (151
tests), `forge test` (56 tests) and the Python SDK (35 tests) have **no CI coverage at all**
— 242 tests, a quarter of the repo's total, that nothing would catch breaking. The patch adds
three jobs, including a guard that fails the build if `mcp-server/abi/` ever drifts from the
compiled artifacts.

**Deployment config note (not a clean-clone failure).** `.railwayignore` is written for
`mcp-server/Dockerfile` (it excludes `/contracts/`, `/scripts/`, `/test/`, `/python/`…),
while the root `railway.json` points `railway up` at the **root** `Dockerfile`, which does
`COPY . .` and then `RUN npm run compile || true`. Under `.railwayignore` that compile has no
contracts to compile and the `|| true` hides it. Worth reconciling before the next root
deploy.

---

## 6. Prerequisites for a new contributor

Required:

* **Node.js 22 LTS** — everything. On this machine: `export PATH="/opt/homebrew/opt/node@22/bin:$PATH"`.
* **Network access on first build** — npm registry, plus hardhat downloading solc 0.8.20.

Optional, per area:

* **Foundry (`forge`)** — only `test/foundry/`. `curl -L https://foundry.paradigm.xyz | bash && foundryup`.
  `lib/forge-std` self-installs on first `forge` run, so `--recurse-submodules` is not needed;
  **but root `npm install` must come first.**
* **Python ≥ 3.10 + `pip install -r python/requirements.txt pytest`** — only `python/`.
* **A private key** — only for `scripts/deploy-*.js`. An unfunded throwaway suffices for a
  dry run; funds are needed only behind `DEPLOY_CONFIRM=YES`.

Not required by anything: **slither**, **Docker**, a funded wallet, an `.env` (for the
read-only monitors), and any global npm package.

Shortest path that works, verified end to end:

```bash
git clone https://github.com/thegrand-canyon/specular.git && cd specular
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
npm install && npx hardhat compile && npm test          # 872 passing
forge test                                              # 56 passing  (optional)
cd mcp-server && npm install && npm run build && npm test   # 151 passing (optional)
cd ../python && pip install -r requirements.txt pytest && pytest tests/   # 35 passing (optional)
```

---

## 7. Verdict

**`main` is usable by someone who is not the author.** A stranger with Node 22 can clone,
install, compile and run **1,114 tests to green** (872 hardhat + 56 foundry + 151 mcp-server
+ 35 python) without touching a config, without a `.env`, without an API key, and without
any file that exists only on the developer's machine. The two monitors and the V7 deploy
dry-run all execute correctly from the clone, and the deploy script's safety gate holds.
Nothing in the build depends on the untracked state in the working directory — the
`.gitignore` tightening in `503b4d2` and its predecessors did not break the build, and the
`mcp-server` ABI fallback in particular is the right design and is working.

What a stranger *cannot* do is trust the README — it would send them to the wrong contract
addresses and a deploy script that does not exist — or reproduce the V7 economic validation
and the 2026-09-20 staging E2E reports, whose harnesses (`scripts/sim/`, `scripts/e2e/`)
were never committed. Those are the three things to fix. The first is in the attached patch;
the other two are two `git add`s.

**Attached:** `clean-clone-fixes.patch` — generated against `main` @ `503b4d2`, verified with
`git apply --check` on a pristine third clone. It fixes the README (addresses, prerequisites,
the non-existent `deploy-local.js`, the tier table, the admin-key claim), closes the two
`.gitignore` gaps, and extends CI with mcp-server, Foundry, Python and an ABI-drift guard.
It does **not** touch `CLAUDE.md` or add the two untracked harnesses — both are the author's
calls.

```
git apply forensics/output/testing-2026-09-24/clean-clone-fixes.patch
```
