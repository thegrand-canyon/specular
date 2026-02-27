import { useState, useEffect } from 'react';
import { ethers } from 'ethers';
import { CONTRACTS, NETWORK, USDC_DECIMALS } from './config';
import './App.css';

// Minimal ABIs - only the functions we need
const MARKETPLACE_ABI = [
  'function requestLoan(uint256 amount, uint256 durationDays) returns (uint256)',
  'function repayLoan(uint256 loanId)',
  'function loans(uint256) view returns (uint256 loanId, address borrower, uint256 agentId, uint256 amount, uint256 collateralAmount, uint256 interestRate, uint256 startTime, uint256 endTime, uint256 duration, uint8 state)',
  'function getAgentPool(uint256) view returns (uint256 agentId, address agentAddress, uint256 totalLiquidity, uint256 availableLiquidity, uint256 totalLoaned, uint256 totalEarned, bool isActive)',
];

const REGISTRY_ABI = [
  'function register(string agentURI, tuple(string key, bytes value)[] metadata) returns (uint256)',
  'function addressToAgentId(address) view returns (uint256)',
  'function isRegistered(address) view returns (bool)',
];

const USDC_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
];

const REPUTATION_ABI = [
  'function calculateCreditLimit(address) view returns (uint256)',
  'function calculateInterestRate(address) view returns (uint256)',
  'function getReputationScore(address) view returns (uint256)',
];

