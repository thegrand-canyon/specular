# §S1-Exposed Lender Outreach

Identifies the 38 Arc Testnet lenders with unclaimed interest in v4 pools as of 2026-05-12. Each is a candidate for migration-window communication.

## Aggregate

- **Total lenders with claimable balance**: 38
- **Σ unclaimed interest**: 74.865743 USDC
- **§S1 risk**: when these lenders call `claimInterest`, `pool.availableLiquidity` does NOT decrement on v4 → phantom liquidity grows by exactly their claim amount

## Top exposure concentration

| Lender (anon) | Unclaimed | Pools |
|---------------|----------:|------:|
| `0xd673e66b…` | 29.16 USDC | 2 |
| `0x05e7092f…` | 14.17 USDC | 1 |
| `0x6df560f9…` | 7.16 USDC | 1 |
| `0xa0983956…` | 7.12 USDC | 1 |
| `0xd0a1761b…` | 7.10 USDC | 1 |

Top 5 lenders concentrate **64.7 USDC = 86%** of the cumulative exposure.

Full list: `forensics/output/regression-2026-05-07/41-s1-lender-exposure.json`

## Per-lender notification template

```
Subject: Specular Marketplace V6 Migration — Your Unclaimed Interest

Hello,

You have {{ EARNED_INTEREST }} USDC of unclaimed interest in {{ POOL_COUNT }} pool(s)
on the Arc Testnet AgentLiquidityMarketplace contract
(0x048363A325A5B188b7FF157d725C5e329f0171D3).

Two important pieces of context:

1. The current contract (v4) has a known accounting issue (§S1) — when you call
   claimInterest, the contract transfers your USDC out but does NOT update its
   own bookkeeping. This was discovered in our security audit. Your funds are
   safe; the issue affects pool accounting, not custody.

2. A fixed contract (V6) is deployed on Arc Testnet and prepared for production.
   V6 properly accounts for claimed interest. Migration to V6 will happen after
   external security audit.

What you can do NOW (no action required):
  - You can claim your interest at any time on v4. You will receive your USDC.
  - The §S1 accounting drift this causes is documented and will be cleared
    during V6 migration.

What you'll be asked to do LATER (after V6 audit):
  - Withdraw your supplied liquidity from v4
  - Re-supply to V6 at the new address
  - We'll send specific instructions when V6 is live

There is no urgency. Your funds remain accessible throughout.

Questions: {{ CONTACT }}
```

## Migration FAQ

**Q: Are my funds at risk?**
A: No. §S1 affects internal accounting, not USDC custody. Your withdrawals and claims work correctly — you receive the right amount of USDC. The bug is that the contract's `pool.availableLiquidity` view doesn't update on claim, so the public statistic can drift upward over time.

**Q: Do I need to do anything right now?**
A: No. You can keep using v4 normally. The §S1 drift is bounded by the total interest you've earned (currently 0.43–29 USDC per affected lender on Arc Testnet).

**Q: When does V6 launch?**
A: Pending external security audit (1–4 weeks typical). We'll announce the migration window 7 days in advance.

**Q: Will I lose interest during migration?**
A: No. Your full earned interest is claimable on v4 before migration. You will supply fresh USDC to V6 — your v4 history isn't carried over to V6 (it's a fresh contract), but your USDC is yours.

**Q: What about Base mainnet?**
A: Base has 1 lender on v4 (the protocol owner) — single-user migration. Real users come online with V6 after the audit gate.

**Q: Why doesn't the audit firm name appear?**
A: Auditor selection in progress. We'll publish the firm + report when complete.

## Recommended communication channels

| Channel | Audience | Timing |
|---------|----------|--------|
| Direct on-chain message (ENS / blockscan messaging) | All 38 affected Arc lenders | T-7d to V6 cutover |
| X / Twitter announcement | Public | T-7d, T-3d, T-0 |
| Discord pinned post | Community | T-14d through T+30d |
| Email (if subscribers exist) | Opt-in users | T-7d, T-1d |
| Frontend banner on specular.financial | All visitors | From V6 deploy through migration |

## Action items

1. Resolve auditor selection
2. Draft per-lender messages (template above)
3. Set up frontend banner component
4. Prep Discord/X announcement copy
5. Communications timeline: T-7d, T-3d, T-1d, T-0, T+1d, T+30d (close)
