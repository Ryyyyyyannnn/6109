/**
 * IntentBridge — Cross-Rollup Router Server
 * ==========================================
 * Off-chain routing engine for SC6019 Option 6.
 *
 * Architecture
 * ────────────
 *   User intent  →  /api/intents  →  Routing Engine  →  Best Rollup
 *                                           │
 *                            Scores each rollup by:
 *                              • Normalised fee       (cost score)
 *                              • Normalised latency   (speed score)
 *                              • Success probability  (reliability)
 *                            Weighted by user's routing preference.
 *
 * Trust model (for report)
 * ────────────────────────
 *   This router is a centralised component — a single point of trust.
 *   A malicious router could route to an expensive rollup it controls.
 *   Mitigations discussed in the analysis section of the frontend:
 *     1. Publish routing logic on-chain (IntentRegistry stores reason hash).
 *     2. Multiple competing routers with a fallback mechanism.
 *     3. User-specified max-fee to prevent routing abuse.
 *
 * Run:  node router/server.js
 */

"use strict";

const express  = require("express");
const cors     = require("cors");
const crypto   = require("crypto");

const app = express();
app.use(cors());
app.use(express.json());

// ── Rollup definitions ────────────────────────────────────────────────────────
//
// Each rollup entry represents a distinct execution environment.
// `baseFeeGwei` and `confirmationLatencyMs` are the floor values at zero congestion.
// Congestion is a dynamic variable updated every 4 seconds.

// ── Rollup parameter calibration ─────────────────────────────────────────────
//
// Values are calibrated against publicly available 2024 Q4 data from
// l2fees.info and each chain's block explorer.  They are SIMULATION parameters
// intended to produce realistic relative behaviour, not live oracle feeds.
//
// Fee surge model: fee = baseFee × (1 + congestion²)
//   Rationale: EIP-1559 §3 specifies an exponential base-fee adjustment.
//   A quadratic approximation of (1 + c²) captures the non-linear spike
//   observed during sustained high demand while remaining analytically simple.
//   Ref: Roughgarden (2021) "Transaction Fee Mechanism Design for the Ethereum
//        Blockchain" — §4 empirical validation.
//
// Latency model: two distinct concepts are tracked separately:
//   • confirmationLatencyMs — time until the sequencer acknowledges the tx
//     (soft confirmation, usable for most applications).
//   • settlementAssumption  — the finality guarantee mechanism and its horizon
//     (hard finality, relevant for high-value cross-chain settlement).
//
// Success probability model (operationalReliability):
//   Models INCLUSION reliability (will the tx be included without timeout?),
//   NOT cryptographic execution correctness.
//   ZK rollups: congestion affects inclusion latency but NOT batch validity —
//     validity proofs guarantee that included txs are correctly executed.
//     We assign 0.99 to reflect rare sequencer downtime, not proof failure.
//   Optimistic rollups: mempool pressure under high congestion can cause
//     dropped or stale transactions before sequencer picks them up.