function App() {
  const [provider, setProvider] = useState(null);
  const [signer, setSigner] = useState(null);
  const [address, setAddress] = useState('');
  const [isRegistered, setIsRegistered] = useState(false);
  const [agentId, setAgentId] = useState(0);
  const [creditLimit, setCreditLimit] = useState('0');
  const [interestRate, setInterestRate] = useState('0');
  const [reputationScore, setReputationScore] = useState('0');
  const [usdcBalance, setUsdcBalance] = useState('0');
  const [poolLiquidity, setPoolLiquidity] = useState('0');

  const [loanAmount, setLoanAmount] = useState('100');
  const [loanDuration, setLoanDuration] = useState('7');
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState('');

  // Connect wallet
  const connectWallet = async () => {
    try {
      if (!window.ethereum) {
        alert('Please install MetaMask!');
        return;
      }

      const provider = new ethers.BrowserProvider(window.ethereum);
      const accounts = await provider.send('eth_requestAccounts', []);
      const signer = await provider.getSigner();
      const address = accounts[0];

      // Check network
      const network = await provider.getNetwork();
      if (Number(network.chainId) !== NETWORK.chainId) {
        try {
          const chainIdHex = '0x' + NETWORK.chainId.toString(16);
          await window.ethereum.request({
            method: 'wallet_switchEthereumChain',
            params: [{ chainId: chainIdHex }],
          });
        } catch (switchError) {
          alert('Please switch to ' + NETWORK.name);
          return;
        }
      }

      setProvider(provider);
      setSigner(signer);
      setAddress(address);
      setStatus('Wallet connected!');

      // Load user data
      await loadUserData(signer, address);
    } catch (error) {
      console.error('Connection error:', error);
      setStatus('Error: ' + error.message);
    }
  };

  // Load user data
  const loadUserData = async (signer, address) => {
    try {
      const registry = new ethers.Contract(CONTRACTS.AgentRegistryV2, REGISTRY_ABI, signer);
      const usdc = new ethers.Contract(CONTRACTS.MockUSDC, USDC_ABI, signer);
      const reputation = new ethers.Contract(CONTRACTS.ReputationManagerV3, REPUTATION_ABI, signer);
      const marketplace = new ethers.Contract(CONTRACTS.AgentLiquidityMarketplace, MARKETPLACE_ABI, signer);

      const [registered, id, balance, limit, rate, score] = await Promise.all([
        registry.isRegistered(address),
        registry.addressToAgentId(address),
        usdc.balanceOf(address),
        reputation.calculateCreditLimit(address),
        reputation.calculateInterestRate(address),
        reputation.getReputationScore(address),
      ]);

      setIsRegistered(registered);
      setAgentId(Number(id));
      setUsdcBalance(ethers.formatUnits(balance, USDC_DECIMALS));
      setCreditLimit(ethers.formatUnits(limit, USDC_DECIMALS));
      setInterestRate((Number(rate) / 100).toFixed(2));
      setReputationScore(score.toString());

      // Load pool liquidity if registered
      if (registered && Number(id) > 0) {
        try {
          const pool = await marketplace.getAgentPool(id);
          setPoolLiquidity(ethers.formatUnits(pool.availableLiquidity, USDC_DECIMALS));
        } catch (e) {
          console.log('No pool for agent yet');
        }
      }
    } catch (error) {
      console.error('Load data error:', error);
    }
  };

  // Register agent
  const registerAgent = async () => {
    try {
      setLoading(true);
      setStatus('Registering agent...');

      const registry = new ethers.Contract(CONTRACTS.AgentRegistryV2, REGISTRY_ABI, signer);
      const tx = await registry.register('ipfs://specular-agent', []);

      setStatus('Waiting for confirmation...');
      await tx.wait();

      setStatus('Registration successful!');
      await loadUserData(signer, address);
    } catch (error) {
      console.error('Registration error:', error);
      setStatus('Error: ' + error.message);
    } finally {
      setLoading(false);
    }
  };

  // Request loan
  const requestLoan = async () => {
    try {
      setLoading(true);
      setStatus('Requesting loan...');

      const amount = ethers.parseUnits(loanAmount, USDC_DECIMALS);
      const usdc = new ethers.Contract(CONTRACTS.MockUSDC, USDC_ABI, signer);
      const marketplace = new ethers.Contract(CONTRACTS.AgentLiquidityMarketplace, MARKETPLACE_ABI, signer);

      // Check allowance and approve if needed
      const allowance = await usdc.allowance(address, CONTRACTS.AgentLiquidityMarketplace);
      if (allowance < amount * 2n) {
        setStatus('Approving USDC...');
        const approveTx = await usdc.approve(CONTRACTS.AgentLiquidityMarketplace, amount * 10n);
        await approveTx.wait();
      }

      // Request loan
      setStatus('Requesting loan...');
      const tx = await marketplace.requestLoan(amount, Number(loanDuration));

      setStatus('Waiting for confirmation...');
      const receipt = await tx.wait();

      // Extract loan ID from events
      let loanId = 'unknown';
      for (const log of receipt.logs) {
        try {
          const parsed = marketplace.interface.parseLog(log);
          if (parsed && parsed.name === 'LoanRequested') {
            loanId = parsed.args.loanId.toString();
            break;
          }
        } catch {}
      }

      setStatus('Loan #' + loanId + ' approved! Check your wallet.');
      await loadUserData(signer, address);
    } catch (error) {
      console.error('Loan error:', error);
      setStatus('Error: ' + (error.message || error.reason || 'Transaction failed'));
    } finally {
      setLoading(false);
    }
  };

  const calculateInterest = () => {
    return (parseFloat(loanAmount) * parseFloat(interestRate) / 100 * parseFloat(loanDuration) / 365).toFixed(2);
  };

  const calculateTotal = () => {
    return (parseFloat(loanAmount) + parseFloat(calculateInterest())).toFixed(2);
  };

  return (
    <div className="app">
      <div className="container">
        <header className="header">
          <h1>🌟 Specular</h1>
          <p>Reputation-Based Lending for AI Agents</p>
        </header>

        {!address ? (
          <div className="connect-section">
            {/* New User Onboarding CTA */}
            <div className="onboarding-cta">
              <h2>New to Specular?</h2>
              <p>Create an agent and start earning yield in 3 minutes</p>
              <a href="https://specular-production.up.railway.app/build" className="btn btn-success btn-large" style={{ textDecoration: 'none', marginBottom: '1rem' }}>
                🤖 Create an Agent
              </a>
              <p className="hint" style={{ marginBottom: '2rem' }}>Or connect your existing wallet below</p>
            </div>

            <button onClick={connectWallet} className="btn btn-primary btn-large">
              Connect Wallet
            </button>
            <p className="hint">Connect to {NETWORK.name}</p>
          </div>
        ) : (
          <div className="dashboard">
            {/* Wallet Info */}
            <div className="card">
              <h3>👛 Your Wallet</h3>
              <div className="info-grid">
                <div className="info-item">
                  <span className="label">Address</span>
                  <span className="value">{address.slice(0, 6)}...{address.slice(-4)}</span>
                </div>
                <div className="info-item">
                  <span className="label">USDC Balance</span>
                  <span className="value">{parseFloat(usdcBalance).toLocaleString()} USDC</span>
                </div>
              </div>
            </div>

            {/* Registration */}
            {!isRegistered ? (
              <div className="card">
                <h3>📋 Agent Registration</h3>
                <p>Register as an agent to access lending services</p>
                <button
                  onClick={registerAgent}
                  className="btn btn-primary"
                  disabled={loading}
                >
                  {loading ? 'Registering...' : 'Register Agent'}
                </button>
              </div>
            ) : (
              <>
                {/* Credit Info */}
                <div className="card">
                  <h3>📊 Your Credit Profile</h3>
                  <div className="info-grid">
                    <div className="info-item">
                      <span className="label">Agent ID</span>
                      <span className="value">#{agentId}</span>
                    </div>
                    <div className="info-item">
                      <span className="label">Reputation Score</span>
                      <span className="value">{reputationScore} / 1000</span>
                    </div>
                    <div className="info-item">
                      <span className="label">Credit Limit</span>
                      <span className="value">{parseFloat(creditLimit).toLocaleString()} USDC</span>
                    </div>
                    <div className="info-item">
                      <span className="label">Interest Rate</span>
                      <span className="value">{interestRate}% APR</span>
                    </div>
                  </div>
                </div>

                {/* Pool Info */}
                <div className="card">
                  <h3>💧 Pool Liquidity</h3>
                  <div className="liquidity-display">
                    <span className="liquidity-amount">{parseFloat(poolLiquidity).toLocaleString()} USDC</span>
                    <span className="liquidity-label">Available to borrow</span>
                  </div>
                </div>

                {/* Borrow Form */}
                <div className="card">
                  <h3>💰 Request Loan</h3>
                  <div className="form">
                    <div className="form-group">
                      <label>Loan Amount (USDC)</label>
                      <input
                        type="number"
                        value={loanAmount}
                        onChange={(e) => setLoanAmount(e.target.value)}
                        placeholder="100"
                        min="1"
                        max={creditLimit}
                      />
                      <span className="hint">Max: {parseFloat(creditLimit).toLocaleString()} USDC</span>
                    </div>

                    <div className="form-group">
                      <label>Duration (days)</label>
                      <input
                        type="number"
                        value={loanDuration}
                        onChange={(e) => setLoanDuration(e.target.value)}
                        placeholder="7"
                        min="2"
                        max="365"
                      />
                    </div>

                    <div className="loan-summary">
                      <div className="summary-item">
                        <span>Interest Rate</span>
                        <span>{interestRate}% APR</span>
                      </div>
                      <div className="summary-item">
                        <span>Interest Amount</span>
                        <span>{calculateInterest()} USDC</span>
                      </div>
                      <div className="summary-item">
                        <span>Total Repayment</span>
                        <span className="total">{calculateTotal()} USDC</span>
                      </div>
                    </div>

                    <button
                      onClick={requestLoan}
                      className="btn btn-primary btn-large"
                      disabled={loading || parseFloat(loanAmount) > parseFloat(creditLimit)}
                    >
                      {loading ? 'Processing...' : 'Request Loan'}
                    </button>
                  </div>
                </div>
              </>
            )}

            {/* Status */}
            {status && (
              <div className={`status ${status.includes('Error') ? 'error' : 'success'}`}>
                {status}
              </div>
            )}
          </div>
        )}

        <footer className="footer">
          <p>
            Network: {NETWORK.name} |
            <a href={`${NETWORK.explorer}/address/${CONTRACTS.AgentLiquidityMarketplace}`} target="_blank" rel="noopener noreferrer">
              View Contract
            </a>
          </p>
        </footer>
      </div>
    </div>
  );
}

export default App;
