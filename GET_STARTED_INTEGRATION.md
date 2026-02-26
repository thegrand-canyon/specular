# Get Started Page - Integration Guide

## 🎯 Overview

The "Get Started" page provides a complete onboarding flow for new users to create an AI agent on Specular. It includes:

1. **Network Selection** - Choose between Arc Testnet, Base Mainnet, or Arbitrum One
2. **Wallet Connection** - Connect MetaMask or create a new wallet (Privy integration coming soon)
3. **Agent Registration** - Register wallet as an agent on-chain
4. **Success & Next Steps** - Show agent details and guide user to dashboard

---

## 📁 Files Created

### Frontend Components
```
frontend/
├── get-started.html                      # Standalone page (NEW)
├── src/
│   ├── get-started-main.jsx             # Entry point for get-started page (NEW)
│   └── components/
│       ├── GetStarted.jsx               # Main onboarding component (NEW)
│       └── GetStarted.css               # Styling for onboarding flow (NEW)
```

### Documentation
```
GET_STARTED_INTEGRATION.md               # This file (NEW)
```

---

## 🚀 Local Testing

### 1. Start Development Server

```bash
cd frontend
npm install  # If not already installed
npm run dev  # Start Vite dev server
```

### 2. Access Get Started Page

Open your browser to:
```
http://localhost:5173/get-started.html
```

### 3. Test the Flow

**Step 1: Welcome**
- Choose a network (Arc Testnet for free testing, Base or Arbitrum for production)
- Click "Get Started"

**Step 2: Connect Wallet**
- Click "MetaMask" to connect your wallet
- Approve the connection in MetaMask
- MetaMask will auto-switch to the selected network (or prompt to add it)

**Step 3: Register Agent**
- Review your wallet address and network
- Click "Register Agent"
- Approve the transaction in MetaMask
- Wait for confirmation (~5-30 seconds depending on network)

**Step 4: Success**
- See your Agent ID and details
- Click "Go to Dashboard" to start using Specular

---

## 🌐 Production Deployment

### Option 1: Add to Existing Website

If you have a website at `specular.financial`, add the get-started page:

```bash
# Copy files to your web server
scp frontend/get-started.html user@server:/var/www/specular.financial/
scp -r frontend/src user@server:/var/www/specular.financial/

# Build production bundle
cd frontend
npm run build

# Deploy the build
scp -r dist/* user@server:/var/www/specular.financial/
```

Then access at: `https://www.specular.financial/get-started.html`

### Option 2: Deploy with Railway/Vercel

**Railway:**
```bash
# Add build configuration to railway.json
{
  "build": {
    "builder": "NIXPACKS",
    "buildCommand": "cd frontend && npm install && npm run build"
  },
  "deploy": {
    "startCommand": "cd frontend && npm run preview"
  }
}
```

**Vercel:**
```bash
# Install Vercel CLI
npm install -g vercel

# Deploy from frontend directory
cd frontend
vercel --prod
```

### Option 3: Add to Existing React App

If you have a React app with routing, integrate the `GetStarted` component:

```jsx
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import GetStarted from './components/GetStarted';

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/get-started" element={<GetStarted />} />
        <Route path="/dashboard" element={<Dashboard />} />
      </Routes>
    </BrowserRouter>
  );
}
```

---

## 🔗 Adding to Your Main Website

### Option A: Direct Link

Add a button to your homepage:

```html
<a href="/get-started.html" class="cta-button">
  Create an Agent →
</a>
```

### Option B: Modal/Overlay

Embed the component as a modal:

```jsx
import { useState } from 'react';
import GetStarted from './components/GetStarted';

function HomePage() {
  const [showOnboarding, setShowOnboarding] = useState(false);

  return (
    <>
      <button onClick={() => setShowOnboarding(true)}>
        Create an Agent
      </button>

      {showOnboarding && (
        <div className="modal-overlay">
          <GetStarted onComplete={(data) => {
            setShowOnboarding(false);
            // Redirect to dashboard or show success
          }} />
        </div>
      )}
    </>
  );
}
```

---

## 🎨 Customization

### Change Colors/Branding

Edit `frontend/src/components/GetStarted.css`:

```css
/* Primary gradient */
background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
/* Change to your brand colors */
background: linear-gradient(135deg, #YOUR_COLOR_1 0%, #YOUR_COLOR_2 100%);
```

### Modify Network Options

Edit `frontend/src/components/GetStarted.jsx`:

```jsx
const NETWORKS = {
  // Add or remove networks
  yourNetwork: {
    name: 'Your Network',
    chainId: 12345,
    rpcUrl: 'https://your-rpc.com',
    contracts: {
      registry: '0x...',
      reputation: '0x...',
      marketplace: '0x...',
    }
  }
};
```

### Change Default Network

```jsx
const [selectedNetwork, setSelectedNetwork] = useState('base'); // or 'arc' or 'arbitrum'
```

---

## 🛠 Features

### ✅ Currently Working
- ✅ MetaMask wallet connection
- ✅ Multi-network support (Arc, Base, Arbitrum)
- ✅ Automatic network switching
- ✅ On-chain agent registration
- ✅ Agent ID retrieval
- ✅ Redirect to dashboard after completion
- ✅ Responsive design (mobile-friendly)
- ✅ Error handling and user feedback

### 🚧 Coming Soon (Placeholders Included)
- 🚧 Social login via Privy (embedded wallets)
- 🚧 Fiat on-ramp via Moonpay (buy crypto with card)
- 🚧 Email wallet creation
- 🚧 Multi-language support

---

## 📊 Analytics & Tracking

To track user conversions, add analytics to the component:

```jsx
// In GetStarted.jsx, add to success step:
const renderSuccess = () => {
  // Track successful registration
  if (window.gtag) {
    window.gtag('event', 'agent_created', {
      network: selectedNetwork,
      agent_id: agentId,
      wallet: walletAddress
    });
  }

  return (
    // ... rest of success UI
  );
};
```

---

## 🧪 Testing Checklist

### Before Production:
- [ ] Test on Arc Testnet (free, no risk)
- [ ] Test on Base Mainnet (with small amount)
- [ ] Test on Arbitrum One (with small amount)
- [ ] Test with different wallets (MetaMask, others)
- [ ] Test on mobile devices
- [ ] Test network switching
- [ ] Test error cases (rejected transactions, wrong network, etc.)
- [ ] Verify agent registration on block explorer
- [ ] Test redirect to dashboard
- [ ] Test on different browsers (Chrome, Firefox, Safari)

### Arc Testnet Testing:
```bash
# Get free Arc testnet ETH from faucet
# (Provide faucet URL if available)

# Get test USDC
# (Provide test token faucet if available)
```

---

## 🎯 User Flow Diagram

```
┌─────────────────────────────────────────┐
│  1. Landing Page                        │
│  - Click "Create an Agent"              │
└──────────────┬──────────────────────────┘
               ▼
┌─────────────────────────────────────────┐
│  2. Welcome Screen                      │
│  - Choose network (Arc/Base/Arbitrum)   │
│  - See features & benefits              │
│  - Click "Get Started"                  │
└──────────────┬──────────────────────────┘
               ▼
┌─────────────────────────────────────────┐
│  3. Wallet Connection                   │
│  Option A: MetaMask (existing wallet)   │
│  Option B: Social Login (coming soon)   │
│  Option C: Buy Crypto (coming soon)     │
└──────────────┬──────────────────────────┘
               ▼
┌─────────────────────────────────────────┐
│  4. Agent Registration                  │
│  - Show wallet address                  │
│  - Explain what happens                 │
│  - Send registration transaction        │
│  - Wait for confirmation                │
└──────────────┬──────────────────────────┘
               ▼
┌─────────────────────────────────────────┐
│  5. Success!                            │
│  - Show Agent ID                        │
│  - Show next steps                      │
│  - Link to dashboard                    │
│  - Link to explorer                     │
└─────────────────────────────────────────┘
```

---

## 🔧 Troubleshooting

### Issue: MetaMask not connecting
**Solution:** Check that:
1. MetaMask is installed
2. User approved the connection request
3. Wallet is unlocked

### Issue: Network switch fails
**Solution:**
- Network might not be in MetaMask
- Component will auto-prompt to add network
- User needs to approve adding the network

### Issue: Registration transaction fails
**Solution:** Check:
1. User has enough ETH for gas
2. User approved the transaction
3. Network is not congested (try higher gas)
4. Wallet is not already registered (check existing ID)

### Issue: "Agent already registered" error
**Solution:**
- This is handled automatically
- Component will fetch existing Agent ID
- User proceeds directly to success screen

---

## 📞 Support

### For Users
Add a help section to the page:

```jsx
<div className="help-section">
  <h4>Need Help?</h4>
  <ul>
    <li><a href="/faq">FAQ</a></li>
    <li><a href="https://discord.gg/specular">Discord Support</a></li>
    <li><a href="mailto:support@specular.financial">Email Support</a></li>
  </ul>
</div>
```

### For Developers
- Check browser console for errors
- Verify contract addresses in network config
- Test with Hardhat local node first
- Check MetaMask/wallet console for transaction details

---

## 🚀 Next Steps

After a user completes onboarding:

1. **Redirect to Dashboard** - Show their agent stats, reputation, credit limit
2. **Guide to First Loan** - Help them request their first loan
3. **Supply Liquidity** - Encourage them to become a lender
4. **Build Reputation** - Explain how to improve their score

---

## 📝 Example Usage

### Embed in Main Site

```jsx
// pages/index.jsx
import GetStarted from '../components/GetStarted';

export default function Home() {
  return (
    <div>
      <header>
        <h1>Specular - AI Agent Lending</h1>
        <GetStarted onComplete={(data) => {
          console.log('New agent created!', data);
          // Redirect to dashboard
          window.location.href = `/dashboard?agent=${data.agentId}`;
        }} />
      </header>
    </div>
  );
}
```

---

## 🎉 Success Metrics

Track these metrics to measure onboarding effectiveness:

- **Conversion Rate:** Users who complete all 4 steps
- **Drop-off Point:** Which step users abandon most
- **Time to Complete:** Average time from start to finish
- **Network Preference:** Which network users choose most
- **Wallet Type:** MetaMask vs Social Login usage

Add tracking:

```jsx
// Track each step
const setStep = (newStep) => {
  setState(newStep);
  if (window.gtag) {
    window.gtag('event', 'onboarding_step', {
      step: newStep,
      network: selectedNetwork
    });
  }
};
```

---

## 🔐 Security Notes

1. **Never store private keys** - Component only uses MetaMask/Privy (they manage keys)
2. **Verify contract addresses** - Always double-check the registry address for each network
3. **Test thoroughly** - Use Arc Testnet before going to production
4. **HTTPS required** - MetaMask requires HTTPS for production sites
5. **No sensitive data** - Don't log or send wallet addresses to analytics without consent

---

**Built with:** React + Vite + ethers.js + MetaMask
**Maintained by:** Specular Team
**Last Updated:** February 26, 2026

For questions or issues, open an issue at https://github.com/thegrand-canyon/specular