const ROLLUPS = {
  rollupA: {
    id:            "rollupA",
    name:          "ArbiNova",
    fullName:      "ArbiNova Rollup",
    rollupType:    "Optimistic",
    description:   "Arbitrum-style optimistic rollup. Lowest fees, 7-day L1 finality window. Best for non-urgent, cost-sensitive transfers.",
    color:         "#00e5ff",
    // Calibrated on: Arbitrum One median base fee ~0.01–0.1 gwei (l2fees.info 2024 Q4).
    // Using 0.5 gwei as a conservative upper-normal estimate for demo contrast.
    baseFeeGwei:              0.5,
    confirmationLatencyMs:    2000,   // sequencer soft-confirm; typical Arbitrum ~0.25s, using 2s as avg under load
    settlementAssumption:     "Optimistic — 7-day challenge window for L1 finality",
    congestion:               10,
    // Token liquidity depth (0–1, 1 = deepest market).
    // Source: relative TVL/volume ranking, DeFiLlama 2024 Q4.
    // Affects slippage cost for token_swap intents.
    liquidity: { ETH: 0.98, USDC: 0.95, WBTC: 0.72, DAI: 0.80 },
    // Estimated bridge confirmation time from L1 (ms, soft-confirm).
    // Used to compute effective latency for asset_transfer intents.
    bridgeLatencyMs: 90_000,
  },
  rollupB: {
    id:            "rollupB",
    name:          "OptiSwift",
    fullName:      "OptiSwift Network",
    rollupType:    "Optimistic",
    description:   "Optimism / Base-style rollup. Balanced fee and speed. Good general-purpose choice for DeFi interactions.",
    color:         "#ff4560",
    // Calibrated on: OP Mainnet / Base ~0.001–0.01 gwei typical; 1.2 gwei represents
    // moderate-load scenario with sequencer prioritisation overhead.
    baseFeeGwei:              1.2,
    confirmationLatencyMs:    800,    // faster sequencer than Arbitrum in typical conditions
    settlementAssumption:     "Optimistic — 7-day challenge window for L1 finality",
    congestion:               35,
    liquidity: { ETH: 0.97, USDC: 0.92, WBTC: 0.68, DAI: 0.88 },
    bridgeLatencyMs: 75_000,
  },
  rollupC: {
    id:            "rollupC",
    name:          "ZkRapid",
    fullName:      "ZkRapid Proof Network",
    rollupType:    "ZK",
    description:   "ZK validity-proof rollup. L1 finality in tens of minutes to hours (batch proving pipeline). Higher base cost from proof generation overhead.",
    color:         "#7b61ff",
    // Calibrated on: zkSync Era ~0.1–0.5 gwei typical; ZK proof overhead
    // adds ~3–5× vs optimistic (PLONK/STARK verification gas on L1).
    // Using 3.0 gwei as representative cost under moderate load.
    baseFeeGwei:              3.0,
    confirmationLatencyMs:    300,    // fast sequencer soft-confirm; L1 proof posting varies
    settlementAssumption:     "ZK validity proof — L1 finality in tens of minutes to hours (depends on proving/batch pipeline; zkSync Era typically 3+ h)",
    congestion:               55,
    // ZK rollups have narrower DeFi ecosystems currently → lower liquidity for
    // non-ETH tokens; higher slippage on WBTC/DAI swaps.
    liquidity: { ETH: 0.90, USDC: 0.85, WBTC: 0.60, DAI: 0.70 },
    bridgeLatencyMs: 60_000,
  },
};

// ── Dynamic congestion simulation ─────────────────────────────────────────────
//
// Congestion changes realistically over time using sinusoidal waves with
// random noise — mimicking real block demand patterns.

let tick = 0;

function stepCongestion() {
  tick++;
  const noise = () => (Math.random() - 0.5) * 12;

  ROLLUPS.rollupA.congestion = clamp(
    10 + 18 * Math.sin(tick / 18)          + noise(), 0, 100);
  ROLLUPS.rollupB.congestion = clamp(
    35 + 22 * Math.sin(tick / 14 + 1.2)    + noise(), 0, 100);
  ROLLUPS.rollupC.congestion = clamp(
    55 + 28 * Math.sin(tick / 10 + 2.4)    + noise(), 0, 100);
}

setInterval(stepCongestion, 4000);

// ── Fee / latency / success models ───────────────────────────────────────────

/** Fee increases quadratically with congestion (mirrors EIP-1559 surge pricing) */
function getFee(rollupId) {
  const r = ROLLUPS[rollupId];
  const c = r.congestion / 100;
  return r.baseFeeGwei * (1 + c * c);
}

/** Latency increases linearly with congestion (soft-confirmation only) */
function getLatency(rollupId) {
  const r = ROLLUPS[rollupId];
  return Math.round(r.confirmationLatencyMs * (1 + r.congestion / 100));
}

/**
 * Slippage cost in basis points for a token_swap intent.
 * Model: base slippage = 5 bps at perfect liquidity (depth = 1.0).
 * Lower liquidity → higher slippage: slippage_bps = BASE_BPS / liquidity.
 *
 * IMPORTANT LIMITATION: this models network routing cost (which chain has the
 * best liquidity pool), NOT AMM price impact.  Real DEX slippage scales with
 * swap amount relative to pool TVL: impact ≈ amount / (2 × reserve).  This
 * model is amount-invariant — it treats all swap sizes identically and is
 * appropriate only for comparing RELATIVE rollup quality, not for quoting
 * actual swap costs to end users.
 */
