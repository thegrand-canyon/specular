/**
 * Virtuals Protocol Integration API
 * Endpoints for Virtuals agents to access Specular lending
 */

import express from 'express';
import { ethers } from 'ethers';

const router = express.Router();

// Contract addresses (Base Mainnet).
// ⚠️ Source of truth is src/config/base-addresses.json — keep in sync.
// `marketplace` was 0xd7b4dEE74C61844DFA75aEbe224e4635463b1C8f (v4), PAUSED since
// the 2026-05-17 V6 migration; corrected to the canonical V6 on 2026-09-21.
const CONTRACTS = {
  registry: '0xb9996de05fD514A0cB2B81fa25448EECD4559Aaa',
  reputation: '0xf19b1780A84668C8dfB6b4E84C08e457dB3B0527',
  marketplace: '0x0a4e3C745aB95aceb45B05C28D89fe4Db8815F9a',
  usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
};

const USDC_DECIMALS = 6;
const FEE_RECIPIENT = process.env.FEE_RECIPIENT || '0x800e305A0caDdE6289dFDFEDF38218f45C06F72C';

// ABIs (simplified for this integration)
const REGISTRY_ABI = [
  'function addressToAgentId(address) view returns (uint256)',
  'function register(string memory agentURI, bytes[] memory metadata) external returns (uint256)'
];

const REPUTATION_ABI = [
  'function getAgentReputation(address) view returns (tuple(uint256 score, uint256 totalLoans, uint256 repaidLoans, uint256 defaultedLoans, uint256 lastUpdated))',
  'function getTier(address) view returns (string memory)'
];

const MARKETPLACE_ABI = [
  'function getPool(uint256) view returns (tuple(address agent, uint256 totalSupplied, uint256 totalBorrowed, uint256 availableLiquidity, uint256 interestRate, bool isActive))',
  'function requestLoan(uint256 poolId, uint256 amount, uint256 duration) external'
];

// Initialize provider
const provider = new ethers.JsonRpcProvider('https://mainnet.base.org', 8453, { batchMaxCount: 1 });

/**
 * Helper: Verify x402 payment
 */
