import type { Address } from "viem";
import { ADMIN_SEED_PHRASE, ETH_RPC_URL, REGISTRATION_PORT } from "./config.js";
import { AdminAgent } from "./agents/AdminAgent.js";
import { RegistrationServer } from "./server/RegistrationServer.js";
import { PoolManager } from "./PoolManager.js";
import { Orchestrator } from "./orchestrator.js";

async function main() {
  const WdkManager = (await import("@tetherto/wdk")).default;
  const WalletManagerEvm = (await import("@tetherto/wdk-wallet-evm")).default;

  const wdk = new WdkManager(ADMIN_SEED_PHRASE);
  wdk.registerWallet("ethereum", WalletManagerEvm, { provider: ETH_RPC_URL });
  const account = await wdk.getAccount("ethereum");

  const admin = new AdminAgent(account);
  const server = new RegistrationServer();
  const poolManager = new PoolManager(admin, server);
  const orchestrator = new Orchestrator({ admin, server, poolManager });

  server.setOrchestrator(orchestrator);
  await server.start();

  // Resume payout tracking for any closed pools persisted from a previous session
  const closedPools = server.getClosedPools();
  if (closedPools.length > 0) {
    console.log(`[Startup] Resuming payout tracking for ${closedPools.length} closed pool(s)...`);
    for (const pool of closedPools) {
      poolManager.resume(pool.poolAddress as Address);
    }
  }

  console.log(`Open http://localhost:${REGISTRATION_PORT} to manage pools and chat with the agent.`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
