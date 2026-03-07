import type Anthropic from "@anthropic-ai/sdk";
import type { Address } from "viem";
import type { AdminAgent } from "./agents/AdminAgent.js";
import type { RegistrationServer } from "./server/RegistrationServer.js";
import { FACTORY_ADDRESS } from "./config.js";

export interface ToolContext {
  admin: AdminAgent;
  server: RegistrationServer;
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
      const result = await ctx.admin.createSavingsPool(
        FACTORY_ADDRESS as Address,
        intervalSeconds,
        contributionRaw
      );
      ctx.server.setPoolInfo({
        poolAddress: result.poolAddress,
        contribution: contributionRaw.toString(),
        interval: intervalSeconds.toString(),
        memberCount: 0,
        requiredCount: 0,
      });
      return `Pool deployed at ${result.poolAddress}. Tx: ${result.txHash}. Registration site is live.`;
    }

    case "get_registered_members": {
      const members = ctx.server.getRegisteredMembers();
      if (members.length === 0) return "No members have signed up yet.";
      return (
        `${members.length} member(s) registered:\n` +
        members.map((m) => `  ${m.address} — ${m.status}`).join("\n")
      );
    }

    case "wait_for_members": {
      const count = input.count as number;
      console.log(`\n[Waiting for ${count} member(s) to sign up at http://localhost:3000...]\n`);
      const addresses = await ctx.server.waitForMembers(count);
      return `${addresses.length} member(s) signed up: ${addresses.join(", ")}`;
    }

    case "add_members": {
      const poolAddress = input.pool_address as Address;
      const memberAddresses = input.member_addresses as Address[];
      const txHash = await ctx.admin.addMembers(poolAddress, memberAddresses);
      ctx.server.markMembersAdded(memberAddresses);
      return `Members added on-chain. Tx: ${txHash}`;
    }

    case "get_pool_info": {
      const poolAddress = input.pool_address as Address;
      const info = await ctx.admin.getPoolInfo(poolAddress);
      return (
        `Pool ${poolAddress}:\n` +
        `  balance:               ${info.balance} raw USDT (${Number(info.balance) / 1e6} USDT)\n` +
        `  interval:              ${info.interval}s (${Number(info.interval) / 86400} days)\n` +
        `  contribution:          ${info.contribution} raw USDT (${Number(info.contribution) / 1e6} USDT)\n` +
        `  lastProcessedInterval: ${info.lastProcessedInterval}\n` +
        `  lastPayoutTimestamp:   ${info.lastPayoutTimestamp}`
      );
    }

    case "trigger_payout": {
      const poolAddress = input.pool_address as Address;
      const timestamp = input.timestamp as number;
      const recipient = input.recipient as Address;
      const txHash = await ctx.admin.triggerPayout(poolAddress, timestamp, recipient);
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
    description: "Deploy a new AjoV1 savings pool. USDT (6 decimals) is always the contribution token.",
    input_schema: {
      type: "object",
      properties: {
        interval_seconds: {
          type: "number",
          description: "Interval duration in seconds (e.g. 604800 = 7 days)",
        },
        contribution_raw: {
          type: "number",
          description: "Contribution amount in raw USDT units (e.g. 1000000 = 1 USDT)",
        },
      },
      required: ["interval_seconds", "contribution_raw"],
    },
  },
  {
    name: "get_registered_members",
    description: "Check how many members have signed up via the registration website and their current status",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "wait_for_members",
    description: "Block until a specific number of members have signed up via the website. Use this when the user asks you to wait for N members.",
    input_schema: {
      type: "object",
      properties: {
        count: {
          type: "number",
          description: "Number of member signups to wait for",
        },
      },
      required: ["count"],
    },
  },
  {
    name: "add_members",
    description: "Add member addresses to the pool on-chain. Call get_registered_members first to get the addresses.",
    input_schema: {
      type: "object",
      properties: {
        pool_address: { type: "string", description: "The savings pool contract address" },
        member_addresses: {
          type: "array",
          items: { type: "string" },
          description: "Ethereum addresses to add as members",
        },
      },
      required: ["pool_address", "member_addresses"],
    },
  },
  {
    name: "get_pool_info",
    description: "Read pool state: balance, interval, contribution, lastProcessedInterval, lastPayoutTimestamp",
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
    description: "Trigger a payout to a recipient. Use lastPayoutTimestamp + interval as the timestamp. Read pool info first to get these values.",
    input_schema: {
      type: "object",
      properties: {
        pool_address: { type: "string" },
        timestamp: { type: "number", description: "Interval end timestamp (Unix seconds)" },
        recipient: { type: "string", description: "Recipient Ethereum address" },
      },
      required: ["pool_address", "timestamp", "recipient"],
    },
  },
];
