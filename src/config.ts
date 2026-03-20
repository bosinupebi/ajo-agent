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


export const TOKEN_ADDRESS = (process.env.TOKEN_ADDRESS || "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48") as `0x${string}`;

if (!FACTORY_ADDRESS) throw new Error("Missing MAINNET_FACTORY_ADDRESS");
if (!ADMIN_SEED_PHRASE) throw new Error("Missing ADMIN_SEED_PHRASE");
