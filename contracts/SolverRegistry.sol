// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title SolverRegistry
 * @notice Stake-based registry for the Multi-Solver auction market.
 *
 * Trust model
 * -----------
 * Each Solver locks a stake to participate in bidding.  The auction contract
 * (set by the owner) is the only address authorised to slash that stake.  This
 * creates an economic disincentive for a Solver to under-quote, censor a
 * better quote, or fail to execute a winning bid.
 *
 * Lifecycle
 * ---------
 *   register()         — deposit ≥ MIN_STAKE, become active
 *   topUp()            — add more stake while active
 *   requestWithdraw()  — start the unbonding window
 *   withdraw()         — after the window, pull funds out, become inactive
 *   slash()            — auction-only; deducts stake and routes to treasury
 *
 * Storage layout
 * --------------
 *   Slot 0: stake(128) + registeredAt(64) + successCount(32) + slashCount(32) = 256 bits
 *   Slot 1: active(8)  + withdrawAvailableAt(64)                              = 72  bits
 *
 * Demo simplifications
 * --------------------
 *   • `unbondDelay` defaults to 60 seconds (real systems use days).
 *   • Slashed funds are sent to a `treasury` address — no DAO, no challenger
 *     reward split is computed here; the auction contract decides who gets
 *     what by composing slash() with a separate payout.
 */
contract SolverRegistry {
    // ─── Types ────────────────────────────────────────────────────────────────
    struct Solver {
        uint128 stake;
        uint64  registeredAt;
        uint32  successCount;
        uint32  slashCount;
        bool    active;
        uint64  withdrawAvailableAt; // 0 = no pending withdraw
    }

    // ─── State ────────────────────────────────────────────────────────────────
    mapping(address => Solver) private _solvers;
    address[] public solverList;
    mapping(address => bool) private _seen;

    address public owner;
    address public auction;   // authorised to slash / record success
    address public treasury;  // receives slashed stake

    uint128 public constant MIN_STAKE = 0.1 ether;
    uint64  public unbondDelay = 60; // seconds — demo-friendly default

    // ─── Events ───────────────────────────────────────────────────────────────
    event SolverRegistered(address indexed solver, uint128 stake);
    event StakeIncreased(address indexed solver, uint128 newStake);
    event WithdrawRequested(address indexed solver, uint64 availableAt);
    event Withdrawn(address indexed solver, uint128 amount);
    event SolverSlashed(address indexed solver, uint128 amount, bytes32 indexed reason);
    event SuccessRecorded(address indexed solver, uint32 newCount);
    event AuctionUpdated(address indexed newAuction);
    event TreasuryUpdated(address indexed newTreasury);
    event UnbondDelayUpdated(uint64 newDelay);

    // ─── Modifiers ────────────────────────────────────────────────────────────
    modifier onlyOwner()   { require(msg.sender == owner,   "Not owner");   _; }
    modifier onlyAuction() { require(msg.sender == auction, "Not auction"); _; }

    // ─── Constructor ──────────────────────────────────────────────────────────
    constructor(address _treasury) {
        owner    = msg.sender;
        treasury = _treasury == address(0) ? msg.sender : _treasury;
    }

    // ─── Solver lifecycle ─────────────────────────────────────────────────────

    function register() external payable {
        Solver storage s = _solvers[msg.sender];
        require(!s.active, "Already active");
        require(msg.value + s.stake >= MIN_STAKE, "Insufficient stake");

        s.stake               += uint128(msg.value);
        s.active               = true;
        s.withdrawAvailableAt  = 0;
        if (s.registeredAt == 0) {
            s.registeredAt = uint64(block.timestamp);
        }

        if (!_seen[msg.sender]) {
            _seen[msg.sender] = true;
            solverList.push(msg.sender);
        }

        emit SolverRegistered(msg.sender, s.stake);
    }

    function topUp() external payable {
        Solver storage s = _solvers[msg.sender];
        require(s.active, "Not active");
        require(msg.value > 0, "Zero value");
        s.stake += uint128(msg.value);
        emit StakeIncreased(msg.sender, s.stake);
    }

    function requestWithdraw() external {
        Solver storage s = _solvers[msg.sender];
        require(s.active, "Not active");
        uint64 availableAt = uint64(block.timestamp) + unbondDelay;
        s.withdrawAvailableAt = availableAt;
        emit WithdrawRequested(msg.sender, availableAt);
    }

    function withdraw() external {
        Solver storage s = _solvers[msg.sender];
        require(s.active, "Not active");
        require(s.withdrawAvailableAt != 0,                  "No withdraw requested");
        require(block.timestamp >= s.withdrawAvailableAt,    "Unbonding");

        uint128 amount = s.stake;
        s.stake               = 0;
        s.active              = false;
        s.withdrawAvailableAt = 0;

        (bool ok, ) = msg.sender.call{value: amount}("");
        require(ok, "Transfer failed");
        emit Withdrawn(msg.sender, amount);
    }

    // ─── Auction-only hooks ───────────────────────────────────────────────────

    /// @notice Deduct `amount` from `solver`'s stake; auto-deactivate below MIN_STAKE.
    /// @dev    Clamps to the solver's current stake; routes funds to treasury.
    function slash(address solver, uint128 amount, bytes32 reason) external onlyAuction {
        Solver storage s = _solvers[solver];
        require(s.active, "Solver not active");

        uint128 actual = amount > s.stake ? s.stake : amount;
        s.stake     -= actual;
        s.slashCount = s.slashCount + 1;

        if (s.stake < MIN_STAKE) {
            s.active = false;
        }

        (bool ok, ) = treasury.call{value: actual}("");
        require(ok, "Transfer failed");
        emit SolverSlashed(solver, actual, reason);
    }

    /// @notice Increment a solver's success count after a winning bid is settled.
    function recordSuccess(address solver) external onlyAuction {
        Solver storage s = _solvers[solver];
        s.successCount = s.successCount + 1;
        emit SuccessRecorded(solver, s.successCount);
    }

    // ─── Admin ────────────────────────────────────────────────────────────────

    function setAuction(address _auction) external onlyOwner {
        auction = _auction;
        emit AuctionUpdated(_auction);
    }

    function setTreasury(address _treasury) external onlyOwner {
        require(_treasury != address(0),    "Zero address");
        require(_treasury != address(this), "Treasury cannot be self");
        treasury = _treasury;
        emit TreasuryUpdated(_treasury);
    }

    function setUnbondDelay(uint64 _delay) external onlyOwner {
        unbondDelay = _delay;
        emit UnbondDelayUpdated(_delay);
    }

    // ─── Views ────────────────────────────────────────────────────────────────

    function isActive(address solver) external view returns (bool) {
        return _solvers[solver].active;
    }

    function stakeOf(address solver) external view returns (uint128) {
        return _solvers[solver].stake;
    }

    function getSolver(address solver) external view returns (Solver memory) {
        return _solvers[solver];
    }

    function solverCount() external view returns (uint256) {
        return solverList.length;
    }
}
