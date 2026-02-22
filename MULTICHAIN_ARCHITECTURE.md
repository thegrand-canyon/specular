# Specular Protocol - Multichain Architecture

## Overview
Multichain P2P lending protocol with Arc Network as the primary lending chain, using Circle Gateway and CCTP for seamless USDC routing from any supported chain.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        USER EXPERIENCE                          │
│  Deposit USDC from ANY chain → Automatically routes to Arc      │
└─────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────┐
│                      CIRCLE GATEWAY                             │
│  • Single SDK for USDC onboarding from 8+ chains                │
│  • Fiat on-ramp (credit card → USDC)                           │
│  • Automatic chain selection & routing                          │
└─────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────┐
│                   CROSS-CHAIN TRANSFER PROTOCOL                 │
│  Supported Chains:                                              │
│  • Ethereum Mainnet                                             │
│  • Arbitrum                                                     │
│  • Optimism                                                     │
│  • Base                                                         │
│  • Polygon PoS                                                  │
│  • Avalanche                                                    │
│  • Solana                                                       │
│  • Noble (Cosmos)                                               │
└─────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────┐
│                    ARC NETWORK (Primary)                        │
│  • All lending pools on Arc                                     │
│  • All reputation on Arc                                        │
│  • USDC-native gas (optimal UX)                                │
│  • Fast 2s confirmations                                        │
│  • Predictable gas costs                                        │
└─────────────────────────────────────────────────────────────────┘
```

## Implementation Components

### 1. Frontend USDC Gateway
**File:** `src/gateway/CircleGatewayIntegration.js`
- Integrate Circle Gateway SDK
- Support deposits from 8+ chains
- Automatic routing to Arc
- Fiat on-ramp support

### 2. CCTP Bridge Contract
**File:** `contracts/bridge/CCTPBridge.sol`
- Receive USDC from any CCTP-supported chain
- Automatically forward to lending pools on Arc
- Track cross-chain transactions
- Handle bridge fees

### 3. Multichain Registry
**File:** `contracts/core/MultichainRegistry.sol`
- Map agent addresses across chains
- Unified agent identity (same agent ID on all chains)
- Cross-chain reputation sync

### 4. SDK Enhancement
**File:** `src/SpecularAgent.js`
- Auto-detect user's current chain
- Suggest optimal deposit path
- Handle CCTP transfers transparently
- Unified API regardless of deposit chain

## User Flow

### Scenario 1: User has USDC on Ethereum
```javascript
// User deposits 10,000 USDC from Ethereum
const agent = new SpecularAgent(wallet, { preferredChain: 'arc' });

// SDK automatically:
// 1. Detects user is on Ethereum
// 2. Uses CCTP to bridge to Arc
// 3. Supplies to lending pool on Arc
await agent.depositToPool(agentId, '10000');
// ✅ USDC now in lending pool on Arc
```

### Scenario 2: User has no USDC (Fiat on-ramp)
```javascript
// User wants to buy 10,000 USDC with credit card
const gateway = new CircleGateway();

// Gateway automatically:
// 1. Converts USD → USDC on optimal chain
// 2. Routes to Arc via CCTP
// 3. Deposits to lending pool
await gateway.buyAndDeposit({
  amount: '10000',
  currency: 'USD',
  destinationChain: 'arc',
  targetPool: agentId
});
// ✅ User funded lending pool with credit card
```

### Scenario 3: Agent borrows on Arc
```javascript
// Agent requests loan on Arc (always)
const agent = new SpecularAgent(wallet, { chain: 'arc' });
await agent.requestLoan('5000', 30);
// ✅ Loan disbursed instantly on Arc
```

## Circle Gateway Integration

### Features
- **Multi-chain USDC deposits**: Ethereum, Arbitrum, Base, Polygon, etc.
- **Fiat on-ramp**: Credit card → USDC → Arc
- **Automatic routing**: SDK handles optimal path
- **No manual bridging**: Users never interact with bridges

### Implementation Steps

1. **Install Circle Gateway SDK**
```bash
npm install @circle-fin/w3s-pw-web-sdk
```

2. **Initialize Gateway**
```javascript
import { CircleGateway } from '@circle-fin/w3s-pw-web-sdk';

const gateway = new CircleGateway({
  appId: process.env.CIRCLE_APP_ID,
  chains: ['ethereum', 'arbitrum', 'base', 'polygon', 'arc'],
  destinationChain: 'arc' // Always route to Arc
});
```

3. **Deposit Flow**
```javascript
// User selects source chain or uses credit card
const result = await gateway.transfer({
  amount: '10000',
  sourceChain: 'ethereum', // or 'fiat'
  destinationChain: 'arc',
  destinationAddress: marketplaceAddress
});
```

## CCTP Integration

### Features
- **Native USDC bridging**: Burn on source, mint on destination
- **No wrapped tokens**: Always native USDC
- **Fast**: Minutes instead of hours
- **Secure**: Circle-operated, battle-tested

### Implementation Steps

1. **CCTP Bridge Contract**
```solidity
// contracts/bridge/CCTPBridge.sol
contract CCTPBridge {
    ITokenMessenger public tokenMessenger;
    IMessageTransmitter public messageTransmitter;

    // Receive USDC from any chain via CCTP
    function bridgeToArc(
        uint256 amount,
        uint32 destinationDomain,
        address destinationContract
    ) external {
        // Burn USDC on source chain
        usdc.approve(address(tokenMessenger), amount);
        tokenMessenger.depositForBurn(
            amount,
            destinationDomain,
            destinationContract,
            address(usdc)
        );
    }

    // Receive USDC on Arc
    function receiveMessage(
        bytes memory message,
        bytes memory attestation
    ) external {
        // Verify and mint USDC on Arc
        messageTransmitter.receiveMessage(message, attestation);
        // Forward to lending pool
    }
}
```

2. **Auto-bridge in SDK**
```javascript
class SpecularAgent {
    async depositToPool(agentId, amount) {
        const currentChain = await this.detectChain();

        if (currentChain !== 'arc') {
            // Auto-bridge via CCTP
            console.log(`Bridging ${amount} USDC from ${currentChain} to Arc...`);
            await this.bridgeToArc(amount);
        }

        // Supply to pool on Arc
        await this.marketplace.supplyLiquidity(agentId, amount);
    }
}
```

## Supported Chains

### Phase 1: EVM Chains (CCTP)
1. **Arc Network** (Primary - lending happens here)
2. **Ethereum Mainnet** (Deposits only)
3. **Base** (Coinbase L2 - good UX)
4. **Arbitrum** (Popular L2)
5. **Optimism** (OP Stack)
6. **Polygon PoS** (Low fees)
7. **Avalanche C-Chain**

### Phase 2: Non-EVM (Future)
8. **Solana** (CCTP supported)
9. **Noble** (Cosmos USDC hub)

## Gas Strategy

### User Never Pays Bridge Fees
```javascript
// Frontend estimates total cost
const quote = await gateway.estimateDeposit({
    amount: '10000',
    sourceChain: 'ethereum',
    destinationChain: 'arc'
});