function getSlippageBps(rollupId, token) {
  const liq = (ROLLUPS[rollupId].liquidity || {})[token] ?? 0.5;
  return 5 / liq;
}

/**
 * Effective fee for scoring:
 *   • payment / asset_transfer — base fee only
 *   • token_swap — base fee + slippage overhead (penalises low-liquidity pools)
 */
function getEffectiveFee(rollupId, intentType, token) {
  const base = getFee(rollupId);
  if (intentType === "token_swap") {
    const slippageBps = getSlippageBps(rollupId, token);
    return base * (1 + slippageBps / 10_000);
  }
  return base;
}

/**
 * Effective latency for scoring:
 *   • payment / token_swap — confirmation latency only
 *   • asset_transfer — confirmation + 30% of bridge latency
 *     (user must wait for bridge confirmation before funds are usable)
 */
function getEffectiveLatency(rollupId, intentType) {
  const base = getLatency(rollupId);
  if (intentType === "asset_transfer") {
    return base + (ROLLUPS[rollupId].bridgeLatencyMs ?? 0) * 0.3;
  }
  return base;
}

/**
 * Success probability model — differs by rollup type:
 *
 * Optimistic rollups: higher congestion → more mempool competition → higher
 *   revert/timeout rate.  Clamped at 70% floor.
 *
 * ZK rollups: validity proofs guarantee cryptographic finality — a tx either
 *   proves correctly or it doesn't.  Congestion does NOT create reverts the
 *   way optimistic sequencers do.  Success is ~99% regardless of load.
 */
function getSuccessProb(rollupId) {
  if (ROLLUPS[rollupId].rollupType === "ZK") return 0.99;
  return Math.max(0.70, 1 - ROLLUPS[rollupId].congestion / 333);
}

// ── Routing engine ────────────────────────────────────────────────────────────

const WEIGHTS = {
  cheapest: { fee: 0.70, latency: 0.15, success: 0.15 },
  fastest:  { fee: 0.10, latency: 0.75, success: 0.15 },
  balanced: { fee: 0.40, latency: 0.40, success: 0.20 },
};

/**
 * Score every rollup and return sorted results.
 * Scores are normalised so the "best" rollup on each criterion gets 100.
 *
 * intentType and token adjust the effective fee/latency used for scoring:
 *   token_swap  → fee includes slippage overhead (lower liquidity = higher cost)
 *   asset_transfer → latency includes bridge overhead
 *   payment     → no adjustment (standard scoring)
 */
function scoreAllRollups(preference, intentType = "payment", token = "ETH") {
  const ids     = Object.keys(ROLLUPS);
  const weights = WEIGHTS[preference] || WEIGHTS.balanced;

  const baseFees  = ids.map(getFee);
  const baseLats  = ids.map(getLatency);
  const fees      = ids.map(id => getEffectiveFee(id, intentType, token));
  const latencies = ids.map(id => getEffectiveLatency(id, intentType));

  const minFee = Math.min(...fees),      maxFee = Math.max(...fees);
  const minLat = Math.min(...latencies), maxLat = Math.max(...latencies);

  return ids
    .map((id, i) => {
      const fee     = fees[i];
      const latency = latencies[i];
      const success = getSuccessProb(id);

      const normFee = maxFee === minFee ? 1 : 1 - (fee - minFee) / (maxFee - minFee);
      const normLat = maxLat === minLat ? 1 : 1 - (latency - minLat) / (maxLat - minLat);

      const score =
        weights.fee     * normFee +
        weights.latency * normLat +
        weights.success * success;

      const feeAdj     = +(fee - baseFees[i]).toFixed(4);
      const latencyAdj = Math.round(latency - baseLats[i]);

      return {
        rollupId:             id,
        name:                 ROLLUPS[id].name,
        rollupType:           ROLLUPS[id].rollupType,
        settlementAssumption: ROLLUPS[id].settlementAssumption,
        fee:            +fee.toFixed(4),
        baseFee:        +baseFees[i].toFixed(4),
        feeAdjustment:  feeAdj,       // > 0 means slippage overhead was added
        latency:        Math.round(latency),
        baseLatency:    baseLats[i],
        latencyAdjustment: latencyAdj, // > 0 means bridge overhead was added
        congestion:     Math.round(ROLLUPS[id].congestion),
        successProb:    +(success * 100).toFixed(1),
        score:          +(score * 100).toFixed(2),
        scoreBreakdown: {
          feeScore:     +(normFee  * 100).toFixed(1),
          latencyScore: +(normLat  * 100).toFixed(1),
          successScore: +(success  * 100).toFixed(1),
          weights,
        },
      };
    })
    .sort((a, b) => b.score - a.score);
}

