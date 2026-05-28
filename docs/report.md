# IntentBridge — Technical Report

**SC6019 Option 6: Cross-Rollup Intent Router for Scalable User Transactions**

---

## 1. System Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│  User browser (frontend/index.html)                                 │
│  • intent form: type · token · amount · preference · constraints    │
│  • live preview (fee/latency before submission)                     │
│  • routing decision panel + settlement assumption badge             │
│  • intent history + global analytics                                │
└──────────────────────────┬──────────────────────────────────────────┘
                           │ REST (fetch)
                           ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Off-chain Router  (router/server.js)                               │
│  • Express REST API on :3001                                        │
│  • scoreAllRollups(preference, intentType, token)                   │
│    – effective_fee  : base × (1 + (cong/100)²) + slippage          │
│    – effective_lat  : base × (1 + cong/100) + bridge overhead      │
│    – success_prob   : ZK 0.99 flat; Optimistic max(0.70, …)        │
│  • 422 rejection when intent violates maxFeeGwei / maxLatencyMs     │
│  • Simulated congestion changes every 4 s                           │
└──────────────────────────┬──────────────────────────────────────────┘
                           │ ethers.js / RPC (optional live mode)
                           ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Smart-contract layer  (Hardhat / localhost:8545)                   │
│                                                                     │
│  IntentRegistry.sol           MockRollup.sol (×3)                      │
│  ┌─────────────────┐          ┌─────────────────────────────────────┐  │
│  │ submitIntent    │          │ ArbiNova  baseFee 0.5g  lat 2000 ms │  │
│  │ recordRouting   │◀──router │ OptiSwift baseFee 1.2g  lat  800 ms │  │
│  │ recordExecution │          │ ZkRapid   baseFee 3.0g  lat  300 ms │  │
│  │ recordFailure   │          └─────────────────────────────────────┘  │
│  └─────────────────┘                                                   │
└─────────────────────────────────────────────────────────────────────┘
```

**Data flow:**

1. User submits intent (type, token, amount, preference, optional constraints).
2. Router queries each rollup's current fee/latency, runs weighted scoring.
3. If any constraint (maxFee, maxLatency) is violated by ALL rollups → 422 returned.
4. Router returns the winning rollup + score breakdown to the frontend.
5. (Optional live mode) Router calls `IntentRegistry.recordRouting()`, then
   `MockRollup.executeIntent()`, then `IntentRegistry.recordExecution()`.

---

## 2. Rollup Simulations

| Rollup     | Type        | baseFee (gwei) | baseLat (ms) | Initial cong | Real-world analogue       |
|------------|-------------|----------------|--------------|--------------|---------------------------|
| ArbiNova   | Optimistic  | 0.5            | 2000         | 10%          | Arbitrum One              |
| OptiSwift  | Optimistic  | 1.2            | 800          | 35%          | OP Mainnet / Base         |
| ZkRapid    | ZK          | 3.0            | 300          | 55%          | zkSync Era                |

### Parameter calibration

| Parameter | Sim value | Real-world range | Source & sampling method | Scale-up rationale |
|-----------|-----------|------------------|--------------------------|--------------------|
| ArbiNova baseFee | 0.5 gwei | 0.1–0.4 gwei (Arbitrum One, 2024 Q4) | l2fees.info spot samples, Dec 2024 | Slightly above observed median to create clear decision margin between rollups |
| OptiSwift baseFee | 1.2 gwei | 0.5–1.5 gwei (OP Mainnet / Base, 2024 Q4) | l2fees.info spot samples, Dec 2024 | Mid-range of observed OP/Base fees |
| ZkRapid baseFee | 3.0 gwei | 0.1–0.5 gwei (zkSync Era, 2024 Q4) | l2fees.info spot samples, Dec 2024 | **Scaled up ×6–30×** to reflect ZK proof overhead on L1 gas (PLONK/STARK verification ~300–500k gas); real zkSync fees are low but L1 settlement is expensive |
| ArbiNova baseLat | 2000 ms | 300–3000 ms soft-confirm (Arbitrum) | Arbitrum sequencer latency docs | Representative median; Arbitrum soft-confirm is faster but varies |
| OptiSwift baseLat | 800 ms | 200–2000 ms (OP Mainnet) | OP Mainnet sequencer benchmarks | Faster than Arbitrum due to shorter block time |
| ZkRapid baseLat | 300 ms | 1–500 ms (zkSync Era) | zkSync Era sequencer benchmarks | ZK sequencers batch-post faster; 300 ms matches Era typical |

**Scale-up note**: ZkRapid's 3.0 gwei is intentionally higher than observed spot fees to create a meaningful routing decision space. In production, the cost difference between ZK and Optimistic rollups is smaller on a per-tx basis; the fee spread in this simulation is designed to make the routing algorithm's latency/fee tradeoff visually demonstrable, not to replicate live market prices.

`fee = baseFee × (1 + (congestion/100)²)` — quadratic surge matches EIP-1559 observed behaviour.  
`latency = baseLat × (1 + congestion/100)` — linear increase with mempool pressure.

---

## 3. Routing Algorithm

```
score_i = w_fee × normFee_i  +  w_latency × normLat_i  +  w_success × successProb_i
```

Normalisation: `normFee_i = 1 − (fee_i − minFee) / (maxFee − minFee)`  (higher = cheaper)

### Preference weights

| Preference | w_fee | w_latency | w_success |
|------------|-------|-----------|-----------|
| Cheapest   | 0.70  | 0.15      | 0.15      |
| Fastest    | 0.10  | 0.75      | 0.15      |
| Balanced   | 0.40  | 0.40      | 0.20      |

### Intent-type adjustments

| Intent type    | Fee adjustment                                    | Latency adjustment              |
|----------------|---------------------------------------------------|---------------------------------|
| payment        | none                                              | none                            |
| token_swap     | `+= base × slippage_bps / 10000`                  | none                            |
| asset_transfer | none                                              | `+= bridge_latency_ms × 0.30`   |

`slippage_bps = 5 / liquidity[rollup][token]` (illiquid pairs penalised more)

---

## 4. Design Assumptions & Limitations

### 4.1 Simulation, not live execution

The default router runs fully in-memory.  No on-chain transactions are submitted
in the standard demo mode.  The `IntentRegistry` contract is deployed and fully
functional; `scripts/demo-routing.js` demonstrates the complete on-chain lifecycle.
Wiring the router to call `recordRouting()` / `recordExecution()` on every intent
is a straightforward extension (requires a funded signer and `RPC_URL` in `.env`).

### 4.2 ZK success probability model

`success_prob(ZK) = 0.99` — a **simulation assumption**.

ZK validity proofs guarantee state-transition *correctness* (invalid state changes
cannot be posted to L1), but they do **not** protect against inclusion failure caused
by sequencer downtime or censorship.  The model assigns 0.99 to reflect rare sequencer
outages, and treats this probability as congestion-independent.

**Limitation:** in practice, ZK sequencer liveness may correlate with network load
during high-throughput periods.  The 0.99 constant is a deliberate simplification to
keep the model tractable; it should not be presented as an empirical guarantee.

### 4.3 Optimistic success probability model

`success_prob(Optimistic) = max(0.70, 1 − congestion / 333)`

At 100% congestion → `1 − 0.30 = 0.70`.  Floor of 70% is conservative; real
Arbitrum / OP sequencers rarely drop transactions.  The model captures the
qualitative effect (high mempool pressure increases revert/drop risk) without
claiming specific empirical accuracy.

### 4.4 Centralised trust model

The router is a single trusted party.  A compromised router could:

- Route to the most expensive rollup.
- Suppress intents for targeted users.
- Post false reason hashes on-chain.

**Mitigations implemented:**

- Routing algorithm is open-source (verifiable by anyone).
- `reasonHash = keccak256(JSON.stringify(routingDecision))` anchored on-chain —
  post-hoc audits can verify the claimed fee/score match observed state.

**Future mitigations (not implemented):**

- Multi-sig or threshold router.
- On-chain scoring with aggregated L2 oracle feeds.
- Optimistic dispute period for routing decisions.

### 4.5 Slippage model is amount-invariant

`slippage_bps = 5 / liquidity[rollup][token]`

This models **relative rollup pool quality** (which chain has deeper liquidity), NOT
AMM price impact.  Real DEX slippage scales with swap size:
`impact ≈ amount / (2 × pool_reserve)`.

This model treats all swap sizes identically — a 10 USDC swap and a 1 000 000 USDC
swap receive the same slippage penalty.  This is intentional: the routing layer
selects *which* rollup to use; it does not simulate execution within the pool.
If amount-aware slippage is needed, replace `getSlippageBps()` in `router/server.js`
with a TVL-based price-impact formula (not currently in scope).

### 4.6 Fee and latency data freshness (congestion update interval)

Congestion state changes every 4 seconds in the simulation.  In production, a router
would subscribe to sequencer mempool feeds or L2 RPC endpoints.  The simulation
deliberately uses stochastic noise (Gaussian) rather than purely deterministic values
to exercise the adaptive routing behaviour.

### 4.7 Bridge latency model

`bridge_latency_overhead = bridge_latency_ms[rollup] × 0.30`

`bridge_latency_ms`: ArbiNova 90 000 ms · OptiSwift 75 000 ms · ZkRapid 60 000 ms

The overhead represents time to obtain a cross-chain message proof (not the full
L1 finality window).  The 30% factor is a conservative soft-confirm estimate.
**The 7-day challenge window for Optimistic rollups and the ZK proof-posting window
(tens of minutes to hours depending on proving/batch pipeline; zkSync Era typically
3+ hours per [zkSync finality docs](https://docs.zksync.io/zk-stack/concepts/finality))
are separate settlement concerns and are NOT included in the routing latency score**
— they apply after the application has already acted on the soft-confirmation.

---

## 5. Baseline Comparison Results

Monte Carlo simulation: 2 000 random congestion snapshots, uniform distribution [0, 100].

| Strategy                  | Avg Fee (g) | Avg Latency (ms) | Avg Success | E[cost] (g) |
|---------------------------|-------------|------------------|-------------|-------------|
| Fixed-ArbiNova            | 0.6676      | 3 006            | 84.9%       | 0.8125      |
| Fixed-OptiSwift           | 1.6113      | 1 204            | 84.8%       | 1.9659      |
| Random selection          | 2.1065      | 1 549            | 89.7%       | 2.2819      |
| Cheapest-fee-only         | 0.6676      | 3 006            | 84.9%       | 0.8125      |
| Fastest-latency-only      | 3.9828      | 448              | 99.0%       | 4.0230      |
| **Multi-criteria (ours)** | **1.7936**  | **1 050**        | **88.7%**   | **2.0355**  |

`E[cost] = fee / success_prob` — penalises strategies that route to unreliable chains.

### Key findings

- Multi-criteria is **not** the cheapest (Fixed-ArbiNova wins on raw fee).
- Multi-criteria is **not** the fastest (Fastest-latency-only wins on latency).
- Multi-criteria achieves the best **combination**: it pays a +1.1260 gwei routing
  premium over Fixed-ArbiNova but receives 1 956 ms lower latency in return.
- vs Random: −0.31 gwei fee, −499 ms latency; success rates are comparable
  (88.7% vs 89.7%) — multi-criteria dominates on cost and speed.
- vs Cheapest-fee-only: +1.1260 gwei buys 1 956 ms faster confirmations.
  This tradeoff is appropriate for time-sensitive applications.

---

## 6. Intent-Type Benchmark Results

1 000 intents per cell · 3 intent types × 4 congestion scenarios · balanced preference.

### Key result: routing decision is **stable** across intent types

The dominant rollup (OptiSwift under balanced preference) does not change across
intent types.  This is by design: the fee and latency adjustments are proportional,
so the relative ranking is preserved.

| Metric                       | Value                         |
|------------------------------|-------------------------------|
| Avg latency overhead (xfer)  | +22 497 ms (bridge wait)      |
| Avg fee overhead (WBTC swap) | +0.0017 gwei (slippage)       |

**Model value: cost transparency, not routing shifts.**
Without intent-type modelling the UI would display ~800 ms for an asset transfer
that actually takes ~23 s (800 ms routing latency + 22 500 ms bridge overhead);
WBTC swap cost would omit slippage entirely.

---

## 7. Scalability Discussion

### Routing layer scales horizontally

The off-chain router reads rollup state via API and scores N rollups in O(N) time.
Adding a new rollup requires only a new entry in `SIM_ROLLUPS` (server.js) — the
scoring loop and frontend are automatically updated.  No smart-contract changes.

### On-chain record scales by intent volume

`IntentRegistry` stores one 17-field struct per intent in a mapping (O(1) lookup,
O(1) insert).  Gas cost is ~80 000 per intent regardless of the number of registered
rollups.  A gas estimate at Ethereum mainnet fees (~30 gwei, 2024):

```
80 000 × 30 gwei = 2 400 000 gwei = 0.0024 ETH ≈ $5–8 per intent
```

This is too expensive for micro-transactions but acceptable for larger cross-chain
asset transfers.  Mitigation: batch-record multiple intents per transaction or move
the registry to an L2 itself.

### EVM batching analysis

Observed gas per cold `submitIntent()` call: **~207 000** (see gas table in README.md).
In a batched multicall, the 2nd+ intents reuse warm storage slots (EIP-2929), reducing
the per-intent incremental cost to an estimated **~80 000 gas**.

Base transaction overhead: 21 000 gas per transaction (EVM fixed cost).
When N intents are batched into one transaction:
```
saving_pct = (N−1) × 21 000 / (N × 80 000 + (N−1) × 21 000)
```
At N → ∞: 21 000 / (80 000 + 21 000) ≈ **20.8%** saving per intent.
Maximum realistic batch (30M block gas limit ÷ 80 000 ≈ 375 intents): ~20% saving.

> The `batch-preview` API endpoint in `router/server.js` uses the same 80 000 gas figure
> and 20.8% asymptote, consistent with this analysis.

### Congestion adaptability

Because the router re-queries rollup state on every request, it adapts to network
changes within one polling interval (4 s in the simulation).  A fixed-chain strategy
(e.g., always ArbiNova) would remain on a congested chain until the user manually
intervenes — exactly the scenario the Asymmetric benchmark demonstrates.

---

## 8. Trust Model Summary

| Component          | Trust assumption                          | Risk if compromised         |
|--------------------|-------------------------------------------|-----------------------------|
| Off-chain router   | Trusted singleton                         | Incorrect routing           |
| IntentRegistry     | Deployed by owner; router set by owner    | Router can be updated       |
| MockRollup         | Trusted; can update congestion            | Fee manipulation in demo    |
| Reason hash        | keccak256 of routing decision JSON        | Post-hoc verification only  |

---

## 9. Limitations Summary

1. **Simulation only**: congestion is stochastic, not read from live RPCs.
2. **No real assets moved**: `executeIntent` in MockRollup records but does not
   transfer ERC-20 tokens.
3. **Single router**: no redundancy; a down router blocks all intent submission.
4. **Success probability model**: 0.99 ZK constant is a simplification; congestion
   independence is an assumption.
5. **Bridge latency model**: 30% of bridge_latency_ms is a rough estimate; actual
   cross-chain message delays vary widely by rollup and L1 block time.
6. **No slippage oracle**: liquidity depths are static constants, not live DEX data.

---

## 10. References

- l2fees.info — L2 gas fee tracker (2024 Q4 snapshots)
- EIP-1559: Ethereum fee market mechanism
- Arbitrum Documentation — optimistic rollup challenge period
- zkSync Era Documentation — ZK proof posting timeline
- L2Beat — rollup TVL and risk analysis framework
