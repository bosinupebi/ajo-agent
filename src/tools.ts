import type Anthropic from "@anthropic-ai/sdk";
import type { Address } from "viem";
import type { AdminAgent } from "./agents/AdminAgent.js";
import type { RegistrationServer } from "./server/RegistrationServer.js";
import type { PoolManager } from "./PoolManager.js";
import { FACTORY_ADDRESS, REGISTRATION_PORT, TOKEN_ADDRESS } from "./config.js";

export interface ToolContext {
  admin: AdminAgent;
  server: RegistrationServer;
  poolManager: PoolManager;
}

export async function handleTool(
  name: string,
  input: Record<string, unknown>,
  ctx: ToolContext
): Promise<string> {
  switch (name) {
    case "get_admin_address": {
      const address = await ctx.admin.getAddress();
      return `Admin wallet: ${address}`;
    }

    case "get_eth_balance": {
      const balance = await ctx.admin.getEthBalance();
      return `ETH balance: ${balance} ETH`;
    }

    case "create_savings_pool": {
      const intervalSeconds = input.interval_seconds as number;
      const contributionRaw = input.contribution_raw as number;
      const requiredCount = input.required_count as number;
      const tokenAddress = (input.token_address as Address | undefined) ?? TOKEN_ADDRESS;
      const result = await ctx.admin.createSavingsPool(
        FACTORY_ADDRESS as Address,
        intervalSeconds,
        contributionRaw,
        tokenAddress
      );
      ctx.server.addPool({
        poolAddress: result.poolAddress,
        tokenAddress,
        contribution: contributionRaw.toString(),
        interval: intervalSeconds.toString(),
        requiredCount,
      });
      ctx.poolManager.watch(result.poolAddress, requiredCount);
      return `Pool deployed at ${result.poolAddress}. Tx: ${result.txHash}. Now visible on the registration site at http://localhost:${REGISTRATION_PORT}`;
    }

    case "get_registered_members": {
      const poolAddress = input.pool_address as string | undefined;
      const members = ctx.server.getRegisteredMembers(poolAddress);
      if (members.length === 0) return "No members have signed up yet.";
      return (
        `${members.length} member(s):\n` +
        members.map((m) => `  ${m.address} — ${m.status}`).join("\n")
      );
    }

    case "wait_for_members": {
      const poolAddress = input.pool_address as string;
      const count = input.count as number;
      console.log(`\n[Waiting for ${count} member(s) on pool ${poolAddress}...]\n`);
      const addresses = await ctx.server.waitForMembers(poolAddress, count);
      return `${addresses.length} member(s) signed up: ${addresses.join(", ")}`;
    }

    case "add_members": {
      const poolAddress = input.pool_address as Address;
      const memberAddresses = input.member_addresses as Address[];
      const txHash = await ctx.admin.addMembers(poolAddress, memberAddresses);
      ctx.server.markMembersAdded(poolAddress, memberAddresses);
      return `Members added on-chain. Tx: ${txHash}`;
    }

    case "get_pool_info": {
      const poolAddress = input.pool_address as Address;
      const info = await ctx.admin.getPoolInfo(poolAddress);
      const intervalSecs = Number(info.interval);
      const intervalLabel = intervalSecs < 86400
        ? `${Math.round(intervalSecs / 60)} min`
        : `${(intervalSecs / 86400).toFixed(1)} days`;
      return (
        `Pool ${poolAddress}:\n` +
        `  balance:               ${info.balance} raw units (${Number(info.balance) / 1e6})\n` +
        `  interval:              ${info.interval}s (${intervalLabel})\n` +
        `  contribution:          ${info.contribution} raw units (${Number(info.contribution) / 1e6})\n` +
        `  lastProcessedInterval: ${info.lastProcessedInterval}\n` +
        `  lastPayoutTimestamp:   ${info.lastPayoutTimestamp}\n` +
        `  nextIntervalEnd:       ${info.nextIntervalEndTimestamp}\n` +
        `  canPayoutNow:          ${info.canPayoutNow ? "YES — call trigger_payout now" : "NO — interval has not ended yet or next interval not created"}`
      );
    }

    case "trigger_payout": {
      const poolAddress = input.pool_address as Address;
      const recipient = input.recipient as Address;

      // Hard enforcement: recipient must be an added member of this pool
      const members = ctx.server.getRegisteredMembers(poolAddress);
      const isMember = members.some(
        (m) => m.address.toLowerCase() === recipient.toLowerCase() && m.status === "added"
      );
      if (!isMember) {
        return `Payout rejected: ${recipient} is not an added member of pool ${poolAddress}. Only members with status "added" can receive payouts.`;
      }

      // Use the interval's endTimestamp (not Date.now()) so the value is always
      // in the past relative to block.timestamp — avoids "Timestamp cannot be in the future".
      const info = await ctx.admin.getPoolInfo(poolAddress);
      const timestamp = Number(info.nextIntervalEndTimestamp);
      const txHash = await ctx.admin.triggerPayout(poolAddress, timestamp, recipient);
      ctx.server.recordPayout(poolAddress, { recipient, txHash, timestamp });
      return `Payout sent to ${recipient}. Tx: ${txHash}`;
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export const tools: Anthropic.Tool[] = [
  {
    name: "get_admin_address",
    description: "Get the admin wallet address",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_eth_balance",
    description: "Get the admin wallet ETH balance to check gas availability",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "create_savings_pool",
    description: "Deploy a new AjoV1 savings pool and register it on the website. The contribution token is an ERC-20 configured via TOKEN_ADDRESS.",
    input_schema: {
      type: "object",
      properties: {
        interval_seconds: {
          type: "number",
          description: "Interval duration in seconds (e.g. 604800 = 7 days)",
        },
        contribution_raw: {
          type: "number",
          description: "Contribution amount in raw token units (e.g. 1000000 = 1 token for a 6-decimal ERC-20)",
        },
        token_address: {
          type: "string",
          description: "Optional ERC-20 token address for contributions. Defaults to USDT on Ethereum Mainnet if not specified.",
        },
        required_count: {
          type: "number",
          description: "Number of members required to fill this pool. When reached the site shows 'Membership Closed'.",
        },
      },
      required: ["interval_seconds", "contribution_raw", "required_count"],
    },
  },
  {
    name: "get_registered_members",
    description: "Check who has signed up via the website, optionally filtered by pool address",
    input_schema: {
      type: "object",
      properties: {
        pool_address: {
          type: "string",
          description: "Optional: filter by a specific pool address",
        },
      },
      required: [],
    },
  },
  {
    name: "wait_for_members",
    description: "Block until a specific number of members have signed up for a pool. Use when the user asks you to wait for N members.",
    input_schema: {
      type: "object",
      properties: {
        pool_address: { type: "string", description: "The pool to watch" },
        count: { type: "number", description: "Number of signups to wait for" },
      },
      required: ["pool_address", "count"],
    },
  },
  {
    name: "add_members",
    description: "Add member addresses to the pool on-chain and update their status on the website.",
    input_schema: {
      type: "object",
      properties: {
        pool_address: { type: "string" },
        member_addresses: {
          type: "array",
          items: { type: "string" },
          description: "Addresses to add",
        },
      },
      required: ["pool_address", "member_addresses"],
    },
  },
  {
    name: "get_pool_info",
    description: "Read live pool state: balance, interval, contribution, lastProcessedInterval, lastPayoutTimestamp, nextIntervalEnd, and canPayoutNow. Always call this before trigger_payout.",
    input_schema: {
      type: "object",
      properties: {
        pool_address: { type: "string" },
      },
      required: ["pool_address"],
    },
  },
  {
    name: "trigger_payout",
    description: "Trigger a payout to a recipient. The timestamp is computed automatically — just provide pool_address and recipient. Only call this when get_pool_info shows canPayoutNow: YES.",
    input_schema: {
      type: "object",
      properties: {
        pool_address: { type: "string" },
        recipient: { type: "string", description: "Recipient Ethereum address" },
      },
      required: ["pool_address", "recipient"],
    },
  },
];
