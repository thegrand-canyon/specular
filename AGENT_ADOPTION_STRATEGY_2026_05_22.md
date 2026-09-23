# Agent Adoption Strategy

**Date**: 2026-05-22
**Context**: V6 is live on Base mainnet + Arc testnet, fully audited (4 internal passes), zero violations across 7M+ USDC live throughput. Now the question is: **how do we get AI agents to actually use it?**

## The honest diagnosis

The contract is solid. The product is invisible. Right now Specular is in the same position as 90% of DeFi protocols: technically excellent, no real users. The work that matters from here is **distribution**, not engineering.

Current state (rough):
- Real-world TVL: $1.5 USDC on Base, ~30k USDC on Arc (testnet, including pool 1 + dispersed)
- Real-world borrowers: 3 agents on Base, ~115 on Arc (most are test/dev)
- Real-world repaid loans: 1 on V6 Base (the smoke test we just did), the §B1 stuck ones on v4
- Daily active agents: effectively 0

To go from 0 → 1000 daily-active agents, the contract is not the bottleneck.

---

## Five lenses on what agents actually need

### Lens 1: Onboarding friction

Today, an agent needs:
1. Wallet with ETH on Base for gas
2. Call `AgentRegistryV2.register()` → mint NFT (~80k gas)
3. Call `marketplace.createAgentPool()` (~150k gas)
4. Call `usdc.approve(marketplace, MaxUint)` (~50k gas)
5. Wait for a lender to supply liquidity (or be the same wallet)
6. Call `requestLoan(amount, days)` (~430k gas first loan)

That's **5+ transactions before getting any USDC**, ~720k gas total. On Base at $0.0001/gas = $0.07 cost — fine for humans, prohibitive for an agent spinning up programmatically with no funds.

**The "first transaction" is the killer**. An agent needs ETH to do anything, but to get ETH they need a wallet, and to get a useful wallet they need ETH. Solving this is the highest-leverage onboarding fix.

### Lens 2: Capital efficiency

For a new agent at reputation 0, V6 offers:
- 1,000 USDC credit limit (the lowest tier)
- **100% collateral required**
- 15% APR

This means a new agent needs $1,000 of USDC to borrow $1,000 of USDC. That's not credit, that's a self-loop.

The reputation system addresses this — over time, an agent reaches 0% collateral with 50k USDC credit at 5% APR. But the path from 0 → 800 score requires **80 successful loan repayments**, each requiring collateral the agent doesn't have at the start.

**The chicken-and-egg problem is the core economic friction.** Resolving it is the difference between "interesting protocol" and "actually useful protocol."

### Lens 3: Network and chain access

Agents in 2026 don't have a chain preference. They run wherever the user / orchestrator runs. Right now Specular is:
- Live on Base (real money, V6)
- Live on Arc Testnet (V6 with stress evidence)
- Mentioned in configs for Arbitrum, Optimism, Polygon (not deployed)

Each chain requires:
- Separate deployment
- Separate gas funding
- Separate agent registration
- Separate reputation building

That's a lot of friction per chain.

### Lens 4: Real-world utility

Even if onboarding were free, an agent needs to *want* USDC. What does an AI agent do with USDC?
- Pay API providers (OpenAI, Anthropic, Replicate)
- Compute (GPU rentals via Akash, vast.ai)
- Storage (Filecoin, Arweave)
- Other on-chain protocols (settlement, trading capital)
- Hire other agents

For most of these, USDC needs to convert to something else. The further the conversion path, the higher the friction.

The agents most likely to use USDC credit are **agents that already operate on-chain** — trading bots, MEV searchers, AMM rebalancers, agent-to-agent payment systems. That's a narrower market than "all AI agents".

### Lens 5: Trust and discovery

How does an agent find out Specular exists?
- A human developer integrates it (one-time, slow)
- It's listed in an agent framework's tool catalog (LangChain, OpenAI Functions)
- It's discoverable via on-chain queries (very few agents do this)
- An aggregator surfaces it (none exist for agent-credit specifically)

For trust:
- Audit signal: we have 4 internal audits but no external. Sophisticated users will discount internal-only audits heavily.
- TVL signal: $1.5 USDC on Base. That's a "not in production" signal to anyone evaluating.
- Track record: 1 real loan completed. Same signal.

---

## Top 10 things to ship for agent adoption (ranked by impact × ease)

### Tier 1 — Highest ROI

**1. One-shot onboarding endpoint**

Add an API endpoint `POST /agent/onboard` that bundles register + createAgentPool + approve into a single ERC-2771 meta-transaction. Agent signs once, protocol pays gas, agent is fully set up.

Engineering: 2-3 days. Infrastructure: a relayer service to pay gas + ERC-2771 trusted forwarder. Cost: ~$0.50/agent in subsidized gas.

This is the single biggest reduction in onboarding friction.

**2. Initial credit boost (gas-equivalent USDC airdrop)**

When a new agent onboards, the protocol grants them 10 USDC of initial credit (or actual USDC) so they can take a meaningful first loan and start building reputation. Funded from accumulated fees.

Engineering: 1 day. Cost: $10/agent. ROI: agent starts the rep flywheel immediately instead of needing external capital.

**3. Sponsored gas for agents below score 300**

Lower-rep agents have transactions paid for by the protocol (via Pimlico/Biconomy). Same ERC-2771 infrastructure as #1. Once they cross score 300, they pay their own gas. Removes the "ETH-to-borrow-ETH" trap.

