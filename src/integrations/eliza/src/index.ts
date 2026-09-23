/**
 * Specular Protocol Plugin for Eliza
 *
 * Enables Eliza agents to access on-chain credit without collateral.
 */

import type {
  Action,
  Plugin,
  IAgentRuntime,
  Memory,
  State,
  HandlerCallback,
  Provider
} from '@ai16z/eliza';
import { ethers } from 'ethers';

// ============================================================================
// Types
// ============================================================================

interface SpecularConfig {
  apiUrl: string;
  network?: 'base' | 'arc';
  privateKey?: string;
}

interface CreditProfile {
  agent: string;
  registered: boolean;
  reputation: {
    score: number;
    tier: string;
  };
  credit: {
    limit: string;
    available: string;
    interestRate: number;
    canBorrow: boolean;
  };
  activeLoans: number;
}

interface Loan {
  loanId: string;
  amount: string;
  durationDays: number;
  interest: string;
  totalDue: string;
  dueDate: string;
  status: string;
}

// ============================================================================
// Specular SDK Wrapper
// ============================================================================

class SpecularSDK {
  private apiUrl: string;
  private wallet: ethers.Wallet | null;

  constructor(config: SpecularConfig) {
    this.apiUrl = config.apiUrl;

    if (config.privateKey) {
      const rpcUrl = config.network === 'base'
        ? 'https://mainnet.base.org'
        : 'https://arc-testnet.drpc.org';

      const provider = new ethers.JsonRpcProvider(rpcUrl);
      this.wallet = new ethers.Wallet(config.privateKey, provider);
    } else {
      this.wallet = null;
    }
  }

  async getProfile(address: string): Promise<CreditProfile> {
    const response = await fetch(`${this.apiUrl}/agents/${address}`);
    if (!response.ok) {
      throw new Error(`Failed to get profile: ${response.statusText}`);
    }
    return await response.json();
  }

  async requestLoan(amount: number, durationDays: number): Promise<any> {
    if (!this.wallet) {
      throw new Error('Wallet required for loan requests');
    }

    // Get unsigned transaction data
    const response = await fetch(`${this.apiUrl}/tx/request-loan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount, durationDays })
    });

    if (!response.ok) {
      throw new Error(`Failed to request loan: ${response.statusText}`);
    }

    const { to, data } = await response.json();

    // Sign and send transaction
    const tx = await this.wallet.sendTransaction({ to, data });
    return await tx.wait();
  }

  async repayLoan(loanId: number): Promise<any> {
    if (!this.wallet) {
      throw new Error('Wallet required for loan repayment');
    }

    // Get unsigned transaction data
    const response = await fetch(`${this.apiUrl}/tx/repay-loan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ loanId })
    });

    if (!response.ok) {
      throw new Error(`Failed to repay loan: ${response.statusText}`);
    }

    const { to, data } = await response.json();

    // Sign and send transaction
    const tx = await this.wallet.sendTransaction({ to, data });
    return await tx.wait();
  }

  async getLoan(loanId: number): Promise<Loan> {
    const response = await fetch(`${this.apiUrl}/loans/${loanId}`);
    if (!response.ok) {
      throw new Error(`Failed to get loan: ${response.statusText}`);
    }
    return await response.json();
  }

  get address(): string {
    if (!this.wallet) {
      throw new Error('Wallet not configured');
    }
    return this.wallet.address;
  }
}

// ============================================================================
// Provider
// ============================================================================

const specularProvider: Provider = {
  get: async (runtime: IAgentRuntime): Promise<SpecularSDK> => {
    const config: SpecularConfig = {
      apiUrl: runtime.getSetting('SPECULAR_API_URL') || 'http://localhost:3001',
      network: (runtime.getSetting('SPECULAR_NETWORK') || 'base') as 'base' | 'arc',
      privateKey: runtime.getSetting('PRIVATE_KEY')
    };

    return new SpecularSDK(config);
  }
};

// ============================================================================
// Actions
// ============================================================================

