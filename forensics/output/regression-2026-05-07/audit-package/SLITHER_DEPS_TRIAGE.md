# Slither Triage — V6 Dependency Contracts

Slither run on the three contracts V6 trusts: AgentRegistryV2, ReputationManagerV3, ValidationRegistry. **Out of V6 audit scope** but documented here because V6 inherits the trust chain.

| Contract | Total slither results |
|----------|----------------------:|
| AgentRegistryV2 | 66 |
| ReputationManagerV3 | 86 |
| ValidationRegistry | (parsing — many) |

## Most notable finding — AgentRegistryV2.register reentrancy

**Finding**: `reentrancy-no-eth` in `register(string, MetadataEntry[])`

```solidity
// AgentRegistryV2.sol:71-105
_safeMint(msg.sender, agentId);  // line 81 — fires ERC721 callback
_setTokenURI(agentId, agentURI); // line 82
// ... metadata loop ...
addressToAgentId[msg.sender] = agentId;  // line 94 — AFTER external call
```

**Mechanism**: If `msg.sender` is a contract implementing `IERC721Receiver`, its `onERC721Received` callback runs AFTER the mint but BEFORE `addressToAgentId[msg.sender]` is written. The callback can re-enter `register()` because the "already registered" check (line 75) reads `addressToAgentId[msg.sender]` which is still 0.

**Impact**:
- A malicious contract receiver can register **multiple agentIds for the same address** by re-entering during the safeMint callback
- Each registration consumes a unique agent ID
- The address holds multiple agent NFTs; `addressToAgentId` ends up pointing only to the most recent
- Older agent records (`agents[oldId]`) are orphaned in storage but still exist
- Token URIs accumulate; reputation systems treat the older IDs as ghost agents

**Severity assessment**: Medium-low.
- Doesn't steal funds from anyone
- Doesn't grant elevated permissions
- Does allow griefing (cluttering agent ID namespace, wasting storage)
- Triggers only when msg.sender is a contract — most agents are EOAs
- AgentRegistryV2 is currently locked to secure-wallet ownership; abuse limited to whoever holds that key

**Fix recommendation**: Follow checks-effects-interactions — write `addressToAgentId[msg.sender] = agentId` BEFORE calling `_safeMint`. Or add `nonReentrant` modifier to `register`.

**V6 impact**: V6 reads `addressToAgentId(msg.sender)` to determine if the caller is a registered agent. If a contract has multiple agent IDs (due to this bug), V6 sees only the latest. V6 isn't broken by this, but it could be used to confuse reputation tracking. Out of scope for the V6 audit; should be addressed in a separate AgentRegistryV2 upgrade.

## Other findings (informational)

- **incorrect-exp / divide-before-multiply / timestamp / pragma / naming-convention / etc.** — standard slither noise on inherited OZ deps and project style. Same triage pattern as V6:
  - `divide-before-multiply` in reputation calculations: intentional ordering for uint256 safety
  - `timestamp`: canonical time source, low risk in lending context
  - `unindexed-event-address`: cosmetic
  - `naming-convention`: project style, dependency code mostly compliant

- **`unused-return` in `ReputationManagerV3.calculateCreditLimit`**: ignores 3 of 4 fields from `validationRegistry.getSummary(...)`. The `avgScore` IS used; others (validator counts, etc.) discarded. Cosmetic.

- **`immutable-states` in ReputationManagerV3**: `agentRegistry` should be immutable (matches V6's slither fix pattern). Would save gas on every read.

## Recommendation

For the V6 audit, scope decision:
- **Option A (narrower)**: Keep audit scoped to V6 only. Note these registry findings in audit appendix; address in a separate v3 upgrade.
- **Option B (wider)**: Add AgentRegistryV2 to the audit scope. Concretely, fix the reentrancy + immutable, redeploy registry + V6.

Option A is faster and gets V6 to mainnet sooner. Option B is comprehensive but slower (the registry has live agents — migrating is more invasive than V6).

Raw output: `slither-deps-output.txt` (1122 lines), per-contract JSON in `slither-{AgentRegistryV2,ReputationManagerV3,ValidationRegistry}.json`.
