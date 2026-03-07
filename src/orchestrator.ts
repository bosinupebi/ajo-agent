import Anthropic from "@anthropic-ai/sdk";
import readline from "readline";
import { ANTHROPIC_API_KEY } from "./config.js";
import { tools, handleTool, type ToolContext } from "./tools.js";

const SYSTEM_PROMPT = `You are an admin assistant managing an AjoV1 rotating savings pool on Ethereum Mainnet.

You control a wallet and can interact with the AjoV1 factory and savings pool contracts via tools.
A registration website is already running where members can sign up by submitting their Ethereum address.

Key facts:
- USDT on mainnet has 6 decimals: 1 USDT = 1,000,000 raw units
- When the user says "create a pool with X USDT contribution", convert X to raw units
- Payout timestamp = lastPayoutTimestamp + interval (read pool info to get these values)
- Always check ETH balance before sending transactions
- Report transaction hashes for every on-chain action
- Be concise but clear`;

export async function runChat(ctx: ToolContext): Promise<void> {
  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  const history: Anthropic.MessageParam[] = [];

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const prompt = (q: string) => new Promise<string>((resolve) => rl.question(q, resolve));

  console.log('\nAjo admin ready. Type your instructions (Ctrl+C to exit).\n');

  while (true) {
    const userInput = await prompt("You: ");
    if (!userInput.trim()) continue;

    history.push({ role: "user", content: userInput });

    // Agentic loop for this turn — Claude may call multiple tools before responding
    while (true) {
      const response = await client.messages.create({
        model: "claude-opus-4-6",
        max_tokens: 4096,
        system: SYSTEM_PROMPT,
        tools,
        messages: history,
      });

      history.push({ role: "assistant", content: response.content });

      // Print any text Claude emits
      const textBlocks = response.content.filter((b) => b.type === "text");
      if (textBlocks.length > 0) {
        process.stdout.write("\nClaude: ");
        for (const block of textBlocks) {
          if (block.type === "text") process.stdout.write(block.text);
        }
        process.stdout.write("\n\n");
      }

      if (response.stop_reason !== "tool_use") break;

      // Execute tool calls
      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const block of response.content) {
        if (block.type !== "tool_use") continue;
        console.log(`  [tool] ${block.name}`);
        let content: string;
        try {
          content = await handleTool(block.name, block.input as Record<string, unknown>, ctx);
        } catch (err) {
          content = `Error: ${err instanceof Error ? err.message : String(err)}`;
          console.error(`  [error] ${content}`);
        }
        toolResults.push({ type: "tool_result", tool_use_id: block.id, content });
      }

      history.push({ role: "user", content: toolResults });
    }
  }
}