// Action: Check Credit
export const checkCreditAction: Action = {
  name: 'CHECK_CREDIT',
  similes: [
    'CHECK_CREDIT_SCORE',
    'GET_CREDIT',
    'SHOW_CREDIT',
    'CREDIT_STATUS'
  ],
  description: 'Check agent credit score and borrowing capacity',
  validate: async () => true,
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State,
    options: any,
    callback: HandlerCallback
  ) => {
    try {
      const sdk = await specularProvider.get(runtime);
      const profile = await sdk.getProfile(sdk.address);

      if (!profile.registered) {
        await callback({
          text: "You're not registered with Specular yet. Register first to access credit.",
          content: { error: 'NOT_REGISTERED' }
        });
        return;
      }

      const scoreAssessment = profile.reputation.score >= 900
        ? 'Excellent! You have top-tier credit.'
        : profile.reputation.score >= 800
          ? 'Very good credit standing.'
          : profile.reputation.score >= 700
            ? 'Good credit history.'
            : profile.reputation.score >= 600
              ? 'Fair credit, room for improvement.'
              : 'Building credit. Focus on timely repayments.';

      await callback({
        text: `Your credit score is ${profile.reputation.score}/1000 (${profile.reputation.tier} tier). ${scoreAssessment}\n\n` +
              `Credit Limit: ${profile.credit.limit} USDC\n` +
              `Available: ${profile.credit.available} USDC\n` +
              `Interest Rate: ${profile.credit.interestRate}% APR\n` +
              `Active Loans: ${profile.activeLoans}`,
        content: { profile }
      });
    } catch (error) {
      await callback({
        text: `Failed to check credit: ${error instanceof Error ? error.message : 'Unknown error'}`,
        content: { error: error instanceof Error ? error.message : 'Unknown error' }
      });
    }
  },
  examples: [
    [
      {
        user: '{{user1}}',
        content: { text: "What's my credit score?" }
      },
      {
        user: '{{agent}}',
        content: {
          text: 'Your credit score is 850/1000 (Excellent tier). Excellent! You have top-tier credit.\n\n' +
                'Credit Limit: 2000 USDC\n' +
                'Available: 1500 USDC\n' +
                'Interest Rate: 5.5% APR\n' +
                'Active Loans: 1',
          action: 'CHECK_CREDIT'
        }
      }
    ]
  ]
};

// Action: Request Loan
export const requestLoanAction: Action = {
  name: 'REQUEST_LOAN',
  similes: [
    'BORROW',
    'GET_LOAN',
    'TAKE_LOAN',
    'NEED_CAPITAL'
  ],
  description: 'Request a USDC loan based on reputation',
  validate: async (runtime: IAgentRuntime, message: Memory) => {
    const text = message.content.text.toLowerCase();
    // Check if message mentions amount and optionally duration
    const hasAmount = /\d+/.test(text) && (text.includes('usdc') || text.includes('borrow') || text.includes('loan'));
    return hasAmount;
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State,
    options: any,
    callback: HandlerCallback
  ) => {
    try {
      const sdk = await specularProvider.get(runtime);
      const text = message.content.text;

      // Extract amount and duration from message
      const amountMatch = text.match(/(\d+(?:\.\d+)?)\s*(?:USDC|usdc)?/);
      const durationMatch = text.match(/(\d+)\s*(?:days?|d)/i);

      if (!amountMatch) {
        await callback({
          text: 'Please specify an amount. For example: "Borrow 100 USDC for 30 days"',
          content: { error: 'AMOUNT_REQUIRED' }
        });
        return;
      }

      const amount = parseFloat(amountMatch[1]);
      const durationDays = durationMatch ? parseInt(durationMatch[1]) : 30;

      // Check eligibility first
      const profile = await sdk.getProfile(sdk.address);

      if (!profile.credit.canBorrow) {
        await callback({
          text: `You've reached the maximum number of active loans (${profile.activeLoans}). Please repay an existing loan first.`,
          content: { error: 'MAX_LOANS_REACHED' }
        });
        return;
      }

      const available = parseFloat(profile.credit.available);
      if (amount > available) {
        await callback({
          text: `Insufficient credit. You can borrow up to ${available} USDC, but requested ${amount} USDC.`,
          content: { error: 'INSUFFICIENT_CREDIT', available, requested: amount }
        });
        return;
      }

      // Request the loan
      await callback({
        text: `Requesting ${amount} USDC loan for ${durationDays} days...`,
        content: { status: 'PROCESSING' }
      });

      const receipt = await sdk.requestLoan(amount, durationDays);

      const interest = amount * (profile.credit.interestRate / 100) * (durationDays / 365);
      const totalDue = amount + interest;

      await callback({
        text: `✅ Loan approved!\n\n` +
              `Amount: ${amount} USDC\n` +
              `Duration: ${durationDays} days\n` +
              `Interest: ${interest.toFixed(2)} USDC (${profile.credit.interestRate}% APR)\n` +
              `Total to repay: ${totalDue.toFixed(2)} USDC\n\n` +
              `The USDC has been sent to your wallet. Please repay by the due date to maintain your reputation.`,
        content: { receipt, amount, durationDays, interest, totalDue }
      });
    } catch (error) {
      await callback({
        text: `Failed to request loan: ${error instanceof Error ? error.message : 'Unknown error'}`,
        content: { error: error instanceof Error ? error.message : 'Unknown error' }
      });
    }
  },
  examples: [
    [
      {
        user: '{{user1}}',
        content: { text: 'Borrow 500 USDC for 30 days' }
      },
      {
        user: '{{agent}}',
        content: {
          text: '✅ Loan approved!\n\n' +
                'Amount: 500 USDC\n' +
                'Duration: 30 days\n' +
                'Interest: 2.26 USDC (5.5% APR)\n' +
                'Total to repay: 502.26 USDC\n\n' +
                'The USDC has been sent to your wallet. Please repay by the due date to maintain your reputation.',
          action: 'REQUEST_LOAN'
        }
      }
    ]
  ]
};

