# Auditor Outreach Drafts

Four firms tailored to V6's scope, complexity, and timeline. Copy-paste, fill the `{{ braces }}`, send.

## Common context (for the body of any email)

- **Contract**: `AgentLiquidityMarketplaceV6.sol` (~700 LOC excluding deps)
- **Scope**: V6 only. AgentRegistryV2, ReputationManagerV3, ValidationRegistry are out of scope unless they want to include them
- **Audit package**: 270K self-contained tarball with source, 363 tests, threat model, slither output + triage, on-chain evidence JSONs
- **Live deployment**: V6 verified on Arc Testnet at `0x05f359D663fa8E70C49b3D69f65dA7C059b0cC7a`
- **Target chain for production**: Base Mainnet
- **Timeline preference**: Standard turnaround (2-4 weeks), no rush

---

## 1. Trail of Bits — `contact@trailofbits.com` or audit-form at https://trailofbits.com/audit

```
Subject: Audit request — Specular V6 Marketplace patch (3 critical fixes)

Hi Trail of Bits team,

We have a small (~700 LOC) Solidity contract — AgentLiquidityMarketplaceV6 — that
patches three vulnerabilities in our deployed marketplace (§B1 reentrancy-like
panic, §S1 fund-drain accounting, §S5 DoS via unbounded loop). The patch is
surgical: it's a v4-baseline contract with three targeted code changes plus
admin migration helpers.

What's ready for handoff:
- Self-contained audit package (270K tarball) with source, threat model,
  test suite, annotated v4→V6 diff, slither output + triage
- 363 hardhat tests passing, plus 5 Foundry invariant properties × 10,240
  random sequences (0 violations)
- Live verification: V6 deployed and exercised on Arc Testnet for 5+ days,
  invariant monitor running every 30 min (67 clean snapshots)
- §B1 confirmed bites in production on Base mainnet (3 stuck loans we just
  liquidated to clear the active state); §S1 drift quantified at 74.87 USDC
  across 40 lenders on Arc

Two recommended audit-scope decisions:
- Include AgentRegistryV2? Slither found a medium-low reentrancy in
  AgentRegistryV2.register; we can defer or bundle
- Engagement model: traditional full audit vs. focused-review-with-pair?

Cost-estimate range: what does a 1-2 week engagement on ~700 LOC look like?
Could you point me at a recent comparable engagement for context?

I can send the tarball + a read-only repo link as soon as you're ready.

Thanks,
{{ NAME }}, Specular Protocol
specular.financial
{{ EMAIL }}
{{ TG_OR_DISCORD }}
```

---

## 2. OpenZeppelin — https://www.openzeppelin.com/security-audits (audit-request form)

```
Subject: Audit request — AgentLiquidityMarketplaceV6 (P2P lending, ~700 LOC)

Hi OZ team,

Submitting an audit request for a focused patch contract. Specular is a P2P
agent-credit protocol; we discovered three vulnerabilities in our deployed v4
contract during an internal audit and built a fixed V6 contract ready for
external review before mainnet redeploy.

Key facts:
- 700 LOC, 1 contract; depends on AgentRegistryV2 + ReputationManagerV3
  (which V6 trusts as oracles — out-of-scope unless wider review wanted)
- Solidity 0.8.20, OZ Ownable/ReentrancyGuard/Pausable
- 363 hardhat tests + 5 Foundry invariant properties tested over 10,240
  random sequences (0 violations)
- Slither clean of medium+ severity findings on V6 (full triage in package)
- Three security fixes ready for verification: §B1 (poolLenders dedup),
  §S1 (claimInterest pool decrement), §S5 (loan-count O(1) counter)

Audit package is self-contained (270K) and includes:
- Source (V6, v4 baseline for diff)
- All 6 test suites (mocha + Foundry)
- THREAT_MODEL.md (actors, attack surface, focus areas)
- V4_TO_V6_DIFF.md (annotated walkthrough of every change)
- Slither outputs + triage
- Live on-chain evidence JSONs

I can share the tarball over a secure channel or a read-only GitHub link
the moment you're ready. Could you let me know your current capacity,
timeline, and pricing on a contract this size?

Thanks,
{{ NAME }}
Specular Protocol
{{ EMAIL }}
```

---

## 3. Spearbit — `audits@spearbit.com` (or via cantina.xyz request form)

```
Subject: Engagement request — Specular V6 marketplace patch audit

Hi Spearbit,

We have a focused audit request: AgentLiquidityMarketplaceV6 (~700 LOC), a
patch contract addressing three findings from our internal audit. V6 is fully
implemented, tested, deployed on Arc Testnet, and ready for external review
before Base mainnet redeploy.

What makes this engagement well-scoped for Spearbit:
- Small surface: 1 contract, 3 surgical fixes, clear scope boundary
- Strong test corpus already: 363 hardhat unit + 5 Foundry invariant
  properties × 10,240 sequences = 0 invariant violations
- Slither v0.11.4 clean of V6 medium+ findings (triage doc included)
- Differential testing shows V6 is byte-identical to v4 on non-fix paths
- Audit package is self-contained — 270K tarball with source, threat model,
  test files, on-chain evidence, annotated diff

Looking for a 1-2 week engagement; happy to do a Cantina-public format or
private depending on what makes sense for the scope.

Could you share availability, your senior reviewer assignment process, and
pricing for a contract this size?

Best,
{{ NAME }}
Specular Protocol
{{ EMAIL }}
```

---

## 4. Code4rena — https://code4rena.com/contact

```
Subject: Audit interest — Specular V6 marketplace patch

Hi Code4rena team,

Interested in running a focused contest on Specular's V6 marketplace patch
(~700 LOC, 1 contract). This is a fix for three internally-discovered
vulnerabilities (§B1, §S1, §S5) that we want external review on before Base
mainnet redeployment.

Why a contest format could fit:
- Small clear scope (1 contract, 3 fixes, no token, no governance)
- Strong existing test base — wardens can focus on hunting rather than setup
- Live testnet deployment for hands-on probing
- Self-contained audit package with annotated diff (270K tarball ready)

Constraints/preferences:
- Production target: Base mainnet (no V6 deploy yet — gated on this audit)
- Timeline: flexible; not under deadline
- Scope decision pending: include AgentRegistryV2 (medium-low reentrancy
  finding) or just V6?
- Award budget: open to your standard rate for scope of this size, would
  appreciate guidance

Could you share your current bookings, contest tier (Pro vs Open), and the
typical award range for a ~700-LOC engagement?

Thanks,
{{ NAME }}
Specular Protocol
specular.financial
{{ EMAIL }}
```

---

## Recommendation

If you want **fastest**: Spearbit. Smaller teams, faster turnaround for focused-scope audits.

If you want **strongest brand** for marketing post-audit: Trail of Bits or OpenZeppelin.

If you want **broadest review** (many eyes): Code4rena contest.

If budget-constrained: Code4rena's tiered pricing has a low end; smaller boutiques (e.g., Pashov, zellic) also reasonable.

## Attachments to share

- `forensics/output/regression-2026-05-07/audit-package.tar.gz` (270K)
- Or a clone link: `https://github.com/thegrand-canyon/specular.git` (tag: `v6-pre-audit-2026-05-12`) — works after push
