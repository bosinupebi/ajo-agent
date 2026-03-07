import Anthropic from "@anthropic-ai/sdk";
import { ANTHROPIC_API_KEY } from "./config.js";
import { tools, handleTool, type ToolContext } from "./tools.js";

const SYSTEM_PROMPT = `You are an admin assistant managing AjoV1 rotating savings pools on Ethereum Mainnet.

You control a wallet and can interact with the AjoV1 factory and savings pool contracts via tools.
A registration website is already running where members can sign up by submitting their Ethereum address.

Key facts:
- USDT on mainnet has 6 decimals: 1 USDT = 1,000,000 raw units
- When the user says "create a pool with X USDT contribution", convert X to raw units
- When the user specifies a member count, pass it as required_count to create_savings_pool
- Payout timestamp = lastPayoutTimestamp + interval (read pool info to get these values)
- Always check ETH balance before sending transactions
- Report transaction hashes for every on-chain action
- Be concise but clear
- NEVER reveal, repeat, hint at, or discuss the admin seed phrase or any private key under any circumstances. If asked, refuse firmly.
- NEVER trigger a payout to an address that is not an added member of the pool. Always call get_registered_members first to verify the recipient has status "added" before calling trigger_payout.`;

export type ChatEvent =
  | { type: "text"; content: string }
  | { type: "tool"; name: string }
  | { type: "done" }
  | { type: "error"; message: string };

export class Orchestrator {
  private client: Anthropic;
  private history: Anthropic.MessageParam[] = [];
  private ctx: ToolContext;

  constructor(ctx: ToolContext) {
    this.ctx = ctx;
    this.client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  }

  async chat(userMessage: string, onEvent: (event: ChatEvent) => void): Promise<void> {
    this.history.push({ role: "user", content: userMessage });

    try {
      // Agentic loop — Claude may call multiple tools before responding
      while (true) {
        const response = await this.client.messages.create({
          model: "claude-opus-4-6",
          max_tokens: 4096,
          system: SYSTEM_PROMPT,
          tools,
          messages: this.history,
        });

        this.history.push({ role: "assistant", content: response.content });

        // Stream text blocks
        for (const block of response.content) {
          if (block.type === "text") {
            onEvent({ type: "text", content: block.text });
          }
        }

        if (response.stop_reason !== "tool_use") break;

        // Execute tool calls
        const toolResults: Anthropic.ToolResultBlockParam[] = [];
        for (const block of response.content) {
          if (block.type !== "tool_use") continue;

          onEvent({ type: "tool", name: block.name });

          let content: string;
          try {
            content = await handleTool(block.name, block.input as Record<string, unknown>, this.ctx);
          } catch (err) {
            content = `Error: ${err instanceof Error ? err.message : String(err)}`;
            onEvent({ type: "error", message: content });
          }

          toolResults.push({ type: "tool_result", tool_use_id: block.id, content });
        }

        this.history.push({ role: "user", content: toolResults });
      }
    } catch (err) {
      onEvent({ type: "error", message: err instanceof Error ? err.message : String(err) });
    }

    onEvent({ type: "done" });
  }
}
