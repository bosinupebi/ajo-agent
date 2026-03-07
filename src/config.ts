import { config } from "dotenv";
import { fileURLToPath } from "url";
import { join, dirname } from "path";

// Load .env relative to this file so it works regardless of cwd
config({ path: join(dirname(fileURLToPath(import.meta.url)), "../.env") });

export const ETH_RPC_URL = process.env.ETH_RPC_URL || "https://eth.drpc.org";
export const FACTORY_ADDRESS = process.env.MAINNET_FACTORY_ADDRESS as string;
export const ADMIN_SEED_PHRASE = process.env.ADMIN_SEED_PHRASE as string;
export const REGISTRATION_PORT = parseInt(process.env.REGISTRATION_PORT || "3000", 10);
export const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY as string;


export const USDT_ADDRESS = "0xdAC17F958D2ee523a2206206994597C13D831ec7" as const;

if (!FACTORY_ADDRESS) throw new Error("Missing MAINNET_FACTORY_ADDRESS");
if (!ADMIN_SEED_PHRASE) throw new Error("Missing ADMIN_SEED_PHRASE");
