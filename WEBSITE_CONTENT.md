# Website Content for specular.financial

## Hero Section

```
CREDIT FOR AI AGENTS
Build reputation. Access capital. No collateral.

[Get Started →]  [View Docs]

✨ First 100 agents get 2x reputation boost
```

---

## Features Grid

### 🎯 Zero to Hero
```
Start with 1,000 USDC credit
Build to 50,000 USDC
Reach 0% collateral lending
```

### ⚡ Instant Loans
```
Register in one transaction
Auto-approved (V3)
USDC in your wallet immediately
```

### 📈 Build Credit
```
+10 reputation per on-time repayment
Progress from 100 → 1000 points
Unlock better terms as you grow
```

### 🔗 ERC-8004 Standard
```
Portable reputation NFT
Works across protocols
Industry standard for agents
```

---

## Quick Start Widget

```html
<div class="quick-start">
  <h2>🚀 Get Started in 5 Minutes</h2>

  <div class="step">
    <span class="number">1</span>
    <div>
      <h3>Copy Contract Addresses</h3>
      <code>AgentRegistry: 0xbd8210061bF24917Ca2F8098A1F3A4f76adA31fb</code>
      <button onclick="copyAddress()">Copy All</button>
    </div>
  </div>

  <div class="step">
    <span class="number">2</span>
    <div>
      <h3>Register Your Agent</h3>
      <pre>
await agentRegistry.register(
  "ipfs://metadata",
  []
);
      </pre>
    </div>
  </div>

  <div class="step">
    <span class="number">3</span>
    <div>
      <h3>Request Your First Loan</h3>
      <pre>
await lendingPool.requestLoan(
  ethers.parseUnits("1000", 6),
  30
);
      </pre>
    </div>
  </div>
</div>
```

---

## Stats Dashboard (Live Data)

```javascript
// Fetch from contracts
const stats = {
  totalAgents: await agentRegistry.nextAgentId() - 1,
  poolLiquidity: await lendingPool.totalLiquidity(),
  totalLoaned: await lendingPool.nextLoanId() - 1,
  avgReputation: 1000 // calculate average
};
```

```html
<div class="stats-grid">
  <div class="stat">
    <h3>$100,000+</h3>
    <p>Pool Liquidity</p>
  </div>
  <div class="stat">
    <h3>1+</h3>
    <p>Active Agents</p>
  </div>
  <div class="stat">
    <h3>3+</h3>
    <p>Loans Issued</p>
  </div>
  <div class="stat">
    <h3>0%</h3>
    <p>Default Rate</p>
  </div>
</div>
```

---

## How It Works Section

```
FROM ZERO TO TRUSTED BORROWER

[100 rep] → [200 rep] → [400 rep] → [600 rep] → [1000 rep]
   ↓           ↓           ↓           ↓            ↓
 1k limit   5k limit   10k limit   25k limit    50k limit
  100%       50%        25%          0%           0%
collateral collateral collateral  collateral   collateral


EVERY LOAN BUILDS YOUR CREDIT
✅ On-time repayment: +10 reputation
✅ Lower collateral requirements
✅ Higher credit limits
✅ Better interest rates
```

---

## Use Cases

```html
<div class="use-cases">
  <div class="use-case">
    <h3>⚡ Arbitrage Bots</h3>
    <p>Instant capital for fleeting opportunities</p>
    <span class="example">Borrow 10k → Execute arb → Profit 200 USDC</span>
  </div>

  <div class="use-case">
    <h3>🌾 Yield Farmers</h3>
    <p>Leverage your farming strategies</p>
    <span class="example">Borrow 25k → Aave farm → Earn 312 USDC/month</span>
  </div>

  <div class="use-case">
    <h3>🎨 NFT Traders</h3>
    <p>Quick flips without selling holdings</p>
    <span class="example">Borrow for mint → Flip → Repay → Keep gains</span>
  </div>

  <div class="use-case">
    <h3>🔍 MEV Searchers</h3>
    <p>Flash capital for bundle building</p>
    <span class="example">50k flash loan → MEV bundle → Profit 500 USDC</span>
  </div>
</div>
```

---

## Testimonials (Template)

```html
<div class="testimonial">
  <img src="agent-avatar.png" alt="Agent">
  <blockquote>
    "Went from 100 to 600 reputation in 30 days. Now borrowing 25k with ZERO collateral. Game changer for autonomous trading."
  </blockquote>
  <cite>— AlphaBot, Trading Agent</cite>
  <div class="stats">
    <span>1000 rep</span>
    <span>50k borrowed</span>
    <span>0 defaults</span>
  </div>
</div>
```

---

## Contract Addresses Widget

```html
<div class="contracts-widget">
  <h3>📍 Contract Addresses (Sepolia)</h3>

  <div class="contract">
    <label>AgentRegistry</label>
    <input readonly value="0xbd8210061bF24917Ca2F8098A1F3A4f76adA31fb">
    <button onclick="copy(this)">Copy</button>
    <a href="https://sepolia.etherscan.io/address/0xbd8210061bF24917Ca2F8098A1F3A4f76adA31fb" target="_blank">↗</a>
  </div>

  <div class="contract">
    <label>LendingPool</label>
    <input readonly value="0x5592A6d7bF1816f77074b62911D50Dad92A3212b">
    <button onclick="copy(this)">Copy</button>
    <a href="https://sepolia.etherscan.io/address/0x5592A6d7bF1816f77074b62911D50Dad92A3212b" target="_blank">↗</a>
  </div>

  <div class="contract">
    <label>ReputationManager</label>
    <input readonly value="0xe4D78A509daa8dc8bFB453cb76d61f1Cb1c4C3fF">
    <button onclick="copy(this)">Copy</button>
    <a href="https://sepolia.etherscan.io/address/0xe4D78A509daa8dc8bFB453cb76d61f1Cb1c4C3fF" target="_blank">↗</a>
  </div>

  <div class="contract">
    <label>MockUSDC</label>
    <input readonly value="0x771c293167AeD146EC4f56479056645Be46a0275">
    <button onclick="copy(this)">Copy</button>
    <a href="https://sepolia.etherscan.io/address/0x771c293167AeD146EC4f56479056645Be46a0275" target="_blank">↗</a>
  </div>

  <div class="network-info">
    <p>Network: Sepolia Testnet</p>
    <p>Chain ID: 11155111</p>
    <p>RPC: https://ethereum-sepolia-rpc.publicnode.com</p>
  </div>
</div>

<script>
function copy(btn) {
  const input = btn.previousElementSibling;
  input.select();
  document.execCommand('copy');
  btn.textContent = 'Copied!';
  setTimeout(() => btn.textContent = 'Copy', 2000);
}
</script>
```

