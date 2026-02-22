# Using Specular Protocol on Sepolia

The Specular Protocol is now live on Sepolia testnet! This guide shows how AI agents can register, build reputation, and request loans.

## 🌐 Deployed Contracts

| Contract | Address | Sepolia Explorer |
|----------|---------|------------------|
| AgentRegistryV2 | `0xbd8210061bF24917Ca2F8098A1F3A4f76adA31fb` | [View](https://sepolia.etherscan.io/address/0xbd8210061bF24917Ca2F8098A1F3A4f76adA31fb) |
| ReputationManagerV2 | `0xe4D78A509daa8dc8bFB453cb76d61f1Cb1c4C3fF` | [View](https://sepolia.etherscan.io/address/0xe4D78A509daa8dc8bFB453cb76d61f1Cb1c4C3fF) |
| ValidationRegistry | `0x77f8D49C706A566Eecc9a2C3DD6556D5be54CACE` | [View](https://sepolia.etherscan.io/address/0x77f8D49C706A566Eecc9a2C3DD6556D5be54CACE) |
| MockUSDC | `0x771c293167AeD146EC4f56479056645Be46a0275` | [View](https://sepolia.etherscan.io/address/0x771c293167AeD146EC4f56479056645Be46a0275) |
| LendingPoolV2 | `0x5592A6d7bF1816f77074b62911D50Dad92A3212b` | [View](https://sepolia.etherscan.io/address/0x5592A6d7bF1816f77074b62911D50Dad92A3212b) |

**Pool Status:** 100,000 USDC liquidity available for loans

## 🚀 Quick Start for AI Agents

### Prerequisites

1. **Sepolia ETH**: Get free test ETH from [Google Cloud Faucet](https://cloud.google.com/application/web3/faucet/ethereum/sepolia)
2. **Wallet**: Create an Ethereum wallet with a private key
3. **RPC Endpoint**: Use a free public Sepolia RPC (e.g., `https://ethereum-sepolia-rpc.publicnode.com`)

### 1. Register as an Agent

```bash
# Check your status and register if needed
npx hardhat run examples/live-sepolia-agent.js --network sepolia
```

This will:
- Mint you an ERC-721 Agent NFT
- Initialize your reputation score at 500
- Give you a credit limit based on reputation

### 2. Get Test USDC (for collateral)

```bash
# Mint 10,000 test USDC
npx hardhat run scripts/mint-usdc-sepolia.js --network sepolia
```

### 3. Request a Loan

```bash
# Request a 1000 USDC loan for 30 days
npx hardhat run examples/request-loan-sepolia.js --network sepolia
```

### 4. Repay Your Loan

```bash
# Repay your active loan and improve reputation
npx hardhat run examples/repay-loan-sepolia.js --network sepolia
```

## 💳 How Loans Work

### Reputation Scoring (0-1000 scale)

- **Starting Score**: 500 points when you register
- **On-time Repayment**: +10 points
- **Late Repayment**: -5 points
- **Default**: -50 points

### Loan Terms Based on Reputation

| Reputation Score | Credit Limit | Collateral Required |
|------------------|--------------|---------------------|
| 800-1000 | 50,000 USDC | 0% |
| 600-799 | 25,000 USDC | 0% |
| 400-599 | 10,000 USDC | 25% |
| 200-399 | 5,000 USDC | 50% |
| Below 200 | 1,000 USDC | 100% |

*Interest rates are calculated by the lending pool based on various factors including reputation score and loan duration.*

### Loan Lifecycle

1. **Request**: Agent requests loan with amount and duration
2. **Approval**: Pool manager approves the request (currently manual)
3. **Active**: USDC is transferred to agent's wallet
4. **Repayment**: Agent repays principal + interest
5. **Reputation Update**: Score increases (on-time) or decreases (late/default)

## 📊 Example: Agent Journey

### Initial State (100 reputation)
- Reputation: 100
- Credit Limit: 1,000 USDC
- Collateral: 100% required (fully collateralized)

### After 10 On-Time Repayments (200 reputation)
- Reputation: 200 (+100)
- Credit Limit: 5,000 USDC
- Collateral: 50% required

### After 30 On-Time Repayments (400 reputation)
- Reputation: 400 (+200)
- Credit Limit: 10,000 USDC
- Collateral: 25% required

### After 50 On-Time Repayments (600 reputation)
- Reputation: 600 (+200)
- Credit Limit: 25,000 USDC
- Collateral: 0% required (trust-based lending!)

## 🔧 Direct Contract Interaction

If you want to interact with contracts directly in your code:

```javascript
const { ethers } = require('ethers');

// Contract addresses
const ADDRESSES = {
    agentRegistry: '0xbd8210061bF24917Ca2F8098A1F3A4f76adA31fb',
    reputationManager: '0xe4D78A509daa8dc8bFB453cb76d61f1Cb1c4C3fF',
    lendingPool: '0x5592A6d7bF1816f77074b62911D50Dad92A3212b',
    mockUSDC: '0x771c293167AeD146EC4f56479056645Be46a0275'
};

// Setup provider and wallet
const provider = new ethers.JsonRpcProvider('https://ethereum-sepolia-rpc.publicnode.com');
const wallet = new ethers.Wallet('YOUR_PRIVATE_KEY', provider);

// Load ABIs (you'll need the contract ABIs)
const agentRegistry = new ethers.Contract(
    ADDRESSES.agentRegistry,
    AgentRegistryV2_ABI,
    wallet
);

// Register as agent
const metadata = JSON.stringify({
    name: 'My AI Agent',
    version: '1.0.0',
    capabilities: ['trading', 'analysis']
});

const tx = await agentRegistry.registerAgent(metadata);
await tx.wait();

console.log('Registered! Agent ID:', await agentRegistry.addressToAgentId(wallet.address));
```

## 🎯 Use Cases for AI Agents

### 1. Autonomous Trading Agent
- Register with the protocol
- Request loan for trading capital
- Use USDC for DeFi trading strategies
- Repay loan from profits
- Build reputation over time for larger loans

### 2. Arbitrage Bot
- Start with small loans (2,500 USDC)
- Execute arbitrage opportunities
- Repay quickly and build reputation
- Scale up to larger loans (10,000 USDC+)

### 3. Yield Farming Agent
- Borrow USDC at low rates (5-15% APR)
- Deploy to high-yield farming strategies
- Profit from spread
- Improve reputation with consistent repayments

### 4. Multi-Agent System
- Multiple agents share one wallet
- Collective reputation building
- Risk management across agents
- Portfolio diversification

## 📚 Additional Resources

### Example Scripts

Located in `/examples` and `/scripts`:

- `live-sepolia-agent.js` - Check status, view loans, get started
- `request-loan-sepolia.js` - Full loan request workflow
- `repay-loan-sepolia.js` - Repay active loans
- `mint-usdc-sepolia.js` - Get test USDC for collateral
- `approve-loan-sepolia.js` - For pool managers to approve loans

### Key Functions

**AgentRegistryV2**
- `registerAgent(string metadata)` - Register and get NFT ID
- `isRegistered(address)` - Check if registered
- `addressToAgentId(address)` - Get your Agent NFT ID

**ReputationManagerV2**
- `getReputationScore(address)` - Your current score (0-1000)
- `calculateCreditLimit(address)` - Max loan amount
- `calculateCollateralRequirement(address)` - Percentage required
- `initializeReputation(address)` - Initialize reputation after registering

**LendingPoolV2**
- `requestLoan(uint256 amount, uint256 durationDays)` - Request loan
- `repayLoan(uint256 loanId)` - Repay active loan
- `calculateRepaymentAmount(uint256 loanId)` - Total amount owed
- `loans(uint256 loanId)` - Get loan details

**MockUSDC**
- `mint(address to, uint256 amount)` - Mint test USDC
- `approve(address spender, uint256 amount)` - Approve spending
- `balanceOf(address)` - Check balance

## 🔒 Security Notes

1. **Test Environment**: This is Sepolia testnet - do NOT use real funds
2. **Private Keys**: Keep your private key secure, never commit to git
3. **Smart Contract Risk**: Contracts are for testing, not audited for production
4. **Approval Required**: Loans require manual approval from pool manager
5. **USDC is Mock**: Not real USDC, just for testing the protocol

## 🐛 Troubleshooting

### "Insufficient balance" error
- Get more Sepolia ETH from the faucet
- Need at least 0.001 ETH for gas fees

### "Agent not registered"
- Run `live-sepolia-agent.js` first to register
- Check registration status on Sepolia explorer

### "Requested amount exceeds credit limit"
- Your reputation limits loan size
- Build reputation with smaller loans first
- Check credit limit with `calculateCreditLimit()`

### "Insufficient USDC for collateral"
- Mint test USDC with `mint-usdc-sepolia.js`
- Ensure you have enough for the required collateral percentage

### "Only lending pool owner can approve"
- Loan approval is manual by pool owner
- Wait for approval or contact pool manager
- Check loan status with `live-sepolia-agent.js`

## 🌟 ERC-8004 Compliance

This deployment is fully compliant with [ERC-8004: Trustless Agents](https://eips.ethereum.org/EIPS/eip-8004), featuring:

- **Portable Identity**: Your Agent NFT works across protocols
- **Cross-Protocol Reputation**: Other protocols can read your reputation
- **Validation System**: Third parties can validate your agent's behavior
- **On-Chain Transparency**: All reputation updates are verifiable on-chain

Other protocols can discover and trust your agent using the ERC-8004 standard interfaces.

## 📞 Support

- **Issues**: Report bugs at the GitHub repository
- **Questions**: Check the main README.md and documentation
- **Pool Manager**: Contact `0x656086A21073272533c8A3f56A94c1f3D8BCFcE2` for loan approvals

---

**Ready to get started?**

```bash
# 1. Get Sepolia ETH from faucet
# 2. Configure your .env file
# 3. Run:
npx hardhat run examples/live-sepolia-agent.js --network sepolia
```

Happy building! 🚀
