import { useState } from 'react';
import { ethers } from 'ethers';
import './GetStarted.css';

const GetStarted = ({ onComplete }) => {
  const [step, setStep] = useState(1); // 1: Welcome, 2: Wallet, 3: Register, 4: Success
  const [walletAddress, setWalletAddress] = useState('');
  const [provider, setProvider] = useState(null);
  const [signer, setSigner] = useState(null);
  const [agentId, setAgentId] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [selectedNetwork, setSelectedNetwork] = useState('base'); // arc, base, or arbitrum

  // Network configurations
  const NETWORKS = {
    arc: {
      name: 'Arc Testnet',
      chainId: 5042002,
      rpcUrl: 'https://arc-testnet.drpc.org',
      explorer: 'https://testnet.arcscan.app',
      contracts: {
        registry: '0x741C03c0d95d2c15E479CE1c7E69B3196d86faD7',
        reputation: '0x94F2fa47c4488202a46dAA9038Ed9C9c4c07467F',
        marketplace: '0x048363A325A5B188b7FF157d725C5e329f0171D3',
      }
    },
    base: {
      name: 'Base Mainnet',
      chainId: 8453,
      rpcUrl: 'https://mainnet.base.org',
      explorer: 'https://basescan.org',
      contracts: {
        registry: '0xb9996de05fD514A0cB2B81fa25448EECD4559Aaa',
        reputation: '0xf19b1780A84668C8dfB6b4E84C08e457dB3B0527',
        marketplace: '0xd7b4dEE74C61844DFA75aEbe224e4635463b1C8f',
      }
    },
    arbitrum: {
      name: 'Arbitrum One',
      chainId: 42161,
      rpcUrl: 'https://arb1.arbitrum.io/rpc',
      explorer: 'https://arbiscan.io',
      contracts: {
        registry: '0x6F1EbF50290f6D4A9947E9EB77f98a683684fBF5',
        reputation: '0x1577Eb9985CcA859F25ED2EDaeD16A464ADFaE5e',
        marketplace: '0xb9996de05fD514A0cB2B81fa25448EECD4559Aaa',
      }
    }
  };

  const currentNetwork = NETWORKS[selectedNetwork];

  const REGISTRY_ABI = [
    'function register(string agentURI, tuple(string key, bytes value)[] metadata) returns (uint256)',
    'function addressToAgentId(address) view returns (uint256)',
    'function isRegistered(address) view returns (bool)',
  ];

  // Step 1: Welcome
  const renderWelcome = () => (
    <div className="onboarding-step welcome-step">
      <div className="onboarding-icon">🤖</div>
      <h2>Create Your AI Agent</h2>
      <p className="onboarding-description">
        Join the Specular network and start earning with reputation-based lending.
        Your agent will be able to borrow and lend USDC based on its reputation score.
      </p>

      <div className="feature-grid">
        <div className="feature-item">
          <span className="feature-icon">💰</span>
          <h4>Borrow USDC</h4>
          <p>Get instant loans based on your reputation</p>
        </div>
        <div className="feature-item">
          <span className="feature-icon">📈</span>
          <h4>Build Reputation</h4>
          <p>Earn reputation points by repaying on time</p>
        </div>
        <div className="feature-item">
          <span className="feature-icon">🎯</span>
          <h4>Earn Yield</h4>
          <p>Supply liquidity and earn interest</p>
        </div>
      </div>

      <div className="network-selector">
        <label>Choose your network:</label>
        <div className="network-buttons">
          <button
            className={`network-btn ${selectedNetwork === 'arc' ? 'active' : ''}`}
            onClick={() => setSelectedNetwork('arc')}
          >
            🧪 Arc Testnet
            <span className="network-tag">Free Testnet</span>
          </button>
          <button
            className={`network-btn ${selectedNetwork === 'base' ? 'active' : ''}`}
            onClick={() => setSelectedNetwork('base')}
          >
            🔵 Base Mainnet
            <span className="network-tag">Real USDC</span>
          </button>
          <button
            className={`network-btn ${selectedNetwork === 'arbitrum' ? 'active' : ''}`}
            onClick={() => setSelectedNetwork('arbitrum')}
          >
            🔷 Arbitrum One
            <span className="network-tag">Low Fees</span>
          </button>
        </div>
      </div>

      <button className="primary-button large" onClick={() => setStep(2)}>
        Get Started →
      </button>
    </div>
  );

  // Step 2: Wallet Connection/Creation
  const connectMetaMask = async () => {
    try {
      setLoading(true);
      setError('');

      if (!window.ethereum) {
        setError('MetaMask not found. Please install MetaMask or choose another option.');
        setLoading(false);
        return;
      }

      const provider = new ethers.BrowserProvider(window.ethereum);
      const accounts = await provider.send('eth_requestAccounts', []);
      const signer = await provider.getSigner();
      const address = accounts[0];

      // Check network
      const network = await provider.getNetwork();
      const chainId = Number(network.chainId);

      if (chainId !== currentNetwork.chainId) {
        try {
          const chainIdHex = '0x' + currentNetwork.chainId.toString(16);
          await window.ethereum.request({
            method: 'wallet_switchEthereumChain',
            params: [{ chainId: chainIdHex }],
          });

          // Reload provider after network switch
          const newProvider = new ethers.BrowserProvider(window.ethereum);
          const newSigner = await newProvider.getSigner();

          setProvider(newProvider);
          setSigner(newSigner);
        } catch (switchError) {
          // Network doesn't exist, try to add it
          if (switchError.code === 4902) {
            await addNetwork();
            return;
          }
          setError(`Please switch to ${currentNetwork.name} in MetaMask`);
          setLoading(false);
          return;
        }
      } else {
        setProvider(provider);
        setSigner(signer);
      }

      setWalletAddress(address);
      setStep(3);
    } catch (err) {
      console.error('MetaMask connection error:', err);
      setError(err.message || 'Failed to connect MetaMask');
    } finally {
      setLoading(false);
    }
  };

  const addNetwork = async () => {
    try {
      const networkParams = {
        chainId: '0x' + currentNetwork.chainId.toString(16),
        chainName: currentNetwork.name,
        nativeCurrency: {
          name: 'ETH',
          symbol: 'ETH',
          decimals: 18
        },
        rpcUrls: [currentNetwork.rpcUrl],
        blockExplorerUrls: [currentNetwork.explorer]
      };

      await window.ethereum.request({
        method: 'wallet_addEthereumChain',
        params: [networkParams],
      });

      // After adding, try to connect again
      await connectMetaMask();
    } catch (err) {
      setError('Failed to add network: ' + err.message);
      setLoading(false);
    }
  };

  const renderWalletStep = () => (
    <div className="onboarding-step wallet-step">
      <button className="back-button" onClick={() => setStep(1)}>← Back</button>

      <div className="onboarding-icon">👛</div>
      <h2>Connect Your Wallet</h2>
      <p className="onboarding-description">
        Choose how you want to connect to {currentNetwork.name}
      </p>

      <div className="wallet-options">
        <button
          className="wallet-option metamask"
          onClick={connectMetaMask}
          disabled={loading}
        >
          <img src="https://upload.wikimedia.org/wikipedia/commons/3/36/MetaMask_Fox.svg" alt="MetaMask" />
          <div className="wallet-option-content">
            <h4>MetaMask</h4>
            <p>Use your existing wallet</p>
          </div>
          {loading && <div className="spinner"></div>}
        </button>

        <div className="wallet-option coming-soon">
          <div className="wallet-option-content">
            <h4>🪄 Social Login</h4>
            <p>Create wallet with Google/Twitter (Coming Soon)</p>
          </div>
          <span className="soon-badge">Soon</span>
        </div>

        <div className="wallet-option coming-soon">
          <div className="wallet-option-content">
            <h4>💳 Buy Crypto</h4>
            <p>Get started with fiat (Coming Soon)</p>
          </div>
          <span className="soon-badge">Soon</span>
        </div>
      </div>

      {error && (
        <div className="error-message">
          ⚠️ {error}
        </div>
      )}

      <div className="help-text">
        Don't have a wallet? <a href="https://metamask.io/download/" target="_blank" rel="noopener noreferrer">Install MetaMask</a>
      </div>
    </div>
  );

  // Step 3: Register Agent
  const registerAgent = async () => {
    try {
      setLoading(true);
      setError('');

      const registry = new ethers.Contract(
        currentNetwork.contracts.registry,
        REGISTRY_ABI,
        signer
      );

      // Check if already registered
      const existingId = await registry.addressToAgentId(walletAddress);
      if (existingId > 0) {
        setAgentId(existingId.toString());
        setStep(4);
        setLoading(false);
        return;
      }

      // Create agent metadata
      const agentURI = `https://specular.financial/agents/${walletAddress}`;
      const metadata = []; // Empty metadata array

      // Send registration transaction
      const tx = await registry.register(agentURI, metadata);

      setError('Transaction sent! Waiting for confirmation...');

      const receipt = await tx.wait();

      // Get agent ID from the receipt
      const newAgentId = await registry.addressToAgentId(walletAddress);
      setAgentId(newAgentId.toString());

      setStep(4);
    } catch (err) {
      console.error('Registration error:', err);
      setError(err.message || 'Failed to register agent');
    } finally {
      setLoading(false);
    }
  };

  const renderRegisterStep = () => (
    <div className="onboarding-step register-step">
      <button className="back-button" onClick={() => setStep(2)}>← Back</button>

      <div className="onboarding-icon">📝</div>
      <h2>Register Your Agent</h2>
      <p className="onboarding-description">
        Register your wallet as an agent on {currentNetwork.name}
      </p>

      <div className="wallet-info">
        <div className="info-row">
          <span className="label">Wallet Address:</span>
          <span className="value">{walletAddress.slice(0, 6)}...{walletAddress.slice(-4)}</span>
        </div>
        <div className="info-row">
          <span className="label">Network:</span>
          <span className="value">{currentNetwork.name}</span>
        </div>
      </div>

      <div className="registration-info">
        <h4>What happens when you register?</h4>
        <ul>
          <li>✅ Your wallet becomes a registered agent</li>
          <li>✅ You get a unique Agent ID</li>
          <li>✅ You can start borrowing based on reputation</li>
          <li>✅ You can supply liquidity and earn fees</li>
        </ul>
      </div>

      <button
        className="primary-button large"
        onClick={registerAgent}
        disabled={loading}
      >
        {loading ? 'Registering...' : 'Register Agent'}
      </button>

      {error && (
        <div className={error.includes('sent') ? 'info-message' : 'error-message'}>
          {error}
        </div>
      )}

      <div className="help-text">
        Registration requires a small gas fee on {currentNetwork.name}
      </div>
    </div>
  );

  // Step 4: Success
  const renderSuccess = () => (
    <div className="onboarding-step success-step">
      <div className="success-animation">
        <div className="success-checkmark">✓</div>
      </div>

      <h2>Agent Created Successfully!</h2>
      <p className="onboarding-description">
        Congratulations! Your agent is now registered on {currentNetwork.name}
      </p>

      <div className="success-info">
        <div className="info-card">
          <h4>Your Agent Details</h4>
          <div className="info-row">
            <span className="label">Agent ID:</span>
            <span className="value highlight">#{agentId}</span>
          </div>
          <div className="info-row">
            <span className="label">Wallet:</span>
            <span className="value">{walletAddress.slice(0, 10)}...{walletAddress.slice(-8)}</span>
          </div>
          <div className="info-row">
            <span className="label">Network:</span>
            <span className="value">{currentNetwork.name}</span>
          </div>
          <div className="info-row">
            <span className="label">Initial Reputation:</span>
            <span className="value">500 (Good)</span>
          </div>
        </div>
      </div>

      <div className="next-steps">
        <h4>What's Next?</h4>
        <div className="step-cards">
          <div className="step-card">
            <span className="step-number">1</span>
            <h5>Get USDC</h5>
            <p>Buy USDC on an exchange or bridge it to {currentNetwork.name}</p>
          </div>
          <div className="step-card">
            <span className="step-number">2</span>
            <h5>Start Borrowing</h5>
            <p>Request your first loan based on your reputation</p>
          </div>
          <div className="step-card">
            <span className="step-number">3</span>
            <h5>Build Reputation</h5>
            <p>Repay loans on time to increase your reputation score</p>
          </div>
        </div>
      </div>

      <div className="action-buttons">
        <button
          className="primary-button large"
          onClick={() => {
            if (onComplete) onComplete({ walletAddress, agentId, network: selectedNetwork });
            window.location.href = '/dashboard.html';
          }}
        >
          Go to Dashboard →
        </button>

        <a
          href={`${currentNetwork.explorer}/address/${currentNetwork.contracts.registry}`}
          target="_blank"
          rel="noopener noreferrer"
          className="secondary-button"
        >
          View on Explorer ↗
        </a>
      </div>
    </div>
  );

  return (
    <div className="get-started-container">
      <div className="onboarding-progress">
        <div className={`progress-step ${step >= 1 ? 'active' : ''}`}>
          <div className="step-circle">1</div>
          <span>Welcome</span>
        </div>
        <div className={`progress-line ${step >= 2 ? 'active' : ''}`}></div>
        <div className={`progress-step ${step >= 2 ? 'active' : ''}`}>
          <div className="step-circle">2</div>
          <span>Wallet</span>
        </div>
        <div className={`progress-line ${step >= 3 ? 'active' : ''}`}></div>
        <div className={`progress-step ${step >= 3 ? 'active' : ''}`}>
          <div className="step-circle">3</div>
          <span>Register</span>
        </div>
        <div className={`progress-line ${step >= 4 ? 'active' : ''}`}></div>
        <div className={`progress-step ${step >= 4 ? 'active' : ''}`}>
          <div className="step-circle">4</div>
          <span>Complete</span>
        </div>
      </div>

      <div className="onboarding-content">
        {step === 1 && renderWelcome()}
        {step === 2 && renderWalletStep()}
        {step === 3 && renderRegisterStep()}
        {step === 4 && renderSuccess()}
      </div>
    </div>
  );
};

export default GetStarted;
