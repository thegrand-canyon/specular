// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./AgentRegistry.sol";
import "./ReputationManager.sol";

/**
 * @title LendingPool
 * @notice Core lending logic - manages loan lifecycle, liquidity, and interest
 * @dev Implements checks-effects-interactions pattern and reentrancy protection
 */
contract LendingPool is Ownable, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum LoanState {
        REQUESTED,
        APPROVED,
        ACTIVE,
        REPAID,
        DEFAULTED
    }

    struct Loan {
        uint256 loanId;
        address borrower;
        uint256 amount;
        uint256 durationDays;
        uint256 interestRate; // Basis points (e.g., 500 = 5%)
        uint256 startTime;
        uint256 endTime;
        uint256 collateralAmount;
        LoanState state;
    }

    AgentRegistry public agentRegistry;
    ReputationManager public reputationManager;
    IERC20 public usdcToken;

    mapping(uint256 => Loan) public loans;
    mapping(address => uint256[]) public borrowerLoans;
    uint256 public nextLoanId;

    uint256 public totalLiquidity;
    uint256 public availableLiquidity;
    uint256 public totalLoaned;

    uint256 public constant BASE_INTEREST_RATE = 500; // 5% in basis points
    uint256 public constant SECONDS_PER_DAY = 86400;
    uint256 public constant SECONDS_PER_YEAR = 31536000;
    uint256 public constant BASIS_POINTS = 10000;

    event LoanRequested(
        uint256 indexed loanId,
        address indexed borrower,
        uint256 amount,
        uint256 durationDays
    );
    event LoanApproved(uint256 indexed loanId, uint256 interestRate);
    event LoanRepaid(
        uint256 indexed loanId,
        address indexed borrower,
        uint256 totalAmount,
        bool onTime
    );
    event LoanDefaulted(uint256 indexed loanId, address indexed borrower);
    event LiquidityDeposited(address indexed provider, uint256 amount);
    event LiquidityWithdrawn(address indexed provider, uint256 amount);

    constructor(
        address _agentRegistry,
        address _reputationManager,
        address _usdcToken
    ) Ownable(msg.sender) {
        require(_agentRegistry != address(0), "Invalid agent registry");
        require(_reputationManager != address(0), "Invalid reputation manager");
        require(_usdcToken != address(0), "Invalid USDC token");

        agentRegistry = AgentRegistry(_agentRegistry);
        reputationManager = ReputationManager(_reputationManager);
        usdcToken = IERC20(_usdcToken);
    }

    /**
     * @notice Request a loan
     * @param _amount Loan amount in USDC (with 6 decimals)
     * @param _durationDays Loan duration in days
     * @return loanId The ID of the created loan request
     */
    function requestLoan(uint256 _amount, uint256 _durationDays)
        external
        whenNotPaused
        nonReentrant
        returns (uint256)
    {
        require(agentRegistry.isAgentActive(msg.sender), "Agent not active");
        require(_amount > 0, "Amount must be positive");
        require(_durationDays > 0 && _durationDays <= 365, "Invalid duration");

        // Check credit limit
        uint256 creditLimit = reputationManager.calculateCreditLimit(msg.sender);
        require(_amount <= creditLimit, "Amount exceeds credit limit");

        // Check if collateral is required
        uint256 collateralPercent = reputationManager.calculateCollateralRequirement(msg.sender);
        uint256 collateralAmount = (_amount * collateralPercent) / 100;

        // If collateral required, transfer it
        if (collateralAmount > 0) {
            usdcToken.safeTransferFrom(msg.sender, address(this), collateralAmount);
        }

        uint256 loanId = nextLoanId++;
        loans[loanId] = Loan({
            loanId: loanId,
            borrower: msg.sender,
            amount: _amount,
            durationDays: _durationDays,
            interestRate: 0, // Set upon approval
            startTime: 0,
            endTime: 0,
            collateralAmount: collateralAmount,
            state: LoanState.REQUESTED
        });

        borrowerLoans[msg.sender].push(loanId);

        emit LoanRequested(loanId, msg.sender, _amount, _durationDays);

        return loanId;
    }

    /**
     * @notice Approve a loan request (only owner)
     * @param _loanId ID of the loan to approve
     */
    function approveLoan(uint256 _loanId) external onlyOwner nonReentrant {
        Loan storage loan = loans[_loanId];
        require(loan.state == LoanState.REQUESTED, "Loan not in requested state");
        require(availableLiquidity >= loan.amount, "Insufficient liquidity");

        // Calculate interest rate based on reputation
        uint256 reputationScore = reputationManager.getReputationScore(loan.borrower);
        uint256 interestRate = calculateInterestRate(reputationScore);

        // Update loan details
        loan.interestRate = interestRate;
        loan.startTime = block.timestamp;
        loan.endTime = block.timestamp + (loan.durationDays * SECONDS_PER_DAY);
        loan.state = LoanState.ACTIVE;

        // Update liquidity
        availableLiquidity -= loan.amount;
        totalLoaned += loan.amount;

        // Transfer loan amount to borrower
        usdcToken.safeTransfer(loan.borrower, loan.amount);

        // Record borrow in reputation
        reputationManager.recordBorrow(loan.borrower, loan.amount);

        emit LoanApproved(_loanId, interestRate);
    }

    /**
     * @notice Repay a loan
     * @param _loanId ID of the loan to repay
     */
    function repayLoan(uint256 _loanId) external nonReentrant {
        Loan storage loan = loans[_loanId];
        require(loan.borrower == msg.sender, "Not loan borrower");
        require(loan.state == LoanState.ACTIVE, "Loan not active");

        // Calculate total repayment amount (principal + interest)
        uint256 interest = calculateInterest(
            loan.amount,
            loan.interestRate,
            loan.durationDays
        );
        uint256 totalRepayment = loan.amount + interest;

        // Check if repayment is on time
        bool onTime = block.timestamp <= loan.endTime;

        // Transfer repayment from borrower
        usdcToken.safeTransferFrom(msg.sender, address(this), totalRepayment);

        // Update state
        loan.state = LoanState.REPAID;
        availableLiquidity += totalRepayment;
        totalLoaned -= loan.amount;

        // Return collateral if any
        if (loan.collateralAmount > 0) {
            usdcToken.safeTransfer(msg.sender, loan.collateralAmount);
        }

        // Update reputation
        reputationManager.recordLoanCompletion(msg.sender, loan.amount, onTime);

        emit LoanRepaid(_loanId, msg.sender, totalRepayment, onTime);
    }

    /**
     * @notice Mark a loan as defaulted (only owner, called after deadline)
     * @param _loanId ID of the loan to mark as defaulted
     */
    function liquidateLoan(uint256 _loanId) external onlyOwner nonReentrant {
        Loan storage loan = loans[_loanId];
        require(loan.state == LoanState.ACTIVE, "Loan not active");
        require(block.timestamp > loan.endTime, "Loan not past due");

        loan.state = LoanState.DEFAULTED;
        totalLoaned -= loan.amount;

        // Keep collateral (if any) as partial recovery
        if (loan.collateralAmount > 0) {
            availableLiquidity += loan.collateralAmount;
        }

        // Update reputation with severe penalty
        reputationManager.recordDefault(loan.borrower, loan.amount);

        emit LoanDefaulted(_loanId, loan.borrower);
    }

    /**
     * @notice Deposit liquidity into the pool
     * @param _amount Amount of USDC to deposit
     */
    function depositLiquidity(uint256 _amount) external nonReentrant {
        require(_amount > 0, "Amount must be positive");

        usdcToken.safeTransferFrom(msg.sender, address(this), _amount);

        totalLiquidity += _amount;
        availableLiquidity += _amount;

        emit LiquidityDeposited(msg.sender, _amount);
    }

    /**
     * @notice Withdraw liquidity from the pool (only owner)
     * @param _amount Amount of USDC to withdraw
     */
    function withdrawLiquidity(uint256 _amount) external onlyOwner nonReentrant {
        require(_amount > 0, "Amount must be positive");
        require(_amount <= availableLiquidity, "Insufficient available liquidity");

        availableLiquidity -= _amount;
        totalLiquidity -= _amount;

        usdcToken.safeTransfer(msg.sender, _amount);

        emit LiquidityWithdrawn(msg.sender, _amount);
    }

    /**
     * @notice Calculate interest rate based on reputation score
     * @param _reputationScore Agent's reputation score (0-1000)
     * @return Interest rate in basis points
     */
    function calculateInterestRate(uint256 _reputationScore) public pure returns (uint256) {
        if (_reputationScore >= 800) {
            return 500; // 5%
        } else if (_reputationScore >= 600) {
            return 700; // 7%
        } else if (_reputationScore >= 500) {
            return 1000; // 10%
        } else if (_reputationScore >= 300) {
            return 1500; // 15%
        } else {
            return 2000; // 20%
        }
    }

    /**
     * @notice Calculate interest amount
     * @param _principal Loan principal amount
     * @param _interestRate Interest rate in basis points
     * @param _durationDays Loan duration in days
     * @return Interest amount
     */
    function calculateInterest(
        uint256 _principal,
        uint256 _interestRate,
        uint256 _durationDays
    ) public pure returns (uint256) {
        // Interest = Principal * Rate * (Duration / 365)
        return (_principal * _interestRate * _durationDays) / (BASIS_POINTS * 365);
    }

    /**
     * @notice Get all loan IDs for a borrower
     * @param _borrower Address of the borrower
     * @return Array of loan IDs
     */
    function getBorrowerLoans(address _borrower) external view returns (uint256[] memory) {
        return borrowerLoans[_borrower];
    }

    /**
     * @notice Get loan details
     * @param _loanId ID of the loan
     * @return Loan struct
     */
    function getLoan(uint256 _loanId) external view returns (Loan memory) {
        return loans[_loanId];
    }

    /**
     * @notice Pause the contract (only owner)
     */
    function pause() external onlyOwner {
        _pause();
    }

    /**
     * @notice Unpause the contract (only owner)
     */
    function unpause() external onlyOwner {
        _unpause();
    }
}
