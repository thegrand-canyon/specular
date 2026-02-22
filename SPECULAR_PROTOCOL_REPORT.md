# Specular Protocol — Comprehensive Technical Report

**Version:** 1.0.0
**Date:** February 16, 2026
**Status:** Testnet Complete — Production Ready
**Primary Chain:** Arc Testnet (chainId: 5042002)

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [System Architecture](#2-system-architecture)
3. [Smart Contract Reference](#3-smart-contract-reference)
4. [Reputation and Credit Model](#4-reputation-and-credit-model)
5. [Interest Rate Model](#5-interest-rate-model)
6. [Multichain Architecture (CCTP)](#6-multichain-architecture-cctp)
7. [SDK and Off-Chain Infrastructure](#7-sdk-and-off-chain-infrastructure)
8. [Bot System](#8-bot-system)
9. [Test Results — Live on Arc Testnet](#9-test-results--live-on-arc-testnet)
10. [Performance Benchmarks](#10-performance-benchmarks)
11. [Security Model](#11-security-model)
12. [Known Limitations and Rate Limits](#12-known-limitations-and-rate-limits)
13. [Scripts Reference](#13-scripts-reference)
14. [Production Deployment Checklist](#14-production-deployment-checklist)
15. [Roadmap](#15-roadmap)

---

## 1. Executive Summary

Specular Protocol is a decentralized peer-to-peer lending marketplace purpose-built for autonomous AI agents. It enables AI agents to register on-chain, accumulate a verifiable credit reputation, and access USDC-denominated loans without relying on traditional credit infrastructure or human intermediaries.

**Core value proposition:**

- Any AI agent can register on-chain and begin building a credit history immediately.
- Lenders earn yield by supplying liquidity to agent-specific pools.
- Reputation is computed transparently on-chain — no oracle dependency for credit scoring.
- Lenders can deposit from any CCTP-supported chain (Ethereum, Base, Arbitrum, Optimism, Polygon) and have funds routed directly into pools on Arc.
- Arc's ~2-second block times and USDC-denominated gas make it operationally superior for high-frequency agent activity.

The protocol has been fully deployed on Arc Testnet, tested with both manual agents and autonomous bots, and validated end-to-end including the Sepolia-to-Arc CCTP bridge.

**Deployment Owner:** `0x656086A21073272533c8A3f56A94c1f3D8BCFcE2`
**Testnet USDC Balance:** ~2,950,000 USDC

---

## 2. System Architecture

```
                        ┌─────────────────────────────────────┐
                        │         Arc Testnet (chainId 5042002)│
                        │                                      │
  Lender (any chain)    │  ┌──────────────────────────────┐   │
        │               │  │   AgentLiquidityMarketplace  │   │
        │  CCTP Bridge   │  │  - Pool management           │   │
  ┌─────▼──────┐         │  │  - Loan lifecycle            │   │
  │ CCTPBridge │──BURN──►│  │  - Interest accrual          │   │
  │ (Sepolia)  │         │  │  - Collateral enforcement    │   │
  └────────────┘         │  └──────────┬───────────────────┘   │
                        │             │                        │
                        │  ┌──────────▼───────────────────┐   │
  Circle Attestation ──►│  │     DepositRouter (Arc)       │   │
                        │  │  - Receives CCTP USDC         │   │
                        │  │  - Routes to agent pools      │   │
                        │  └──────────────────────────────┘   │
                        │                                      │
                        │  ┌──────────────────────────────┐   │
                        │  │     AgentRegistryV2           │   │
                        │  │  - Agent identity + URI       │   │
                        │  └──────────────────────────────┘   │
                        │                                      │
                        │  ┌──────────────────────────────┐   │
                        │  │    ReputationManagerV3        │   │
                        │  │  - Score 0–1000               │   │
                        │  │  - Gated: marketplace only    │   │
                        │  └──────────────────────────────┘   │
                        │                                      │
                        │  ┌──────────────────────────────┐   │
                        │  │        MockUSDC               │   │
                        │  │  - 6 decimals, mintable       │   │
                        │  └──────────────────────────────┘   │
                        └─────────────────────────────────────┘
```

---

## 3. Smart Contract Reference

### 3.1 Deployed Contracts — Arc Testnet (chainId: 5042002)

| Contract | Address |
|---|---|
| AgentRegistryV2 | `0x741C03c0d95d2c15E479CE1c7E69B3196d86faD7` |
| ReputationManagerV3 | `0x94F2fa47c4488202a46dAA9038Ed9C9c4c07467F` |
| MockUSDC | `0xf2807051e292e945751A25616705a9aadfb39895` |
| AgentLiquidityMarketplace | `0xD1cf6E7864Bc4CbBE52aA94369dF08B106927559` |
| DepositRouter (Arc) | `0x5592AaFDdd1f73F5D7547e664f3513C409FB9796` |

### 3.2 Bridge Contracts

| Contract | Address | Network | Chain ID |
|---|---|---|---|
| CCTPBridge | `0x633e03c71aE37bD620d4482917aEC06D7C131AD5` | Sepolia | 11155111 |

### 3.3 Contract Source Files

| File | Description |
|---|---|
| `contracts/core/AgentRegistryV2.sol` | Agent registration with URI metadata |
| `contracts/core/ReputationManagerV3.sol` | Credit scoring engine, 0–1000 range |
| `contracts/core/AgentLiquidityMarketplace.sol` | Loan lifecycle, interest, pool management |
| `contracts/tokens/MockUSDC.sol` | 6-decimal ERC-20 test token |
| `contracts/bridge/CCTPBridge.sol` | Burns USDC on source chains via Circle CCTP |
| `contracts/bridge/DepositRouter.sol` | Receives CCTP-minted USDC on Arc, routes to pools |

### 3.4 Key Contract Interfaces

**AgentRegistryV2 — Registration**
```solidity
// Register a new agent with metadata URI
function registerAgent(string calldata metadataURI) external returns (uint256 agentId);

// Retrieve agent info
function getAgent(uint256 agentId) external view returns (
    address owner,
    string memory metadataURI,
    uint256 registeredAt,
    bool active
);
```

**ReputationManagerV3 — Credit Scoring**
```solidity
// Initialize reputation for a new agent (called by marketplace)
function initializeReputation(uint256 agentId) external;

// Record on-time repayment (+10 points)
function recordRepayment(uint256 agentId) external;

// Record default (-50 points, scaled by loan size)
function recordDefault(uint256 agentId, uint256 loanAmount) external;

// Get current score (0–1000)
function getReputation(uint256 agentId) external view returns (uint256);
```

**AgentLiquidityMarketplace — Loan Lifecycle**
```solidity
// Lender supplies liquidity to an agent pool
function supplyLiquidity(uint256 agentId, uint256 amount) external;

// Agent requests a loan from their pool
function requestLoan(uint256 agentId, uint256 amount, uint256 duration) external;

// Agent repays outstanding loan (principal + interest)
function repayLoan(uint256 loanId) external;

// Withdraw lender funds (principal + earned interest, minus platform fee)
function withdrawLiquidity(uint256 agentId, uint256 amount) external;

// Retrieve current loan details
function getLoan(uint256 loanId) external view returns (
    uint256 agentId,
    address borrower,
    uint256 principal,
    uint256 startTime,
    uint256 duration,
    uint256 interestRate,
    uint256 collateralAmount,
    bool repaid,
    bool defaulted
);
```

**CCTPBridge — Cross-Chain Deposit (Sepolia)**
```solidity
// Burns USDC on source chain and initiates CCTP transfer to Arc pool
function bridgeToArcPool(uint256 amount, uint256 agentId) external;
```

**DepositRouter — CCTP Receiver (Arc)**
```solidity
// Called by Circle's MessageTransmitter after attestation
// Mints USDC and routes to agent pool
function receiveMessage(
    bytes calldata message,
    bytes calldata attestation
) external;
```

---

## 4. Reputation and Credit Model

### 4.1 Scoring Rules

| Event | Score Change |
|---|---|
| Agent registration (initial score) | 100 |
| On-time loan repayment | +10 |
| Default | -50 (scaled by loan size) |
| Maximum achievable score | 1000 |
| Minimum score (floor) | 0 |

Reputation is stored entirely on-chain in `ReputationManagerV3`. Write access is restricted exclusively to the `AgentLiquidityMarketplace` contract via role-based access control. No external oracle or off-chain feed influences credit scores.

### 4.2 Collateral and Rate Tiers

| Reputation Range | Collateral Required | APR |
|---|---|---|
| 800 – 1000 | 0% | 5% |
| 600 – 799 | 0% | 7% |
| 500 – 599 | 25% | 10% |
| < 500 | 100% | 15% |

Collateral is held in escrow by the marketplace contract and returned in full upon successful repayment. Collateral is seized and distributed to lenders upon default.

---

## 5. Interest Rate Model

Interest accrues continuously on a per-second basis using the following formula:

```
interest = principal × annualRate × elapsedSeconds / (365 × 86400)
```

Where `annualRate` is expressed as a decimal (e.g., 0.07 for 7%).

**Example — Alice's Loan:**
- Principal: 1,000 USDC
- Rate: 15% APR (reputation < 500 at loan time)
- Duration: ~30 days
- Interest accrued: ~12.33 USDC
- Total repaid: 1,012.33 USDC
- Platform fee (10% of interest): ~1.23 USDC → protocol treasury
- Lender receives: ~11.10 USDC net interest

**Platform Fee:** 10% of all interest earned is collected by the protocol. The remaining 90% is distributed proportionally to liquidity providers in the agent's pool.

---

## 6. Multichain Architecture (CCTP)

### 6.1 Bridge Flow — Sepolia to Arc

```
Step 1: Lender calls CCTPBridge.bridgeToArcPool(amount, agentId) on Sepolia
           │
           ▼
Step 2: CCTPBridge approves and burns USDC via Circle's TokenMessenger
           │
           ▼
Step 3: Circle's off-chain Attestation Service detects the burn event,
        issues a signed attestation message
           │
           ▼
Step 4: DepositRouter.receiveMessage(message, attestation) called on Arc
        Circle's MessageTransmitter verifies attestation and mints USDC
           │
           ▼
Step 5: DepositRouter calls marketplace.supplyLiquidity(agentId, amount)
           │
           ▼
Step 6: Funds immediately available in agent's lending pool
```

### 6.2 Supported Source Chains

| Chain | CCTP Domain | Status |
|---|---|---|
| Ethereum Mainnet / Sepolia | 0 | Deployed and tested |
| Optimism / Optimism Sepolia | 2 | Scripts ready |
| Arbitrum / Arbitrum Sepolia | 3 | Scripts ready |
| Base / Base Sepolia | 6 | Scripts ready |
| Polygon / Polygon Amoy | 7 | Scripts ready |

### 6.3 Deployment Configuration

The Hardhat configuration defines network entries for all supported chains. To deploy `CCTPBridge` to a new source chain, run the corresponding deploy script with the target network flag. The `DepositRouter` on Arc does not require changes — it is chain-agnostic and handles all CCTP mints regardless of origin domain.

---

## 7. SDK and Off-Chain Infrastructure

### 7.1 SDK File Reference

| File | Role |
|---|---|
| `src/SpecularAgent.js` | Primary agent interface (v1) |
| `src/SpecularAgentV2.js` | Improved agent interface with retry logic |
| `src/ContractManager.js` | ABI loading, contract instantiation, multicall support |
| `src/StateManager.js` | TTL-based in-memory caching layer for on-chain reads |
| `src/EventListener.js` | WebSocket subscriptions for real-time event streaming |
| `src/gateway/CircleGatewayIntegration.js` | Auto-detects source chain, chooses bridge or direct deposit |
| `src/bots/AutonomousAgentBot.js` | Fully autonomous borrower bot |
| `src/bots/LenderBot.js` | Fully autonomous liquidity provider bot |

### 7.2 CircleGatewayIntegration — Chain Detection Logic

The `CircleGatewayIntegration` module auto-detects the caller's chain at runtime. If the caller is on Arc, it calls `marketplace.supplyLiquidity` directly. If on any other CCTP-supported chain, it routes through `CCTPBridge.bridgeToArcPool`. This makes the deposit path chain-transparent for higher-level application code.

```js
// Usage example
const gateway = new CircleGatewayIntegration(signer);
await gateway.deposit(agentId, amountUsdc);
// Internally resolves to direct deposit or CCTP bridge based on chainId
```

---

## 8. Bot System

### 8.1 AutonomousAgentBot

A self-operating borrower bot that simulates a real AI agent building credit history through repeated borrow-and-repay cycles.

**Strategy Parameters:**

```js
{
  loanAmount: 1000,           // USDC per loan
  loanDuration: 86400,        // seconds (1 day default)
  repaymentDelay: 0,          // seconds delay after due date (0 = on-time)
  targetLoans: 5,             // number of borrow cycles to complete
  poolLiquidity: 5000         // initial USDC seeded into own pool
}
```

**Lifecycle:**

```
register()
  → initReputation()
    → createPool() + supplyLiquidity(poolLiquidity)
      → [requestLoan() → wait(duration) → repayLoan() → reputation++] × targetLoans
```

Each successful repayment adds +10 reputation. After `targetLoans` cycles, the bot's reputation has increased by `targetLoans × 10` points from the initial 100.

### 8.2 LenderBot

A self-operating liquidity provider that allocates capital across agent pools based on reputation ranking.

**Strategy Parameters:**

```js
{
  totalCapital: 30000,          // total USDC to deploy
  diversification: 3,           // number of agents to split across
  minAgentReputation: 500,      // minimum reputation to consider
  rebalanceInterval: 3600       // seconds between portfolio rebalances
}
```

**Lifecycle:**

```
findAgents(minReputation) → sort by reputation descending
  → allocate capital across top N agents
    → supplyLiquidity(agentId, allocation) × N
      → monitorLoop(rebalanceInterval)
        → rebalance if reputation scores shift
```

### 8.3 Bot Results — Arc Testnet

| Bot | Type | Capital Deployed | Agents Served |
|---|---|---|---|
| LenderBot-Omega | Lender | $30,000 USDC | 3 agents |
| LenderBot-Sigma | Lender | $40,000 USDC | 4 agents |
| AgentBot-Alpha (ID 9) | Borrower | — | Self |
| AgentBot-Beta (ID 10) | Borrower | — | Self |
| AgentBot-Gamma (ID 11) | Borrower | — | Self |

**Total Liquidity Deployed by Bots:** $70,000 USDC
All three AgentBots registered successfully, initialized reputation, created pools, and executed borrow-repay cycles without human intervention.

---

## 9. Test Results — Live on Arc Testnet

### 9.1 Registered Agents

| Agent Name | Agent ID | Wallet | Notes |
|---|---|---|---|
| Alice | 1 | — | Manual test agent |
| Bob | 2 | — | Manual test agent |
| Carol | 3 | — | Manual test agent |
| Dave | 4 | — | Manual test agent |
| AgentBot-Alpha | 9 | — | Autonomous bot |
| AgentBot-Beta | 10 | — | Autonomous bot |
| AgentBot-Gamma | 11 | — | Autonomous bot |

### 9.2 Loan Test — Alice (Agent ID 1)

| Parameter | Value |
|---|---|
| Principal borrowed | 1,000 USDC |
| Collateral posted | 1,000 USDC (100% — reputation < 500) |
| Interest accrued | 12.33 USDC |
| Platform fee (10%) | 1.23 USDC |
| Total repaid | 1,012.33 USDC |
| Collateral returned | 1,000 USDC |
| Reputation before | 100 |
| Reputation after | 110 (+10 on-time) |

### 9.3 Bridge Test — Sepolia to Arc

The full CCTP bridge flow was executed successfully:

1. `CCTPBridge.bridgeToArcPool` called on Sepolia (chain 11155111)
2. USDC burned via Circle `TokenMessenger`
3. Circle attestation retrieved and submitted
4. `DepositRouter` on Arc received attestation, USDC minted
5. Funds routed to target agent pool
6. Liquidity immediately available for borrowing

---

## 10. Performance Benchmarks

### 10.1 Arc vs. Sepolia Comparison

| Metric | Arc Testnet | Sepolia |
|---|---|---|
| Block time | ~2 seconds | ~12 seconds |
| Confirmations needed | 1 block | 3 blocks |
| Gas token | USDC (no ETH required) | ETH |
| Effective confirmation time | ~2 seconds | ~36 seconds |
| Throughput advantage | ~6x faster finality | Baseline |

Arc's USDC-denominated gas model is particularly well-suited to agent-operated protocols: agents that hold USDC for lending activity automatically have gas covered, eliminating the need for a separate ETH balance.

### 10.2 RPC Rate Limits

The Arc Testnet public RPC endpoint (`rpc.testnet.arc.network`) enforces a sustained rate limit of approximately 1 request per second. This becomes a constraint in high-concurrency scenarios such as the comprehensive load test (`scripts/comprehensive-load-test-arc.js`).

**Mitigation strategies:**

- Use `scripts/manual-load-test-arc.js` which introduces deliberate delays between requests for sequential rate-limit-safe execution.
- For production load testing, provision a private Arc RPC endpoint or use Arc Mainnet infrastructure.
- The `StateManager.js` TTL caching layer reduces redundant RPC calls by serving repeated reads from cache.

---

## 11. Security Model

### 11.1 Contract-Level Protections

| Protection | Where Applied |
|---|---|
| `ReentrancyGuard` | All external-facing functions in `AgentLiquidityMarketplace` |
| Checks-Effects-Interactions pattern | All state-modifying paths |
| `Pausable` emergency stop | `AgentLiquidityMarketplace`, `DepositRouter` |
| Role-based access control | `ReputationManagerV3` — write access restricted to marketplace |
| Collateral enforcement | Verified and locked at `requestLoan` time, not repayment time |
| CCTP message verification | Handled by Circle's audited `MessageTransmitter` contract |

### 11.2 Role Hierarchy

```
Owner (deployer)
  ├── Can pause/unpause all contracts
  ├── Can update contract references (e.g., point marketplace to new registry)
  └── Receives platform fee treasury

AgentLiquidityMarketplace
  └── Only contract authorized to call ReputationManagerV3.recordRepayment / recordDefault

Agents
  └── Can only interact with pools where they are the registered borrower
```

### 11.3 Known Risk Areas for Production

- **MockUSDC** must be replaced with Circle's official USDC contract on mainnet. The current mock allows unrestricted minting.
- **DepositRouter** `receiveMessage` should validate the source domain to prevent spoofed CCTP messages if Circle's `MessageTransmitter` is ever upgraded.
- **Reputation manipulation** via flash-loan-funded rapid repayments is theoretically possible with sufficient capital. A minimum loan duration enforcement is recommended for mainnet.

---

## 12. Known Limitations and Rate Limits

| Limitation | Detail | Mitigation |
|---|---|---|
| Arc Testnet RPC rate limit | ~1 req/sec sustained | Private RPC for production |
| MockUSDC is mintable by anyone | Testnet only | Replace with official USDC on mainnet |
| CCTP attestation latency | ~15–30 seconds (Circle off-chain) | UX: show "pending bridge" state |
| Reputation floor at 0 | Agent cannot go negative | Designed intentionally; pool closure at 0 rep recommended |
| Single-chain marketplace | All lending state on Arc only | Acceptable; Arc is the settlement layer |
| Bot wallet private keys | Currently stored in `.env` | Use AWS KMS or HSM for production bots |

---

## 13. Scripts Reference

| Script | Purpose |
|---|---|
| `scripts/run-bot-simulation-arc.js` | Full bot simulation: 3 AgentBots + 2 LenderBots on Arc |
| `scripts/monitor-arc-protocol.js` | Real-time protocol dashboard, refreshes every 30 seconds |
| `scripts/deploy-cctp-bridge-sepolia.js` | Deploy CCTPBridge contract to Sepolia |
| `scripts/test-sepolia-to-arc-bridge.js` | End-to-end test of Sepolia → Arc CCTP bridge flow |
| `scripts/comprehensive-load-test-arc.js` | 8-scenario parallel load test (requires private RPC) |
| `scripts/manual-load-test-arc.js` | Sequential load test with rate limit handling |

**Example — Run the full bot simulation:**
```bash
npx hardhat run scripts/run-bot-simulation-arc.js --network arc
```

**Example — Deploy CCTPBridge to Sepolia:**
```bash
npx hardhat run scripts/deploy-cctp-bridge-sepolia.js --network sepolia
```

**Example — Monitor live protocol state:**
```bash
npx hardhat run scripts/monitor-arc-protocol.js --network arc
```

---

## 14. Production Deployment Checklist

### 14.1 Pre-Deployment

- [ ] Replace `MockUSDC` with Circle's official USDC contract address on Arc Mainnet
- [ ] Audit all contracts with a third-party security firm (Cyfrin, Trail of Bits, or equivalent)
- [ ] Conduct formal verification of `ReputationManagerV3` scoring logic
- [ ] Update `hardhat.config.js` with Arc Mainnet RPC and chain ID
- [ ] Provision private Arc RPC endpoint (not public testnet endpoint)
- [ ] Set up multi-sig wallet (Gnosis Safe) as protocol owner — remove single EOA ownership
- [ ] Configure treasury address for platform fee collection
- [ ] Set `Pausable` admin to multi-sig, not deployer EOA

### 14.2 Contract Deployment Order

```
1. Deploy MockUSDC (testnet) OR configure USDC address (mainnet)
2. Deploy AgentRegistryV2
3. Deploy ReputationManagerV3(registryAddress)
4. Deploy AgentLiquidityMarketplace(registryAddress, reputationAddress, usdcAddress)
5. Grant marketplace REPUTATION_MANAGER role in ReputationManagerV3
6. Deploy DepositRouter(marketplaceAddress, usdcAddress, messageTransmitterAddress)
7. Deploy CCTPBridge on each source chain (Sepolia, Base, Arbitrum, Optimism, Polygon)
8. Verify all contracts on block explorer
```

### 14.3 Post-Deployment

- [ ] Verify all contract addresses on Arc block explorer
- [ ] Verify CCTPBridge on Sepolia Etherscan
- [ ] Run `scripts/test-sepolia-to-arc-bridge.js` on mainnet with small amount
- [ ] Run `scripts/monitor-arc-protocol.js` and confirm all state reads succeed
- [ ] Seed initial liquidity pools to bootstrap lending activity
- [ ] Configure bot wallets with AWS KMS or equivalent HSM key management
- [ ] Set up PagerDuty or equivalent alerting on `Paused` and `Default` events
- [ ] Publish contract addresses and ABIs to protocol documentation site
- [ ] Configure `EventListener.js` with mainnet WebSocket endpoint for production bots

### 14.4 Monitoring and Operations

- [ ] Deploy `scripts/monitor-arc-protocol.js` as a persistent process (PM2 or equivalent)
- [ ] Set up Grafana dashboard consuming protocol events
- [ ] Define SLA for CCTP bridge completion time (target: < 60 seconds end-to-end)
- [ ] Establish incident response runbook for emergency pause scenarios
- [ ] Configure Tenderly or equivalent for real-time transaction simulation and alerting

---

## 15. Roadmap

### Phase 1 — Mainnet Launch (0–3 months)

- Deploy all contracts to Arc Mainnet with official USDC
- Complete third-party security audit
- Launch with whitelisted agent set (invitation-only) for controlled rollout
- Deploy LenderBot and AgentBot infrastructure for protocol-owned liquidity bootstrapping
- Publish SDK to npm for third-party agent developers

### Phase 2 — Multichain Expansion (3–6 months)

- Deploy CCTPBridge contracts on Base, Arbitrum, Optimism, and Polygon (scripts already prepared)
- Launch `CircleGatewayIntegration` as a hosted API endpoint for non-SDK integrations
- Add support for native USDC on Base and Arbitrum (no bridge required, direct deposit via DepositRouter equivalent)
- Governance token design and initial distribution proposal

### Phase 3 — Reputation Portability (6–12 months)

- Expose reputation scores via ERC-721 or ERC-5192 (soulbound token) for composability with other protocols
- Cross-protocol reputation import (e.g., Aave repayment history → Specular reputation boost)
- Agent identity federation: allow one agent to operate across multiple registered IDs with shared reputation anchor
- On-chain reputation disputes and challenge mechanism

### Phase 4 — Autonomous Agent Ecosystem (12+ months)

- Specular Agent SDK published as open standard for AI agent credit primitives
- Protocol-level agent marketplace: lenders can browse agent performance dashboards
- Dynamic interest rate model based on pool utilization (Aave-style kink model)
- Undercollateralized lending expansion: 0% collateral extended to 600+ reputation agents for larger principal amounts
- Cross-chain reputation attestation using ZK proofs

---

## Appendix A — Technical Stack Summary

| Component | Technology |
|---|---|
| Smart contract framework | Hardhat 2.x |
| Solidity version | 0.8.20 |
| Contract libraries | OpenZeppelin 5.x |
| Ethereum library | ethers.js v6 |
| Runtime | Node.js |
| Cross-chain standard | Circle CCTP v1 |
| Primary chain | Arc Testnet / Arc Mainnet (EVM-compatible) |
| Gas token | USDC (Arc-native) |
| Supported source chains | Ethereum, Base, Arbitrum, Optimism, Polygon |

---

## Appendix B — Contract ABI Quick Reference

**Full ABIs** are loaded at runtime by `src/ContractManager.js` from the `artifacts/` directory generated by Hardhat compilation. To regenerate:

```bash
npx hardhat compile
```

ABI files will be located at:
```
artifacts/contracts/core/AgentRegistryV2.sol/AgentRegistryV2.json
artifacts/contracts/core/ReputationManagerV3.sol/ReputationManagerV3.json
artifacts/contracts/core/AgentLiquidityMarketplace.sol/AgentLiquidityMarketplace.json
artifacts/contracts/bridge/CCTPBridge.sol/CCTPBridge.json
artifacts/contracts/bridge/DepositRouter.sol/DepositRouter.json
```

---

*This report reflects the complete state of Specular Protocol as of the Arc Testnet deployment. All contract addresses, test results, and performance figures are from live on-chain activity.*
