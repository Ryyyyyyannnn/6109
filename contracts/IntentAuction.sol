// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA}  from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

import {SolverRegistry} from "./SolverRegistry.sol";

/**
 * @title IntentAuction
 * @notice Commit-reveal sealed-bid auction for intent execution rights.
 *
 * Lifecycle (per intent)
 * ----------------------
 *   1. startAuction(intentId)            — opens COMMIT window
 *   2. commitBid(intentId, commitHash)   — Solvers submit hash(bid + nonce)
 *   3. revealBid(intentId, ...)          — after commit window: reveal & lowest fee wins
 *   4. challenge(intentId, ...)          — anyone can prove a suppressed lower bid via
 *                                          EIP-712 signature + matching commit hash
 *   5. settle(intentId)                  — after challenge window: success counted
 *
 * Demo simplifications (vs. production)
 * -------------------------------------
 *   • First-price sealed bid (no Vickrey second-price).
 *   • Single auction per intent — `startAuction` is permissionless and idempotent
 *     guard is just `phase == NONE`.
 *   • Slashed funds: a CHALLENGER_REWARD_BPS share is paid to the challenger
 *     immediately; the remainder is held in this contract as protocol treasury
 *     and is owner-withdrawable.
 *
 * Trust model
 * -----------
 *   • A malicious Solver who suppresses a competing reveal can still be caught:
 *     the challenger presents (a) their own committed hash on-chain and (b) an
 *     EIP-712 signed bid whose hash matches that commitment with a strictly
 *     lower fee.  Both pieces together prove the bid existed.
 */
