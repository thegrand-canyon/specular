// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./AgentRegistryV2.sol";
import "./ReputationManagerV3.sol";

/**
 * @title AgentLiquidityMarketplace
 * @notice P2P lending marketplace where users can supply liquidity to specific agents
 * @dev Allows direct agent funding instead of pooled liquidity
 */
contract AgentLiquidityMarketplace is Ownable, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    // State variables
    AgentRegistryV2 public agentRegistry;
    ReputationManagerV3 public reputationManager;
    IERC20 public usdcToken;

    // Agent liquidity pools
    struct AgentPool {
        uint256 agentId;
        address agentAddress;
        uint256 totalLiquidity;      // Total USDC supplied to this agent
        uint256 availableLiquidity;  // USDC available for borrowing
        uint256 totalLoaned;         // Currently loaned out
        uint256 totalEarned;         // Total interest earned
        bool isActive;               // Agent can accept liquidity
    }

    // Lender position tracking
    struct LenderPosition {
        uint256 amount;              // USDC supplied to agent
        uint256 earnedInterest;      // Interest earned so far
        uint256 depositTimestamp;    // When they deposited
    }

    // Loan tracking
    struct Loan {
        uint256 loanId;
        address borrower;
        uint256 agentId;
        uint256 amount;
        uint256 collateralAmount;
        uint256 interestRate;        // Basis points (e.g., 500 = 5%)
        uint256 startTime;
        uint256 endTime;
        uint256 duration;            // In days
        LoanState state;
    }

    enum LoanState {
        REQUESTED,
        ACTIVE,
        REPAID,
        DEFAULTED
    }

    // Mappings
    mapping(uint256 => AgentPool) public agentPools;                          // agentId => pool
    mapping(uint256 => mapping(address => LenderPosition)) public positions;  // agentId => lender => position
    mapping(uint256 => address[]) public poolLenders;                         // agentId => lender addresses
    mapping(uint256 => Loan) public loans;                                    // loanId => loan
    mapping(address => uint256[]) public agentLoans;                          // agent => loanIds

    uint256 public nextLoanId = 1;
    uint256 public platformFeeRate = 100; // 1% platform fee (in basis points)
    uint256 public accumulatedFees;

    // Discovery: ordered list of all agent IDs that have created pools
    uint256[] public agentPoolIds;

    // Constants
    uint256 public constant MAX_INTEREST_RATE = 2000; // 20% max
    uint256 public constant MIN_LOAN_DURATION = 7 days;
    uint256 public constant MAX_LOAN_DURATION = 365 days;
    // [H-04 mitigation] Cap lenders per pool to bound _distributeInterest gas cost
    uint256 public constant MAX_LENDERS_PER_POOL = 200;
    // [SECURITY-01] Limit concurrent active loans per agent to prevent credit limit bypass
    uint256 public constant MAX_ACTIVE_LOANS_PER_AGENT = 10;

    // Events
    event PoolCreated(uint256 indexed agentId, address indexed agentAddress);
    event LiquiditySupplied(uint256 indexed agentId, address indexed lender, uint256 amount);
    event LiquidityWithdrawn(uint256 indexed agentId, address indexed lender, uint256 amount);
    event LoanRequested(uint256 indexed loanId, uint256 indexed agentId, address indexed borrower, uint256 amount);
    event LoanDisbursed(uint256 indexed loanId, uint256 amount);
    event LoanRepaid(uint256 indexed loanId, uint256 principal, uint256 interest);
    event LoanDefaulted(uint256 indexed loanId);
    event InterestDistributed(uint256 indexed agentId, uint256 totalInterest);

    constructor(
        address _agentRegistry,
        address _reputationManager,
        address _usdcToken
    ) Ownable(msg.sender) {
        agentRegistry = AgentRegistryV2(_agentRegistry);
        reputationManager = ReputationManagerV3(_reputationManager);
        usdcToken = IERC20(_usdcToken);
    }

    /**
     * @notice Create a liquidity pool for an agent
     */
    function createAgentPool() external whenNotPaused {
        uint256 agentId = agentRegistry.addressToAgentId(msg.sender);
        require(agentId != 0, "Not a registered agent");
        require(!agentPools[agentId].isActive, "Pool already exists");

        agentPools[agentId] = AgentPool({
            agentId: agentId,
            agentAddress: msg.sender,
            totalLiquidity: 0,
            availableLiquidity: 0,
            totalLoaned: 0,
            totalEarned: 0,
            isActive: true
        });

        agentPoolIds.push(agentId);

        emit PoolCreated(agentId, msg.sender);
    }

    /**
     * @notice Returns the total number of agent pools created
     */
    function totalPools() external view returns (uint256) {
        return agentPoolIds.length;
    }

    /**
     * @notice Supply liquidity to a specific agent's pool
     */
    function supplyLiquidity(uint256 agentId, uint256 amount) external nonReentrant whenNotPaused {
        require(amount > 0, "Amount must be > 0");
        require(agentPools[agentId].isActive, "Pool not active");

        AgentPool storage pool = agentPools[agentId];
        LenderPosition storage position = positions[agentId][msg.sender];

        // Transfer USDC from lender
        usdcToken.safeTransferFrom(msg.sender, address(this), amount);

        // Update pool
        pool.totalLiquidity += amount;
        pool.availableLiquidity += amount;

        // Update or create position
        if (position.amount == 0) {
            // [H-04 mitigation] Enforce lender cap to bound _distributeInterest gas cost
            require(
                poolLenders[agentId].length < MAX_LENDERS_PER_POOL,
                "Pool lender capacity reached"
            );
            poolLenders[agentId].push(msg.sender);
            position.depositTimestamp = block.timestamp;
        }
        position.amount += amount;

        emit LiquiditySupplied(agentId, msg.sender, amount);
    }

    /**
     * @notice Withdraw liquidity from an agent's pool
     */
    function withdrawLiquidity(uint256 agentId, uint256 amount) external nonReentrant whenNotPaused {
        LenderPosition storage position = positions[agentId][msg.sender];
        AgentPool storage pool = agentPools[agentId];

        require(position.amount >= amount, "Insufficient balance");
        require(pool.availableLiquidity >= amount, "Insufficient pool liquidity");

        // Update position
        position.amount -= amount;

        // Update pool
        pool.totalLiquidity -= amount;
        pool.availableLiquidity -= amount;

        // Transfer USDC back to lender
        usdcToken.safeTransfer(msg.sender, amount);

        emit LiquidityWithdrawn(agentId, msg.sender, amount);
    }

    /**
     * @notice Agent requests a loan from their dedicated pool
     */
    function requestLoan(uint256 amount, uint256 durationDays) external nonReentrant whenNotPaused returns (uint256) {
        uint256 agentId = agentRegistry.addressToAgentId(msg.sender);
        require(agentId != 0, "Not a registered agent");
        require(agentPools[agentId].isActive, "No pool for agent");

        AgentPool storage pool = agentPools[agentId];
        require(amount <= pool.availableLiquidity, "Insufficient pool liquidity");

        // Validate loan parameters
        uint256 duration = durationDays * 1 days;
        require(duration >= MIN_LOAN_DURATION && duration <= MAX_LOAN_DURATION, "Invalid duration");

        // Get credit limit based on reputation
        uint256 creditLimit = reputationManager.calculateCreditLimit(msg.sender);
        require(amount <= creditLimit, "Exceeds credit limit");

        // [SECURITY-01] Enforce concurrent loan limit to prevent credit limit bypass
        uint256 activeLoans = _countActiveLoans(msg.sender);
        require(activeLoans < MAX_ACTIVE_LOANS_PER_AGENT, "Too many active loans");

        // Calculate collateral requirement
        uint256 collateralPercent = reputationManager.calculateCollateralRequirement(msg.sender);
        uint256 requiredCollateral = (amount * collateralPercent) / 100;

        // Get interest rate
        uint256 interestRate = reputationManager.calculateInterestRate(msg.sender);

        // Create loan
        uint256 loanId = nextLoanId++;
        loans[loanId] = Loan({
            loanId: loanId,
            borrower: msg.sender,
            agentId: agentId,
            amount: amount,
            collateralAmount: requiredCollateral,
            interestRate: interestRate,
            startTime: 0, // Set when disbursed
            endTime: 0,
            duration: duration,
            state: LoanState.REQUESTED
        });

        agentLoans[msg.sender].push(loanId);

        emit LoanRequested(loanId, agentId, msg.sender, amount);

        // Auto-disburse if no collateral required
        if (requiredCollateral == 0) {
            _disburseLoan(loanId);
        } else {
            // Require collateral to be deposited
            usdcToken.safeTransferFrom(msg.sender, address(this), requiredCollateral);
            _disburseLoan(loanId);
        }

        return loanId;
    }

    /**
     * @notice Internal function to disburse loan
     */
    function _disburseLoan(uint256 loanId) internal {
        Loan storage loan = loans[loanId];
        AgentPool storage pool = agentPools[loan.agentId];

        require(loan.state == LoanState.REQUESTED, "Invalid loan state");

        // Update pool
        pool.availableLiquidity -= loan.amount;
        pool.totalLoaned += loan.amount;

        // Update loan
        loan.state = LoanState.ACTIVE;
        loan.startTime = block.timestamp;
        loan.endTime = block.timestamp + loan.duration;

        // Transfer funds to borrower
        usdcToken.safeTransfer(loan.borrower, loan.amount);

        // Record with reputation manager
        reputationManager.recordBorrow(loan.borrower, loan.amount);

        emit LoanDisbursed(loanId, loan.amount);
    }

    /**
     * @notice Repay a loan
     */
    function repayLoan(uint256 loanId) external nonReentrant whenNotPaused {
        Loan storage loan = loans[loanId];
        require(msg.sender == loan.borrower, "Not the borrower");
        require(loan.state == LoanState.ACTIVE, "Loan not active");

        // Calculate interest
        uint256 interest = calculateInterest(
            loan.amount,
            loan.interestRate,
            loan.duration
        );

        uint256 totalRepayment = loan.amount + interest;

        // Calculate platform fee
        uint256 platformFee = (interest * platformFeeRate) / 10000;
        uint256 lenderInterest = interest - platformFee;

        // [C-01 FIX] Collect repayment FIRST before any state changes (strict CEI)
        usdcToken.safeTransferFrom(msg.sender, address(this), totalRepayment);

        // EFFECTS: update state only after funds confirmed received
        loan.state = LoanState.REPAID;

        // Update pool
        AgentPool storage pool = agentPools[loan.agentId];
        pool.availableLiquidity += loan.amount + lenderInterest;
        pool.totalLoaned -= loan.amount;
        pool.totalEarned += lenderInterest;

        // Distribute interest to lenders proportionally
        _distributeInterest(loan.agentId, lenderInterest);

        // Accumulate platform fees
        accumulatedFees += platformFee;

        // INTERACTIONS: return collateral last
        if (loan.collateralAmount > 0) {
            usdcToken.safeTransfer(loan.borrower, loan.collateralAmount);
        }

        // Record with reputation manager
        bool onTime = block.timestamp <= loan.endTime;
        reputationManager.recordLoanCompletion(loan.borrower, loan.amount, onTime);

        emit LoanRepaid(loanId, loan.amount, interest);
    }

    /**
     * @notice Distribute interest to lenders proportionally
     */
    function _distributeInterest(uint256 agentId, uint256 totalInterest) internal {
        AgentPool storage pool = agentPools[agentId];
        address[] storage lenders = poolLenders[agentId];

        // [H-01 FIX] Track distributed amount to credit rounding dust to platform fees
        uint256 distributed = 0;

        for (uint256 i = 0; i < lenders.length; i++) {
            address lender = lenders[i];
            LenderPosition storage position = positions[agentId][lender];

            if (position.amount > 0) {
                // Calculate lender's share based on their proportion of the pool
                uint256 share = (totalInterest * position.amount) / pool.totalLiquidity;
                position.earnedInterest += share;
                distributed += share;
            }
        }

        // Credit any remainder (rounding dust) as platform fees rather than trapping it
        uint256 dust = totalInterest - distributed;
        if (dust > 0) {
            accumulatedFees += dust;
        }

        emit InterestDistributed(agentId, totalInterest);
    }

    /**
     * @notice Liquidate a defaulted loan
     */
    function liquidateLoan(uint256 loanId) external onlyOwner nonReentrant {
        Loan storage loan = loans[loanId];
        require(loan.state == LoanState.ACTIVE, "Loan not active");
        require(block.timestamp > loan.endTime, "Loan not overdue");

        AgentPool storage pool = agentPools[loan.agentId];

        // [H-02 FIX] Correctly account for principal loss when collateral < loan amount
        uint256 recovered = loan.collateralAmount;
        uint256 loss = loan.amount > recovered ? loan.amount - recovered : 0;

        // Seize collateral (what we actually recover)
        pool.availableLiquidity += recovered;

        // Reduce totalLiquidity by the unrecovered loss so it reflects real pool value
        if (loss > 0) {
            pool.totalLiquidity -= loss;
        }

        // Update loaned amount
        pool.totalLoaned -= loan.amount;

        // Mark as defaulted
        loan.state = LoanState.DEFAULTED;

        // Record default with reputation manager
        reputationManager.recordDefault(loan.borrower, loan.amount);

        emit LoanDefaulted(loanId);
    }

    /**
     * @notice Calculate interest for a loan
     */
    function calculateInterest(
        uint256 principal,
        uint256 annualRateBPS,
        uint256 durationSeconds
    ) public pure returns (uint256) {
        uint256 annualInterest = (principal * annualRateBPS) / 10000;
        uint256 interest = (annualInterest * durationSeconds) / 365 days;
        return interest;
    }

    /**
     * @notice Get agent pool details
     */
    function getAgentPool(uint256 agentId) external view returns (
        address agentAddress,
        uint256 totalLiquidity,
        uint256 availableLiquidity,
        uint256 totalLoaned,
        uint256 totalEarned,
        uint256 utilizationRate,
        uint256 lenderCount
    ) {
        AgentPool memory pool = agentPools[agentId];
        uint256 utilization = pool.totalLiquidity > 0
            ? (pool.totalLoaned * 10000) / pool.totalLiquidity
            : 0;

        return (
            pool.agentAddress,
            pool.totalLiquidity,
            pool.availableLiquidity,
            pool.totalLoaned,
            pool.totalEarned,
            utilization,
            poolLenders[agentId].length
        );
    }

    /**
     * @notice Get lender position for an agent
     */
    function getLenderPosition(uint256 agentId, address lender) external view returns (
        uint256 amount,
        uint256 earnedInterest,
        uint256 depositTimestamp,
        uint256 shareOfPool
    ) {
        LenderPosition memory position = positions[agentId][lender];
        AgentPool memory pool = agentPools[agentId];

        uint256 share = pool.totalLiquidity > 0
            ? (position.amount * 10000) / pool.totalLiquidity
            : 0;

        return (
            position.amount,
            position.earnedInterest,
            position.depositTimestamp,
            share
        );
    }

    /**
     * @notice Get all active agent pools (for browsing)
     */
    function getActiveAgents() external view returns (uint256[] memory) {
        // Note: This requires tracking active agent IDs separately for gas efficiency
        // For now, front-end should query by known agent IDs
        // TODO: Add agentId array tracking if needed
        revert("Use front-end to query specific agents");
    }

    /**
     * @notice Claim earned interest
     */
    function claimInterest(uint256 agentId) external nonReentrant whenNotPaused {
        LenderPosition storage position = positions[agentId][msg.sender];
        uint256 interest = position.earnedInterest;

        require(interest > 0, "No interest to claim");

        position.earnedInterest = 0;
        usdcToken.safeTransfer(msg.sender, interest);
    }

    /**
     * @notice Owner withdraws platform fees
     */
    function withdrawFees(uint256 amount) external onlyOwner nonReentrant {
        require(amount <= accumulatedFees, "Insufficient fees");
        accumulatedFees -= amount;
        usdcToken.safeTransfer(owner(), amount);
    }

    /**
     * @notice Emergency pause
     */
    function pause() external onlyOwner {
        _pause();
    }

    /**
     * @notice Unpause
     */
    function unpause() external onlyOwner {
        _unpause();
    }

    /**
     * @notice Update platform fee rate
     */
    function setPlatformFeeRate(uint256 newRate) external onlyOwner {
        require(newRate <= 500, "Fee too high"); // Max 5%
        platformFeeRate = newRate;
    }

    /**
     * @notice Emergency function to recalculate and fix pool accounting
     * @dev Recalculates totalLoaned by summing active loans for agent
     * @param agentId The agent ID whose pool to fix
     */
    function resetPoolAccounting(uint256 agentId) external onlyOwner {
        AgentPool storage pool = agentPools[agentId];
        require(pool.agentId == agentId, "Pool does not exist");

        // Recalculate totalLoaned from active loans
        uint256 actualLoaned = 0;
        uint256[] memory loanIds = agentLoans[pool.agentAddress];

        for (uint256 i = 0; i < loanIds.length; i++) {
            Loan storage loan = loans[loanIds[i]];
            if (loan.state == LoanState.ACTIVE) {
                actualLoaned += loan.amount;
            }
        }

        // Update pool state
        uint256 oldLoaned = pool.totalLoaned;
        pool.totalLoaned = actualLoaned;
        pool.availableLiquidity = pool.totalLiquidity + pool.totalEarned - actualLoaned;

        emit PoolAccountingReset(agentId, oldLoaned, actualLoaned, pool.availableLiquidity);
    }

    /**
     * @notice Count active loans for an agent
     * @dev [SECURITY-01] Internal helper to enforce concurrent loan limits
     */
    function _countActiveLoans(address agent) internal view returns (uint256) {
        uint256[] memory loanIds = agentLoans[agent];
        uint256 activeCount = 0;

        for (uint256 i = 0; i < loanIds.length; i++) {
            if (loans[loanIds[i]].state == LoanState.ACTIVE) {
                activeCount++;
            }
        }

        return activeCount;
    }

    // Events
    event PoolAccountingReset(
        uint256 indexed agentId,
        uint256 oldTotalLoaned,
        uint256 newTotalLoaned,
        uint256 newAvailableLiquidity
    );
}
