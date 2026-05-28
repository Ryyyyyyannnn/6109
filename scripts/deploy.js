/**
 * Deploy IntentBridge contracts
 * ==============================
 * Deploys three simulated rollup environments with distinct characteristics,
 * then deploys the IntentRegistry.
 *
 * Usage:
 *   npx hardhat node               (terminal 1)
 *   npx hardhat run scripts/deploy.js --network localhost   (terminal 2)
 */

const hre = require("hardhat");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  console.log("Deployer:", deployer.address);

  // ── Deploy test tokens ─────────────────────────────────────────────────────
  const Token = await hre.ethers.getContractFactory("MockToken");
  const usdc  = await Token.deploy("Mock USDC", "mUSDC");
  const eth   = await Token.deploy("Mock WETH", "mWETH");
  await usdc.waitForDeployment();
  await eth.waitForDeployment();
  console.log("mUSDC :", await usdc.getAddress());
  console.log("mWETH :", await eth.getAddress());

  // ── Deploy three simulated rollups ─────────────────────────────────────────
  //
  //  Fee constructor args use integer tenths-of-a-gwei (× MockRollup.FEE_SCALE = 10).
  //  Divide by 10 to get real gwei values shown in the router/frontend.
  //
  //  RollupA — ArbiNova (Arbitrum-style optimistic)
  //    baseFee = 5  → 0.5 gwei   (Arbitrum One median, l2fees.info 2024 Q4)
  //    latency = 2000 ms          (soft-confirmation; L1 finality: 7-day challenge window)
  //
  //  RollupB — OptiSwift (Optimism / Base-style optimistic)
  //    baseFee = 12 → 1.2 gwei   (OP Mainnet / Base typical, l2fees.info 2024 Q4)
  //    latency = 800 ms           (faster sequencer; same 7-day challenge window)
  //
  //  RollupC — ZkRapid (zkSync Era-style ZK rollup)
  //    baseFee = 30 → 3.0 gwei   (ZK proof overhead adds ~3–5× vs optimistic)
  //    latency = 300 ms           (soft-confirm; L1 finality: ~1h validity proof posting)

  const Rollup = await hre.ethers.getContractFactory("MockRollup");

  const rollupA = await Rollup.deploy("ArbiNova",  "optimistic", 5,  2000, 10);
  const rollupB = await Rollup.deploy("OptiSwift", "optimistic", 12, 800,  35);
  const rollupC = await Rollup.deploy("ZkRapid",   "zk",         30, 300,  55);

  await rollupA.waitForDeployment();
  await rollupB.waitForDeployment();
  await rollupC.waitForDeployment();

  const addrA = await rollupA.getAddress();
  const addrB = await rollupB.getAddress();
  const addrC = await rollupC.getAddress();

  console.log("RollupA (ArbiNova) :", addrA);
  console.log("RollupB (OptiSwift):", addrB);
  console.log("RollupC (ZkRapid)  :", addrC);

  // ── Deploy IntentRegistry ─────────────────────────────────────────────────
  const Registry = await hre.ethers.getContractFactory("IntentRegistry");
  const registry = await Registry.deploy(deployer.address);
  await registry.waitForDeployment();
  const addrReg = await registry.getAddress();
  console.log("IntentRegistry     :", addrReg);

  // ── Deploy Multi-Solver auction stack ─────────────────────────────────────
  //
  // SolverRegistry handles Solver stake and is the slash authority.
  // IntentAuction runs commit-reveal sealed-bid auctions and is the only
  // address allowed to call slash().  We wire the registry's treasury to
  // the auction contract so slashed funds flow there for the challenger
  // reward split.
  const SolverRegistry = await hre.ethers.getContractFactory("SolverRegistry");
  const solverReg      = await SolverRegistry.deploy(deployer.address);
  await solverReg.waitForDeployment();
  const addrSolverReg  = await solverReg.getAddress();

  const IntentAuction = await hre.ethers.getContractFactory("IntentAuction");
  const auction       = await IntentAuction.deploy(addrSolverReg);
  await auction.waitForDeployment();
  const addrAuction   = await auction.getAddress();

  await (await solverReg.setAuction (addrAuction)).wait();
  await (await solverReg.setTreasury(addrAuction)).wait();

  console.log("SolverRegistry     :", addrSolverReg);
  console.log("IntentAuction      :", addrAuction);

  // ── Mint test tokens ──────────────────────────────────────────────────────
  const amount = hre.ethers.parseEther("1000000");
  await usdc.mint(deployer.address, amount);
  await eth.mint(deployer.address, amount);
  console.log("Minted 1M mUSDC and 1M mWETH to deployer");

  // ── Print config for router/frontend ─────────────────────────────────────
  console.log("\n── Paste into router/.env ──────────────────────────────");
  console.log(`REGISTRY_ADDRESS=${addrReg}`);
  console.log(`SOLVER_REGISTRY_ADDRESS=${addrSolverReg}`);
  console.log(`INTENT_AUCTION_ADDRESS=${addrAuction}`);
  console.log(`ROLLUP_A_ADDRESS=${addrA}`);
  console.log(`ROLLUP_B_ADDRESS=${addrB}`);
  console.log(`ROLLUP_C_ADDRESS=${addrC}`);
  console.log(`TOKEN_USDC=${await usdc.getAddress()}`);
  console.log(`TOKEN_WETH=${await eth.getAddress()}`);
  console.log(`RPC_URL=http://127.0.0.1:8545`);
  console.log(`DEPLOYER_ADDRESS=${deployer.address}`);
  console.log(`# PRIVATE_KEY=<paste Hardhat account #0 private key here>  # shown by 'npm run node'`);
  console.log("────────────────────────────────────────────────────────\n");
}

main().catch(e => { console.error(e); process.exit(1); });