console.log(quote);
// {
//   sourceAmount: '10000 USDC',
//   bridgeFee: '1 USDC',
//   destinationAmount: '9999 USDC',
//   estimatedTime: '15 minutes'
// }
```

### Platform Subsidizes Small Bridges
- Specular pays CCTP fees for deposits > $1000
- Encourages large liquidity providers
- Smaller deposits pay minimal fee (~$1)

## Deployment Strategy

### Contract Deployment
```
Arc Network (Primary):
├── AgentRegistryV2 (canonical)
├── ReputationManagerV3 (canonical)
├── AgentLiquidityMarketplace (canonical)
└── USDC (native)

Ethereum:
├── CCTPBridge
└── DepositRouter → Routes to Arc

Arbitrum:
├── CCTPBridge
└── DepositRouter → Routes to Arc

Base:
├── CCTPBridge
└── DepositRouter → Routes to Arc

(Repeat for each chain)
```

### Why Arc is Primary?
1. **USDC-native gas** - Best UX for stablecoin protocol
2. **Fast finality** - 2s vs 12s on Ethereum
3. **Low costs** - Predictable USDC gas fees
4. **Unified liquidity** - All pools in one place
5. **Optimal for lending** - Circle's endorsed chain

## Frontend Architecture

### Multichain UX
```javascript
// components/DepositWidget.js
export function DepositWidget({ agentId }) {
    const [sourceChain, setSourceChain] = useState('auto');
    const [amount, setAmount] = useState('');

    // Auto-detect user's chain
    const currentChain = useWallet().chain;

    async function handleDeposit() {
        const gateway = new CircleGateway();

        // Gateway automatically routes to Arc
        await gateway.transfer({
            amount,
            sourceChain: currentChain,
            destinationChain: 'arc',
            targetPool: agentId
        });

        toast.success('USDC deposited to Arc pool!');
    }

    return (
        <div>
            <ChainSelector
                current={currentChain}
                supported={['ethereum', 'base', 'arbitrum', 'polygon']}
            />
            <input value={amount} onChange={(e) => setAmount(e.target.value)} />
            <button onClick={handleDeposit}>
                Deposit to Pool {currentChain !== 'arc' && '(via Arc)'}
            </button>
        </div>
    );
}
```

## Benefits

### For Users
✅ Deposit USDC from ANY chain
✅ No manual bridging
✅ Unified experience
✅ Fiat on-ramp support
✅ Always get optimal rates on Arc

### For Agents
✅ Access to liquidity from all chains
✅ Borrow on fastest chain (Arc)
✅ Build reputation on one chain
✅ Simple API

### For Lenders
✅ Supply from any chain
✅ Earn interest on Arc
✅ Withdraw to any chain
✅ No fragmented liquidity

## Implementation Timeline

### Week 1: Circle Gateway Integration
- [ ] Install Circle Gateway SDK
- [ ] Create deposit widget
- [ ] Test fiat on-ramp
- [ ] Test multi-chain deposits

### Week 2: CCTP Bridge Contracts
- [ ] Deploy CCTPBridge on Ethereum
- [ ] Deploy CCTPBridge on Base
- [ ] Deploy CCTPBridge on Arbitrum
- [ ] Test cross-chain transfers

### Week 3: SDK Enhancement
- [ ] Add auto-bridging to SDK
- [ ] Chain detection
- [ ] Unified deposit API
- [ ] Documentation

### Week 4: Testing & Polish
- [ ] End-to-end testing
- [ ] Gas optimization
- [ ] Frontend refinement
- [ ] Launch!

## Key Contracts to Build

1. **CCTPBridge.sol** - Handle CCTP messages on each chain
2. **DepositRouter.sol** - Route deposits to Arc pools
3. **MultichainRegistry.sol** - Unified agent identity
4. **WithdrawalManager.sol** - Withdraw to any chain

## Resources

- Circle Gateway Docs: https://developers.circle.com/gateway
- CCTP Docs: https://developers.circle.com/cctp
- CCTP Contract Addresses: https://developers.circle.com/cctp/cctp-protocol-contract
- Arc Network Docs: https://docs.arc.network

## Next Steps

1. Set up Circle Gateway API key
2. Deploy CCTPBridge to Ethereum testnet
3. Test Ethereum → Arc USDC transfer
4. Build deposit widget with chain selector
5. Integrate with existing marketplace
6. Launch multichain beta!
