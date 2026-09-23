# Base unlimited-allowance remediation (2026-09-23)

Closing finding **M-3** from `CROSS_GENERATION_REGRESSION.md`: three Base wallets held
`MaxUint256` USDC allowances to the canonical V6 marketplace. An unlimited allowance means
any bug in the approved contract can drain the wallet's entire USDC balance, not just the
amount a user intended to transact.

## Acted on

| Wallet | USDC | Allowance before | After | Tx |
|---|---|---|---|---|
| `0x800e305A…F72C` (owner/deployer) → canonical V6 `0x0a4e3C74…` | **181.450557** | MaxUint256 | **0.0** | `0x019f544970146ccca03e82b3bab1321617c9ec992bfbd68779a74da1b93e2b4b` |
| same → archived v4 `0xd7b4dEE7…` (paused) | — | 0.2 | **0.0** | `0x0f20cf1722e5266accd090aa11495ae4773f99ae73a086cfd3e6d7854e5b0b55` |

Verified 0.0 for both on a later block. Revoking moves no funds: the 181.45 USDC is
untouched, it is simply no longer reachable by those contracts. Cost was gas only
(33,501 each, Base gas ~0.006 gwei).

Safe to do because the SDKs approve **exactly** what each operation needs, just in time,
and revoke leftovers — the 2026-07 audit rule. Nothing depended on the standing allowance.
It is also reversible: any future operation re-approves its own exact amount.

## Not acted on, and why

- **`0xF2A861b2…CBaf` — 2.000000 USDC, still unlimited.** A throwaway agent wallet from the
  2026-05 Base agent-journey test. Its key was written to `/tmp/agent-journey-1779810269350.json`
  (see `forensics/output/regression-2026-05-07/108-base-agent-journey.txt:6`) and `/tmp` has
  since been cleared. **The key is gone, so neither the allowance nor the 2 USDC is
  recoverable by us.** Exposure is capped at that 2 USDC.
  *Lesson worth keeping: test wallets funded with real money should never have their only
  key in `/tmp`. Use the gitignored per-run wallet files the later e2e suites adopted.*
- **`0x88B7Db65…3889` — unlimited, 0.000000 USDC.** Nothing at risk; not our key either.

## State after

Material exposure is closed: the only wallet we control no longer grants an unlimited
allowance to any Base contract. Arc mainnet was already clean (0.0 against all three
marketplaces) and remains so.