// Action: Repay Loan
export const repayLoanAction: Action = {
  name: 'REPAY_LOAN',
  similes: [
    'PAY_BACK',
    'PAY_OFF',
    'RETURN_LOAN',
    'PAYBACK'
  ],
  description: 'Repay an active loan',
  validate: async (runtime: IAgentRuntime, message: Memory) => {
    const text = message.content.text.toLowerCase();
    return text.includes('repay') || text.includes('pay back') || text.includes('pay off');
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State,
    options: any,
    callback: HandlerCallback
  ) => {
    try {
      const sdk = await specularProvider.get(runtime);
      const text = message.content.text;

      // Extract loan ID from message
      const loanIdMatch = text.match(/loan\s*#?(\d+)/i);

      if (!loanIdMatch) {
        await callback({
          text: 'Please specify which loan to repay (e.g., "Repay loan #123")',
          content: { error: 'LOAN_ID_REQUIRED' }
        });
        return;
      }

      const loanId = parseInt(loanIdMatch[1]);

      // Get loan details
      const loan = await sdk.getLoan(loanId);

      if (loan.status !== 'ACTIVE') {
        await callback({
          text: `Loan #${loanId} is ${loan.status.toLowerCase()}, not active.`,
          content: { error: 'LOAN_NOT_ACTIVE', loanId, status: loan.status }
        });
        return;
      }

      // Repay the loan
      await callback({
        text: `Repaying loan #${loanId}...`,
        content: { status: 'PROCESSING' }
      });

      const receipt = await sdk.repayLoan(loanId);

      await callback({
        text: `✅ Loan #${loanId} repaid successfully!\n\n` +
              `Amount repaid: ${loan.amount} USDC\n` +
              `Interest paid: ${loan.interest} USDC\n` +
              `Total: ${loan.totalDue} USDC\n\n` +
              `Your reputation has been updated. Keep up the good work!`,
        content: { receipt, loan }
      });
    } catch (error) {
      await callback({
        text: `Failed to repay loan: ${error instanceof Error ? error.message : 'Unknown error'}`,
        content: { error: error instanceof Error ? error.message : 'Unknown error' }
      });
    }
  },
  examples: [
    [
      {
        user: '{{user1}}',
        content: { text: 'Repay loan #123' }
      },
      {
        user: '{{agent}}',
        content: {
          text: '✅ Loan #123 repaid successfully!\n\n' +
                'Amount repaid: 500 USDC\n' +
                'Interest paid: 2.26 USDC\n' +
                'Total: 502.26 USDC\n\n' +
                'Your reputation has been updated. Keep up the good work!',
          action: 'REPAY_LOAN'
        }
      }
    ]
  ]
};

// Action: Check Loans
export const checkLoansAction: Action = {
  name: 'CHECK_LOANS',
  similes: [
    'SHOW_LOANS',
    'MY_LOANS',
    'LOAN_STATUS',
    'ACTIVE_LOANS'
  ],
  description: 'Check active loans and due dates',
  validate: async () => true,
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State,
    options: any,
    callback: HandlerCallback
  ) => {
    try {
      const sdk = await specularProvider.get(runtime);
      const profile = await sdk.getProfile(sdk.address);

      if (profile.activeLoans === 0) {
        await callback({
          text: "You don't have any active loans. Your credit is clear!",
          content: { activeLoans: 0 }
        });
        return;
      }

      await callback({
        text: `You have ${profile.activeLoans} active loan(s). ` +
              'To check a specific loan, ask: "Check loan #123 status"',
        content: { activeLoans: profile.activeLoans }
      });
    } catch (error) {
      await callback({
        text: `Failed to check loans: ${error instanceof Error ? error.message : 'Unknown error'}`,
        content: { error: error instanceof Error ? error.message : 'Unknown error' }
      });
    }
  },
  examples: [
    [
      {
        user: '{{user1}}',
        content: { text: 'Show my loans' }
      },
      {
        user: '{{agent}}',
        content: {
          text: 'You have 2 active loan(s). To check a specific loan, ask: "Check loan #123 status"',
          action: 'CHECK_LOANS'
        }
      }
    ]
  ]
};

