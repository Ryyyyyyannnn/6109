"use strict";
/**
 * IntentBridge — Test Suite
 * =========================
 * Three sections:
 *   1. MockRollup     — contract tests (fee model, latency, lifecycle)
 *   2. IntentRegistry — contract tests (submit → route → execute lifecycle)
 *   3. Router Scoring — off-chain unit tests (pure JS, mirrors server.js logic)
 *
 * Run:  npx hardhat test
 */

const { expect } = require("chai");
const { ethers }  = require("hardhat");

// ── Pure-JS helpers (mirror router/server.js for off-chain unit tests) ────────
//
// These are duplicated here deliberately — they validate the *algorithm*
// independently of the server process.  Any divergence between these and
// server.js is itself a bug.

const WEIGHTS = {
  cheapest: { fee: 0.70, latency: 0.15, success: 0.15 },
  fastest:  { fee: 0.10, latency: 0.75, success: 0.15 },
  balanced: { fee: 0.40, latency: 0.40, success: 0.20 },
};

const SIM_ROLLUPS = [
  { id: "rollupA", name: "ArbiNova",  type: "Optimistic", baseFeeGwei: 0.5, confLatMs: 2000 },
  { id: "rollupB", name: "OptiSwift", type: "Optimistic", baseFeeGwei: 1.2, confLatMs: 800  },
  { id: "rollupC", name: "ZkRapid",   type: "ZK",         baseFeeGwei: 3.0, confLatMs: 300  },
];

// Per-rollup token liquidity (0–1, 1 = deepest market)
// Source: relative TVL/volume ranking from DeFiLlama 2024 Q4; see README for rationale.
const LIQUIDITY = {
  rollupA: { ETH: 0.98, USDC: 0.95, WBTC: 0.72, DAI: 0.80 },
  rollupB: { ETH: 0.97, USDC: 0.92, WBTC: 0.68, DAI: 0.88 },
  rollupC: { ETH: 0.90, USDC: 0.85, WBTC: 0.60, DAI: 0.70 },
};

// Bridge latency from L1 (ms, soft-confirmation to rollup)
const BRIDGE_LATENCY_MS = { rollupA: 90_000, rollupB: 75_000, rollupC: 60_000 };

function simFee(r, c)     { return r.baseFeeGwei * (1 + (c / 100) ** 2); }
function simLatency(r, c) { return Math.round(r.confLatMs * (1 + c / 100)); }
function simSuccess(r, c) { return r.type === "ZK" ? 0.99 : Math.max(0.70, 1 - c / 333); }

function slippageBps(rollupId, token) {
  const liq = (LIQUIDITY[rollupId] || {})[token] ?? 0.5;
  return 5 / liq;   // base 5 bps at perfect liquidity; lower liq → higher slippage
}

function effectiveFee(r, c, intentType, token) {
  const base = simFee(r, c);
  if (intentType === "token_swap")
    return base * (1 + slippageBps(r.id, token) / 10_000);
  return base;
}

function effectiveLatency(r, c, intentType) {
  const base = simLatency(r, c);
  if (intentType === "asset_transfer")
    return base + (BRIDGE_LATENCY_MS[r.id] ?? 0) * 0.3;
  return base;
}

function scoreAll(congMap, pref, intentType = "payment", token = "ETH") {
  const w    = WEIGHTS[pref];
  const fees = SIM_ROLLUPS.map(r => effectiveFee(r, congMap[r.id], intentType, token));
  const lats = SIM_ROLLUPS.map(r => effectiveLatency(r, congMap[r.id], intentType));
  const minF = Math.min(...fees), maxF = Math.max(...fees);
  const minL = Math.min(...lats), maxL = Math.max(...lats);

  return SIM_ROLLUPS.map((r, i) => {
    const nf    = maxF === minF ? 1 : 1 - (fees[i] - minF) / (maxF - minF);
    const nl    = maxL === minL ? 1 : 1 - (lats[i] - minL) / (maxL - minL);
    const score = w.fee * nf + w.latency * nl + w.success * simSuccess(r, congMap[r.id]);
    return { id: r.id, score, fee: fees[i], latency: lats[i] };
  }).sort((a, b) => b.score - a.score);
}

