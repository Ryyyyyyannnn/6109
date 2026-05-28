/**
 * demo-auction.js — Multi-Solver Auction Lifecycle Demo
 * ======================================================
 * Walks through a full Multi-Solver auction on a local Hardhat node:
 *
 *   1. Deploy SolverRegistry + IntentAuction
 *   2. Register three Solvers with 1 ETH stake each
 *   3. Open an auction for one intent
 *   4. Each Solver submits a sealed commit (hash of their bid)
 *      • SolverA bids 8.0 gwei  (will reveal — eventual winner)
 *      • SolverB bids 10.0 gwei (will reveal — runner-up)
 *      • SolverC bids 5.0 gwei  (will NOT reveal — simulates censorship)
 *   5. Mine through commit window → reveal phase
 *   6. Only A and B reveal.  A wins at 8.0 gwei.
 *   7. Mine through reveal window → challenge phase
 *   8. A third party (challenger) presents SolverC's EIP-712 signed bid +
 *      matching commit hash.  Contract verifies, slashes A, promotes C,
 *      pays the challenger 50% of the slashed stake.
 *   9. Mine through challenge window
 *  10. settle() — records SolverC's success
 *
 * Run:
 *   npm run node            (Terminal 1 — keep running)
 *   npm run demo-auction    (Terminal 2)
 */

const hre = require("hardhat");
const { ethers } = hre;

// ── Helpers ───────────────────────────────────────────────────────────────────

async function mineBlocks(n) {
  await ethers.provider.send("hardhat_mine", ["0x" + n.toString(16)]);
}

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
    intentId, solver,
    quotedFeeGwei:   fee,
    quotedLatencyMs: latency,
    routePlanHash:   route,
    nonce,
  };
  return signer.signTypedData(domain, types, value);
}

const RULE   = "─".repeat(72);
const HEAVY  = "═".repeat(72);
const fmtETH = wei => `${ethers.formatEther(wei)} ETH`;

function banner(title) {
  console.log("\n" + HEAVY);
  console.log("  " + title);
  console.log(HEAVY);
}

