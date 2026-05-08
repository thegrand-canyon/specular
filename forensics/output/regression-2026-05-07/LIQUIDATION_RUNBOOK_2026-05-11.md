# Liquidation Runbook — Base Loans #2/#3/#4

## When to run

**On or after 2026-05-11 19:10:09 UTC** (= 2026-05-11 12:10:09 PDT). Recommended buffer: wait 15-30 minutes after the earliest endTime to avoid block-timestamp-vs-loan.endTime edge cases.

| Loan | endTime (UTC) | endTime (PDT) |
|------|---------------|---------------|
| #2 | 2026-05-11 19:10:09 | 12:10:09 |
| #3 | 2026-05-11 19:10:15 | 12:10:15 |
| #4 | 2026-05-11 19:10:29 | 12:10:29 |

## Pre-run checklist

- [ ] Secure wallet (`0x800e305A...F72C`) has private key in `.env` as `PRIVATE_KEY`
- [ ] Secure wallet has ≥0.001 ETH on Base for gas (current: 0.0103 ETH ≈ $31)
- [ ] Loans #2/#3/#4 still in state ACTIVE (verify before broadcast — script does this)

## Execution

```bash
cd ~/Specular
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
node forensics/scripts/base_liquidate_2026_05_11.js 2>&1 | tee forensics/output/regression-2026-05-07/14-base-liquidation.txt
```

The script:
1. Verifies wallet is contract owner
2. Verifies sufficient gas
3. For each loan: skips if not ACTIVE, skips if not yet overdue, static-calls before broadcasting, captures tx hash + final state
4. Writes `14-base-liquidation-result.json` with structured output

## Expected outcome

Per `LIQUIDATION_GUIDE.md` and the contract source:
- `liquidateLoan` does NOT call `_distributeInterest` → bypasses §B1 panic
- Each loan transitions ACTIVE → DEFAULTED (the contract's term for liquidated)
- `pool.availableLiquidity` increases by `loan.collateralAmount` per loan
- `pool.totalLiquidity` decreases by any unrecovered loss
- Borrower (secure wallet) records 3× default in ReputationManager

Aggregate effect on Base agent #1's pool: ~3× collateral returned (~3× 0.000128 USDC + adjustments). Reputation hit: -50 × 3 = -150 points (but secure wallet may not be using its agent for new borrows).

## OS-level reminder (recommended)

Add to your local crontab so a reminder fires regardless of Claude session state:

```bash
( crontab -l 2>/dev/null; echo '23 12 11 5 * /usr/bin/osascript -e "display notification \"Time to liquidate Base loans #2/#3/#4. Run forensics/scripts/base_liquidate_2026_05_11.js\" with title \"Specular Liquidation\""' ) | crontab -
```

Or simpler — phone calendar event for 2026-05-11 12:30 PDT.

## Rollback / contingency

`liquidateLoan` is one-way: state DEFAULTED is final. There's no un-liquidate. If the broadcast fails:
- staticCall before broadcast catches most issues (the script does this)
- If only some succeed, re-run the script — it's idempotent (skips state ≠ ACTIVE)
- If §B1 panic somehow appears: it shouldn't — `liquidateLoan` doesn't touch `_distributeInterest`

If you want to PRESERVE the loans (e.g., for additional forensic evidence) past 2026-05-11, just don't run the script. Loans remain ACTIVE indefinitely until liquidated.