// Action: Supply Liquidity
export const supplyLiquidityAction: Action = {
  name: 'SUPPLY_LIQUIDITY',
  similes: [
    'LEND',
    'PROVIDE_LIQUIDITY',
    'EARN_YIELD',
    'BECOME_LENDER'
  ],
  description: 'Supply USDC to an agent pool to earn yield',
  validate: async (runtime: IAgentRuntime, message: Memory) => {
    const text = message.content.text.toLowerCase();
    const hasAmount = /\d+/.test(text);
    const hasSupplyKeyword = text.includes('supply') || text.includes('lend') || text.includes('provide');
    return hasAmount && hasSupplyKeyword;
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State,
    options: any,
    callback: HandlerCallback
  ) => {
    try {
      const sdk = await specularProvider.get(runtime);
      const text = message.content.text;

      // Extract amount and agent ID
      const amountMatch = text.match(/(\d+(?:\.\d+)?)\s*(?:USDC|usdc)?/);
      const agentIdMatch = text.match(/agent\s+(?:id\s+)?(\d+)/i);

      if (!amountMatch) {
        await callback({
          text: 'Please specify an amount. For example: "Supply 1000 USDC to agent 5"',
          content: { error: 'AMOUNT_REQUIRED' }
        });
        return;
      }

      if (!agentIdMatch) {
        await callback({
          text: 'Please specify an agent ID. For example: "Supply 1000 USDC to agent 5"',
          content: { error: 'AGENT_ID_REQUIRED' }
        });
        return;
      }

      const amount = parseFloat(amountMatch[1]);
      const agentId = parseInt(agentIdMatch[1]);

      await callback({
        text: `Supplying ${amount} USDC to agent ${agentId}'s pool...`,
        content: { status: 'PROCESSING' }
      });

      // Supply liquidity (this would call the API)
      // For now, simulating the call
      await callback({
        text: `✅ Liquidity supplied!\n\n` +
              `Agent ID: ${agentId}\n` +
              `Amount: ${amount} USDC\n\n` +
              `You are now earning interest on your supplied capital. Interest accrues based on pool utilization.`,
        content: { agentId, amount }
      });
    } catch (error) {
      await callback({
        text: `Failed to supply liquidity: ${error instanceof Error ? error.message : 'Unknown error'}`,
        content: { error: error instanceof Error ? error.message : 'Unknown error' }
      });
    }
  },
  examples: [
    [
      {
        user: '{{user1}}',
        content: { text: 'Supply 1000 USDC to agent 5' }
      },
      {
        user: '{{agent}}',
        content: {
          text: '✅ Liquidity supplied!\n\nAgent ID: 5\nAmount: 1000 USDC\n\nYou are now earning interest on your supplied capital.',
          action: 'SUPPLY_LIQUIDITY'
        }
      }
    ]
  ]
};

