# V7 Mainnet Migration Runbook — Arc Mainnet (chainId 5042)

Moving Arc mainnet from **V6.1 + ReputationManagerV3** to **V6.2 + ReputationManagerV4**
(the M1 ladder + M2 self-stake model), which is the fix for **F-04**.

Status: **staging rehearsal in progress.** Do not run the mainnet steps until the
rehearsal and the client migration both pass. This document is the plan, not a green light.

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

- [ ] Staging rehearsal green: `forensics/output/v7-model/V7_E2E_STAGING_REPORT.md` — in
      particular the M2 self-stake lock and the M1 ladder behaving exactly as designed on-chain.
- [ ] Client migration complete and released: `V7_CLIENT_MIGRATION.md`. The interface is
      **breaking** — `recordBorrow/recordLoanCompletion/recordDefault` take `loanId`, new
      `requiredSelfStake`/`selfStake` views, new reverts, and **the tier table is now on-chain**,
      so every hardcoded 25k/50k assumption must read from the contract.
- [ ] Hosted server redeployed with V6.2 support and three-way V6/V6.1/V6.2 capability detection.
- [ ] Root suite green; `forge test` green; slither 0 High on the new contracts.
- [ ] Deployer funded (needs ≈ 0.2 USDC of gas; wallet currently holds ~164 USDC).
- [ ] A decision recorded on the **single owner EOA** (§7) — this migration does not fix it.

## 4. Sequence

```bash
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"

# 1. Dry run — validates chain, USDC decimals, prints the plan. No broadcast.
node scripts/deploy-v7.js --network arc-mainnet

# 2. Broadcast (IRREVERSIBLE).
DEPLOY_CONFIRM=YES node scripts/deploy-v7.js --network arc-mainnet
```

The script deploys `ReputationManagerV4(registry)` then
`AgentLiquidityMarketplaceV62(registry, V4, usdc)`, wires `authorizePool`, applies the
launch levers (M-1 on, minHold 86400s, minSupply 10 USDC, fee 100 bps, rate limit 5/86400s),
calls `setMigrationFinalized()` at deploy (closing F-08 immediately, not later), reads the
tier table back from chain, and rewrites `src/config/arc-mainnet-addresses.json` — moving the
superseded addresses to `*_legacy` keys and pointing the canonical keys at V7.

**The registry is reused, so agent NFTs and identities persist.** Only reputation resets.

**The old marketplace is deliberately left running, unpaused and still authorized.** Per the
2026-09 audit, `pause()` freezes lender exits, repayment, and our own `liquidateLoan`
(6 of 18 operations), and revoking its pool would break repayment for anyone mid-loan. It is
retired separately, once it is drained — see §6.

## 5. Post-deploy (same session)

1. **Verify source** — submit both contracts to Sourcify v2 for chain 5042 and confirm
   `exact_match` (the Arc explorer's own `/api` is Cloudflare-challenged and `hardhat verify`
   cannot reach it; hardhat-verify also targets Sourcify's retired v1 API):
   `POST https://sourcify.dev/server/v2/verify/5042/<addr>` with the hardhat build-info.
2. **Smoke test** with real USDC at tiny amounts, including the two new paths: the self-stake
   lock refusing a creator withdrawal while borrowing, and `requiredSelfStake` gating a loan.
3. **Monitoring — two jobs, not one.** The canonical pointer now names V7, so the existing job
   follows V7 automatically. The superseded marketplace **stops being watched** unless you add:
   ```
   V6_MONITOR_NETWORK=arc-mainnet V6_MONITOR_MARKETPLACE_KEY=agentLiquidityMarketplace_v61_legacy \
     node forensics/monitor/v6-invariants.js
   ```
   Keep that second job until the legacy contract is drained and retired. Confirm the V7 job
   emits the `V6.2-SELFSTAKE` check family once a pool exists — if that line never appears, the
   self-stake invariants are not actually running.
4. **Update** `CLAUDE.md` (network table + risk posture), `src/config/chains.json`, and memory.
5. **Faucet**: it points at the registry, not the marketplace, so it keeps working. Confirm.

## 6. Retiring the legacy stack

Only when the superseded marketplace holds nothing beyond its own `accumulatedFees` **and**
has zero ACTIVE loans:

```
withdrawFees(accumulatedFees) → pause() → reputation(V3).revokePool(legacy marketplace)
```

`scripts/redeploy-marketplace-v6.1.js` already refuses to retire a contract holding lender
funds; apply the same rule by hand here. Until then, leave it running and monitored.

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
  immutable `MAX_TIER_LIMIT`), levers, and fees. Monitoring detects an ownership change; it
  cannot prevent a compromised key. This is the largest remaining structural risk and it is
  outside what any of this work addresses.
- **No external audit** of V6.1, V6.2 or V4. Gate 1 of `ARC_MAINNET_DEPLOY_PREP.md` remains open
  by owner decision.

## 8. Rollback

There is no upgrade path, so "rollback" means **repointing the canonical config keys back to the
legacy addresses** and redeploying the clients. That works precisely because the legacy stack is
left running and unpaused. It does **not** recover anything that happened on V7 in the meantime,
and reputation earned on V7 does not exist on V3. Decide fast if you are going to decide at all;
the longer V7 runs, the less meaningful a rollback becomes.
