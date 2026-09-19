/**
 * Specular Protocol Configuration
 * Contract addresses and ABIs for Base Mainnet and Arc Testnet
 */

const NETWORKS = {
    base: {
        chainId: 8453,
        rpcUrl: 'https://mainnet.base.org',
        contracts: {
            agentRegistry: '0xb9996de05fD514A0cB2B81fa25448EECD4559Aaa',
            reputationManager: '0xf19b1780A84668C8dfB6b4E84C08e457dB3B0527',
            // Canonical V6 (unpaused). Was 0xd7b4dEE7…1C8f — the ARCHIVED/PAUSED
            // v4; transacting against it would revert. Keep in sync with
            // src/config/base-addresses.json:agentLiquidityMarketplace.
            marketplace: '0x0a4e3C745aB95aceb45B05C28D89fe4Db8815F9a',
            usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
        }
    },
    arc: {
        chainId: 5042002,
        rpcUrl: 'https://arc-testnet.drpc.org',
        contracts: {
            agentRegistry: '0x741C03c0d95d2c15E479CE1c7E69B3196d86faD7',
            reputationManager: '0x94F2fa47c4488202a46dAA9038Ed9C9c4c07467F',
            marketplace: '0x048363A325A5B188b7FF157d725C5e329f0171D3',
            usdc: '0xf2807051e292e945751A25616705a9aadfb39895'
        }
    }
};

// Minimal ABIs needed for the tool to function
const ABIS = {
    registry: [
        'function addressToAgentId(address) view returns (uint256)',
        'function register(string agentURI, tuple(string,bytes)[] metadata) returns (uint256)'
    ],
    reputation: [
        'function getReputationScore(uint256 agentId) view returns (uint256)'
    ],
    marketplace: [
        'function getCreditParameters(uint256 agentId) view returns (uint256 maxLoanAmount, uint256 interestRate, uint256 collateralPercent)',
        'function requestLoan(uint256 amount, uint256 durationDays) returns (uint256)',
        'function repayLoan(uint256 loanId)',
        'function loans(uint256) view returns (uint256 loanId, address borrower, uint256 agentId, uint256 amount, uint256 collateralAmount, uint256 interestRate, uint256 startTime, uint256 endTime, uint256 duration, uint8 state)',
        'event LoanRequested(uint256 indexed loanId, address indexed borrower, uint256 amount)'
    ],
    usdc: [
        'function approve(address spender, uint256 amount) returns (bool)',
        'function balanceOf(address account) view returns (uint256)'
    ]
};

module.exports = {
    NETWORKS,
    ABIS
};
