// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title MockRollup
 * @notice Simulates an L2 rollup execution environment.
 *
 * Each deployed instance represents a distinct rollup with its own base fee,
 * base confirmation latency, and congestion level.  The router off-chain
 * component reads `getCurrentFee()` and `getCurrentLatency()` to score routes.
 *
 * Fee model:   fee = baseFeeGwei × (1 + (congestion/100)²)
 * Latency model: latency = baseLatencyMs × (1 + congestion/100)
 *
 * These non-linear models reflect real-world EIP-1559 behaviour: fees spike
 * faster than latency during congestion surges.
 */
contract MockRollup {
    // ─── Types ────────────────────────────────────────────────────────────────
    enum IntentType { PAYMENT, TOKEN_SWAP, ASSET_TRANSFER }

    struct ExecutedIntent {
        bytes32   intentId;
        address   user;
        IntentType intentType;
        uint256   amount;
        uint256   feeCharged;   // gwei (scaled ×1e9)
        uint256   latencyMs;
        uint256   executedAt;
    }

    // ─── State ────────────────────────────────────────────────────────────────
    // Fee unit: integer tenths-of-a-gwei (×10).
    // e.g. ArbiNova baseFeeGwei = 5  → 0.5 gwei gas price.
    // Solidity has no float; the off-chain router converts with / FEE_SCALE.
    uint256 public constant FEE_SCALE = 10;

    string  public rollupName;
    string  public rollupType;       // "optimistic" | "zk"
    uint256 public baseFeeGwei;      // base gas price, units of 0.1 gwei (÷ FEE_SCALE for real gwei)
    uint256 public baseLatencyMs;    // soft-confirmation latency in ms (NOT L1 finality)
    uint256 public congestionLevel;  // 0–100

    uint256 public totalExecuted;
    uint256 public totalFeesGwei;

    mapping(bytes32 => ExecutedIntent) public executions;
    mapping(bytes32 => bool)           public alreadyExecuted;

    address public owner;
    address public router;

    // ─── Events ───────────────────────────────────────────────────────────────
    event IntentExecuted(
        bytes32 indexed intentId,
        address indexed user,
        uint256 feeGwei,
        uint256 latencyMs
    );
    event CongestionUpdated(uint256 from, uint256 to);

    // ─── Constructor ──────────────────────────────────────────────────────────
    constructor(
        string memory _name,
        string memory _type,
        uint256 _baseFeeGwei,
        uint256 _baseLatencyMs,
        uint256 _initialCongestion
    ) {
        rollupName        = _name;
        rollupType        = _type;
        baseFeeGwei       = _baseFeeGwei;
        baseLatencyMs     = _baseLatencyMs;
        congestionLevel   = _initialCongestion;
        owner             = msg.sender;
        router            = msg.sender;
    }

    // ─── Core execution ───────────────────────────────────────────────────────

    /**
     * @notice Record the execution of a routed intent on this rollup.
     * @return feeGwei    actual fee charged (gwei)
     * @return latencyMs  simulated confirmation latency (ms)
     */
    function executeIntent(
        bytes32   intentId,
        address   user,
        uint8     intentType,
        uint256   amount
    ) external returns (uint256 feeGwei, uint256 latencyMs) {
        require(msg.sender == router || msg.sender == owner, "Not authorised");
        require(!alreadyExecuted[intentId],  "Already executed");
        require(intentType <= 2,             "Invalid intent type");

        feeGwei   = getCurrentFee();
        latencyMs = getCurrentLatency();

        executions[intentId] = ExecutedIntent({
            intentId:   intentId,
            user:       user,
            intentType: IntentType(intentType),
            amount:     amount,
            feeCharged: feeGwei,
            latencyMs:  latencyMs,
            executedAt: block.timestamp
        });
        alreadyExecuted[intentId] = true;
        totalExecuted++;
        totalFeesGwei += feeGwei;

        emit IntentExecuted(intentId, user, feeGwei, latencyMs);
    }

    // ─── View helpers ─────────────────────────────────────────────────────────

    /// @notice Dynamic fee — returned in same tenths-of-gwei unit as baseFeeGwei (÷ FEE_SCALE for real gwei)
    function getCurrentFee() public view returns (uint256) {
        // fee = baseFee × (1 + (congestion/100)²)
        uint256 congSq = congestionLevel * congestionLevel;
        return baseFeeGwei * (10000 + congSq) / 10000;
    }

    /// @notice Dynamic latency based on current congestion (ms)
    function getCurrentLatency() public view returns (uint256) {
        return baseLatencyMs * (100 + congestionLevel) / 100;
    }

    /// @notice Estimated success probability (basis points, 10000 = 100%)
    /// ZK rollups: validity proofs protect correctness; sequencer liveness modelled
    ///   as congestion-independent at 99% (simulation assumption — not empirical).
    /// Optimistic rollups: high congestion increases nonce races / drops; floor 70%.
    function getSuccessProbabilityBps() public view returns (uint256) {
        if (keccak256(abi.encodePacked(rollupType)) == keccak256(abi.encodePacked("zk"))) {
            return 9900;
        }
        uint256 penalty = congestionLevel * 30;  // up to 3000 bps at 100% congestion
        return penalty >= 3000 ? 7000 : 10000 - penalty;
    }

    function getStats() external view returns (
        uint256 fee,
        uint256 latency,
        uint256 congestion,
        uint256 successBps,
        uint256 execCount
    ) {
        return (
            getCurrentFee(),
            getCurrentLatency(),
            congestionLevel,
            getSuccessProbabilityBps(),
            totalExecuted
        );
    }

    // ─── Admin ────────────────────────────────────────────────────────────────

    function updateCongestion(uint256 newLevel) external {
        require(msg.sender == owner || msg.sender == router, "Not authorised");
        require(newLevel <= 100, "Max 100");
        emit CongestionUpdated(congestionLevel, newLevel);
        congestionLevel = newLevel;
    }

    function setRouter(address newRouter) external {
        require(msg.sender == owner, "Not owner");
        router = newRouter;
    }
}