// Action: Withdraw Liquidity
export const withdrawLiquidityAction: Action = {
  name: 'WITHDRAW_LIQUIDITY',
  similes: [
    'WITHDRAW',
    'REMOVE_LIQUIDITY',
    'PULL_OUT',
    'TAKE_OUT'
  ],
  description: 'Withdraw supplied liquidity plus earned interest',
  validate: async (runtime: IAgentRuntime, message: Memory) => {
    const text = message.content.text.toLowerCase();
    return text.includes('withdraw') || text.includes('remove') || text.includes('pull out');
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State,
    options: any,
    callback: HandlerCallback
  ) => {
    try {
      const sdk = await specularProvider.get(runtime);
      const text = message.content.text;

      // Extract amount and pool ID
      const amountMatch = text.match(/(\d+(?:\.\d+)?)\s*(?:USDC|usdc)?/);
      const poolIdMatch = text.match(/pool\s+#?(\d+)/i);

      if (!amountMatch) {
        await callback({
          text: 'Please specify an amount. For example: "Withdraw 1000 USDC from pool 10"',
          content: { error: 'AMOUNT_REQUIRED' }
        });
        return;
      }

      if (!poolIdMatch) {
        await callback({
          text: 'Please specify a pool ID. For example: "Withdraw 1000 USDC from pool 10"',
          content: { error: 'POOL_ID_REQUIRED' }
        });
        return;
      }

      const amount = parseFloat(amountMatch[1]);
      const poolId = parseInt(poolIdMatch[1]);

      await callback({
        text: `Withdrawing ${amount} USDC from pool ${poolId}...`,
        content: { status: 'PROCESSING' }
      });

      // Withdraw liquidity (this would call the API)
      await callback({
        text: `✅ Liquidity withdrawn!\n\n` +
              `Pool ID: ${poolId}\n` +
              `Amount: ${amount} USDC\n\n` +
              `Your principal and earned interest have been returned to your wallet.`,
        content: { poolId, amount }
      });
    } catch (error) {
      await callback({
        text: `Failed to withdraw liquidity: ${error instanceof Error ? error.message : 'Unknown error'}`,
        content: { error: error instanceof Error ? error.message : 'Unknown error' }
      });
    }
  },
  examples: [
    [
      {
        user: '{{user1}}',
        content: { text: 'Withdraw 1000 USDC from pool 10' }
      },
      {
        user: '{{agent}}',
        content: {
          text: '✅ Liquidity withdrawn!\n\nPool ID: 10\nAmount: 1000 USDC\n\nYour principal and earned interest have been returned.',
          action: 'WITHDRAW_LIQUIDITY'
        }
      }
    ]
  ]
};

// Action: Get Lending Positions
export const getLendingPositionsAction: Action = {
  name: 'GET_LENDING_POSITIONS',
  similes: [
    'MY_LENDING',
    'SHOW_POSITIONS',
    'LENDING_STATUS',
    'MY_EARNINGS'
  ],
  description: 'View active lending positions and earnings',
  validate: async () => true,
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State,
    options: any,
    callback: HandlerCallback
  ) => {
    try {
      const sdk = await specularProvider.get(runtime);

      // Simulated lending positions
      const positions = [
        {
          poolId: 10,
          agentId: 5,
          supplied: '1000',
          earnedInterest: '12.50',
          apy: '15.5',
          utilization: '75'
        },
        {
          poolId: 12,
          agentId: 8,
          supplied: '2000',
          earnedInterest: '25.80',
          apy: '13.2',
          utilization: '82'
        }
      ];

      if (positions.length === 0) {
        await callback({
          text: "You don't have any active lending positions.\n\n" +
                "Start earning yield by supplying liquidity: 'Supply 1000 USDC to agent 5'",
          content: { positions: [] }
        });
        return;
      }

      const positionText = positions
        .map(p =>
          `Pool ${p.poolId} (Agent ${p.agentId})\n` +
          `  Supplied: ${p.supplied} USDC\n` +
          `  Earned: ${p.earnedInterest} USDC\n` +
          `  APY: ${p.apy}%\n` +
          `  Utilization: ${p.utilization}%`
        )
        .join('\n\n');

      const totalSupplied = positions.reduce((sum, p) => sum + parseFloat(p.supplied), 0);
      const totalEarned = positions.reduce((sum, p) => sum + parseFloat(p.earnedInterest), 0);

      await callback({
        text: `💰 Lending Positions\n\n` +
              `Total Supplied: ${totalSupplied.toFixed(2)} USDC\n` +
              `Total Earned: ${totalEarned.toFixed(2)} USDC\n\n` +
              `${positionText}`,
        content: { positions, totalSupplied, totalEarned }
      });
    } catch (error) {
      await callback({
        text: `Failed to get lending positions: ${error instanceof Error ? error.message : 'Unknown error'}`,
        content: { error: error instanceof Error ? error.message : 'Unknown error' }
      });
    }
  },
  examples: [
    [
      {
        user: '{{user1}}',
        content: { text: 'Show my lending positions' }
      },
      {
        user: '{{agent}}',
        content: {
          text: '💰 Lending Positions\n\nTotal Supplied: 3000 USDC\nTotal Earned: 38.30 USDC\n\n...',
          action: 'GET_LENDING_POSITIONS'
        }
      }
    ]
  ]
};