function step(label, ...lines) {
  console.log("\n── " + label + " " + "─".repeat(Math.max(0, 68 - label.length)));
  for (const l of lines) console.log("  " + l);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const [deployer, user, solverA, solverB, solverC, challenger] = await ethers.getSigners();

  banner("Multi-Solver Auction Demo");
  console.log(`  Deployer    : ${deployer.address}`);
  console.log(`  User        : ${user.address}`);
  console.log(`  SolverA     : ${solverA.address}`);
  console.log(`  SolverB     : ${solverB.address}`);
  console.log(`  SolverC     : ${solverC.address}`);
  console.log(`  Challenger  : ${challenger.address}`);

  // ── 1. Deploy ────────────────────────────────────────────────────────────
  step("1. Deploy contracts");

  const SolverRegistry = await ethers.getContractFactory("SolverRegistry");
  const registry       = await SolverRegistry.deploy(deployer.address);
  await registry.waitForDeployment();

  const IntentAuction = await ethers.getContractFactory("IntentAuction");
  const auction       = await IntentAuction.deploy(await registry.getAddress());
  await auction.waitForDeployment();

  await (await registry.setAuction(await auction.getAddress())).wait();
  await (await registry.setTreasury(await auction.getAddress())).wait();

  console.log(`  SolverRegistry : ${await registry.getAddress()}`);
  console.log(`  IntentAuction  : ${await auction.getAddress()}`);
  console.log(`  treasury → auction (slashed funds flow into auction for reward split)`);

  // ── 2. Solver registration ───────────────────────────────────────────────
  step("2. Solver registration (1 ETH stake each)");

  const STAKE = ethers.parseEther("1.0");
  for (const [name, signer] of [["A", solverA], ["B", solverB], ["C", solverC]]) {
    await (await registry.connect(signer).register({ value: STAKE })).wait();
    const s = await registry.getSolver(signer.address);
    console.log(`  Solver${name}  active=${s.active}  stake=${fmtETH(s.stake)}`);
  }

  // ── 3. Open auction ──────────────────────────────────────────────────────
  step("3. User submits intent → auction opens");

  const INTENT_ID = ethers.id("intent-payment-100usdc");
  await (await auction.connect(user).startAuction(INTENT_ID)).wait();
  const aInit = await auction.getAuction(INTENT_ID);
  console.log(`  intentId            : ${INTENT_ID}`);
  console.log(`  commitDeadline    @ : block ${aInit.commitDeadline}`);
  console.log(`  revealDeadline    @ : block ${aInit.revealDeadline}`);
  console.log(`  challengeDeadline @ : block ${aInit.challengeDeadline}`);

  // ── 4. Solver commits (sealed bids) ──────────────────────────────────────
  step("4. Solvers commit sealed bids (fee hidden in keccak256)");

  const ROUTE = ethers.id("via-rollupA-fastpath");
  const bids = [
    { name: "A", signer: solverA, fee: 8n,  latency: 1200n, nonce: 11n, willReveal: true  },
    { name: "B", signer: solverB, fee: 10n, latency: 1100n, nonce: 22n, willReveal: true  },
    { name: "C", signer: solverC, fee: 5n,  latency: 1300n, nonce: 33n, willReveal: false },
  ];

  for (const b of bids) {
    const h = commitHash(b.signer.address, b.fee, b.latency, ROUTE, b.nonce);
    await (await auction.connect(b.signer).commitBid(INTENT_ID, h)).wait();
    console.log(`  Solver${b.name} commit  ${h.slice(0, 14)}…   (hidden fee=${b.fee} gwei)`);
  }

  // ── 5. Close commit window, enter reveal ─────────────────────────────────
  step("5. Mine to end of commit window → REVEAL phase");
  await mineToBlock(aInit.commitDeadline);
  console.log(`  block.number = ${await ethers.provider.getBlockNumber()}  (commitDeadline=${aInit.commitDeadline})`);

  // ── 6. Reveals — A & B reveal, C is censored / withheld ──────────────────
  step("6. Reveals — SolverC's reveal is SUPPRESSED (simulated censorship)");

  for (const b of bids) {
    if (!b.willReveal) {
      console.log(`  Solver${b.name} … ✗ did NOT reveal  (its low ${b.fee} gwei bid was censored)`);
      continue;
    }
    await (await auction.connect(b.signer).revealBid(
      INTENT_ID, b.fee, b.latency, ROUTE, b.nonce
    )).wait();
    console.log(`  Solver${b.name} reveal  fee=${b.fee} gwei  latency=${b.latency} ms`);
  }

  const afterReveal = await auction.getAuction(INTENT_ID);
  console.log(RULE);
  console.log(`  Provisional winner: Solver${afterReveal.winner === solverA.address ? "A" : "B"}  ` +
              `at ${afterReveal.winningFee} gwei`);
  console.log(`  But SolverC actually had a 5 gwei bid the user never saw…`);

  // ── 7. Mine to challenge phase ───────────────────────────────────────────
  step("7. Mine to end of reveal window → CHALLENGE phase");
  await mineToBlock(afterReveal.revealDeadline);
  console.log(`  block.number = ${await ethers.provider.getBlockNumber()}`);

  // ── 8. Challenge ─────────────────────────────────────────────────────────
  step("8. Challenger presents SolverC's signed bid + matching on-chain commit");

  const chainId = (await ethers.provider.getNetwork()).chainId;
  const domain = {
    name: "IntentAuction", version: "1", chainId,
    verifyingContract: await auction.getAddress(),
  };

  const cBid = bids.find(b => b.name === "C");
  const sigC = await signBid(
    solverC, domain, INTENT_ID, solverC.address,
    cBid.fee, cBid.latency, ROUTE, cBid.nonce
  );
  console.log(`  EIP-712 signature : ${sigC.slice(0, 22)}…`);
  console.log(`  Claimed bid       : ${cBid.fee} gwei (strictly < winning ${afterReveal.winningFee} gwei)`);

  const stakeBefore     = await registry.stakeOf(afterReveal.winner);
  const challengerBal0  = await ethers.provider.getBalance(challenger.address);

  const tx = await auction.connect(challenger).challenge(
    INTENT_ID, solverC.address,
    cBid.fee, cBid.latency, ROUTE, cBid.nonce, sigC
  );
  const r  = await tx.wait();
  const ev = r.logs
    .map(l => { try { return auction.interface.parseLog(l); } catch { return null; } })
    .find(e => e?.name === "AuctionDisputed");

  const stakeAfter      = await registry.stakeOf(ev.args.previousWinner);
  const challengerBal1  = await ethers.provider.getBalance(challenger.address);
  const gasUsed         = r.gasUsed * r.gasPrice;
  const challengerNet   = challengerBal1 - challengerBal0 + gasUsed;

  console.log(`  ✓ Slashed   ${ethers.formatEther(stakeBefore - stakeAfter)} ETH from previous winner`);
  console.log(`  ✓ Reward    ${fmtETH(ev.args.challengerReward)} → challenger`);
  console.log(`  ✓ Net to challenger (after gas): ${fmtETH(challengerNet)}`);
  console.log(RULE);

  const afterChallenge = await auction.getAuction(INTENT_ID);
  console.log(`  New winner: SolverC   winning fee: ${afterChallenge.winningFee} gwei   ` +
              `disputeCount: ${afterChallenge.disputeCount}`);

  // ── 9. Settle ────────────────────────────────────────────────────────────
  step("9. Mine to end of challenge window → settle");
  await mineToBlock(afterChallenge.challengeDeadline);
  await (await auction.connect(user).settle(INTENT_ID)).wait();

  const final     = await auction.getAuction(INTENT_ID);
  const successC  = (await registry.getSolver(solverC.address)).successCount;
  const slashedA  = (await registry.getSolver(solverA.address)).slashCount;
  const PHASE     = ["NONE", "COMMIT", "REVEAL", "CHALLENGE", "SETTLED"];

  console.log(`  Auction phase           : ${PHASE[final.phase]}`);
  console.log(`  SolverC successCount    : ${successC}`);
  console.log(`  SolverA slashCount      : ${slashedA}`);
  console.log(`  Auction contract balance: ${fmtETH(await ethers.provider.getBalance(await auction.getAddress()))}  (protocol treasury — 50% of slash)`);

  banner("Demo complete — Multi-Solver auction with dispute path verified");
  console.log("  Key properties demonstrated:");
  console.log("    • Sealed bids hide fees during commit window");
  console.log("    • Lowest revealed bid wins by default");
  console.log("    • A suppressed lower bid is provable post-hoc via EIP-712 + commit hash");
  console.log("    • Misbehaving solver is slashed; honest challenger is rewarded");
  console.log("    • Final winner reflects the actual best price, not the original reveal");
  console.log(HEAVY + "\n");
}

main().catch(e => { console.error(e); process.exit(1); });