/** Build a human-readable explanation of the routing decision */
function buildReasons(winner, allScores) {
  const r      = ROLLUPS[winner.rollupId];
  const second = allScores[1];
  const reasons = [];

  reasons.push(`Routed to ${r.name} with composite score ${winner.score}/100`);
  reasons.push(`Current fee: ${winner.fee} gwei (congestion: ${winner.congestion}%)`);
  reasons.push(`Estimated confirmation: ${winner.latency} ms`);
  reasons.push(`Execution success probability: ${winner.successProb}%`);

  const feeSaved = (second.fee - winner.fee).toFixed(4);
  if (parseFloat(feeSaved) > 0) {
    reasons.push(`Saves ${feeSaved} gwei vs. next-best option (${second.name})`);
  }
  if (winner.congestion < 20)  reasons.push(`Low congestion window — optimal routing timing`);
  if (winner.rollupId === "rollupC") reasons.push(`ZK finality guarantees fast settlement`);

  return reasons;
}

// ── In-memory intent store ────────────────────────────────────────────────────

const intentStore   = new Map();   // id → intent object
const intentHistory = [];          // recent executed intents (capped at 200)

// ── API Routes ────────────────────────────────────────────────────────────────

/**
 * GET /api/rollups
 * Returns live state of all simulated rollup environments.
 */
app.get("/api/rollups", (_req, res) => {
  const rollups = Object.values(ROLLUPS).map(r => ({
    id:          r.id,
    name:        r.name,
    fullName:    r.fullName,
    rollupType:  r.rollupType,
    description: r.description,
    color:       r.color,
    fee:                 +getFee(r.id).toFixed(4),
    latency:             getLatency(r.id),
    congestion:          Math.round(r.congestion),
    successProb:         +(getSuccessProb(r.id) * 100).toFixed(1),
    settlementAssumption: r.settlementAssumption,
    liquidity:           r.liquidity,
    bridgeLatencyMs:     r.bridgeLatencyMs,
    execCount:   [...intentStore.values()]
                   .filter(i => i.selectedRollup === r.id && i.status === "executed").length,
  }));
  res.json({ rollups, timestamp: Date.now() });
});

/**
 * POST /api/intents/preview
 * Dry-run: returns routing decision without persisting an intent.
 * Body: { preference?: "cheapest"|"fastest"|"balanced" }
 */
app.post("/api/intents/preview", (req, res) => {
  const { preference = "balanced", intentType = "payment", token = "ETH" } = req.body;
  const scores  = scoreAllRollups(preference, intentType, token);
  const winner  = scores[0];
  const reasons = buildReasons(winner, scores);
  res.json({ winner, allScores: scores, reasons, intentType, token, timestamp: Date.now() });
});

/**
 * POST /api/intents
 * Submit a user intent.  Router scores rollups and selects the best one.
 * Body: {
 *   intentType:  "payment"|"token_swap"|"asset_transfer"
 *   amount:      number (token units)
 *   token:       string  (token symbol or address)
 *   recipient:   string  (address)
 *   preference:  "cheapest"|"fastest"|"balanced"
 *   description: string  (optional user note)
 *   user:        string  (wallet address, optional)
 * }
 */
