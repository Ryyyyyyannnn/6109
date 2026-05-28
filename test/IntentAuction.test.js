"use strict";
/**
 * IntentAuction — Test Suite
 * ==========================
 * Covers the commit-reveal sealed-bid auction:
 *   • startAuction / phase transitions
 *   • commitBid  (registry-gated, no double commits)
 *   • revealBid  (commit binding, lowest fee wins, auto phase advance)
 *   • settle     (challenge window enforcement, recordSuccess on registry)
 *   • challenge  (EIP-712 sig + matching commit → slash + challenger reward)
 *   • admin (withdrawTreasury)
 *
 * Helpers:
 *   • mineBlocks(n) advances `n` blocks using hardhat_mine.
 *   • EIP-712 signing uses ethers v6 `signer.signTypedData`.
 */

const { expect } = require("chai");
const { ethers } = require("hardhat");

const MIN_STAKE  = ethers.parseEther("0.1");
const BIG_STAKE  = ethers.parseEther("1");           // ample buffer for repeated slashes
const ROUTE_HASH = ethers.id("route-plan-v1");
const INTENT_ID  = ethers.id("intent-#1");

const COMMIT_WINDOW    = 5;
const REVEAL_WINDOW    = 5;
const CHALLENGE_WINDOW = 20;

async function mineBlocks(n) {
  // hardhat_mine accepts a hex block count
  await ethers.provider.send("hardhat_mine", ["0x" + n.toString(16)]);
}

// Mine until block.number == targetBlock (no-op if already past it).
// Use this instead of mineBlocks(WINDOW_SIZE) when several txs in the same test
// have already consumed part of the window.
async function mineToBlock(target) {
  const cur = await ethers.provider.getBlockNumber();
  const need = Number(target) - cur;
  if (need > 0) await mineBlocks(need);
}

function commitHash(solver, fee, latency, route, nonce) {
  return ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
    ["address", "uint128", "uint64", "bytes32", "uint256"],
    [solver, fee, latency, route, nonce]
  ));
}

async function signBid(signer, domain, intentId, solver, fee, latency, route, nonce) {
  const types = {
    Bid: [
      { name: "intentId",        type: "bytes32" },
      { name: "solver",          type: "address" },
      { name: "quotedFeeGwei",   type: "uint128" },
      { name: "quotedLatencyMs", type: "uint64"  },
      { name: "routePlanHash",   type: "bytes32" },
      { name: "nonce",           type: "uint256" },
    ],
  };
  const value = {
    intentId,
    solver,
    quotedFeeGwei:   fee,
    quotedLatencyMs: latency,
    routePlanHash:   route,
    nonce,
  };
  return signer.signTypedData(domain, types, value);
}

