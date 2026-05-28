/**
 * demo-routing.js — IntentBridge contract lifecycle demo
 * =======================================================
 * Deploys all contracts to a local Hardhat node, then walks through the full
 * intent lifecycle on-chain:
 *
 *   User         → registry.submitIntent()          → PENDING
 *   Router       → registry.recordRouting()         → ROUTED
 *   Router       → rollup.executeIntent()           → (on selected rollup)
 *   Router       → registry.recordExecution()       → EXECUTED
 *   (second intent shows the FAILED path as well)
 *
 * Run:
 *   npm run node              (Terminal 1 — keep running)
 *   npm run demo-routing      (Terminal 2)
 *
 * This script proves that IntentRegistry's full state machine is reachable
 * and that the off-chain router can close the loop on-chain.
 */

const hre = require("hardhat");

// ─── Inline routing algorithm (mirrors server.js) ─────────────────────────────

const WEIGHTS = {
  cheapest: { fee: 0.70, latency: 0.15, success: 0.15 },
  fastest:  { fee: 0.10, latency: 0.75, success: 0.15 },
  balanced: { fee: 0.40, latency: 0.40, success: 0.20 },
};

const FEE_SCALE = 10n; // matches MockRollup.FEE_SCALE

function scoreRollups(stats, preference) {
  const w = WEIGHTS[preference] ?? WEIGHTS.balanced;

  const fees      = stats.map(s => Number(s.fee)     / Number(FEE_SCALE));
  const latencies = stats.map(s => Number(s.latency));
  const succs     = stats.map(s => Number(s.successBps) / 10_000);

  const minFee = Math.min(...fees);
  const maxFee = Math.max(...fees);
  const minLat = Math.min(...latencies);
  const maxLat = Math.max(...latencies);

  const scores = fees.map((f, i) => {
    const nf = 1 - (f - minFee) / (maxFee - minFee + 1e-9);
    const nl = 1 - (latencies[i] - minLat) / (maxLat - minLat + 1e-9);
    return w.fee * nf + w.latency * nl + w.success * succs[i];
  });

  const best = scores.indexOf(Math.max(...scores));
  return {
    index:     best,
    score:     Math.round(scores[best] * 10_000), // 0–10000
    feeGwei:   fees[best],
    latencyMs: latencies[best],
  };
}

// ─── Helper: print intent state ───────────────────────────────────────────────

const STATUS_NAMES = ["PENDING", "ROUTED", "EXECUTED", "FAILED"];