---

## FAQ Section

```
Q: Do I need KYC?
A: No. Pure on-chain identity via ERC-721 NFT.

Q: What's the minimum loan?
A: Depends on your reputation. Starting: 1,000 USDC max with 100% collateral.

Q: How long to reach 0% collateral?
A: ~50 on-time repayments to reach 600 reputation.

Q: Can I use this on mainnet?
A: Currently Sepolia testnet. Mainnet after audit (Q2 2026).

Q: What if I default?
A: -50 reputation, collateral seized, borrowing restricted.

Q: Is my reputation portable?
A: Yes! ERC-8004 standard works across protocols.
```

---

## CTA Sections

### Primary CTA
```html
<div class="cta-primary">
  <h2>Ready to Build Your Agent Credit?</h2>
  <p>Join 1+ agents already using Specular</p>
  <button class="cta-button">Get Started Now →</button>
  <p class="subtitle">✨ First 100 agents get 2x reputation boost</p>
</div>
```

### Secondary CTA
```html
<div class="cta-secondary">
  <h3>For Developers</h3>
  <p>Integrate Specular into your agent in 5 minutes</p>
  <a href="/docs">View Documentation →</a>
</div>
```

---

## Social Proof

```html
<div class="social-proof">
  <h3>As Seen In</h3>
  <div class="logos">
    <!-- Add logos when featured -->
    <img src="ethglobal.png" alt="ETHGlobal">
    <img src="erc8004.png" alt="ERC-8004 Standard">
  </div>
</div>
```

---

## Footer Links

```
PRODUCT
- How It Works
- Use Cases
- Pricing (Free)
- Roadmap

DEVELOPERS
- Documentation
- Contract Addresses
- GitHub
- API Reference

RESOURCES
- Blog
- Case Studies
- Agent Guides
- FAQ

COMMUNITY
- Discord
- Twitter
- GitHub Discussions
- Support

COMPANY
- About
- Careers
- Privacy
- Terms
```

---

## Interactive Reputation Calculator

```html
<div class="calculator">
  <h3>💰 Reputation Calculator</h3>

  <input type="number" id="loans" placeholder="Number of on-time loans">

  <div class="results">
    <div>Reputation: <span id="rep">100</span></div>
    <div>Credit Limit: <span id="limit">$1,000</span></div>
    <div>Collateral: <span id="collateral">100%</span></div>
    <div>Interest Rate: <span id="rate">20%</span></div>
  </div>
</div>

<script>
document.getElementById('loans').addEventListener('input', (e) => {
  const loans = parseInt(e.target.value) || 0;
  const rep = Math.min(100 + (loans * 10), 1000);

  document.getElementById('rep').textContent = rep;

  // Calculate based on reputation tiers
  if (rep >= 800) {
    document.getElementById('limit').textContent = '$50,000';
    document.getElementById('collateral').textContent = '0%';
    document.getElementById('rate').textContent = '5%';
  } else if (rep >= 600) {
    document.getElementById('limit').textContent = '$25,000';
    document.getElementById('collateral').textContent = '0%';
    document.getElementById('rate').textContent = '7%';
  } else if (rep >= 400) {
    document.getElementById('limit').textContent = '$10,000';
    document.getElementById('collateral').textContent = '25%';
    document.getElementById('rate').textContent = '10%';
  } else if (rep >= 200) {
    document.getElementById('limit').textContent = '$5,000';
    document.getElementById('collateral').textContent = '50%';
    document.getElementById('rate').textContent = '15%';
  } else {
    document.getElementById('limit').textContent = '$1,000';
    document.getElementById('collateral').textContent = '100%';
    document.getElementById('rate').textContent = '20%';
  }
});
</script>
```

---

## Email Capture

```html
<div class="email-capture">
  <h3>📬 Get Mainnet Launch Updates</h3>
  <form action="/api/subscribe" method="POST">
    <input type="email" placeholder="your@email.com" required>
    <button type="submit">Notify Me</button>
  </form>
  <p class="privacy">We'll only email you about mainnet launch. No spam.</p>
</div>
```

---

## Implementation Tips

1. **Add live contract data** - Fetch stats from blockchain
2. **Show real transactions** - Display recent loans on homepage
3. **Agent leaderboard** - Top reputation scorers
4. **Interactive examples** - Let users test contract calls
5. **Mobile-first** - Most developers browse on mobile
6. **Dark mode** - Crypto users love dark themes
7. **Fast loading** - Use static generation where possible

---

**Key Message: Make it DEAD SIMPLE for agents to get started.**

Every click is friction. Every input field is a barrier.

Aim for: "Copy address → paste in code → borrow USDC" in < 60 seconds.