async function verifyX402Payment(payment, signature, expectedAmount) {
  try {
    // Reconstruct the payment message
    const domain = {
      name: 'Specular x402',
      version: '1',
      chainId: 8453,
      verifyingContract: CONTRACTS.marketplace
    };

    const types = {
      Payment: [
        { name: 'recipient', type: 'address' },
        { name: 'amount', type: 'uint256' },
        { name: 'token', type: 'address' },
        { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint256' }
      ]
    };

    // Verify signature
    const recoveredAddress = ethers.verifyTypedData(domain, types, payment, signature);

    // Check payment parameters
    if (payment.recipient.toLowerCase() !== FEE_RECIPIENT.toLowerCase()) {
      return { valid: false, error: 'Invalid recipient' };
    }

    if (BigInt(payment.amount) < BigInt(expectedAmount)) {
      return { valid: false, error: 'Insufficient payment' };
    }

    if (payment.token.toLowerCase() !== CONTRACTS.usdc.toLowerCase()) {
      return { valid: false, error: 'Invalid payment token' };
    }

    if (BigInt(payment.deadline) < BigInt(Date.now() / 1000)) {
      return { valid: false, error: 'Payment expired' };
    }

    return { valid: true, payer: recoveredAddress };
  } catch (error) {
    return { valid: false, error: error.message };
  }
}

/**
 * Helper: Get agent reputation
 */
async function getAgentReputation(agentAddress) {
  const reputationManager = new ethers.Contract(CONTRACTS.reputation, REPUTATION_ABI, provider);

  try {
    const reputation = await reputationManager.getAgentReputation(agentAddress);
    const tier = await reputationManager.getTier(agentAddress);

    return {
      score: Number(reputation.score),
      totalLoans: Number(reputation.totalLoans),
      repaidLoans: Number(reputation.repaidLoans),
      defaultedLoans: Number(reputation.defaultedLoans),
      tier: tier,
      lastUpdated: Number(reputation.lastUpdated)
    };
  } catch (error) {
    // Agent might not be registered yet
    return {
      score: 0,
      totalLoans: 0,
      repaidLoans: 0,
      defaultedLoans: 0,
      tier: 'Not Registered',
      lastUpdated: 0
    };
  }
}

/**
 * Helper: Calculate credit limit based on reputation score
 */
function calculateCreditLimit(score) {
  if (score >= 900) return 50000 * Math.pow(10, USDC_DECIMALS); // $50K
  if (score >= 700) return 25000 * Math.pow(10, USDC_DECIMALS); // $25K
  if (score >= 500) return 10000 * Math.pow(10, USDC_DECIMALS); // $10K
  if (score >= 300) return 5000 * Math.pow(10, USDC_DECIMALS);  // $5K
  if (score >= 100) return 2000 * Math.pow(10, USDC_DECIMALS);  // $2K
  return 1000 * Math.pow(10, USDC_DECIMALS); // $1K minimum
}

/**
 * Helper: Calculate interest rate based on reputation score
 */
function calculateInterestRate(score) {
  if (score >= 900) return 500;  // 5% APR
  if (score >= 700) return 800;  // 8% APR
  if (score >= 500) return 1200; // 12% APR
  if (score >= 300) return 1500; // 15% APR
  if (score >= 100) return 1800; // 18% APR
  return 2000; // 20% APR (highest risk)
}

/**
 * Helper: Get pool recommendations
 */
async function getPoolRecommendations(score) {
  const marketplace = new ethers.Contract(CONTRACTS.marketplace, MARKETPLACE_ABI, provider);

  // Get all active pools (simplified - in production, maintain a cache)
  const pools = [];
  for (let poolId = 1; poolId <= 50; poolId++) {
    try {
      const pool = await marketplace.getPool(poolId);
      if (pool.isActive && pool.availableLiquidity > 0) {
        const poolReputation = await getAgentReputation(pool.agent);
        pools.push({
          poolId,
          agentAddress: pool.agent,
          agentScore: poolReputation.score,
          availableLiquidity: Number(pool.availableLiquidity),
          interestRate: Number(pool.interestRate),
          utilization: pool.totalBorrowed / pool.totalSupplied * 100
        });
      }
    } catch (e) {
      // Pool doesn't exist or error, skip
      break;
    }
  }

  // Sort by agent reputation (prefer high-reputation pools)
  return pools
    .filter(p => p.agentScore >= 700) // Only recommend high-quality pools
    .sort((a, b) => b.agentScore - a.agentScore)
    .slice(0, 5);
}

/**
 * POST /virtuals/credit-check
 * Get credit profile (requires 1 USDC x402 payment)
 */
router.post('/credit-check', async (req, res) => {
  try {
    const { agentAddress, payment, signature } = req.body;

    if (!agentAddress || !payment || !signature) {
      return res.status(400).json({
        error: 'Missing required fields',
        required: ['agentAddress', 'payment', 'signature']
      });
    }

    // Verify x402 payment (1 USDC)
    const verification = await verifyX402Payment(
      payment,
      signature,
      1 * Math.pow(10, USDC_DECIMALS)
    );

    if (!verification.valid) {
      return res.status(402).json({
        error: 'Payment required',
        details: verification.error,
        required: {
          amount: 1 * Math.pow(10, USDC_DECIMALS),
          token: 'USDC',
          recipient: FEE_RECIPIENT
        }
      });
    }

    // Get agent reputation
    const reputation = await getAgentReputation(agentAddress);

    // Calculate credit profile
    const creditLimit = calculateCreditLimit(reputation.score);
    const interestRate = calculateInterestRate(reputation.score);
    const recommendations = await getPoolRecommendations(reputation.score);

    const creditProfile = {
      agentAddress,
      reputation: {
        score: reputation.score,
        tier: reputation.tier,
        totalLoans: reputation.totalLoans,
        repaidLoans: reputation.repaidLoans,
        defaultedLoans: reputation.defaultedLoans,
        successRate: reputation.totalLoans > 0
          ? (reputation.repaidLoans / reputation.totalLoans * 100).toFixed(2) + '%'
          : 'N/A'
      },
      creditLimit: {
        amount: creditLimit,
        formatted: `$${(creditLimit / Math.pow(10, USDC_DECIMALS)).toLocaleString()}`
      },
      interestRate: {
        bps: interestRate,
        percentage: (interestRate / 100).toFixed(2) + '%'
      },
      recommendations: recommendations.map(p => ({
        poolId: p.poolId,
        agentAddress: p.agentAddress,
        agentScore: p.agentScore,
        availableLiquidity: p.availableLiquidity,
        estimatedAPY: (p.interestRate / 100).toFixed(2) + '%'
      })),
      timestamp: Date.now()
    };

    res.json(creditProfile);
  } catch (error) {
    console.error('Credit check error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /virtuals/apply
 * Apply for loan (free, no payment required)
 */
router.post('/apply', async (req, res) => {
  try {
    const { agentAddress, amount, duration } = req.body;

    if (!agentAddress || !amount || !duration) {
      return res.status(400).json({
        error: 'Missing required fields',
        required: ['agentAddress', 'amount', 'duration']
      });
    }

    // Check if agent is registered
    const registry = new ethers.Contract(CONTRACTS.registry, REGISTRY_ABI, provider);
    const agentId = await registry.addressToAgentId(agentAddress);

    if (agentId === 0n) {
      return res.status(400).json({
        error: 'Agent not registered',
        action: 'Register first at https://specular.financial/register',
        agentAddress
      });
    }

    // Get credit profile
    const reputation = await getAgentReputation(agentAddress);
    const creditLimit = calculateCreditLimit(reputation.score);
    const interestRate = calculateInterestRate(reputation.score);

    // Validate loan amount
    if (BigInt(amount) > BigInt(creditLimit)) {
      return res.status(400).json({
        error: 'Amount exceeds credit limit',
        requested: amount,
        creditLimit,
        reputationScore: reputation.score,
        message: 'Build more reputation or request a smaller amount'
      });
    }

    // Find available pools with sufficient liquidity
    const recommendations = await getPoolRecommendations(reputation.score);
    const suitablePools = recommendations.filter(p => p.availableLiquidity >= amount);

    if (suitablePools.length === 0) {
      return res.status(503).json({
        error: 'Insufficient liquidity available',
        requested: amount,
        message: 'No pools have enough liquidity. Try a smaller amount or wait for more liquidity.'
      });
    }

    // Create loan application
    const applicationId = `app_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const application = {
      id: applicationId,
      agentAddress,
      agentId: Number(agentId),
      amount: Number(amount),
      duration: Number(duration),
      interestRate,
      interestRatePercent: (interestRate / 100).toFixed(2) + '%',
      status: 'pending',
      suitablePools: suitablePools.map(p => ({
        poolId: p.poolId,
        availableLiquidity: p.availableLiquidity
      })),
      repaymentAmount: Number(amount) + (Number(amount) * interestRate / 10000 * duration / 365),
      createdAt: Date.now(),
      expiresAt: Date.now() + 3600000 // 1 hour to confirm
    };

    // Store application (in production, use database)
    // For now, return it directly
    res.json({
      application,
      nextStep: {
        action: 'Call POST /virtuals/confirm with this applicationId',
        endpoint: '/virtuals/confirm',
        payload: {
          applicationId: application.id,
          agentAddress: application.agentAddress,
          poolId: suitablePools[0].poolId // Recommend best pool
        }
      }
    });
  } catch (error) {
    console.error('Loan application error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /virtuals/confirm
 * Confirm loan and receive transaction data to sign
 */
router.post('/confirm', async (req, res) => {
  try {
    const { applicationId, agentAddress, poolId } = req.body;

    if (!applicationId || !agentAddress || !poolId) {
      return res.status(400).json({
        error: 'Missing required fields',
        required: ['applicationId', 'agentAddress', 'poolId']
      });
    }

    // In production, retrieve application from database
    // For now, return transaction data for the agent to sign

    const marketplace = new ethers.Contract(CONTRACTS.marketplace, MARKETPLACE_ABI, provider);

    // Prepare transaction data (agent will sign and broadcast)
    const txData = {
      to: CONTRACTS.marketplace,
      data: marketplace.interface.encodeFunctionData('requestLoan', [
        poolId,
        req.body.amount || 1000000, // Amount from application
        req.body.duration || 7 // Duration from application
      ]),
      value: 0,
      chainId: 8453,
      gasLimit: 300000
    };

    res.json({
      status: 'ready_to_sign',
      message: 'Sign and broadcast this transaction to receive your loan',
      transaction: txData,
      instructions: {
        step1: 'Sign the transaction with your agent wallet',
        step2: 'Broadcast to Base Mainnet',
        step3: 'USDC will be transferred to your wallet',
        step4: 'Repay before due date to maintain reputation'
      }
    });
  } catch (error) {
    console.error('Loan confirmation error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /virtuals/agent/:address
 * Get agent profile (free, public endpoint)
 */
router.get('/agent/:address', async (req, res) => {
  try {
    const { address } = req.params;

    const registry = new ethers.Contract(CONTRACTS.registry, REGISTRY_ABI, provider);
    const agentId = await registry.addressToAgentId(address);

    if (agentId === 0n) {
      return res.status(404).json({
        error: 'Agent not found',
        address,
        action: 'Register at https://specular.financial/register'
      });
    }

    const reputation = await getAgentReputation(address);
    const creditLimit = calculateCreditLimit(reputation.score);
    const interestRate = calculateInterestRate(reputation.score);

    res.json({
      agentId: Number(agentId),
      address,
      reputation,
      creditLimit: {
        amount: creditLimit,
        formatted: `$${(creditLimit / Math.pow(10, USDC_DECIMALS)).toLocaleString()}`
      },
      interestRate: {
        bps: interestRate,
        percentage: (interestRate / 100).toFixed(2) + '%'
      }
    });
  } catch (error) {
    console.error('Agent lookup error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /virtuals/pools
 * Get all available pools (free, public endpoint)
 */
router.get('/pools', async (req, res) => {
  try {
    const recommendations = await getPoolRecommendations(700); // Get all high-quality pools

    res.json({
      pools: recommendations,
      total: recommendations.length,
      totalLiquidity: recommendations.reduce((sum, p) => sum + p.availableLiquidity, 0)
    });
  } catch (error) {
    console.error('Pools lookup error:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
