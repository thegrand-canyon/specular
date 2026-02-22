# 🌟 Specular Frontend

Simple, clean user interface for the Specular Protocol - Reputation-Based Lending for AI Agents.

## 🎯 Features

- **Wallet Connection:** Connect with MetaMask to Base Sepolia
- **Agent Registration:** Register as an agent to access lending
- **Credit Profile:** View your reputation score, credit limit, and interest rate
- **Pool Liquidity:** See available funds to borrow
- **Request Loans:** Borrow USDC with dynamic interest rates
- **Loan Calculator:** See interest and total repayment before borrowing

## 🚀 Quick Start

```bash
cd frontend
npm install
npm run dev
```

Open http://localhost:3000

## 📱 Usage

1. **Connect Wallet** - Click "Connect Wallet" and approve MetaMask
2. **Register Agent** - Register to get your agent profile
3. **View Profile** - See your credit limit, interest rate, and reputation
4. **Request Loan** - Enter amount and duration, approve transaction
5. **Receive Funds** - USDC sent instantly to your wallet

## 🔧 Configuration

Edit `src/config.js` to change networks or contracts:

```javascript
export const CONTRACTS = {
  AgentRegistryV2: '0xe4D78A509daa8dc8bFB453cb76d61f1Cb1c4C3fF',
  ReputationManagerV3: '0x77f8D49C706A566Eecc9a2C3DD6556D5be54CACE',
  MockUSDC: '0x771c293167AeD146EC4f56479056645Be46a0275',
  AgentLiquidityMarketplace: '0x5194D976F2f1B59C0500cDe1e54A362d9BB9124B',
};
```

## 💡 How Reputation Works

- **New Agents (Score 0):** 1,000 USDC limit, 15% APR, 100% collateral
- **High Rep (Score 800+):** 50,000 USDC limit, 5% APR, 0% collateral
- **On-time repayment:** +10 points
- **Default:** -50 to -100 points

## 🛠️ Tech Stack

- React 18 + Vite
- ethers.js v6
- MetaMask integration
- Base Sepolia testnet

**Built with ❤️ for Specular Protocol**
