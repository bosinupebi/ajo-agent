import "dotenv/config";
import { ADMIN_SEED_PHRASE, ETH_RPC_URL, REGISTRATION_PORT } from "./config.js";
import { AdminAgent } from "./agents/AdminAgent.js";
import { RegistrationServer } from "./server/RegistrationServer.js";
import { runChat } from "./orchestrator.js";

async function main() {
  const WdkManager = (await import("@tetherto/wdk")).default;
  const WalletManagerEvm = (await import("@tetherto/wdk-wallet-evm")).default;

  const wdk = new WdkManager(ADMIN_SEED_PHRASE);
  wdk.registerWallet("ethereum", WalletManagerEvm, { provider: ETH_RPC_URL });
  const account = await wdk.getAccount("ethereum");

  const admin = new AdminAgent(account);
  const server = new RegistrationServer();

  await server.start();
  console.log(`Registration site: http://localhost:${REGISTRATION_PORT}`);

  await runChat({ admin, server });
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