describe("IntentAuction", function () {
  let registry, auction, domain;
  let owner, user, solverA, solverB, solverC, outsider;

  beforeEach(async () => {
    [owner, user, solverA, solverB, solverC, outsider] = await ethers.getSigners();

    // Deploy registry (treasury will be reset to the auction once it exists).
    registry = await (await ethers.getContractFactory("SolverRegistry"))
      .deploy(owner.address);
    await registry.waitForDeployment();

    auction = await (await ethers.getContractFactory("IntentAuction"))
      .deploy(await registry.getAddress());
    await auction.waitForDeployment();

    // Wire registry → auction so the auction can slash and slashed funds land in auction.
    await registry.connect(owner).setAuction(await auction.getAddress());
    await registry.connect(owner).setTreasury(await auction.getAddress());

    // Three live solvers with plenty of stake.
    await registry.connect(solverA).register({ value: BIG_STAKE });
    await registry.connect(solverB).register({ value: BIG_STAKE });
    await registry.connect(solverC).register({ value: BIG_STAKE });

    // EIP-712 domain for signing
    const chainId = (await ethers.provider.getNetwork()).chainId;
    domain = {
      name:              "IntentAuction",
      version:           "1",
      chainId,
      verifyingContract: await auction.getAddress(),
    };
  });

  // ── startAuction ────────────────────────────────────────────────────────────
  describe("startAuction", () => {
    it("opens the COMMIT phase and sets deadlines relative to current block", async () => {
      const tx = await auction.connect(user).startAuction(INTENT_ID);
      const receipt = await tx.wait();
      const a = await auction.getAuction(INTENT_ID);

      expect(a.phase).to.equal(1n); // COMMIT
      expect(a.user).to.equal(user.address);
      expect(a.commitDeadline).to.equal(BigInt(receipt.blockNumber + COMMIT_WINDOW));
      expect(a.revealDeadline).to.equal(BigInt(receipt.blockNumber + COMMIT_WINDOW + REVEAL_WINDOW));
      expect(a.challengeDeadline).to.equal(
        BigInt(receipt.blockNumber + COMMIT_WINDOW + REVEAL_WINDOW + CHALLENGE_WINDOW)
      );
    });

    it("emits AuctionStarted", async () => {
      await expect(auction.connect(user).startAuction(INTENT_ID))
        .to.emit(auction, "AuctionStarted");
    });

    it("rejects starting the same auction twice", async () => {
      await auction.connect(user).startAuction(INTENT_ID);
      await expect(
        auction.connect(user).startAuction(INTENT_ID)
      ).to.be.revertedWith("Auction exists");
    });
  });

  // ── commitBid ───────────────────────────────────────────────────────────────
  describe("commitBid", () => {
    beforeEach(async () => {
      await auction.connect(user).startAuction(INTENT_ID);
    });

    it("stores the commit hash and emits BidCommitted", async () => {
      const h = commitHash(solverA.address, 10n, 1000n, ROUTE_HASH, 42n);
      await expect(auction.connect(solverA).commitBid(INTENT_ID, h))
        .to.emit(auction, "BidCommitted")
        .withArgs(INTENT_ID, solverA.address, h);
      expect(await auction.commits(INTENT_ID, solverA.address)).to.equal(h);
    });

    it("rejects non-active solver", async () => {
      const h = commitHash(outsider.address, 10n, 1000n, ROUTE_HASH, 1n);
      await expect(
        auction.connect(outsider).commitBid(INTENT_ID, h)
      ).to.be.revertedWith("Solver inactive");
    });

    it("rejects double-commit by same solver", async () => {
      const h = commitHash(solverA.address, 10n, 1000n, ROUTE_HASH, 1n);
      await auction.connect(solverA).commitBid(INTENT_ID, h);
      await expect(
        auction.connect(solverA).commitBid(INTENT_ID, h)
      ).to.be.revertedWith("Already committed");
    });

    it("rejects empty commit", async () => {
      await expect(
        auction.connect(solverA).commitBid(INTENT_ID, ethers.ZeroHash)
      ).to.be.revertedWith("Empty commit");
    });

    it("rejects commit after window closes", async () => {
      await mineBlocks(COMMIT_WINDOW);
      const h = commitHash(solverA.address, 10n, 1000n, ROUTE_HASH, 1n);
      // First reveal call auto-advances phase; commit fails on phase check.
      await expect(
        auction.connect(solverA).commitBid(INTENT_ID, h)
      ).to.be.revertedWith("Commit window closed");
    });
  });

  // ── revealBid ───────────────────────────────────────────────────────────────
  describe("revealBid", () => {
    beforeEach(async () => {
      await auction.connect(user).startAuction(INTENT_ID);
    });

    it("reveals a valid commit and updates the leader", async () => {
      const fee = 7n, lat = 1200n, nonce = 99n;
      await auction.connect(solverA).commitBid(
        INTENT_ID,
        commitHash(solverA.address, fee, lat, ROUTE_HASH, nonce)
      );
      await mineBlocks(COMMIT_WINDOW);

      await expect(
        auction.connect(solverA).revealBid(INTENT_ID, fee, lat, ROUTE_HASH, nonce)
      ).to.emit(auction, "BidRevealed")
        .withArgs(INTENT_ID, solverA.address, fee, lat);

      const a = await auction.getAuction(INTENT_ID);
      expect(a.winner).to.equal(solverA.address);
      expect(a.winningFee).to.equal(fee);
    });

    it("lowest revealed fee wins across multiple solvers", async () => {
      const bids = [
        { signer: solverA, fee: 12n, lat: 900n,  nonce: 1n },
        { signer: solverB, fee:  8n, lat: 1100n, nonce: 2n },
        { signer: solverC, fee: 15n, lat: 700n,  nonce: 3n },
      ];
      for (const b of bids) {
        await auction.connect(b.signer).commitBid(
          INTENT_ID,
          commitHash(b.signer.address, b.fee, b.lat, ROUTE_HASH, b.nonce)
        );
      }
      const { commitDeadline } = await auction.getAuction(INTENT_ID);
      await mineToBlock(commitDeadline);
      for (const b of bids) {
        await auction.connect(b.signer).revealBid(INTENT_ID, b.fee, b.lat, ROUTE_HASH, b.nonce);
      }
      const a = await auction.getAuction(INTENT_ID);
      expect(a.winner).to.equal(solverB.address);
      expect(a.winningFee).to.equal(8n);
    });

    it("rejects mismatched bid (commit-binding)", async () => {
      await auction.connect(solverA).commitBid(
        INTENT_ID,
        commitHash(solverA.address, 10n, 1000n, ROUTE_HASH, 1n)
      );
      await mineBlocks(COMMIT_WINDOW);
      await expect(
        auction.connect(solverA).revealBid(INTENT_ID, 9n /* different fee */, 1000n, ROUTE_HASH, 1n)
      ).to.be.revertedWith("Commit mismatch");
    });

    it("rejects reveal without a prior commit", async () => {
      await mineBlocks(COMMIT_WINDOW);
      await expect(
        auction.connect(solverA).revealBid(INTENT_ID, 9n, 1000n, ROUTE_HASH, 1n)
      ).to.be.revertedWith("No commit");
    });

    it("rejects reveal before commit window closes", async () => {
      await auction.connect(solverA).commitBid(
        INTENT_ID,
        commitHash(solverA.address, 10n, 1000n, ROUTE_HASH, 1n)
      );
      // No mining → still in COMMIT phase, block.number < commitDeadline.
      await expect(
        auction.connect(solverA).revealBid(INTENT_ID, 10n, 1000n, ROUTE_HASH, 1n)
      ).to.be.revertedWith("Not reveal phase");
    });

    it("rejects reveal after reveal window closes", async () => {
      await auction.connect(solverA).commitBid(
        INTENT_ID,
        commitHash(solverA.address, 10n, 1000n, ROUTE_HASH, 1n)
      );
      await mineBlocks(COMMIT_WINDOW + REVEAL_WINDOW);
      await expect(
        auction.connect(solverA).revealBid(INTENT_ID, 10n, 1000n, ROUTE_HASH, 1n)
      ).to.be.revertedWith("Reveal window closed");
    });

    it("rejects double-reveal by same solver", async () => {
      await auction.connect(solverA).commitBid(
        INTENT_ID,
        commitHash(solverA.address, 10n, 1000n, ROUTE_HASH, 1n)
      );
      await mineBlocks(COMMIT_WINDOW);
      await auction.connect(solverA).revealBid(INTENT_ID, 10n, 1000n, ROUTE_HASH, 1n);
      await expect(
        auction.connect(solverA).revealBid(INTENT_ID, 10n, 1000n, ROUTE_HASH, 1n)
      ).to.be.revertedWith("Already revealed");
    });
  });

  // ── settle ─────────────────────────────────────────────────────────────────
  describe("settle", () => {
    beforeEach(async () => {
      await auction.connect(user).startAuction(INTENT_ID);
      await auction.connect(solverA).commitBid(
        INTENT_ID,
        commitHash(solverA.address, 10n, 1000n, ROUTE_HASH, 1n)
      );
      await mineBlocks(COMMIT_WINDOW);
      await auction.connect(solverA).revealBid(INTENT_ID, 10n, 1000n, ROUTE_HASH, 1n);
    });

    it("rejects settle while challenge window is open", async () => {
      await mineBlocks(REVEAL_WINDOW);
      await expect(
        auction.connect(user).settle(INTENT_ID)
      ).to.be.revertedWith("Challenge window open");
    });

    it("settles after the challenge window and increments solver successCount", async () => {
      await mineBlocks(REVEAL_WINDOW + CHALLENGE_WINDOW);

      await expect(auction.connect(user).settle(INTENT_ID))
        .to.emit(auction, "AuctionSettled")
        .withArgs(INTENT_ID, solverA.address, 10n);

      expect((await registry.getSolver(solverA.address)).successCount).to.equal(1n);
      expect((await auction.getAuction(INTENT_ID)).phase).to.equal(4n); // SETTLED
    });

    it("rejects double-settle", async () => {
      await mineBlocks(REVEAL_WINDOW + CHALLENGE_WINDOW);
      await auction.connect(user).settle(INTENT_ID);
      await expect(
        auction.connect(user).settle(INTENT_ID)
      ).to.be.revertedWith("Not in challenge phase");
    });
  });

  // ── challenge ──────────────────────────────────────────────────────────────
  describe("challenge", () => {
    // Scenario: SolverA commits a high fee (10), reveals.  SolverB committed a
    // lower fee (5) but never revealed (simulating censorship / DoS).  A third
    // party (outsider) submits the proof and earns the challenger reward.
    const HIGH_FEE  = 10n;
    const LOW_FEE   = 5n;
    const HIGH_NONCE = 1n;
    const LOW_NONCE  = 2n;

    async function setupChallengeScenario() {
      await auction.connect(user).startAuction(INTENT_ID);

      await auction.connect(solverA).commitBid(
        INTENT_ID, commitHash(solverA.address, HIGH_FEE, 1000n, ROUTE_HASH, HIGH_NONCE)
      );
      await auction.connect(solverB).commitBid(
        INTENT_ID, commitHash(solverB.address, LOW_FEE,  900n, ROUTE_HASH, LOW_NONCE)
      );

      await mineBlocks(COMMIT_WINDOW);

      // Only SolverA reveals — SolverB's reveal was suppressed.
      await auction.connect(solverA).revealBid(INTENT_ID, HIGH_FEE, 1000n, ROUTE_HASH, HIGH_NONCE);

      await mineBlocks(REVEAL_WINDOW);
      // Now in CHALLENGE phase.
    }

    it("slashes the previous winner, promotes the challenged bid, and pays the challenger", async () => {
      await setupChallengeScenario();

      const sig = await signBid(
        solverB, domain, INTENT_ID, solverB.address, LOW_FEE, 900n, ROUTE_HASH, LOW_NONCE
      );

      const treasuryBefore = await registry.stakeOf(solverA.address);

      await expect(auction.connect(outsider).challenge(
        INTENT_ID, solverB.address, LOW_FEE, 900n, ROUTE_HASH, LOW_NONCE, sig
      ))
        .to.emit(auction, "AuctionDisputed");

      const a = await auction.getAuction(INTENT_ID);
      expect(a.winner).to.equal(solverB.address);
      expect(a.winningFee).to.equal(LOW_FEE);
      expect(a.disputeCount).to.equal(1n);

      // SolverA's stake reduced by SLASH_AMOUNT (0.05 ETH).
      const stakeAfter = await registry.stakeOf(solverA.address);
      expect(treasuryBefore - stakeAfter).to.equal(ethers.parseEther("0.05"));
    });

    it("transfers the challenger 50% of the slashed amount", async () => {
      await setupChallengeScenario();

      const sig = await signBid(
        solverB, domain, INTENT_ID, solverB.address, LOW_FEE, 900n, ROUTE_HASH, LOW_NONCE
      );
      const expectedReward = ethers.parseEther("0.025"); // 50% of 0.05

      // changeEtherBalances handles gas fees automatically.
      await expect(
        auction.connect(outsider).challenge(
          INTENT_ID, solverB.address, LOW_FEE, 900n, ROUTE_HASH, LOW_NONCE, sig
        )
      ).to.changeEtherBalances(
        [outsider, auction],
        [expectedReward, ethers.parseEther("0.05") - expectedReward]
      );
    });

    it("rejects challenge when quoted fee is not strictly lower than current winner", async () => {
      await setupChallengeScenario();
      // SolverB had committed LOW_FEE, but the challenge asks with HIGH_FEE which is not better.
      const equalBid = HIGH_FEE;
      const sig = await signBid(
        solverB, domain, INTENT_ID, solverB.address, equalBid, 900n, ROUTE_HASH, LOW_NONCE
      );
      await expect(auction.connect(outsider).challenge(
        INTENT_ID, solverB.address, equalBid, 900n, ROUTE_HASH, LOW_NONCE, sig
      )).to.be.revertedWith("Not strictly better");
    });

    it("rejects challenge when challenger never committed (no on-chain commit hash)", async () => {
      await setupChallengeScenario();
      // SolverC never committed.
      const sig = await signBid(
        solverC, domain, INTENT_ID, solverC.address, 3n, 800n, ROUTE_HASH, 9n
      );
      await expect(auction.connect(outsider).challenge(
        INTENT_ID, solverC.address, 3n, 800n, ROUTE_HASH, 9n, sig
      )).to.be.revertedWith("Commit absent or mismatch");
    });

    it("rejects challenge with a forged signature (signer ≠ challengeSolver)", async () => {
      await setupChallengeScenario();
      // SolverC signs a bid attributed to SolverB.
      const sig = await signBid(
        solverC, domain, INTENT_ID, solverB.address, LOW_FEE, 900n, ROUTE_HASH, LOW_NONCE
      );
      await expect(auction.connect(outsider).challenge(
        INTENT_ID, solverB.address, LOW_FEE, 900n, ROUTE_HASH, LOW_NONCE, sig
      )).to.be.revertedWith("Invalid signature");
    });

    it("rejects challenge after the challenge window closes", async () => {
      await setupChallengeScenario();
      await mineBlocks(CHALLENGE_WINDOW);

      const sig = await signBid(
        solverB, domain, INTENT_ID, solverB.address, LOW_FEE, 900n, ROUTE_HASH, LOW_NONCE
      );
      await expect(auction.connect(outsider).challenge(
        INTENT_ID, solverB.address, LOW_FEE, 900n, ROUTE_HASH, LOW_NONCE, sig
      )).to.be.revertedWith("Challenge window closed");
    });

    it("rejects challenge using the current winner's own address", async () => {
      await setupChallengeScenario();
      // Cannot challenge yourself with your own (still better but disallowed) bid.
      const sig = await signBid(
        solverA, domain, INTENT_ID, solverA.address, 1n, 500n, ROUTE_HASH, 999n
      );
      await expect(auction.connect(solverA).challenge(
        INTENT_ID, solverA.address, 1n, 500n, ROUTE_HASH, 999n, sig
      )).to.be.revertedWith("Cannot challenge self");
    });
  });

  // ── Admin ──────────────────────────────────────────────────────────────────
  describe("Admin", () => {
    it("withdrawTreasury moves contract funds to the recipient (owner only)", async () => {
      // Seed the contract by completing one challenge.
      await auction.connect(user).startAuction(INTENT_ID);
      await auction.connect(solverA).commitBid(
        INTENT_ID, commitHash(solverA.address, 10n, 1000n, ROUTE_HASH, 1n)
      );
      await auction.connect(solverB).commitBid(
        INTENT_ID, commitHash(solverB.address, 5n, 900n, ROUTE_HASH, 2n)
      );
      await mineBlocks(COMMIT_WINDOW);
      await auction.connect(solverA).revealBid(INTENT_ID, 10n, 1000n, ROUTE_HASH, 1n);
      await mineBlocks(REVEAL_WINDOW);

      const sig = await signBid(
        solverB, domain, INTENT_ID, solverB.address, 5n, 900n, ROUTE_HASH, 2n
      );
      await auction.connect(outsider).challenge(
        INTENT_ID, solverB.address, 5n, 900n, ROUTE_HASH, 2n, sig
      );

      // 50% of 0.05 ETH retained in the auction → 0.025 ETH.
      const retained = ethers.parseEther("0.025");
      expect(await ethers.provider.getBalance(await auction.getAddress()))
        .to.equal(retained);

      await expect(
        auction.connect(owner).withdrawTreasury(owner.address, retained)
      ).to.changeEtherBalances(
        [owner, auction],
        [retained, -retained]
      );
    });

    it("withdrawTreasury reverts when called by a non-owner", async () => {
      await expect(
        auction.connect(outsider).withdrawTreasury(outsider.address, 1)
      ).to.be.revertedWith("Not owner");
    });
  });

  // ── Helpers exposed for clients ────────────────────────────────────────────
  describe("Helpers", () => {
    it("commitHashFor matches the off-chain encoding", async () => {
      const solidityHash = await auction.commitHashFor(
        solverA.address, 10n, 1000n, ROUTE_HASH, 7n
      );
      const jsHash = commitHash(solverA.address, 10n, 1000n, ROUTE_HASH, 7n);
      expect(solidityHash).to.equal(jsHash);
    });

    it("bidDigest reproduces the EIP-712 digest that wallets sign", async () => {
      // The digest itself is opaque; we verify that recovering against it
      // returns the expected signer.
      const fee = 4n, lat = 800n, nonce = 11n;
      const sig = await signBid(
        solverA, domain, INTENT_ID, solverA.address, fee, lat, ROUTE_HASH, nonce
      );
      const digest = await auction.bidDigest(
        INTENT_ID, solverA.address, fee, lat, ROUTE_HASH, nonce
      );
      expect(ethers.recoverAddress(digest, sig)).to.equal(solverA.address);
    });
  });
});