app.post("/api/intents", (req, res) => {
  const {
    intentType   = "payment",
    amount,
    token        = "ETH",
    recipient    = "0x" + crypto.randomBytes(20).toString("hex"),
    preference   = "balanced",
    description  = "",
    user         = "0x" + crypto.randomBytes(20).toString("hex"),
    // Optional user-defined execution constraints.
    // If set, the router only considers rollups that satisfy BOTH bounds.
    // If no rollup qualifies, the intent is rejected with a 422 + explanation.
    // This transforms the router from a "best-effort" selector into a real
    // intent infrastructure component where users express hard requirements.
    maxFeeGwei   = null,
    maxLatencyMs = null,
  } = req.body;

  if (!amount || Number(amount) <= 0) {
    return res.status(400).json({ error: "amount must be > 0" });
  }

  const id     = "0x" + crypto.randomBytes(32).toString("hex");
  const scores = scoreAllRollups(preference, intentType, token);

  // Apply user constraints — filter to eligible rollups only
  const eligible = scores.filter(s =>
    (maxFeeGwei   === null || s.fee     <= Number(maxFeeGwei))   &&
    (maxLatencyMs === null || s.latency <= Number(maxLatencyMs))
  );

  if (eligible.length === 0) {
    const best = scores[0];
    return res.status(422).json({
      error:       "No rollup satisfies your constraints",
      constraints: { maxFeeGwei, maxLatencyMs },
      bestAvailable: {
        name:    best.name,
        fee:     best.fee,
        latency: best.latency,
      },
      suggestion:  `Relax maxFeeGwei to ≥${best.fee} or maxLatencyMs to ≥${best.latency} to route via ${best.name}`,
    });
  }

  const winner  = eligible[0];
  const reasons = buildReasons(winner, scores);

  // Compare against the most expensive / slowest option — not the worst-SCORING
  // one (worst score ≠ worst fee; e.g. a slow-but-cheap rollup scores low but
  // saves nothing vs. the winner in fee terms).
  const maxFee     = Math.max(...scores.map(s => s.fee));
  const maxLatency = Math.max(...scores.map(s => s.latency));
  const feeSaved     = Math.max(0, maxFee     - winner.fee);
  const latencySaved = Math.max(0, maxLatency - winner.latency);

  const intent = {
    id,
    user,
    intentType,
    amount:             Number(amount),
    token,
    recipient,
    preference,
    description,
    selectedRollup:     winner.rollupId,
    selectedRollupName: ROLLUPS[winner.rollupId].name,
    estimatedFee:       winner.fee,
    estimatedLatency:   winner.latency,
    routeScore:         winner.score,
    routingReasons:     reasons,
    allScores:          scores,
    feeSaved:           +feeSaved.toFixed(4),
    latencySaved,
    status:             "routed",
    submittedAt:        Date.now(),
    executedAt:         null,
    actualFee:          null,
  };

  intentStore.set(id, intent);

  // Simulate async execution after estimated latency (+ small jitter)
  const jitter = Math.random() * 300;
  setTimeout(() => {
    const i = intentStore.get(id);
    if (!i) return;
    // Actual fee is estimate ± 5%
    i.actualFee  = +(i.estimatedFee * (0.95 + Math.random() * 0.1)).toFixed(4);
    i.executedAt = Date.now();
    i.status     = "executed";

    intentHistory.unshift({ ...i });
    if (intentHistory.length > 200) intentHistory.pop();
  }, intent.estimatedLatency + jitter);

  res.json({ intent, message: "Intent routed successfully" });
});

/**
 * GET /api/intents/history
 * Returns the 20 most recently executed intents.
 */
app.get("/api/intents/history", (_req, res) => {
  res.json({ intents: intentHistory.slice(0, 20) });
});

/**
 * GET /api/intents/:id
 * Poll for intent execution status.
 */
app.get("/api/intents/:id", (req, res) => {
  const intent = intentStore.get(req.params.id);
  if (!intent) return res.status(404).json({ error: "Intent not found" });
  res.json(intent);
});

/**
 * POST /api/intents/batch-preview
 * Preview how batching N identical intents reduces per-intent cost.
 * Demonstrates the scalability benefit of intent aggregation.
 * Body: { count: number, preference?: string }
 */
