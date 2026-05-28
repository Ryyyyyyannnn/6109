"use strict";
/**
 * SolverRegistry — Test Suite
 * ===========================
 * Covers the stake-based registry used by the Multi-Solver auction:
 *   • register / topUp
 *   • requestWithdraw → withdraw (with unbonding delay)
 *   • slash (auction-only, clamps, auto-deactivates below MIN_STAKE)
 *   • recordSuccess
 *   • admin (setAuction / setTreasury / setUnbondDelay)
 *   • views (isActive / stakeOf / getSolver / solverCount)
 */

const { expect }  = require("chai");
const { ethers }  = require("hardhat");

const MIN_STAKE = ethers.parseEther("0.1");
const REASON    = ethers.id("late-reveal");

async function advance(seconds) {
  await ethers.provider.send("evm_increaseTime", [seconds]);
  await ethers.provider.send("evm_mine", []);
}

describe("SolverRegistry", function () {
  let registry, owner, auction, treasury, solverA, solverB, outsider;

  beforeEach(async () => {
    [owner, auction, treasury, solverA, solverB, outsider] = await ethers.getSigners();
    registry = await (await ethers.getContractFactory("SolverRegistry"))
      .deploy(treasury.address);
    await registry.waitForDeployment();
    await registry.connect(owner).setAuction(auction.address);
  });

  // ── register ────────────────────────────────────────────────────────────────
  describe("register", () => {
    it("activates the solver and records stake at MIN_STAKE", async () => {
      await expect(registry.connect(solverA).register({ value: MIN_STAKE }))
        .to.emit(registry, "SolverRegistered")
        .withArgs(solverA.address, MIN_STAKE);

      expect(await registry.isActive(solverA.address)).to.equal(true);
      expect(await registry.stakeOf(solverA.address)).to.equal(MIN_STAKE);
    });

    it("reverts when stake is below MIN_STAKE", async () => {
      await expect(
        registry.connect(solverA).register({ value: MIN_STAKE - 1n })
      ).to.be.revertedWith("Insufficient stake");
    });

    it("reverts when re-registering while already active", async () => {
      await registry.connect(solverA).register({ value: MIN_STAKE });
      await expect(
        registry.connect(solverA).register({ value: MIN_STAKE })
      ).to.be.revertedWith("Already active");
    });

    it("appends the solver to solverList exactly once across re-registrations", async () => {
      await registry.connect(solverA).register({ value: MIN_STAKE });

      // unbond → withdraw → re-register
      await registry.connect(solverA).requestWithdraw();
      await advance(61);
      await registry.connect(solverA).withdraw();
      await registry.connect(solverA).register({ value: MIN_STAKE });

      expect(await registry.solverCount()).to.equal(1n);
    });

    it("re-registration after a partial slash combines residual stake with new value", async () => {
      // register with 0.2 ETH so a 0.15 ETH slash leaves 0.05 ETH (< MIN_STAKE → inactive)
      const initial = ethers.parseEther("0.2");
      const slashed = ethers.parseEther("0.15");

      await registry.connect(solverA).register({ value: initial });
      await registry.connect(auction).slash(solverA.address, slashed, REASON);
      expect(await registry.isActive(solverA.address)).to.equal(false);
      expect(await registry.stakeOf(solverA.address)).to.equal(initial - slashed);

      // top-up via register() works because !active
      await registry.connect(solverA).register({ value: MIN_STAKE });
      expect(await registry.isActive(solverA.address)).to.equal(true);
      expect(await registry.stakeOf(solverA.address))
        .to.equal(initial - slashed + MIN_STAKE);
    });
  });

  // ── topUp ───────────────────────────────────────────────────────────────────
  describe("topUp", () => {
    beforeEach(async () => {
      await registry.connect(solverA).register({ value: MIN_STAKE });
    });

    it("increases stake and emits StakeIncreased", async () => {
      const bonus = ethers.parseEther("0.05");
      await expect(registry.connect(solverA).topUp({ value: bonus }))
        .to.emit(registry, "StakeIncreased")
        .withArgs(solverA.address, MIN_STAKE + bonus);

      expect(await registry.stakeOf(solverA.address)).to.equal(MIN_STAKE + bonus);
    });

    it("reverts with zero value", async () => {
      await expect(
        registry.connect(solverA).topUp({ value: 0 })
      ).to.be.revertedWith("Zero value");
    });

    it("reverts when caller is not an active solver", async () => {
      await expect(
        registry.connect(solverB).topUp({ value: MIN_STAKE })
      ).to.be.revertedWith("Not active");
    });
  });

  // ── withdraw flow ───────────────────────────────────────────────────────────
  describe("requestWithdraw + withdraw", () => {
    beforeEach(async () => {
      await registry.connect(solverA).register({ value: MIN_STAKE });
    });

    it("requestWithdraw sets an availableAt timestamp ≥ now + unbondDelay", async () => {
      const tx      = await registry.connect(solverA).requestWithdraw();
      const receipt = await tx.wait();
      const evt     = receipt.logs.find(l => l.fragment?.name === "WithdrawRequested");
      const availableAt = evt.args[1];

      const block = await ethers.provider.getBlock(receipt.blockNumber);
      expect(availableAt).to.equal(BigInt(block.timestamp + 60));
    });

    it("withdraw before the unbonding window reverts", async () => {
      await registry.connect(solverA).requestWithdraw();
      await expect(
        registry.connect(solverA).withdraw()
      ).to.be.revertedWith("Unbonding");
    });

    it("withdraw without requestWithdraw reverts", async () => {
      await expect(
        registry.connect(solverA).withdraw()
      ).to.be.revertedWith("No withdraw requested");
    });

    it("withdraw after the window transfers stake and deactivates the solver", async () => {
      await registry.connect(solverA).requestWithdraw();
      await advance(61);

      // changeEtherBalances handles EIP-1559 effective gas price correctly.
      await expect(registry.connect(solverA).withdraw())
        .to.changeEtherBalances(
          [solverA, registry],
          [MIN_STAKE, -MIN_STAKE]
        );

      expect(await registry.isActive(solverA.address)).to.equal(false);
      expect(await registry.stakeOf(solverA.address)).to.equal(0n);
    });
  });

  // ── slash ──────────────────────────────────────────────────────────────────
  describe("slash", () => {
    beforeEach(async () => {
      await registry.connect(solverA).register({ value: ethers.parseEther("0.3") });
    });

    it("transfers the slashed amount to treasury and emits SolverSlashed", async () => {
      const amount  = ethers.parseEther("0.05");
      const before  = await ethers.provider.getBalance(treasury.address);

      await expect(registry.connect(auction).slash(solverA.address, amount, REASON))
        .to.emit(registry, "SolverSlashed")
        .withArgs(solverA.address, amount, REASON);

      const after = await ethers.provider.getBalance(treasury.address);
      expect(after - before).to.equal(amount);
      expect(await registry.stakeOf(solverA.address))
        .to.equal(ethers.parseEther("0.3") - amount);
    });

    it("clamps to current stake when amount exceeds it", async () => {
      const before  = await ethers.provider.getBalance(treasury.address);
      const stake   = await registry.stakeOf(solverA.address);

      await registry.connect(auction).slash(
        solverA.address, ethers.parseEther("999"), REASON
      );

      const after = await ethers.provider.getBalance(treasury.address);
      expect(after - before).to.equal(stake);
      expect(await registry.stakeOf(solverA.address)).to.equal(0n);
    });

    it("deactivates the solver when remaining stake falls below MIN_STAKE", async () => {
      // 0.3 ETH stake, slash 0.25 → 0.05 left → inactive
      await registry.connect(auction).slash(
        solverA.address, ethers.parseEther("0.25"), REASON
      );
      expect(await registry.isActive(solverA.address)).to.equal(false);
    });

    it("does NOT deactivate when remaining stake stays ≥ MIN_STAKE", async () => {
      // 0.3 ETH stake, slash 0.15 → 0.15 left → still active
      await registry.connect(auction).slash(
        solverA.address, ethers.parseEther("0.15"), REASON
      );
      expect(await registry.isActive(solverA.address)).to.equal(true);
    });

    it("increments slashCount", async () => {
      await registry.connect(auction).slash(solverA.address, 1, REASON);
      await registry.connect(auction).slash(solverA.address, 1, REASON);
      const info = await registry.getSolver(solverA.address);
      expect(info.slashCount).to.equal(2n);
    });

    it("reverts when called by an address other than auction", async () => {
      await expect(
        registry.connect(outsider).slash(solverA.address, 1, REASON)
      ).to.be.revertedWith("Not auction");
    });

    it("reverts when target solver is not active", async () => {
      await expect(
        registry.connect(auction).slash(solverB.address, 1, REASON)
      ).to.be.revertedWith("Solver not active");
    });
  });

  // ── recordSuccess ───────────────────────────────────────────────────────────
  describe("recordSuccess", () => {
    beforeEach(async () => {
      await registry.connect(solverA).register({ value: MIN_STAKE });
    });

    it("increments successCount and emits SuccessRecorded", async () => {
      await expect(registry.connect(auction).recordSuccess(solverA.address))
        .to.emit(registry, "SuccessRecorded")
        .withArgs(solverA.address, 1n);

      const info = await registry.getSolver(solverA.address);
      expect(info.successCount).to.equal(1n);
    });

    it("reverts when called by a non-auction address", async () => {
      await expect(
        registry.connect(outsider).recordSuccess(solverA.address)
      ).to.be.revertedWith("Not auction");
    });
  });

  // ── Admin ───────────────────────────────────────────────────────────────────
  describe("Admin", () => {
    it("setAuction can be called by owner and updates state", async () => {
      await expect(registry.connect(owner).setAuction(outsider.address))
        .to.emit(registry, "AuctionUpdated")
        .withArgs(outsider.address);
      expect(await registry.auction()).to.equal(outsider.address);
    });

    it("setAuction by non-owner reverts", async () => {
      await expect(
        registry.connect(outsider).setAuction(outsider.address)
      ).to.be.revertedWith("Not owner");
    });

    it("setTreasury updates state and emits", async () => {
      await expect(registry.connect(owner).setTreasury(outsider.address))
        .to.emit(registry, "TreasuryUpdated")
        .withArgs(outsider.address);
      expect(await registry.treasury()).to.equal(outsider.address);
    });

    it("setTreasury rejects zero address", async () => {
      await expect(
        registry.connect(owner).setTreasury(ethers.ZeroAddress)
      ).to.be.revertedWith("Zero address");
    });

    it("setTreasury rejects the registry itself", async () => {
      await expect(
        registry.connect(owner).setTreasury(await registry.getAddress())
      ).to.be.revertedWith("Treasury cannot be self");
    });

    it("setUnbondDelay updates the delay used by future requestWithdraw calls", async () => {
      await registry.connect(owner).setUnbondDelay(5);
      await registry.connect(solverA).register({ value: MIN_STAKE });
      await registry.connect(solverA).requestWithdraw();
      await advance(6);
      await registry.connect(solverA).withdraw();           // succeeds with shorter delay
      expect(await registry.isActive(solverA.address)).to.equal(false);
    });
  });

  // ── Views ──────────────────────────────────────────────────────────────────
  describe("Views", () => {
    it("solverCount and solverList reflect distinct registrants", async () => {
      await registry.connect(solverA).register({ value: MIN_STAKE });
      await registry.connect(solverB).register({ value: MIN_STAKE });
      expect(await registry.solverCount()).to.equal(2n);
      expect(await registry.solverList(0)).to.equal(solverA.address);
      expect(await registry.solverList(1)).to.equal(solverB.address);
    });

    it("getSolver returns full struct", async () => {
      await registry.connect(solverA).register({ value: MIN_STAKE });
      const info = await registry.getSolver(solverA.address);
      expect(info.stake).to.equal(MIN_STAKE);
      expect(info.active).to.equal(true);
      expect(info.successCount).to.equal(0n);
      expect(info.slashCount).to.equal(0n);
    });
  });
});
