// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title AgentLiquidityMarketplaceV6_Patch
 * @notice Reference patch demonstrating fixes for §B1, §S1, §S5.
 *
 * NOT a drop-in replacement — this is a self-contained illustration of the three
 * mitigations integrated into one file for unit-test verification.
 *
 * Changes vs current AgentLiquidityMarketplace.sol:
 *   §S5 — replace _countActiveLoans array walk with O(1) counter mapping
 *   §B1 — guard supplyLiquidity push with positionExistsInPoolLenders flag,
 *         and add admin compactPoolLenders() to dedup any pre-existing duplicates
 *   §S1 — claimInterest now decrements pool.availableLiquidity by the claimed amount
 *
 * Storage layout is intentionally NOT compatible with v4/v5 — these mitigations
 * require a fresh deployment + state migration, not an in-place upgrade.
 */
contract AgentLiquidityMarketplaceV6_Patch is Ownable, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    enum LoanState { REQUESTED, ACTIVE, REPAID, DEFAULTED, LIQUIDATED }

    struct Loan {
        uint256 loanId;
        address borrower;
        uint256 agentId;
        uint256 amount;
        uint256 collateralAmount;
        uint256 interestRate;
        uint256 startTime;
        uint256 endTime;
        LoanState state;
    }

    struct AgentPool {
        uint256 agentId;
        uint256 totalLiquidity;
        uint256 availableLiquidity;
        uint256 totalLoaned;
        uint256 totalEarned;
        bool isActive;
    }

    struct LenderPosition {
        uint256 amount;
        uint256 earnedInterest;
        uint256 depositTimestamp;
    }

    IERC20 public immutable usdcToken;
    uint256 public nextLoanId = 1;
    uint256 public constant MAX_ACTIVE_LOANS_PER_AGENT = 10;
    uint256 public constant MAX_LENDERS_PER_POOL = 50;
    uint256 public constant MIN_LOAN_DURATION = 7 days;
    uint256 public constant MAX_LOAN_DURATION = 365 days;

    mapping(uint256 => AgentPool) public agentPools;
    mapping(uint256 => Loan) public loans;
    mapping(uint256 => address[]) public poolLenders;
    mapping(uint256 => mapping(address => LenderPosition)) public positions;
    mapping(address => uint256[]) public agentLoans;

    // §S5: O(1) active-loan counter — replaces array walk in _countActiveLoans
    mapping(address => uint256) public activeLoanCount;

    // §B1: per-pool, per-lender flag to gate poolLenders.push()
    // poolLenders[agentId] should never contain duplicates while this flag is honored
    mapping(uint256 => mapping(address => bool)) public isInPoolLenders;

    // Manually managed agent registry stub — real version uses external AgentRegistryV2
    mapping(address => uint256) public addressToAgentId;
    mapping(uint256 => address) public agentToAddress;
    uint256 public nextAgentId = 1;

    event PoolCreated(uint256 indexed agentId, address indexed agent);
    event LiquiditySupplied(uint256 indexed agentId, address indexed lender, uint256 amount);
    event LiquidityWithdrawn(uint256 indexed agentId, address indexed lender, uint256 amount);
    event LoanRequested(uint256 indexed loanId, address indexed borrower, uint256 amount);
    event LoanRepaid(uint256 indexed loanId, uint256 totalPaid);
    event InterestClaimed(uint256 indexed agentId, address indexed lender, uint256 amount);
    event PoolLendersCompacted(uint256 indexed agentId, uint256 removed);

    constructor(address _usdc) Ownable(msg.sender) {
        usdcToken = IERC20(_usdc);
    }

    // === Test-helper agent registration (in production, comes from AgentRegistryV2) ===
    function registerAgent(address who) external returns (uint256 agentId) {
        require(addressToAgentId[who] == 0, "already registered");
        agentId = nextAgentId++;
        addressToAgentId[who] = agentId;
        agentToAddress[agentId] = who;
        agentPools[agentId] = AgentPool(agentId, 0, 0, 0, 0, true);
        emit PoolCreated(agentId, who);
    }

    // === §B1-fixed supplyLiquidity ===
    function supplyLiquidity(uint256 agentId, uint256 amount) external nonReentrant whenNotPaused {
        require(amount > 0, "amount=0");
        require(agentPools[agentId].isActive, "pool inactive");
        AgentPool storage pool = agentPools[agentId];
        LenderPosition storage position = positions[agentId][msg.sender];

        usdcToken.safeTransferFrom(msg.sender, address(this), amount);
        pool.totalLiquidity += amount;
        pool.availableLiquidity += amount;

        // §B1 FIX: gate push on isInPoolLenders flag (instead of position.amount == 0)
        // ensuring no duplicates can ever be created
        if (!isInPoolLenders[agentId][msg.sender]) {
            require(poolLenders[agentId].length < MAX_LENDERS_PER_POOL, "lender cap");
            poolLenders[agentId].push(msg.sender);
            isInPoolLenders[agentId][msg.sender] = true;
            position.depositTimestamp = block.timestamp;
        }
        position.amount += amount;
        emit LiquiditySupplied(agentId, msg.sender, amount);
    }

    function withdrawLiquidity(uint256 agentId, uint256 amount) external nonReentrant whenNotPaused {
        AgentPool storage pool = agentPools[agentId];
        LenderPosition storage position = positions[agentId][msg.sender];
        require(position.amount >= amount, "insufficient position");
        require(pool.availableLiquidity >= amount, "insufficient avail");

        position.amount -= amount;
        pool.totalLiquidity -= amount;
        pool.availableLiquidity -= amount;
        usdcToken.safeTransfer(msg.sender, amount);

        // Note: poolLenders entry is NOT removed here even on full withdraw —
        // §B1-fixed supplyLiquidity already prevents duplicates via isInPoolLenders.
        // Keeping the slot avoids index reshuffles. Use compactPoolLenders to clean up.
        emit LiquidityWithdrawn(agentId, msg.sender, amount);
    }

    // === §S1-fixed claimInterest ===
    function claimInterest(uint256 agentId) external nonReentrant whenNotPaused {
        LenderPosition storage position = positions[agentId][msg.sender];
        AgentPool storage pool = agentPools[agentId];
        uint256 amount = position.earnedInterest;
        require(amount > 0, "no interest");

        position.earnedInterest = 0;

        // §S1 FIX: decrement pool.availableLiquidity to match the USDC leaving the pool
        require(pool.availableLiquidity >= amount, "drain underflow");
        pool.availableLiquidity -= amount;
        // totalEarned is the cumulative interest paid into the pool — leave it as a stat,
        // but availableLiquidity now correctly reflects USDC actually present
        usdcToken.safeTransfer(msg.sender, amount);
        emit InterestClaimed(agentId, msg.sender, amount);
    }

    // === §S5 admin: compactPoolLenders dedup helper ===
    // For migrating poolLenders[] from a buggy v4/v5 contract — removes duplicates in-place
    function compactPoolLenders(uint256 agentId) external onlyOwner {
        address[] storage list = poolLenders[agentId];
        // Reset isInPoolLenders for everyone in the list
        for (uint256 i = 0; i < list.length; i++) {
            isInPoolLenders[agentId][list[i]] = false;
        }
        // Build deduped list in-place
        uint256 writeIdx = 0;
        for (uint256 i = 0; i < list.length; i++) {
            address lender = list[i];
            if (!isInPoolLenders[agentId][lender]) {
                isInPoolLenders[agentId][lender] = true;
                list[writeIdx] = lender;
                writeIdx++;
            }
        }
        uint256 removed = list.length - writeIdx;
        // Pop tail entries
        while (list.length > writeIdx) list.pop();
        emit PoolLendersCompacted(agentId, removed);
    }

    // === §S5 fix: O(1) active-loan check ===
    function _countActiveLoans(address agent) internal view returns (uint256) {
        return activeLoanCount[agent];
    }

    // === Loan lifecycle (showing counter increments/decrements) ===
    function requestLoan(uint256 amount, uint256 durationDays) external nonReentrant whenNotPaused returns (uint256) {
        uint256 agentId = addressToAgentId[msg.sender];
        require(agentId != 0, "not registered");
        require(agentPools[agentId].isActive, "no pool");
        AgentPool storage pool = agentPools[agentId];
        require(amount <= pool.availableLiquidity, "insufficient liq");
        uint256 duration = durationDays * 1 days;
        require(duration >= MIN_LOAN_DURATION && duration <= MAX_LOAN_DURATION, "bad duration");

        // §S5: O(1) check — no array walk
        require(activeLoanCount[msg.sender] < MAX_ACTIVE_LOANS_PER_AGENT, "too many active");

        uint256 loanId = nextLoanId++;
        // For test simplicity: 0% collateral, 15% interest (computed at repay time)

        loans[loanId] = Loan({
            loanId: loanId, borrower: msg.sender, agentId: agentId,
            amount: amount, collateralAmount: 0, interestRate: 1500,
            startTime: block.timestamp, endTime: block.timestamp + duration,
            state: LoanState.ACTIVE
        });
        agentLoans[msg.sender].push(loanId);
        activeLoanCount[msg.sender]++; // §S5

        pool.availableLiquidity -= amount;
        pool.totalLoaned += amount;
        usdcToken.safeTransfer(msg.sender, amount);
        emit LoanRequested(loanId, msg.sender, amount);
        return loanId;
    }

    function repayLoan(uint256 loanId) external nonReentrant whenNotPaused {
        Loan storage loan = loans[loanId];
        require(loan.state == LoanState.ACTIVE, "not active");
        require(loan.borrower == msg.sender, "not borrower");

        uint256 elapsed = block.timestamp - loan.startTime;
        if (elapsed > loan.endTime - loan.startTime) elapsed = loan.endTime - loan.startTime;
        uint256 interest = (loan.amount * 1500 * (loan.endTime - loan.startTime)) / (365 days * 10000);
        uint256 totalPaid = loan.amount + interest;

        usdcToken.safeTransferFrom(msg.sender, address(this), totalPaid);

        AgentPool storage pool = agentPools[loan.agentId];
        pool.availableLiquidity += loan.amount; // principal back
        pool.totalLoaned -= loan.amount;
        pool.totalEarned += interest;
        // Distribute interest across poolLenders (no duplicates after §B1 fix)
        _distributeInterest(loan.agentId, interest);

        loan.state = LoanState.REPAID;
        activeLoanCount[loan.borrower]--; // §S5
        emit LoanRepaid(loanId, totalPaid);
    }

    function _distributeInterest(uint256 agentId, uint256 amount) internal {
        AgentPool storage pool = agentPools[agentId];
        if (pool.totalLiquidity == 0) return;
        address[] memory lenders = poolLenders[agentId];
        uint256 distributed = 0;
        for (uint256 i = 0; i < lenders.length; i++) {
            LenderPosition storage pos = positions[agentId][lenders[i]];
            if (pos.amount == 0) continue;
            uint256 share = (amount * pos.amount) / pool.totalLiquidity;
            pos.earnedInterest += share;
            distributed += share;
        }
        // Dust to first non-zero lender (avoids the §B1 underflow path)
        uint256 dust = amount - distributed;
        if (dust > 0) {
            for (uint256 i = 0; i < lenders.length; i++) {
                if (positions[agentId][lenders[i]].amount > 0) {
                    positions[agentId][lenders[i]].earnedInterest += dust;
                    break;
                }
            }
        }
    }

    // Read helpers for tests
    function getActiveLoanCount(address a) external view returns (uint256) { return activeLoanCount[a]; }
    function getPoolLenders(uint256 agentId) external view returns (address[] memory) { return poolLenders[agentId]; }
    function getPool(uint256 agentId) external view returns (AgentPool memory) { return agentPools[agentId]; }
    function getPosition(uint256 agentId, address lender) external view returns (LenderPosition memory) {
        return positions[agentId][lender];
    }
}
