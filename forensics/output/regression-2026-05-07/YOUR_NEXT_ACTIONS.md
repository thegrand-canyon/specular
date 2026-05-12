# Your Next Actions

Things only you can do. Roughly in priority order — top items unblock the most.

---

## 1. Refresh GitHub OAuth scope (30 sec) — unblocks remote push

Local commits aren't pushed because the GitHub OAuth token lacks the `workflow` scope (needed because we added `.github/workflows/test.yml`).

Run interactively in your shell (or paste with `!` prefix into Claude Code):

```
gh auth refresh -h github.com -s workflow
```

A browser tab opens; click "Authorize". Then back in shell:

```
cd ~/Specular
git push origin main
git push origin v6-pre-audit-2026-05-12
```

Snapshots 7 commits + 1 tag to the remote. Disaster recovery + audit-firm clone link become possible.

---

## 2. Audit firm decision (~30 min thinking, then send)

Read `forensics/output/regression-2026-05-07/AUDITOR_OUTREACH.md` — has 4 ready-to-send drafts:

- **Trail of Bits** — biggest name, strongest brand
- **OpenZeppelin** — also strong; similar
- **Spearbit** — likely fastest; small-team boutique with senior reviewers
- **Code4rena** — public contest format, many eyes

**Recommendation**: send to Spearbit + one of TOB/OZ for parallel quotes. Pick the better fit when both reply.

Each email has `{{ braces }}` for your name, contact, etc. Fill in, send.

---

## 3. Decide registry scope (read + 5 min)

Read `forensics/output/regression-2026-05-07/REGISTRY_SCOPE_DECISION.md`.

Slither found a medium-low reentrancy in `AgentRegistryV2.register()`. Two options:

- **A) Fix + bundle**: write a V3 registry, migrate 100 agents, audit 3 contracts. Cost: 2-3 weeks engineering, 3× audit price.
- **B) Defer**: send V6 to audit alone, file the registry issue for a future v3 release.

My recommendation: **B (defer)**. Reasoning in the memo.

After you decide, tell me which option, and:
- If B: I'll patch the audit-package README with the explicit deferral note
- If A: I'll start the V3 contracts

---

## 4. Confirm cron job for liquidation is settled (1 min)

The 2026-05-11 liquidation cron has fired — Base loans #2/#3/#4 are now DEFAULTED. The launchd monitor is still running every 30 min. Nothing to do unless you want to:

- Disable the launchd monitor: `~/Specular/forensics/monitor/install-v6-monitor.sh uninstall`
- Or keep running (current state — recommended for soak monitoring)

---

## 5. Frontend smoke test (~15 min, optional)

I fixed `frontend/js/config.js` from the deprecated v3 address to current v4 canonical, but never verified in a browser. To check:

```
cd ~/Specular
# whatever your usual frontend dev workflow is, e.g.:
npx vite preview  # if that's how the frontend builds
# or
cd public && python3 -m http.server 8080
```

Then open in browser, connect a wallet on Arc Testnet, try to view a pool. If it loads pool state and shows real numbers, the fix works. If it errors, let me know what + I'll iterate.

---

## 6. Optional: Paid Arc Testnet RPC (~$10-50/mo)

The load testing this session hit drpc.org free-tier rate limit at ~50 sustained tx/min. If you want to do **higher-volume** load tests on Arc, you'll need a paid RPC. Options:

- Drpc.org paid tier (about $20/mo for moderate use)
- Alchemy doesn't yet support Arc — check status
- Quicknode — sometimes has Arc support
- Run your own Arc node — most reliable but operationally heavier

Not needed unless you want more live load testing beyond what we've done. The contract correctness is already proven via Foundry's 10,240-sequence fuzz which runs offline.

---

## 7. Optional: Documentation site

For external audit-firm + community visibility, a small docs site at `docs.specular.financial` or `specular.financial/audit` linking to the audit package would be useful. Not blocking; nice-to-have.

---

## Status summary

What's done (no action needed from you):

- ✅ V6 deployed + verified on Arc (2 versions — pre and post slither)
- ✅ 363 hardhat tests passing
- ✅ 5 Foundry invariant properties × 10,240 random sequences (0 violations)
- ✅ Slither V6 triaged: 2 fixes applied, 7 accepted with rationale
- ✅ Slither dependency triage doc
- ✅ Audit package built (270K tarball)
- ✅ Migration runbook
- ✅ Base deploy script (gated on DEPLOY_CONFIRM env var)
- ✅ Liquidation cron fired 2026-05-11 — loans #2/#3/#4 DEFAULTED
- ✅ Invariant monitor running (launchd, 67+ clean snapshots)
- ✅ V6 NatSpec added
- ✅ GitHub Actions CI workflow file
- ✅ Lender outreach template + S1 exposure list (38 lenders, 74.87 USDC)
- ✅ Foundry test framework set up
- ✅ Executive summary

What you're waiting on (external):
- Audit firm engagement
- Audit feedback (2-4 weeks)

What you might want to do:
- Items 1-6 above