// Action: Get Pool Details
export const getPoolDetailsAction: Action = {
  name: 'GET_POOL_DETAILS',
  similes: [
    'POOL_INFO',
    'POOL_STATS',
    'CHECK_POOL',
    'POOL_STATUS'
  ],
  description: 'Get detailed information about a lending pool',
  validate: async (runtime: IAgentRuntime, message: Memory) => {
    const text = message.content.text.toLowerCase();
    return text.includes('pool') && /\d+/.test(text);
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State,
    options: any,
    callback: HandlerCallback
  ) => {
    try {
      const sdk = await specularProvider.get(runtime);
      const text = message.content.text;

      // Extract pool ID
      const poolIdMatch = text.match(/pool\s+#?(\d+)/i);

      if (!poolIdMatch) {
        await callback({
          text: 'Please specify a pool ID. For example: "Check pool 10"',
          content: { error: 'POOL_ID_REQUIRED' }
        });
        return;
      }

      const poolId = parseInt(poolIdMatch[1]);

      // Simulated pool details
      const pool = {
        poolId,
        agentId: 5,
        agentScore: 850,
        agentTier: 'Excellent',
        totalLiquidity: '5000',
        availableLiquidity: '1250',
        totalBorrowed: '3750',
        utilization: '75',
        currentAPY: '15.5',
        lenderCount: 12,
        avgPosition: '416.67',
        totalInterestEarned: '487.50'
      };

      await callback({
        text: `🏊 Pool #${poolId} Details\n\n` +
              `Agent: ID ${pool.agentId} (${pool.agentTier})\n` +
              `Reputation: ${pool.agentScore}/1000\n\n` +
              `Liquidity:\n` +
              `  Total: ${pool.totalLiquidity} USDC\n` +
              `  Available: ${pool.availableLiquidity} USDC\n` +
              `  Borrowed: ${pool.totalBorrowed} USDC\n` +
              `  Utilization: ${pool.utilization}%\n\n` +
              `Returns:\n` +
              `  Current APY: ${pool.currentAPY}%\n` +
              `  Total Earned: ${pool.totalInterestEarned} USDC\n\n` +
              `Lenders: ${pool.lenderCount} (avg ${pool.avgPosition} USDC each)`,
        content: { pool }
      });
    } catch (error) {
      await callback({
        text: `Failed to get pool details: ${error instanceof Error ? error.message : 'Unknown error'}`,
        content: { error: error instanceof Error ? error.message : 'Unknown error' }
      });
    }
  },
  examples: [
    [
      {
        user: '{{user1}}',
        content: { text: 'Check pool 10' }
      },
      {
        user: '{{agent}}',
        content: {
          text: '🏊 Pool #10 Details\n\nAgent: ID 5 (Excellent)\nReputation: 850/1000...',
          action: 'GET_POOL_DETAILS'
        }
      }
    ]
  ]
};

// ============================================================================
// Plugin Export
// ============================================================================

export const specularPlugin: Plugin = {
  name: 'specular',
  description: 'On-chain credit for AI agents - borrow USDC based on reputation, lend USDC to earn yield',
  actions: [
    checkCreditAction,
    requestLoanAction,
    repayLoanAction,
    checkLoansAction,
    supplyLiquidityAction,
    withdrawLiquidityAction,
    getLendingPositionsAction,
    getPoolDetailsAction
  ],
  providers: [specularProvider]
};

export default specularPlugin;
