# Sepolia Testnet Deployment Guide

## Overview

This guide walks through deploying the Specular Protocol V2 (ERC-8004 compliant) to Sepolia testnet and verifying contracts on Etherscan.

## Prerequisites

### 1. Sepolia ETH

You'll need Sepolia ETH for:
- Contract deployment gas fees (~0.05 ETH)
- Initial pool liquidity setup

Get Sepolia ETH from faucets:
- https://sepoliafaucet.com/
- https://sepolia-faucet.pk910.de/
- https://www.infura.io/faucet/sepolia

### 2. API Keys

Required API keys:
- **Alchemy/Infura RPC**: Get from https://www.alchemy.com/ or https://infura.io/
- **Etherscan API**: Get from https://etherscan.io/myapikey

### 3. Environment Setup

Create `.env` file in the project root:

```bash
# Sepolia RPC URL (Alchemy recommended)
SEPOLIA_RPC_URL=https://eth-sepolia.g.alchemy.com/v2/YOUR_API_KEY

# Deployer private key (NEVER commit this!)
PRIVATE_KEY=0xYOUR_PRIVATE_KEY_HERE

# Etherscan API key for contract verification
ETHERSCAN_API_KEY=YOUR_ETHERSCAN_API_KEY

# Optional: Initial pool liquidity in USDC (default: 100000)
INITIAL_LIQUIDITY=100000
```

⚠️ **IMPORTANT**: Add `.env` to `.gitignore` to prevent accidental commits!

## Deployment Steps

### Step 1: Verify Configuration

Check your Hardhat configuration:

```bash
npx hardhat config
```

Ensure Sepolia network is configured correctly.

### Step 2: Deploy V2 Contracts

Deploy all V2 contracts to Sepolia:

```bash
npx hardhat run scripts/deploy-v2.js --network sepolia
```

This will deploy:
1. AgentRegistryV2 (ERC-721 Identity Registry)
2. ReputationManagerV2 (Reputation + Feedback)
3. ValidationRegistry (Third-party validation)
4. MockUSDC (Test token)
5. LendingPoolV2 (Lending protocol)

Expected output:
```
Deploying Specular V2 to Sepolia...

AgentRegistryV2 deployed to: 0x...
ReputationManagerV2 deployed to: 0x...
ValidationRegistry deployed to: 0x...
MockUSDC deployed to: 0x...
LendingPoolV2 deployed to: 0x...

Contracts deployed successfully!
Saved addresses to: src/config/sepolia-addresses.json
```

**Deployment cost**: ~0.03-0.05 ETH

### Step 3: Verify Contracts on Etherscan

Verify all contracts:

```bash
npx hardhat run scripts/verify-sepolia.js --network sepolia
```

This will verify each contract on Etherscan with constructor arguments.

Expected output:
```
Verifying contracts on Sepolia Etherscan...

✓ AgentRegistryV2 verified: https://sepolia.etherscan.io/address/0x...
✓ ReputationManagerV2 verified: https://sepolia.etherscan.io/address/0x...
✓ ValidationRegistry verified: https://sepolia.etherscan.io/address/0x...
✓ MockUSDC verified: https://sepolia.etherscan.io/address/0x...
✓ LendingPoolV2 verified: https://sepolia.etherscan.io/address/0x...

All contracts verified successfully!
```

### Step 4: Setup Lending Pool

Fund and configure the lending pool:

```bash
npx hardhat run scripts/setup-pool-v2.js --network sepolia
```

This will:
1. Mint initial USDC supply to deployer
2. Approve USDC for lending pool
3. Deposit initial liquidity
4. Verify pool configuration

Expected output:
```
Setting up LendingPoolV2 on Sepolia...

Minted 100,000 USDC to deployer
Approved 100,000 USDC for pool
Deposited 100,000 USDC to pool

Pool Status:
- Total Liquidity: 100,000 USDC
- Available: 100,000 USDC
- Lent Out: 0 USDC

Setup complete!
```

### Step 5: Test Deployment

Run a test transaction to verify everything works:

```bash
npx hardhat run scripts/test-deployment.js --network sepolia
```

This will:
1. Register a test agent
2. Initialize reputation
3. Request a small loan
4. Verify all interactions work

## Post-Deployment

### Update Frontend Configuration

If you have a frontend, update the contract addresses:

```javascript
// src/config/contracts.js
export const SEPOLIA_CONTRACTS = {
  agentRegistry: '0x...',
  reputationManager: '0x...',
  validationRegistry: '0x...',
  lendingPool: '0x...',
  usdc: '0x...'
};
```

### Share Contract Addresses

Share the deployed contract addresses in:
- Documentation
- README.md
- GitHub repository
- Project website

### Monitor Deployment

Monitor your contracts:
- Etherscan: https://sepolia.etherscan.io/
- Tenderly: https://dashboard.tenderly.co/
- Block Explorer: Track transactions and events

## Troubleshooting

### Error: "insufficient funds for intrinsic transaction cost"

**Solution**: Get more Sepolia ETH from faucets.

### Error: "nonce too low"

**Solution**: Reset your account nonce:
```bash
npx hardhat clean
```

### Error: "Contract source code already verified"

**Solution**: This means the contract was already verified. You can skip this contract.

### Error: "Invalid API Key"

**Solution**: Check your Etherscan API key in `.env` file.

### Deployment Failed Mid-Way

If deployment fails after some contracts are deployed:

1. Check `src/config/sepolia-addresses.json` for deployed contracts
2. Comment out already-deployed contracts in `deploy-v2.js`
3. Re-run deployment script

## Cost Estimation

Estimated costs for Sepolia deployment:

| Operation | Estimated Cost (ETH) |
|-----------|---------------------|
| Deploy AgentRegistryV2 | 0.008 |
| Deploy ReputationManagerV2 | 0.012 |
| Deploy ValidationRegistry | 0.010 |
| Deploy MockUSDC | 0.004 |
| Deploy LendingPoolV2 | 0.014 |
| Verify contracts (all) | 0.000 (free) |
| Setup pool | 0.002 |
| **Total** | **~0.05 ETH** |

*Note: Costs vary based on network congestion*

## Security Checklist

Before mainnet deployment:

- [ ] Complete professional security audit
- [ ] Run Slither static analysis
- [ ] Test all functions on testnet
- [ ] Verify all contracts on Etherscan
- [ ] Test with multiple user accounts
- [ ] Monitor for 1-2 weeks on testnet
- [ ] Have emergency pause mechanism tested
- [ ] Document all admin functions
- [ ] Setup monitoring and alerts
- [ ] Create incident response plan

## Next Steps

After successful Sepolia deployment:

1. **Testing Period**: Run protocol on testnet for 1-2 weeks
2. **Community Testing**: Invite users to test
3. **Bug Bounty**: Consider launching bug bounty program
4. **Documentation**: Complete all user documentation
5. **Mainnet Prep**: Prepare for mainnet deployment

## Support

For issues or questions:
- GitHub Issues: https://github.com/your-repo/issues
- Discord: https://discord.gg/your-server
- Documentation: https://docs.your-project.com

## References

- **ERC-8004 Standard**: https://eips.ethereum.org/EIPS/eip-8004
- **Hardhat Documentation**: https://hardhat.org/
- **Etherscan Verification**: https://docs.etherscan.io/tutorials/verifying-contracts-programmatically
- **Sepolia Faucets**: Listed in Prerequisites section
