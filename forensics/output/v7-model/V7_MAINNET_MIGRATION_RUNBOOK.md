# V7 Mainnet Migration Runbook — Arc Mainnet (chainId 5042)

Moving Arc mainnet from **V6.1 + ReputationManagerV3** to **V6.2 + ReputationManagerV4**
(the M1 ladder + M2 self-stake model), which is the fix for **F-04**.

## Status: DONE. This migration was executed on Arc mainnet on 2026-09-23.

This is no longer a plan. It is kept as (a) the record of what was done and (b) the procedure
for doing it again on another network. Everything below has been re-checked against the chain
on **2026-09-24**; the sequence in §4 was additionally **re-executed end to end, twice, on a
local hardhat chain** to prove it is repeatable and that the §5b trap stays closed.

**What is live on Arc mainnet (chainId 5042) today, read on-chain 2026-09-24 at block
22 416 766:**

| | |
|---|---|
| Marketplace | `0xCb23f2fb03Bfd4775Cc0e76E28f64c1e545071be` · `VERSION() == "V6.2"` |
| Reputation | `0x12953e732e5D1aFdA640554125367d1CEC2ac4FB` · `VERSION() == "V4"` |
| Registry (reused, agent NFTs persist) | `0x6F1EbF50290f6D4A9947E9EB77f98a683684fBF5` |
| Faucet (untouched by the migration) | `0xD854F80031A8d0CB166587AafA0969Da8C3757bF` · 19 USDC · claim 1 USDC · cohort ≤ 100 |
| Owner / pendingOwner / paused | secure wallet `0x800e…F72C` / `0x0` / `false` — on all four contracts |
| `migrationFinalized` | `true` (F-08 closed at deploy; `seedPool`/`seedPosition`/`setMigrationFinalized` all revert `Migration finalized`) |
| Levers | fee 100 bps · minSupply 10 USDC · minHold 86 400 s · M-1 on · rate limit 5 / 86 400 s |
| Ladder | k = 2 · growthStep 100 USDC · bootstrap 100 USDC · lockout 180 d · `MAX_TIER_LIMIT` 10 000 USDC (immutable) |
| Tier limits | `[1000, 5000, 10000, 10000, 2500, 5000]` USDC |
| Superseded, still live and monitored | V6.1 `0x358c5E69f712A4b3558333090a45A054bAeEb282` + ReputationV3 `0x1577Eb9985CcA859F25ED2EDaeD16A464ADFaE5e` |
| Fully retired | V6.0 `0xb9996de05fD514A0cB2B81fa25448EECD4559Aaa` |

Staging (the rehearsal target) runs the same generation:
`ReputationManagerV4 0xD7906fDFBf69BA89a4c2FE148797e24f386fE3d2`,
`MarketplaceV6.2 0x7E4D144AbEB3C695Ec2DdF00Fc710aABC04bDd18` (deployed 2026-09-22).

---

## 1. Why this migration happens at all

F-04 is proven — statically, on-chain, and in simulation — to be **unfixable by owner
levers**: across all 40 viable lever configurations the attacker's cost stays pinned at
`platformFeeRate/10000` of an honest agent's cost, capped at 5 % by the contract's own
500 bps fee ceiling. Measured worst case was **25,000 USDC of lender money for 0.125 USDC**.

The tier limits are hardcoded in `ReputationManagerV3` and the marketplace holds
`reputationManager` as `immutable`. So the fix is a **fresh deploy of both**. There is no
upgrade path and none was designed in — deliberately.

## 2. The cost that decides the timing: reputation does not migrate

`ReputationManagerV4` ships **no seeding helper**, on purpose: a seed path is precisely the
owner-drain shape (`seedPool`/`seedPosition`) that F-08 flagged and that we close at deploy
with `setMigrationFinalized()`. Adding one to preserve scores would reintroduce it.

Therefore **every agent restarts at score 0 / bootstrap limit**.

Current mainnet population (read 2026-09-22):

