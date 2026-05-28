# IntentBridge — Cross-Rollup Intent Router

**SC6019 Option 6: Cross-Rollup Intent Router for Scalable User Transactions**

## Project Summary

IntentBridge lets users submit a high-level transaction intent (payment, token swap, or asset transfer) and automatically routes it to the most suitable rollup based on fee, latency, and execution reliability.  Three simulated rollup environments with distinct characteristics are evaluated in real-time using a multi-criteria weighted scoring algorithm.

---

## Project Structure

```
intentbridge/
├── contracts/
│   ├── MockToken.sol          ERC20 token for testing
│   ├── MockRollup.sol         Simulated rollup execution environment
│   └── IntentRegistry.sol     On-chain intent & routing decision ledger
├── scripts/
│   ├── deploy.js              Deploy all contracts + seed test tokens
│   └── demo-routing.js        End-to-end on-chain lifecycle demo
├── router/
│   └── server.js              Off-chain routing engine (Express REST API)
├── frontend/
│   └── index.html             Full UI — intent form, routing viz, analytics
├── analysis/
│   └── benchmark.py           Routing benchmark + intent-type + baseline comparison
├── test/
│   └── IntentBridge.test.js   53 tests: contracts + router scoring logic
├── docs/
│   └── report.md              Architecture, assumptions, baseline results
├── hardhat.config.js
└── package.json
```

---

## Simulated Rollups

| Rollup     | Type        | Base Fee | Base Latency | Characteristics                       |
|------------|-------------|----------|--------------|---------------------------------------|
| ArbiNova   | Optimistic  | 0.5 gwei | 2000 ms      | Cheapest, best for non-urgent txns    |
| OptiSwift  | Optimistic  | 1.2 gwei | 800 ms       | Balanced — good general-purpose chain |
| ZkRapid    | ZK          | 3.0 gwei | 300 ms       | Fastest finality, highest proof cost  |

Congestion dynamically changes every 4 seconds.  Fee surges quadratically with congestion; latency increases linearly.

---

## Routing Algorithm

The router scores each rollup across three normalised criteria:

```
score = w_fee × normFee + w_latency × normLatency + w_success × successProb
```

Weights depend on the user's routing preference:

| Preference | Fee weight | Latency weight | Success weight |
|------------|-----------|----------------|----------------|
| Cheapest   | 70%       | 15%            | 15%            |
| Fastest    | 10%       | 75%            | 15%            |
| Balanced   | 40%       | 40%            | 20%            |

---

## Quick Start

### Step 1 — Install dependencies

```bash
cd intentbridge
npm install
```

### Step 2 — Start the router (runs in demo/simulation mode, no blockchain needed)

```bash
npm run router
# → http://localhost:3001
```

### Step 3 — Open the frontend

Open `frontend/index.html` in your browser.  The "Router Online" status badge will turn green.

### Step 4 — (Optional) Deploy contracts to local Hardhat node

```bash
# Terminal 1
npm run node

# Terminal 2
npm run deploy
```

### Step 5 — Run benchmarks

```bash
npm run benchmark
# or: pip install matplotlib numpy && python3 analysis/benchmark.py
```

### Step 6 — (Optional) On-chain lifecycle demo

Requires a running local node (`npm run node`).  Deploys all contracts and
walks through the full intent lifecycle on-chain: submitIntent → recordRouting →
executeIntent → recordExecution / recordFailure.

```bash
# Terminal 1
npm run node

# Terminal 2
npm run demo-routing
```

### Step 7 — Run tests

```bash
npm test
# 53 tests: MockRollup, IntentRegistry, router scoring logic
```

---

## Technical Report

See [`docs/report.md`](docs/report.md) for:

- Full system architecture diagram
- Design assumptions and limitations
- Baseline comparison results and interpretation
- Scalability analysis
- Trust model summary

---

## Feature Requirements Checklist

| Requirement | Implementation |
|-------------|---------------|
| Intent interface (payment, swap, transfer) | `frontend/index.html` — intent form with type selector |
| Routing layer selecting between ≥2 environments | `router/server.js` — scores 3 simulated rollups |
| Routing criteria: cost, latency, congestion, success | `scoreAllRollups()` in server.js |
| Frontend showing route selection & execution status | Routing Decision panel + Intent History |
| Scalability & efficiency analysis | Analysis accordion in frontend + benchmark.py |

---

## Key Design Decisions

### Why off-chain routing?
On-chain scoring would require reading all rollup states within a single transaction — expensive and slow.  The off-chain router reads rollup state via API calls and can record the *routing decision hash* (keccak256 of the rationale) on-chain via `IntentRegistry`, providing auditability without on-chain computation cost.

> **Simulation note:** The demo router runs in in-memory simulation mode for fast UI demonstration — it does not submit on-chain transactions.  The `IntentRegistry` contract is fully deployed and supports `recordRouting()` / `recordExecution()` calls; wiring the router to a live node is a straightforward extension.

### Trust model
The router is a centralised trust point (see analysis section in frontend).  Mitigation: the routing algorithm is open-source; in production the reason hash would be stored on-chain for post-hoc verification.

### Fee model
`fee = baseFee × (1 + (congestion/100)²)` — quadratic surge matches EIP-1559 behaviour where fees spike faster than congestion during peak demand.

---

## Gas Analysis (observed on local Hardhat node, `npm run demo-routing`)

| Operation               | Observed Gas | Notes                                      |
|-------------------------|--------------|--------------------------------------------|
| Deploy MockRollup       | ~866,000     | per instance; 3 deployed                  |
| Deploy IntentRegistry   | ~943,000     |                                            |
| submitIntent()          | ~207,000     | first call; PENDING state write            |
| recordRouting()         | ~123,000     | PENDING → ROUTED; writes 6 fields          |
| executeIntent()         | ~233,000     | on MockRollup; writes ExecutedIntent struct|
| recordExecution()       | ~142,000     | ROUTED → EXECUTED; updates global stats    |
| recordFailure()         | ~32,000      | ROUTED → FAILED; minimal write             |

---

## Team Work Division (4 people)

| Member | Responsibility |
|--------|---------------|
| 1      | Smart contracts: MockRollup, IntentRegistry, deploy script |
| 2      | Router backend: scoring algorithm, REST API, simulation |
| 3      | Frontend: intent form, routing visualisation, analytics |
| 4      | Analysis: benchmark script, scalability report, presentation |