Engineering: 1 day on top of #1.

### Tier 2 — High ROI, more work

**4. SDK integrations into major agent frameworks**

LangChain tool, OpenAI Function definition, Anthropic tool, AutoGPT plugin, Camel-AI integration. Each integration is one PR + one example notebook + one tutorial.

```python
# Example: LangChain tool
from specular import SpecularTool
tools = [SpecularTool(borrower_key=agent_key)]
agent.run("Borrow 100 USDC against my reputation to pay for compute")
```

Engineering: 2 days per framework, 5 frameworks. Cost: nothing. ROI: massive — these are the surfaces where developers FIND tools.

**5. Pre-built agent templates**

"Spin up a trading bot with a $50 credit line": single-command deploy that wires up a strategy + Specular credit + execution. Same for: API-payments agent, compute-rental agent, market-making agent.

Engineering: 1 week per template. Templates double as integration tests + marketing material + working examples.

**6. Reputation portability / off-chain credit signals**

Agents can prove off-chain identity (GitHub activity, validator attestations, ERC-8004 validations, ENS staking) to bootstrap a higher initial reputation. Integrate with Worldcoin / Privado.ID / Verified Credentials.

Engineering: 2-3 weeks. Reuses existing `validationRegistry` plumbing. ROI: solves the cold-start problem for agents that have proven themselves elsewhere.

### Tier 3 — Strategic, longer-term

**7. Cross-chain reputation bridge**

Agent's reputation on Arc applies to Base (and any future chain). Implementation: CCIP or LayerZero relayed score sync, or canonical reputation chain.

Engineering: 1-2 months. Significantly expands TAM as more chains are added without forcing agents to re-build rep per chain.

**8. Specular as a primitive — yield-bearing position tokens (sLP)**

When a lender supplies USDC, they get `sLP-USDC-{agentId}` ERC-20 tokens representing their position. These tokens auto-accrue value as interest is paid and are transferable. Tradable on Uniswap, usable as collateral elsewhere.

Engineering: 1 month. ROI: brings DeFi composability, unlocks integrations with Aave/Compound, attracts lender capital.

**9. Agent-to-agent payment rails**

Build a layer on top of Specular: agents can request payment from other agents, with credit lines bridging the gap. Standardized protocol for "Agent A asks Agent B for $5 of compute time, payable with V6 credit".

Engineering: 2-3 months. Speculative but high upside — could become the rails for an agent-to-agent economy.

**10. Insurance / underwriting marketplace**

Validators stake bonds to attest to agents. Validators earn fees on attestations. Stake gets slashed on bad attestations. Creates a market for credit underwriting.

Already partly designed via ERC-8004 + ValidationRegistry. Just needs activation + UX.

---

## What NOT to do

- **Don't launch a governance token yet.** Regulatory complexity, no clear demand, distracts from product.
- **Don't add new collateral types (NFTs, other ERC20s)** before there's USDC volume. Attack surface up, no demand.
- **Don't deploy to 5 more chains** before there's usage on Base/Arc. Maintenance burden up, no traction.
- **Don't optimize the contract further** before scaling problems show up. V6 is fast enough.

---

## What I'd ship first if I were running this

Looking at the table above, **#1 (meta-tx onboarding) + #2 (initial credit boost) + #3 (sponsored gas) are the same project**. Together they reduce agent onboarding from "5+ tx + ETH + USDC + 5 minutes" to "1 signature + 0 ETH + 0 USDC + 30 seconds with $10 of credit already in hand."

That's the single biggest unlock for adoption. Estimated 4-week engineering sprint.

After that ships, **#4 (SDK integrations)** is the distribution channel: get the new one-shot onboarding into LangChain/OpenAI/Anthropic tool catalogs. ~2 weeks of integration work, then word-of-mouth growth.

Six weeks of focused work, and Specular goes from "0 daily active agents" to "every developer building an agent in LangChain/OpenAI sees Specular as a default credit option".

---

## The honest TAM caveat

Even with perfect distribution, the market for AI-agent credit in 2026 is small. Most "AI agents" today are:
- Wrappers around OpenAI/Anthropic APIs that handle text/code generation (don't need USDC)
- Internal tools at companies (paid by the company, not via on-chain credit)
- Specific verticals: trading bots, MEV, agent-to-agent payment, autonomous compute purchases

The real protocol-fit users are agents in those specific verticals. The ramp from 0 → meaningful TVL probably takes 12+ months of distribution work, partnerships, and the broader agent ecosystem maturing.

Specular's bet is right: AI agents will eventually be a major economic actor on chain. The protocol just needs to survive long enough for that future to arrive, and be the obvious choice when it does.

---

## Concrete near-term to-do

1. Decide if you want to fund the meta-tx onboarding sprint (~$10k of dev + gas subsidies)
2. Identify the first 5 framework integrations to ship (LangChain, OpenAI Functions, Anthropic Tools, AutoGPT, Camel-AI?)
3. Draft a "first 10 agents" partner outreach — find 10 builders working on agents that NEED credit
4. Decide on the gas-subsidy mechanism (Pimlico vs Biconomy vs custom relayer)
5. Pick a target launch metric (e.g., 100 agents with score > 100 within 60 days of meta-tx onboarding launch)

Open to discussion on priorities.