app.post("/api/intents/batch-preview", (req, res) => {
  const { count = 10, preference = "balanced" } = req.body;
  const scores   = scoreAllRollups(preference);
  const winner   = scores[0];

  // EVM batching model — based on real gas mechanics:
  //   Every Ethereum transaction pays a fixed 21,000 gas base overhead
  //   (ECDSA verification + nonce update + value transfer bookkeeping).
  //   Batching N intents into one multicall shares this overhead across all N,
  //   reducing the per-intent base cost from 21,000 to 21,000/N gas.
  //
  //   Per-intent execution gas (warm-slot storage writes in a batch) ≈ 80,000 gas
  //   and cannot be amortised — it is paid regardless.
  //   Note: a standalone cold-storage submitIntent costs ~207,000 gas (observed).
  //   In a batch the 2nd+ intents hit warm slots (EIP-2929), so ~80,000 per
  //   additional intent is a realistic estimate.
  //
  //   Single:  (21,000 + 80,000) × gasPriceGwei = 101,000 × p   gwei
  //   Batch:   (21,000/N + 80,000) × gasPriceGwei               gwei per intent
  //   Max saving: 21,000 / 101,000 ≈ 20.8% as N → ∞

  const BASE_GAS   = 21_000;
  const INTENT_GAS = 80_000;
  const n          = Math.max(2, Math.min(500, Number(count)));
  const gasPrice   = winner.fee;   // gwei per gas unit

  const singleCost = gasPrice * (BASE_GAS + INTENT_GAS);
  const batchCost  = gasPrice * (BASE_GAS / n + INTENT_GAS);
  const savingPer  = singleCost - batchCost;
  const savingPct  = (savingPer / singleCost) * 100;

  res.json({
    rollup:            winner.name,
    count:             n,
    gasPriceGwei:      gasPrice,
    singleCostGwei:    +singleCost.toFixed(2),
    batchCostGwei:     +batchCost.toFixed(2),
    savingPerIntent:   +savingPer.toFixed(2),
    totalSavingGwei:   +(savingPer * n).toFixed(2),
    savingPct:         +savingPct.toFixed(1),
    maxTheoreticalPct: +((BASE_GAS / (BASE_GAS + INTENT_GAS)) * 100).toFixed(1),
  });
});

/**
 * GET /api/analytics
 * Aggregate statistics for the dashboard.
 */
app.get("/api/analytics", (_req, res) => {
  const executed = intentHistory.filter(i => i.status === "executed");
  const totalFeeSaved = executed.reduce((s, i) => s + (i.feeSaved || 0), 0);

  const byRollup = {};
  Object.values(ROLLUPS).forEach(r => {
    byRollup[r.id] = { name: r.name, count: 0, color: r.color };
  });
  executed.forEach(i => {
    if (byRollup[i.selectedRollup]) byRollup[i.selectedRollup].count++;
  });

  const byPref = { cheapest: 0, fastest: 0, balanced: 0 };
  executed.forEach(i => { if (byPref[i.preference] !== undefined) byPref[i.preference]++; });

  const avgFee = executed.length
    ? +(executed.reduce((s, i) => s + (i.actualFee || i.estimatedFee), 0) / executed.length).toFixed(4)
    : 0;

  res.json({
    totalIntents:  intentStore.size,
    totalExecuted: executed.length,
    totalFeeSaved: +totalFeeSaved.toFixed(4),
    avgFee,
    byRollup,
    byPreference: byPref,
  });
});

/**
 * POST /api/simulate/congestion
 * Demo helper: manually set congestion levels for a rollup.
 * Body: { rollupId, level }
 */
app.post("/api/simulate/congestion", (req, res) => {
  const { rollupId, level } = req.body;
  if (!ROLLUPS[rollupId] || level < 0 || level > 100) {
    return res.status(400).json({ error: "Invalid rollupId or level" });
  }
  ROLLUPS[rollupId].congestion = Number(level);
  res.json({ ok: true, rollupId, congestion: level });
});

// ── Start ─────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`\nIntentBridge Router  →  http://localhost:${PORT}`);
  console.log(`Simulated rollups   :  ${Object.values(ROLLUPS).map(r => r.name).join("  |  ")}`);
  console.log(`Press Ctrl+C to stop\n`);
});

// ── Utility ───────────────────────────────────────────────────────────────────
function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