| | |
|---|---|
| Pools | 1 |
| Loans (all closed) | 1 |
| Registered agents | 1 (the secure wallet's own test agent) |
| Marketplace USDC | 0.000014 (its own accrued fees) |
| Third-party lenders | **none** |

So today the migration costs **one test agent's score** and roughly **0.2 USDC of gas**.
Every real agent that onboards before the migration turns this into a support problem and,
eventually, into a migration nobody wants to do. **The cheapest moment is now and it only
gets worse.**

## 3. Preconditions (ALL must hold)

*(All were satisfied before the 2026-09-23 mainnet run. Kept as the checklist for the next
network. The one deliberately-waived item is the last: no external audit.)*

- [x] Staging rehearsal green ON THE SCALE-FIXED BUILD: `V7_E2E_STAGING_REPORT.md`. Round 1
      passed 230/230 against the PRE-FIX contracts; that result does not carry over. In
      particular re-confirm the M2 self-stake lock, the M1 ladder, and the new refusals
      introduced by the squat fix.
- [ ] Scale findings closed: `V7_SCALE_FIXES.md`. The blocking one was the lender-slot
      squat — `minSupplyAmount` was enforced only when CLAIMING a slot, so a squatter
      supplied the minimum, withdrew to dust and held the slot for ~nothing; 50 of those
      bricked a pool permanently, and under V6.2 the agent's own self-stake needs one of
      those slots, so a squatted pool could never support unsecured borrowing again.
- [ ] Client migration complete and released: `V7_CLIENT_MIGRATION.md`. The interface is
      **breaking** — `recordBorrow/recordLoanCompletion/recordDefault` take `loanId`, new
      `requiredSelfStake`/`selfStake` views, new reverts, and **the tier table is now on-chain**,
      so every hardcoded 25k/50k assumption must read from the contract.
- [ ] Hosted server redeployed with V6.2 support and three-way V6/V6.1/V6.2 capability
      detection. Note: capability flags do NOT imply individual methods — pagination
      arrived in a later V6.2 revision than the first one deployed, and keying on the flag
      broke every read on that deployment. Probe for methods.
- [ ] Client-visible breaks from the squat fix are handled everywhere: `withdrawLiquidity`
      can refuse a sub-minimum remainder, `supplyLiquidity` can refuse when the last slot is
      reserved for the agent's stake, and the one-arg `openLoans(loanId)` getter is gone.
- [ ] Root suite green; `forge test` green; slither 0 High on the new contracts.
- [ ] Deployer funded (needs ≈ 0.2 USDC of gas; wallet currently holds ~164 USDC).
- [ ] A decision recorded on the **single owner EOA** (§7) — this migration does not fix it.

## 4. Sequence

```bash
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"

# 0. OPTIONAL but recommended: walk the whole thing on a throwaway chain first.
#    npx hardhat node  (terminal 1)
#    npx hardhat run --network localhost scripts/incident-drill/deploy-v7-local.js
#    node scripts/deploy-v7.js --network local            # dry
#    DEPLOY_CONFIRM=YES node scripts/deploy-v7.js --network local
#    Run it TWICE and confirm supersededDeployments[] has two entries (§5b).

# 1. Dry run — validates chain id, USDC decimals, mock-token, deployer balance;
#    prints the plan. No broadcast.
node scripts/deploy-v7.js --network arc-mainnet

# 2. Broadcast (IRREVERSIBLE).
DEPLOY_CONFIRM=YES node scripts/deploy-v7.js --network arc-mainnet
```

**The guards that stand between a typo and a real-money mistake** (each one forced and
observed refusing, 2026-09-24):

| guard | fires when | message |
|---|---|---|
| network | `--network` missing or unknown | `--network required: arc-staging \| arc-mainnet \| local` |
| chain id | the endpoint answers a different chain | `GUARD: chainId mismatch — <rpc> reports 5042002, expected 5042 …` |
| token shape | configured USDC is not an ERC-20 | `GUARD: … does not answer decimals()/symbol()/name()` |
| decimals | USDC is not 6-decimal (e.g. Arc's 18-dec native view) | `GUARD: USDC decimals 18 != 6 — refusing.` |
| mock token | a real-money network wired to a mock/test token | `GUARD: token … looks like a mock ("Mock USDC"/"USDC") …` |
| balance | deployer below `DEPLOY_MIN_BALANCE` (default 1 native) | `GUARD: deployer balance 0.0 < required 1.0 …` |
| confirmation | `DEPLOY_CONFIRM` is not exactly `YES` | `DRY RUN — nothing broadcast.` |

The script deploys `ReputationManagerV4(registry)` then
`AgentLiquidityMarketplaceV62(registry, V4, usdc)`, wires `authorizePool`, applies the
launch levers (M-1 on, minHold 86400s, minSupply 10 USDC, fee 100 bps, rate limit 5/86400s),
calls `setMigrationFinalized()` at deploy (closing F-08 immediately, not later), reads the
tier table back from chain, and rewrites `src/config/arc-mainnet-addresses.json` — APPENDING the
superseded stack to `supersededDeployments` (never overwriting an earlier one, see §5b) and
pointing the canonical keys at V7.

**The registry is reused, so agent NFTs and identities persist.** Only reputation resets.

**The old marketplace is deliberately left running, unpaused and still authorized.** Per the
2026-09 audit and the 2026-09-23 drill, `pause()` freezes lender exits, repayment, and our own
`liquidateLoan` — **9 of 35 measured operations on V6.2** (the "6 of 18" in earlier drafts was
the coarser V6.1 probe set; the set of broken families is the same). Revoking its pool would
break repayment for anyone mid-loan. It is retired separately, once it is drained — see §6.

## 5. Post-deploy (same session)

Every item states **how you check it**, so "done" is observable rather than asserted.

1. **Verify source** — submit both contracts to Sourcify v2 for chain 5042 and confirm
   `exact_match` (the Arc explorer's own `/api` is Cloudflare-challenged and `hardhat verify`
   cannot reach it; hardhat-verify also targets Sourcify's retired v1 API):
   `POST https://sourcify.dev/server/v2/verify/5042/<addr>` with the hardhat build-info.
   *Check:* `GET https://sourcify.dev/server/v2/contract/5042/<addr>` returns `exact_match`.
2. **Smoke test** with real USDC at tiny amounts, including the two new paths: the self-stake
   lock refusing a creator withdrawal while borrowing, and `requiredSelfStake` gating a loan.
   *Check:* `node scripts/smoke-test-arc-mainnet.js` (writes) — and afterwards, and any time
   you just want the config read back with no transactions,
   `node scripts/smoke-test-arc-mainnet.js --read-only` (11 assertions, sends nothing).
3. **Levers still exist and are still owner-gated on the deployed bytecode.**
   *Check:* `node scripts/incident-drill/verify-runbook-levers.js` — exit 0, `missing: 0`,
   `notOwnerGated: 0`. (52/52 on 2026-09-24.) This is the item that catches "the runbook names
   a function the new contract does not have".
4. **Monitoring — two jobs, not one.** The canonical pointer now names V7, so the existing job
   follows V7 automatically. The superseded marketplace **stops being watched** unless you add
   a second job. Use the **address** form: superseded stacks live in the
   `supersededDeployments` LIST, so no fixed config key resolves them, and
   `V6_MONITOR_MARKETPLACE_KEY=<a key that does not exist>` makes the monitor `exit(2)` and
   alert every cycle while watching nothing (verified: `No marketplace address: key "…" absent
   from src/config/arc-mainnet-addresses.json`, exit 2).
   ```
   V6_MONITOR_NETWORK=arc-mainnet V6_MONITOR_MARKETPLACE=<superseded marketplace address> \
     node forensics/monitor/v6-invariants.js
   ```
   Live as launchd `com.specular.v6-invariants-arc-mainnet-legacy`.
   *Checks, all three:*
   - the V7 job emits the `V6.2-SELFSTAKE` check family once a pool exists — if that line never
     appears, the self-stake invariants are not actually running (present 2026-09-24);
   - `node forensics/monitor/alert.js --status` gained a **separate heartbeat** for the new job
     (`arc-mainnet-<addr8>`). If it did not, the two jobs are sharing one state file and the
     second is destroying the first's `CP-CHANGED` baseline — that is exactly what happened
     between 2026-09-23 and 2026-09-24 (INCIDENT_RUNBOOK §3.2 box);
   - `forensics/monitor/state-arc-mainnet-<addr8>.json` exists.
5. **Update** `CLAUDE.md` (network table + risk posture), `src/config/chains.json`, and memory.
   *Check:* every address in `CLAUDE.md` appears in the addresses file, and no `*_legacy` key is
   claimed that the file does not contain.
6. **Faucet**: it points at the registry, not the marketplace, so it keeps working.
   *Check:* `read-live-levers.js` shows the faucet owner/claimAmount/cohort/balance unchanged
   (19 USDC / 1 USDC / 100 on 2026-09-24).
7. **Hosted API**: redeploy it, then confirm it is serving the NEW stack. A stale container
   keeps answering from the superseded marketplace and will overstate credit limits 10×.
   *Check:* `GET /v1/arc-mainnet/status` (bearer token) reports `capabilities.v62: true`,
   `reputationV4: true`, `creditTiers.source: "chain"` and the new marketplace address.
   (Confirmed serving V6.2/V4 from chain on 2026-09-24.)

## 5b. Do not lose the address of the contract you just superseded

`deploy-v7.js` once recorded superseded stacks under fixed `*_legacy` keys, so a SECOND
redeploy overwrote the first's record. On staging that dropped the last reference to a
marketplace still holding 482 USDC of lender funds. Superseded stacks now APPEND to
`supersededDeployments` in the addresses file. An address you cannot name is one you cannot
monitor, drain or retire.

**Verified by execution 2026-09-24**: `deploy-v7.js` was run twice against a local chain and
`supersededDeployments[]` ended with **both** generations, `agentLiquidityMarketplacePrevious`
naming the most recent. The script also now prints the monitoring command in **address** form,
never a config key.

`scripts/redeploy-marketplace-v6.1.js` had the *original* version of this bug and was never
fixed: it wrote the superseded address to the single key
`agentLiquidityMarketplace_v6_0_retired`, which on Arc mainnet already held the V6.0 address —
a second run would have silently overwritten it. It now appends to `supersededDeployments[]`
as well. **If you write another deploy script, make it append.**

**Two checks after any redeploy, both of which fail today on staging:**

1. `supersededDeployments[]` grew by one.
2. **Every entry has a monitor pointed at it.** Arc mainnet's single superseded marketplace
   does (`com.specular.v6-invariants-arc-mainnet-legacy`). Arc **staging** has three
   superseded marketplaces — `0xDbDf60AE…` (849.16 USDC), `0xB2d88bbF…` (482.24),
   `0xa736EE7B…` (3 487.69), all unpaused, read 2026-09-24 — and **none of them is
   monitored**. It is test money, but it is the same checklist item that will matter the day a
   mainnet stack is superseded with lender funds still in it.

## 6. Retiring the legacy stack

Only when the superseded marketplace holds nothing beyond its own `accumulatedFees` **and**
has zero ACTIVE loans:

```
withdrawFees(accumulatedFees) → pause() → reputation(V3).revokePool(legacy marketplace)
```

`scripts/redeploy-marketplace-v6.1.js` already refuses to retire a contract holding lender
funds; apply the same rule by hand here. Until then, leave it running and monitored.

**Status of the Arc-mainnet legacy stack, 2026-09-24:** V6.1 `0x358c5E69…` has zero ACTIVE
loans, zero lender positions and holds nothing beyond its own `accumulatedFees`, so it meets
the preconditions above. The one thing that previously blocked retiring it — the hosted API
still serving from it — is **cleared**: `/v1/arc-mainnet/status` now reports the V6.2
marketplace with `v62: true` and `creditTiers.source: "chain"`. Retiring it is therefore a
decision, not a blocker. If you do retire it, remember to unload
`com.specular.v6-invariants-arc-mainnet-legacy` **and delete
`forensics/monitor/heartbeat-arc-mainnet-358c5e69.json`**, or the dead-man's switch will raise
`MONITOR_DOWN` about it every 30 minutes for ever.

⚠️ **Do not reach for `redeploy-marketplace-v6.1.js` to do any of this.** It deploys V6.1, which
is now OLDER than what is live; pointed at Arc mainnet it would deploy a downgrade, repoint the
canonical config key at it, and — because the live V6.2 holds only its own fees — trip the
retirement branch and **pause and revoke the canonical marketplace**. A version guard now
refuses (`GUARD: the canonical marketplace on arc-mainnet is V6.2; this script deploys V6.1,
which is OLDER`), overridable only with `ALLOW_VERSION_DOWNGRADE=YES`.

## 7. What this migration does NOT fix

- **Residual attacker EV is still positive** (~24 %/yr at the chosen parameters). V7 **prices**
  the attack, it does not close it: capital as a share of the prize goes 0.8 % → 229.2 % and
  steady-state extraction 2,500 → 13.9 USDC/day, but an unsecured line to a pseudonymous agent
  can only be made EV-negative by backing it with something seizable. Do not describe F-04 as
  "closed" anywhere.
- **Honest agents are slightly slower and dearer**, not faster. An earlier draft claimed the
  opposite; that comparison used two different strategies rather than two models and was
  refuted on re-measurement. The gain is structural (capacity tracks demonstrated usage, and the
  attacker's added cost is seized while the honest agent's is recoverable).
- **Single owner EOA, no multisig or timelock.** The owner key can retune tiers (within the
  immutable `MAX_TIER_LIMIT`), levers, and fees. Monitoring detects an ownership change **on
  the marketplace only**; registry, reputation-manager and faucet ownership changes are
  invisible, and of 29 successful hostile owner calls enumerated in the 2026-09-23 drill,
  **23 produce no signal at all**. It cannot prevent a compromised key. This is the largest
  remaining structural risk and it is outside what any of this work addresses.
- **No external audit** of V6.1, V6.2 or V4. Gate 1 of `ARC_MAINNET_DEPLOY_PREP.md` remains open
  by owner decision.

## 8. Rollback

There is no upgrade path, so "rollback" means **repointing the canonical config keys back to the
legacy addresses** and redeploying the clients. That works precisely because the legacy stack is
left running and unpaused. It does **not** recover anything that happened on V7 in the meantime,
and reputation earned on V7 does not exist on V3. Decide fast if you are going to decide at all;
the longer V7 runs, the less meaningful a rollback becomes.