contract IntentAuction is EIP712 {
    using ECDSA for bytes32;

    // ─── Constants ────────────────────────────────────────────────────────────
    uint32  public constant COMMIT_WINDOW    = 5;   // blocks
    uint32  public constant REVEAL_WINDOW    = 5;
    uint32  public constant CHALLENGE_WINDOW = 20;
    uint128 public constant SLASH_AMOUNT     = 0.05 ether;
    uint16  public constant CHALLENGER_REWARD_BPS = 5000;  // 50%

    // EIP-712 typed-data hash for off-chain bid signing.
    bytes32 private constant BID_TYPEHASH = keccak256(
        "Bid(bytes32 intentId,address solver,uint128 quotedFeeGwei,uint64 quotedLatencyMs,bytes32 routePlanHash,uint256 nonce)"
    );

    // ─── Types ────────────────────────────────────────────────────────────────
    enum Phase { NONE, COMMIT, REVEAL, CHALLENGE, SETTLED }

    struct Auction {
        address user;
        uint64  commitDeadline;     // block number (exclusive)
        uint64  revealDeadline;
        uint64  challengeDeadline;
        address winner;
        uint128 winningFee;         // gwei
        uint64  winningLatency;     // ms
        bytes32 winningRoute;
        Phase   phase;
        uint16  disputeCount;       // diagnostic: times a challenge succeeded
    }

    // ─── State ────────────────────────────────────────────────────────────────
    SolverRegistry public immutable registry;
    address public owner;

    mapping(bytes32 => Auction) public auctions;
    mapping(bytes32 => mapping(address => bytes32)) public commits;     // intentId → solver → hash
    mapping(bytes32 => mapping(address => bool))    public revealed;    // intentId → solver → did reveal

    // ─── Events ───────────────────────────────────────────────────────────────
    event AuctionStarted (bytes32 indexed intentId, address indexed user, uint64 commitDeadline);
    event BidCommitted   (bytes32 indexed intentId, address indexed solver, bytes32 commitHash);
    event BidRevealed    (bytes32 indexed intentId, address indexed solver, uint128 fee, uint64 latency);
    event AuctionSettled (bytes32 indexed intentId, address indexed winner, uint128 fee);
    event AuctionDisputed(bytes32 indexed intentId, address indexed challenger, address indexed previousWinner, uint128 challengerReward);
    event TreasuryWithdrawn(address indexed to, uint256 amount);

    // ─── Modifiers ────────────────────────────────────────────────────────────
    modifier onlyOwner() { require(msg.sender == owner, "Not owner"); _; }

    // ─── Constructor ──────────────────────────────────────────────────────────
    constructor(address _registry) EIP712("IntentAuction", "1") {
        require(_registry != address(0), "Zero registry");
        registry = SolverRegistry(_registry);
        owner    = msg.sender;
    }

    /// @dev Accepts slashed funds forwarded from SolverRegistry (when treasury = this).
    receive() external payable {}

    // ─── Auction lifecycle ────────────────────────────────────────────────────

    function startAuction(bytes32 intentId) external {
        Auction storage a = auctions[intentId];
        require(a.phase == Phase.NONE, "Auction exists");

        uint64 cd = uint64(block.number) + COMMIT_WINDOW;
        uint64 rd = cd + REVEAL_WINDOW;
        uint64 ch = rd + CHALLENGE_WINDOW;

        a.user              = msg.sender;
        a.commitDeadline    = cd;
        a.revealDeadline    = rd;
        a.challengeDeadline = ch;
        a.phase             = Phase.COMMIT;

        emit AuctionStarted(intentId, msg.sender, cd);
    }

    function commitBid(bytes32 intentId, bytes32 commitHash) external {
        Auction storage a = auctions[intentId];
        require(a.phase == Phase.COMMIT,        "Not commit phase");
        require(block.number < a.commitDeadline, "Commit window closed");
        require(registry.isActive(msg.sender),   "Solver inactive");
        require(commits[intentId][msg.sender] == bytes32(0), "Already committed");
        require(commitHash != bytes32(0),        "Empty commit");

        commits[intentId][msg.sender] = commitHash;
        emit BidCommitted(intentId, msg.sender, commitHash);
    }

    function revealBid(
        bytes32 intentId,
        uint128 quotedFeeGwei,
        uint64  quotedLatencyMs,
        bytes32 routePlanHash,
        uint256 nonce
    ) external {
        Auction storage a = auctions[intentId];

        // Auto-advance phase if the commit window has closed.
        if (a.phase == Phase.COMMIT && block.number >= a.commitDeadline) {
            a.phase = Phase.REVEAL;
        }
        require(a.phase == Phase.REVEAL,        "Not reveal phase");
        require(block.number < a.revealDeadline, "Reveal window closed");
        require(!revealed[intentId][msg.sender], "Already revealed");

        bytes32 stored = commits[intentId][msg.sender];
        require(stored != bytes32(0),            "No commit");

        bytes32 actual = _commitHash(
            msg.sender, quotedFeeGwei, quotedLatencyMs, routePlanHash, nonce
        );
        require(actual == stored, "Commit mismatch");

        revealed[intentId][msg.sender] = true;

        // First-price: the lowest revealed fee wins.
        if (a.winner == address(0) || quotedFeeGwei < a.winningFee) {
            a.winner          = msg.sender;
            a.winningFee      = quotedFeeGwei;
            a.winningLatency  = quotedLatencyMs;
            a.winningRoute    = routePlanHash;
        }

        emit BidRevealed(intentId, msg.sender, quotedFeeGwei, quotedLatencyMs);
    }

    /**
     * @notice Prove that a strictly-better bid existed and was suppressed.
     * @dev    The challenger must show:
     *           (a) `challengeSolver`'s commit is recorded on-chain (commit window
     *               was respected), AND
     *           (b) an EIP-712 signature by `challengeSolver` over the same bid
     *               values whose hash equals that commit, AND
     *           (c) the bid's fee is strictly lower than the current winningFee.
     *
     *         On success, the previous winner is slashed; the challenger
     *         (msg.sender, who paid the gas to surface the proof) receives a
     *         protocol reward; the better bid is promoted to winner.
     */
    function challenge(
        bytes32 intentId,
        address challengeSolver,
        uint128 quotedFeeGwei,
        uint64  quotedLatencyMs,
        bytes32 routePlanHash,
        uint256 nonce,
        bytes calldata signature
    ) external {
        Auction storage a = auctions[intentId];

        if (a.phase == Phase.REVEAL && block.number >= a.revealDeadline) {
            a.phase = Phase.CHALLENGE;
        }
        require(a.phase == Phase.CHALLENGE,         "Not challenge phase");
        require(block.number < a.challengeDeadline, "Challenge window closed");
        require(a.winner != address(0),             "No winner to challenge");
        require(challengeSolver != a.winner,        "Cannot challenge self");
        require(quotedFeeGwei < a.winningFee,       "Not strictly better");

        // (a) commit must match the challenged bid
        bytes32 expectedCommit = _commitHash(
            challengeSolver, quotedFeeGwei, quotedLatencyMs, routePlanHash, nonce
        );
        require(
            commits[intentId][challengeSolver] == expectedCommit,
            "Commit absent or mismatch"
        );

        // (b) EIP-712 signature must recover to challengeSolver
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(
            BID_TYPEHASH, intentId, challengeSolver,
            quotedFeeGwei, quotedLatencyMs, routePlanHash, nonce
        )));
        require(ECDSA.recover(digest, signature) == challengeSolver, "Invalid signature");

        // Effects
        address previousWinner = a.winner;
        a.winner          = challengeSolver;
        a.winningFee      = quotedFeeGwei;
        a.winningLatency  = quotedLatencyMs;
        a.winningRoute    = routePlanHash;
        a.disputeCount   += 1;

        // Interaction: slash → registry forwards SLASH_AMOUNT to this contract
        // (caller sets `treasury = this` on SolverRegistry).  Then we pay the
        // challenger their reward share.
        uint256 balanceBefore = address(this).balance;
        registry.slash(previousWinner, SLASH_AMOUNT, keccak256("suppressed-better-bid"));
        uint256 received = address(this).balance - balanceBefore;

        uint256 reward = (received * CHALLENGER_REWARD_BPS) / 10_000;
        if (reward > 0) {
            (bool ok, ) = msg.sender.call{value: reward}("");
            require(ok, "Reward transfer failed");
        }

        emit AuctionDisputed(intentId, msg.sender, previousWinner, uint128(reward));
    }

    function settle(bytes32 intentId) external {
        Auction storage a = auctions[intentId];

        // Auto-advance from REVEAL → CHALLENGE if reveal window closed.
        if (a.phase == Phase.REVEAL && block.number >= a.revealDeadline) {
            a.phase = Phase.CHALLENGE;
        }
        require(a.phase == Phase.CHALLENGE,            "Not in challenge phase");
        require(block.number >= a.challengeDeadline,   "Challenge window open");
        require(a.winner != address(0),                "No winner");

        a.phase = Phase.SETTLED;
        registry.recordSuccess(a.winner);
        emit AuctionSettled(intentId, a.winner, a.winningFee);
    }

    // ─── Admin ────────────────────────────────────────────────────────────────

    /// @notice Withdraw the non-rewarded share of slashed funds held in the contract.
    function withdrawTreasury(address payable to, uint256 amount) external onlyOwner {
        require(to != address(0), "Zero address");
        require(amount <= address(this).balance, "Insufficient balance");
        (bool ok, ) = to.call{value: amount}("");
        require(ok, "Transfer failed");
        emit TreasuryWithdrawn(to, amount);
    }

    // ─── Views / pure helpers ─────────────────────────────────────────────────

    function getAuction(bytes32 intentId) external view returns (Auction memory) {
        return auctions[intentId];
    }

    /// @notice Compute the commit hash the same way the contract does. Useful for clients.
    function commitHashFor(
        address solver,
        uint128 quotedFeeGwei,
        uint64  quotedLatencyMs,
        bytes32 routePlanHash,
        uint256 nonce
    ) external pure returns (bytes32) {
        return _commitHash(solver, quotedFeeGwei, quotedLatencyMs, routePlanHash, nonce);
    }

    /// @notice Compute the EIP-712 digest a Solver should sign for a bid. Useful for clients.
    function bidDigest(
        bytes32 intentId,
        address solver,
        uint128 quotedFeeGwei,
        uint64  quotedLatencyMs,
        bytes32 routePlanHash,
        uint256 nonce
    ) external view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(
            BID_TYPEHASH, intentId, solver,
            quotedFeeGwei, quotedLatencyMs, routePlanHash, nonce
        )));
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    // ─── Internal ─────────────────────────────────────────────────────────────

    function _commitHash(
        address solver,
        uint128 quotedFeeGwei,
        uint64  quotedLatencyMs,
        bytes32 routePlanHash,
        uint256 nonce
    ) internal pure returns (bytes32) {
        return keccak256(abi.encode(
            solver, quotedFeeGwei, quotedLatencyMs, routePlanHash, nonce
        ));
    }
}