async function printIntent(registry, id, label) {
  const intent = await registry.getIntent(id);
  const status = STATUS_NAMES[Number(intent.status)] ?? "?";
  console.log(`\n  [${label}]`);
  console.log(`    id         : ${id}`);
  console.log(`    status     : ${status}`);
  if (Number(intent.status) >= 1) {
    console.log(`    rollup idx : ${intent.selectedRollupIndex}`);
    console.log(`    est fee    : ${intent.estimatedFeeGwei} (tenths-gwei)`);
    console.log(`    est latency: ${intent.estimatedLatencyMs} ms`);
    console.log(`    score      : ${intent.routeScore} / 10000`);
  }
  if (Number(intent.status) >= 2) {
    console.log(`    actual fee : ${intent.actualFeeGwei} (tenths-gwei)`);
    console.log(`    fee saved  : ${intent.feeSavedGwei} (tenths-gwei)`);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const [deployer, user] = await hre.ethers.getSigners();
  console.log("=".repeat(70));
  console.log("  IntentBridge — On-Chain Contract Lifecycle Demo");
  console.log("=".repeat(70));
  console.log(`\n  Deployer : ${deployer.address}`);
  console.log(`  User     : ${user.address}`);

  // ── 1. Deploy contracts ──────────────────────────────────────────────────

  console.log("\n── Deploying contracts ─────────────────────────────────────────");

  const Rollup   = await hre.ethers.getContractFactory("MockRollup");
  const rollupA  = await Rollup.deploy("ArbiNova",  "optimistic",  5, 2000, 10);
  const rollupB  = await Rollup.deploy("OptiSwift", "optimistic", 12,  800, 35);
  const rollupC  = await Rollup.deploy("ZkRapid",   "zk",         30,  300, 55);
  await rollupA.waitForDeployment();
  await rollupB.waitForDeployment();
  await rollupC.waitForDeployment();

  const Registry = await hre.ethers.getContractFactory("IntentRegistry");
  const registry = await Registry.deploy(deployer.address);
  await registry.waitForDeployment();

  const rollups = [rollupA, rollupB, rollupC];
  const names   = ["ArbiNova", "OptiSwift", "ZkRapid"];

  console.log(`  ArbiNova   : ${await rollupA.getAddress()}`);
  console.log(`  OptiSwift  : ${await rollupB.getAddress()}`);
  console.log(`  ZkRapid    : ${await rollupC.getAddress()}`);
  console.log(`  Registry   : ${await registry.getAddress()}`);

  // ── 2. Query rollup states ────────────────────────────────────────────────

  console.log("\n── Current rollup states ───────────────────────────────────────");
  const stats = [];
  for (let i = 0; i < rollups.length; i++) {
    const s = await rollups[i].getStats();
    stats.push({ fee: s.fee, latency: s.latency, successBps: s.successBps });
    const feeReal = (Number(s.fee) / Number(FEE_SCALE)).toFixed(2);
    console.log(
      `  ${names[i].padEnd(10)}: fee ${feeReal} gwei  ` +
      `latency ${s.latency} ms  congestion ${s.congestion}%  ` +
      `success ${(Number(s.successBps) / 100).toFixed(1)}%`
    );
  }

  // ── 3. Run off-chain routing algorithm ──────────────────────────────────

  const preference = "balanced";
  const result     = scoreRollups(stats, preference);
  const winner     = rollups[result.index];
  const winnerName = names[result.index];

  console.log(`\n── Off-chain routing decision (${preference}) ─────────────────────`);
  console.log(`  Selected rollup : ${winnerName}  (index ${result.index})`);
  console.log(`  Score           : ${result.score} / 10000`);
  console.log(`  Est. fee        : ${result.feeGwei.toFixed(4)} gwei`);
  console.log(`  Est. latency    : ${result.latencyMs} ms`);

  // Build a reason hash (keccak256 of a JSON summary — mirrors production use)
  const reasonStr  = JSON.stringify({
    preference, winner: winnerName, score: result.score,
    feeGwei: result.feeGwei, latencyMs: result.latencyMs,
  });
  const reasonHash = hre.ethers.keccak256(hre.ethers.toUtf8Bytes(reasonStr));
  console.log(`  Reason hash     : ${reasonHash}`);
  console.log(`  Reason string   : ${reasonStr}`);

  // ── 4. Intent 1 — happy path (PENDING → ROUTED → EXECUTED) ──────────────

  console.log("\n── Intent 1: happy path ────────────────────────────────────────");

  const PAYMENT = 0, BALANCED = 2;
  const amount  = hre.ethers.parseUnits("100", 6); // 100 USDC (6 decimals)

  const submitTx = await registry.connect(deployer).submitIntent(
    user.address,
    PAYMENT,
    amount,
    hre.ethers.ZeroAddress,  // token = ETH (no ERC-20 address)
    user.address,             // recipient = user
    BALANCED
  );
  const submitReceipt = await submitTx.wait();

  // Parse IntentSubmitted event to get the id
  const submitEvent = submitReceipt.logs
    .map(log => { try { return registry.interface.parseLog(log); } catch { return null; } })
    .find(e => e?.name === "IntentSubmitted");
  const intentId = submitEvent.args.id;

  await printIntent(registry, intentId, "after submitIntent");

  // Router records the routing decision on-chain
  await (await registry.connect(deployer).recordRouting(
    intentId,
    result.index,
    Math.round(result.feeGwei * 10),  // convert to tenths-gwei to match FEE_SCALE
    result.latencyMs,
    result.score,
    reasonHash
  )).wait();

  await printIntent(registry, intentId, "after recordRouting");

  // Router executes on the selected rollup
  const execTx      = await winner.connect(deployer).executeIntent(
    intentId, user.address, PAYMENT, amount
  );
  const execReceipt = await execTx.wait();
  const execEvent   = execReceipt.logs
    .map(log => { try { return winner.interface.parseLog(log); } catch { return null; } })
    .find(e => e?.name === "IntentExecuted");

  const actualFee  = execEvent.args.feeGwei;
  const maxFeeRaw  = Math.max(...stats.map(s => Number(s.fee)));
  const feeSaved   = BigInt(maxFeeRaw) > actualFee ? BigInt(maxFeeRaw) - actualFee : 0n;

  // Router closes the loop in IntentRegistry
  await (await registry.connect(deployer).recordExecution(
    intentId, actualFee, feeSaved
  )).wait();

  await printIntent(registry, intentId, "after recordExecution");

  // ── 5. Intent 2 — failure path (PENDING → ROUTED → FAILED) ──────────────

  console.log("\n── Intent 2: failure path ──────────────────────────────────────");

  const TOKEN_SWAP = 1;
  const submitTx2 = await registry.connect(deployer).submitIntent(
    user.address, TOKEN_SWAP, amount, hre.ethers.ZeroAddress, user.address, BALANCED
  );
  const receipt2  = await submitTx2.wait();
  const event2    = receipt2.logs
    .map(log => { try { return registry.interface.parseLog(log); } catch { return null; } })
    .find(e => e?.name === "IntentSubmitted");
  const intentId2 = event2.args.id;

  await printIntent(registry, intentId2, "after submitIntent");

  await (await registry.connect(deployer).recordRouting(
    intentId2, result.index, Math.round(result.feeGwei * 10), result.latencyMs,
    result.score, reasonHash
  )).wait();

  await (await registry.connect(deployer).recordFailure(
    intentId2, "Simulated: sequencer rejected tx — nonce conflict"
  )).wait();

  await printIntent(registry, intentId2, "after recordFailure");

  // ── 6. Global stats ───────────────────────────────────────────────────────

  console.log("\n── Global registry stats ───────────────────────────────────────");
  const [total, executed, feeSavedTotal] = await registry.getGlobalStats();
  console.log(`  Total submitted : ${total}`);
  console.log(`  Total executed  : ${executed}`);
  console.log(`  Total fee saved : ${feeSavedTotal} tenths-gwei`);

  console.log("\n" + "=".repeat(70));
  console.log("  Demo complete — full contract lifecycle verified on-chain.");
  console.log("  submitIntent → recordRouting → executeIntent → recordExecution");
  console.log("  The reason hash above can be stored as an audit trail.");
  console.log("=".repeat(70));
}

main().catch(e => { console.error(e); process.exit(1); });