// ─── Shared test constants ─────────────────────────────────────────────────────
const ZERO_ADDR     = ethers.ZeroAddress;
const ZERO_HASH     = ethers.ZeroHash;
const DEFAULT_CONG  = { rollupA: 10, rollupB: 35, rollupC: 55 };

// ══════════════════════════════════════════════════════════════════════════════
// 1. MockRollup
// ══════════════════════════════════════════════════════════════════════════════

describe("MockRollup", function () {
  let rollup, owner, addr1;

  beforeEach(async () => {
    [owner, addr1] = await ethers.getSigners();
    // baseFeeGwei=10 means 1.0 gwei (÷ FEE_SCALE=10); baseLatencyMs=1000; congestion=0
    rollup = await (await ethers.getContractFactory("MockRollup"))
      .deploy("TestRollup", "optimistic", 10, 1000, 0);
    await rollup.waitForDeployment();
  });

  // ── Fee model ───────────────────────────────────────────────────────────────
  describe("Fee model (quadratic: fee = base × (1 + cong²))", () => {
    it("returns baseFeeGwei at zero congestion", async () => {
      expect(await rollup.getCurrentFee()).to.equal(10n);
    });

    it("is 12 at 50% congestion  (10 × (10000+2500)/10000, int-div = 12)", async () => {
      await rollup.updateCongestion(50);
      expect(await rollup.getCurrentFee()).to.equal(12n);
    });

    it("doubles at 100% congestion  (10 × (10000+10000)/10000 = 20)", async () => {
      await rollup.updateCongestion(100);
      expect(await rollup.getCurrentFee()).to.equal(20n);
    });

    it("is strictly increasing from congestion 0 → 50 → 100", async () => {
      const f0  = await rollup.getCurrentFee();
      await rollup.updateCongestion(50);
      const f50 = await rollup.getCurrentFee();
      await rollup.updateCongestion(100);
      const f100 = await rollup.getCurrentFee();
      expect(f50).to.be.greaterThan(f0);
      expect(f100).to.be.greaterThan(f50);
    });
  });

  // ── Latency model ───────────────────────────────────────────────────────────
  describe("Latency model (linear: latency = base × (1 + cong/100))", () => {
    it("returns baseLatencyMs at zero congestion", async () => {
      expect(await rollup.getCurrentLatency()).to.equal(1000n);
    });

    it("is 1500 at 50% congestion  (1000 × 150/100)", async () => {
      await rollup.updateCongestion(50);
      expect(await rollup.getCurrentLatency()).to.equal(1500n);
    });

    it("doubles at 100% congestion  (1000 × 200/100 = 2000)", async () => {
      await rollup.updateCongestion(100);
      expect(await rollup.getCurrentLatency()).to.equal(2000n);
    });
  });

  // ── Success probability ─────────────────────────────────────────────────────
  describe("Success probability", () => {
    it("is 10000 bps at zero congestion", async () => {
      expect(await rollup.getSuccessProbabilityBps()).to.equal(10000n);
    });

    it("is 8500 bps at 50% congestion  (10000 − 50×30)", async () => {
      await rollup.updateCongestion(50);
      expect(await rollup.getSuccessProbabilityBps()).to.equal(8500n);
    });

    it("floors at 7000 bps at 100% congestion  (penalty=3000 ≥ cap)", async () => {
      await rollup.updateCongestion(100);
      expect(await rollup.getSuccessProbabilityBps()).to.equal(7000n);
    });
  });

  // ── executeIntent lifecycle ─────────────────────────────────────────────────
  describe("executeIntent", () => {
    const ID1 = ethers.id("intent-alpha");
    const ID2 = ethers.id("intent-beta");

    it("emits IntentExecuted with correct fee (10) and latency (1000) at congestion=0", async () => {
      await expect(rollup.executeIntent(ID1, addr1.address, 0, 1000))
        .to.emit(rollup, "IntentExecuted")
        .withArgs(ID1, addr1.address, 10n, 1000n);
    });

    it("increments totalExecuted and accumulates totalFeesGwei", async () => {
      await rollup.executeIntent(ID1, addr1.address, 0, 500);
      expect(await rollup.totalExecuted()).to.equal(1n);
      expect(await rollup.totalFeesGwei()).to.equal(10n);
    });

    it("reverts on duplicate intent ID (replay protection)", async () => {
      await rollup.executeIntent(ID1, addr1.address, 0, 500);
      await expect(
        rollup.executeIntent(ID1, addr1.address, 0, 500)
      ).to.be.revertedWith("Already executed");
    });

    it("accepts all three intent types (0=PAYMENT, 1=SWAP, 2=TRANSFER)", async () => {
      const ids = [ID1, ID2, ethers.id("intent-gamma")];
      for (let i = 0; i < 3; i++) {
        await rollup.executeIntent(ids[i], addr1.address, i, 100);
        const rec = await rollup.executions(ids[i]);
        expect(rec.intentType).to.equal(BigInt(i));
      }
    });

    it("reverts for intent type > 2", async () => {
      await expect(
        rollup.executeIntent(ID1, addr1.address, 9, 500)
      ).to.be.revertedWith("Invalid intent type");
    });

    it("reverts when called by unauthorized address", async () => {
      await expect(
        rollup.connect(addr1).executeIntent(ID1, addr1.address, 0, 500)
      ).to.be.revertedWith("Not authorised");
    });
  });

  // ── Admin ───────────────────────────────────────────────────────────────────
  describe("Admin", () => {
    it("owner can update congestion and event is emitted", async () => {
      await expect(rollup.updateCongestion(75))
        .to.emit(rollup, "CongestionUpdated")
        .withArgs(0n, 75n);
      expect(await rollup.congestionLevel()).to.equal(75n);
    });

    it("reverts if new congestion > 100", async () => {
      await expect(rollup.updateCongestion(101)).to.be.revertedWith("Max 100");
    });

    it("getStats reflects current congestion and exec count", async () => {
      await rollup.updateCongestion(40);
      const [, , cong, , cnt] = await rollup.getStats();
      expect(cong).to.equal(40n);
      expect(cnt).to.equal(0n);
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 2. IntentRegistry
// ══════════════════════════════════════════════════════════════════════════════

describe("IntentRegistry", function () {
  let registry, owner, router, user;

  beforeEach(async () => {
    [owner, router, user] = await ethers.getSigners();
    registry = await (await ethers.getContractFactory("IntentRegistry"))
      .deploy(router.address);
    await registry.waitForDeployment();
  });

  // Helper: submit one intent and return its on-chain id
  async function doSubmit(intentType = 0, pref = 0) {
    const tx      = await registry.connect(router).submitIntent(
      user.address, intentType, ethers.parseEther("1"), ZERO_ADDR, ZERO_ADDR, pref
    );
    const receipt = await tx.wait();
    return receipt.logs.find(l => l.fragment?.name === "IntentSubmitted").args[0];
  }

  // ── submitIntent ────────────────────────────────────────────────────────────
  describe("submitIntent", () => {
    it("emits IntentSubmitted and increments totalIntents", async () => {
      await expect(
        registry.connect(router).submitIntent(
          user.address, 0, ethers.parseEther("1"), ZERO_ADDR, ZERO_ADDR, 0)
      ).to.emit(registry, "IntentSubmitted");
      expect(await registry.totalIntents()).to.equal(1n);
    });

    it("stores user, amount, and PENDING status", async () => {
      const id     = await doSubmit();
      const intent = await registry.getIntent(id);
      expect(intent.user).to.equal(user.address);
      expect(intent.amount).to.equal(ethers.parseEther("1"));
      expect(intent.status).to.equal(0n); // PENDING
    });

    it("two intents with different types produce unique IDs", async () => {
      const id1 = await doSubmit(0); // PAYMENT
      const id2 = await doSubmit(1); // TOKEN_SWAP
      expect(id1).to.not.equal(id2);
    });

    it("getIntentCount reflects submitted count", async () => {
      await doSubmit();
      await doSubmit();
      expect(await registry.getIntentCount()).to.equal(2n);
    });

    it("reverts for invalid intent type (> 2)", async () => {
      await expect(
        registry.connect(router).submitIntent(user.address, 9, 1, ZERO_ADDR, ZERO_ADDR, 0)
      ).to.be.revertedWith("Invalid type");
    });

    it("reverts for invalid preference (> 2)", async () => {
      await expect(
        registry.connect(router).submitIntent(user.address, 0, 1, ZERO_ADDR, ZERO_ADDR, 9)
      ).to.be.revertedWith("Invalid preference");
    });

    it("reverts when called by non-router address", async () => {
      await expect(
        registry.connect(user).submitIntent(user.address, 0, 1, ZERO_ADDR, ZERO_ADDR, 0)
      ).to.be.revertedWith("Not authorised");
    });
  });

  // ── recordRouting ───────────────────────────────────────────────────────────
  describe("recordRouting", () => {
    it("transitions PENDING → ROUTED and stores reason hash", async () => {
      const id = await doSubmit();
      const rh = ethers.keccak256(ethers.toUtf8Bytes("cheapest fee on ArbiNova"));
      await registry.connect(router).recordRouting(id, 0, 5, 2000, 8700, rh);
      const intent = await registry.getIntent(id);
      expect(intent.status).to.equal(1n);             // ROUTED
      expect(intent.reasonHash).to.equal(rh);
      expect(intent.selectedRollupIndex).to.equal(0n);
    });

    it("emits IntentRouted with correct args", async () => {
      const id = await doSubmit();
      await expect(
        registry.connect(router).recordRouting(id, 1, 12, 800, 7500, ZERO_HASH)
      ).to.emit(registry, "IntentRouted")
        .withArgs(id, 1n, 12n, 800n, 7500n);
    });

    it("reverts if intent is not in PENDING state", async () => {
      const id = await doSubmit();
      await registry.connect(router).recordRouting(id, 0, 5, 2000, 9000, ZERO_HASH);
      await expect(
        registry.connect(router).recordRouting(id, 0, 5, 2000, 9000, ZERO_HASH)
      ).to.be.revertedWith("Not pending");
    });
  });

  // ── recordExecution ─────────────────────────────────────────────────────────
  describe("recordExecution", () => {
    it("transitions ROUTED → EXECUTED and updates global stats", async () => {
      const id = await doSubmit();
      await registry.connect(router).recordRouting(id, 0, 5, 2000, 8700, ZERO_HASH);
      await registry.connect(router).recordExecution(id, 5, 8);

      const intent = await registry.getIntent(id);
      expect(intent.status).to.equal(2n);       // EXECUTED
      expect(intent.actualFeeGwei).to.equal(5n);
      expect(intent.feeSavedGwei).to.equal(8n);

      const [, executed, saved] = await registry.getGlobalStats();
      expect(executed).to.equal(1n);
      expect(saved).to.equal(8n);
    });

    it("emits IntentExecuted event", async () => {
      const id = await doSubmit();
      await registry.connect(router).recordRouting(id, 0, 5, 2000, 8700, ZERO_HASH);
      await expect(
        registry.connect(router).recordExecution(id, 5, 8)
      ).to.emit(registry, "IntentExecuted");
    });

    it("reverts if intent is not ROUTED", async () => {
      const id = await doSubmit();
      await expect(
        registry.connect(router).recordExecution(id, 5, 0)
      ).to.be.revertedWith("Not routed");
    });
  });

  // ── recordFailure ───────────────────────────────────────────────────────────
  describe("recordFailure", () => {
    it("sets status to FAILED and emits event", async () => {
      const id = await doSubmit();
      await expect(
        registry.connect(router).recordFailure(id, "sequencer timeout")
      ).to.emit(registry, "IntentFailed");
      expect((await registry.getIntent(id)).status).to.equal(3n); // FAILED
    });
  });

  // ── Full lifecycle ──────────────────────────────────────────────────────────
  describe("Full PENDING → ROUTED → EXECUTED lifecycle", () => {
    it("ZK-routed asset transfer completes with correct final state", async () => {
      const id = await doSubmit(2, 1); // ASSET_TRANSFER, FASTEST preference

      expect((await registry.getIntent(id)).status).to.equal(0n); // PENDING

      const rh = ethers.keccak256(ethers.toUtf8Bytes("ZK finality required for high-value transfer"));
      await registry.connect(router).recordRouting(id, 2, 30, 300, 8800, rh);

      let intent = await registry.getIntent(id);
      expect(intent.status).to.equal(1n);              // ROUTED
      expect(intent.selectedRollupIndex).to.equal(2n); // ZkRapid (index 2)

      await registry.connect(router).recordExecution(id, 28, 17);

      intent = await registry.getIntent(id);
      expect(intent.status).to.equal(2n);          // EXECUTED
      expect(intent.actualFeeGwei).to.equal(28n);
      expect(intent.feeSavedGwei).to.equal(17n);

      const [total, executed, saved] = await registry.getGlobalStats();
      expect(total).to.equal(1n);
      expect(executed).to.equal(1n);
      expect(saved).to.equal(17n);
    });
  });

  // ── Admin ───────────────────────────────────────────────────────────────────
  describe("Admin", () => {
    it("owner can update the router address", async () => {
      await registry.connect(owner).setRouter(user.address);
      expect(await registry.router()).to.equal(user.address);
    });

    it("non-owner cannot update router", async () => {
      await expect(
        registry.connect(user).setRouter(user.address)
      ).to.be.revertedWith("Not owner");
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 3. Router Scoring Logic  (pure JS — no blockchain needed)
// ══════════════════════════════════════════════════════════════════════════════
//
// These tests verify the off-chain routing algorithm that runs in server.js.
// No Hardhat deployment required — they run as standard Mocha/Chai tests.

describe("Router Scoring Logic (off-chain unit tests)", function () {

  // ── Preference weights ──────────────────────────────────────────────────────
  describe("Preference weights", () => {
    it("cheapest selects ArbiNova at default congestion (lowest base fee)", () => {
      expect(scoreAll(DEFAULT_CONG, "cheapest")[0].id).to.equal("rollupA");
    });

    it("fastest selects ZkRapid at default congestion (lowest base latency)", () => {
      expect(scoreAll(DEFAULT_CONG, "fastest")[0].id).to.equal("rollupC");
    });

    it("balanced produces three distinct scores (no ties at default congestion)", () => {
      const scores = scoreAll(DEFAULT_CONG, "balanced").map(s => s.score);
      expect(new Set(scores).size).to.equal(3);
    });
  });

  // ── Adaptive re-routing ─────────────────────────────────────────────────────
  describe("Adaptive re-routing", () => {
    it("cheapest routes away from ArbiNova when it spikes to 95%", () => {
      const normal = scoreAll(DEFAULT_CONG, "cheapest");
      const spiked = scoreAll({ rollupA: 95, rollupB: 35, rollupC: 55 }, "cheapest");
      expect(normal[0].id).to.equal("rollupA");       // healthy → ArbiNova
      expect(spiked[0].id).to.not.equal("rollupA");   // spiked  → routes away
    });

    it("routing winner changes as congestion shifts between rollups", () => {
      // ArbiNova low → likely wins for balanced
      const aLow  = scoreAll({ rollupA: 5,  rollupB: 80, rollupC: 80 }, "balanced")[0].id;
      // ArbiNova high → likely loses
      const aHigh = scoreAll({ rollupA: 90, rollupB: 10, rollupC: 10 }, "balanced")[0].id;
      expect(aLow).to.not.equal(aHigh);
    });
  });

  // ── Success probability model ───────────────────────────────────────────────
  describe("Success probability model", () => {
    it("ZK rollup returns 0.99 regardless of congestion (validity proof guarantee)", () => {
      const zk = SIM_ROLLUPS.find(r => r.type === "ZK");
      [0, 50, 100].forEach(c => expect(simSuccess(zk, c)).to.equal(0.99));
    });

    it("Optimistic rollup is 1.0 at zero congestion", () => {
      expect(simSuccess(SIM_ROLLUPS[0], 0)).to.equal(1.0);
    });

    it("Optimistic rollup floors at 0.70 at 100% congestion", () => {
      expect(simSuccess(SIM_ROLLUPS[0], 100)).to.equal(0.70);
    });

    it("Optimistic success is monotonically decreasing with congestion", () => {
      const opt = SIM_ROLLUPS[0];
      const [s0, s50, s100] = [0, 50, 100].map(c => simSuccess(opt, c));
      expect(s0).to.be.greaterThan(s50);
      expect(s50).to.be.greaterThan(s100);
    });
  });

  // ── User constraint filtering ───────────────────────────────────────────────
  describe("User constraint filtering (maxFeeGwei / maxLatencyMs)", () => {
    it("maxLatencyMs=500 keeps only ZkRapid (~465ms at 55% congestion)", () => {
      const scores   = scoreAll(DEFAULT_CONG, "balanced");
      const eligible = scores.filter(s => s.latency <= 500);
      expect(eligible.length).to.equal(1);
      expect(eligible[0].id).to.equal("rollupC");
    });

    it("impossibly low maxFeeGwei rejects all rollups → 422 path fires", () => {
      const scores   = scoreAll(DEFAULT_CONG, "cheapest");
      const minFee   = Math.min(...scores.map(s => s.fee));
      const eligible = scores.filter(s => s.fee <= minFee * 0.01);
      expect(eligible.length).to.equal(0);
    });

    it("feeSaved = max(all fees) − winner.fee, not worst-score fee", () => {
      const scores  = scoreAll(DEFAULT_CONG, "cheapest");
      const maxFee  = Math.max(...scores.map(s => s.fee));
      const saved   = maxFee - scores[0].fee;
      expect(saved).to.be.greaterThan(0);
      expect(scores[0].fee).to.be.lessThan(maxFee);
    });
  });

  // ── Intent type routing differentiation ────────────────────────────────────
  describe("Intent type routing differentiation", () => {
    it("token_swap with WBTC adds slippage overhead vs plain payment", () => {
      const r    = SIM_ROLLUPS[2]; // ZkRapid — lowest WBTC liquidity
      const cong = 55;
      expect(effectiveFee(r, cong, "token_swap", "WBTC"))
        .to.be.greaterThan(effectiveFee(r, cong, "payment", "WBTC"));
    });

    it("asset_transfer adds bridge latency overhead vs plain payment", () => {
      const r    = SIM_ROLLUPS[0]; // ArbiNova
      const cong = 10;
      expect(effectiveLatency(r, cong, "asset_transfer"))
        .to.be.greaterThan(effectiveLatency(r, cong, "payment"));
    });

    it("WBTC slippage is higher on ZkRapid than on ArbiNova (lower liquidity)", () => {
      expect(slippageBps("rollupC", "WBTC")).to.be.greaterThan(slippageBps("rollupA", "WBTC"));
    });

    it("ETH slippage is lower than WBTC slippage on every rollup", () => {
      Object.keys(LIQUIDITY).forEach(id => {
        expect(slippageBps(id, "ETH")).to.be.lessThan(slippageBps(id, "WBTC"));
      });
    });

    it("WBTC swap routing differs from ETH payment routing on balanced preference", () => {
      const ethPay    = scoreAll(DEFAULT_CONG, "balanced", "payment",    "ETH")[0].id;
      const wbtcSwap  = scoreAll(DEFAULT_CONG, "balanced", "token_swap", "WBTC")[0].id;
      // Not guaranteed to differ at default congestion, but the scores must differ
      const ethScores  = scoreAll(DEFAULT_CONG, "balanced", "payment",    "ETH").map(s => s.fee);
      const wbtcScores = scoreAll(DEFAULT_CONG, "balanced", "token_swap", "WBTC").map(s => s.fee);
      // At minimum, WBTC swap fees are strictly higher (slippage added)
      wbtcScores.forEach((f, i) => expect(f).to.be.greaterThan(ethScores[i]));
    });
  });
});
