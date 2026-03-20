import express, { type Request, type Response } from "express";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { encodeFunctionData, createPublicClient, http, type Address } from "viem";
import { mainnet } from "viem/chains";
import { REGISTRATION_PORT, ETH_RPC_URL, TOKEN_ADDRESS } from "../config.js";
import { erc20Abi, savingsPoolAbi } from "../abis.js";
import type { Orchestrator } from "../orchestrator.js";

const DB_PATH = join(dirname(fileURLToPath(import.meta.url)), "../../data/store.json");

export type MemberStatus = "pending" | "added";
export type PoolStatus = "open" | "closed";

export interface PoolRecord {
  poolAddress: string;
  contribution: string;
  interval: string;
  requiredCount: number;
  status: PoolStatus;
  createdAt: string;
}

interface MemberRecord {
  address: string;
  poolAddress: string;
  status: MemberStatus;
  joinedAt: string;
}

export interface PayoutRecord {
  recipient: string;
  txHash: string;
  timestamp: number;
  paidAt: string;
}

interface WaitHandle {
  poolAddress: string;
  count: number;
  resolve: (addresses: Address[]) => void;
}

export class RegistrationServer {
  private app = express();
  private pools = new Map<string, PoolRecord>();
  private members = new Map<string, MemberRecord>();
  private payouts = new Map<string, PayoutRecord[]>();
  private payoutWarnings = new Map<string, string>();
  private waitHandles: WaitHandle[] = [];
  private orchestrator: Orchestrator | null = null;
  private publicClient = createPublicClient({ chain: mainnet, transport: http(ETH_RPC_URL) });

  constructor() {
    this.loadFromDisk();
    this.setup();
  }

  private loadFromDisk() {
    if (!existsSync(DB_PATH)) return;
    try {
      const raw = JSON.parse(readFileSync(DB_PATH, "utf8"));
      if (raw.pools) this.pools = new Map(Object.entries(raw.pools));
      if (raw.members) this.members = new Map(Object.entries(raw.members));
      if (raw.payouts) this.payouts = new Map(Object.entries(raw.payouts) as [string, PayoutRecord[]][]);
      console.log(`[Server] Loaded persisted data from ${DB_PATH}`);
    } catch (err) {
      console.warn(`[Server] Could not load persisted data: ${err}`);
    }
  }

  private saveToDisk() {
    try {
      mkdirSync(dirname(DB_PATH), { recursive: true });
      const data = {
        pools: Object.fromEntries(this.pools),
        members: Object.fromEntries(this.members),
        payouts: Object.fromEntries(this.payouts),
      };
      writeFileSync(DB_PATH, JSON.stringify(data, null, 2), "utf8");
    } catch (err) {
      console.warn(`[Server] Could not save data: ${err}`);
    }
  }

  // ─── Public API ──────────────────────────────────────────────────────────────

  setOrchestrator(orchestrator: Orchestrator) {
    this.orchestrator = orchestrator;
  }

  addPool(info: Omit<PoolRecord, "status" | "createdAt">) {
    const key = info.poolAddress.toLowerCase();
    this.pools.set(key, { ...info, status: "open", createdAt: new Date().toISOString() });
    console.log(`[Server] Pool registered: ${info.poolAddress}`);
    this.saveToDisk();
  }

  getRegisteredMembers(poolAddress?: string) {
    const all = [...this.members.values()];
    if (!poolAddress) return all;
    const key = poolAddress.toLowerCase();
    return all.filter((m) => m.poolAddress === key);
  }

  recordPayout(poolAddress: string, payout: Omit<PayoutRecord, "paidAt">) {
    const key = poolAddress.toLowerCase();
    if (!this.payouts.has(key)) this.payouts.set(key, []);
    this.payouts.get(key)!.push({ ...payout, paidAt: new Date().toISOString() });
    console.log(`[Server] Payout recorded for pool ${key}: ${payout.recipient}`);
    this.saveToDisk();
  }

  markMembersAdded(poolAddress: string, addresses: Address[]) {
    for (const addr of addresses) {
      const key = `${poolAddress.toLowerCase()}:${addr.toLowerCase()}`;
      const m = this.members.get(key);
      if (m) m.status = "added";
    }
    this.saveToDisk();
  }

  getClosedPools(): PoolRecord[] {
    return [...this.pools.values()].filter((p) => p.status === "closed");
  }

  setPayoutWarning(poolAddress: string, message: string): void {
    this.payoutWarnings.set(poolAddress.toLowerCase(), message);
  }

  hasPayoutWarning(poolAddress: string): boolean {
    return this.payoutWarnings.has(poolAddress.toLowerCase());
  }

  clearPayoutWarning(poolAddress: string): void {
    this.payoutWarnings.delete(poolAddress.toLowerCase());
  }

  waitForMembers(poolAddress: string, count: number): Promise<Address[]> {
    return new Promise((resolve) => {
      this.waitHandles.push({ poolAddress: poolAddress.toLowerCase(), count, resolve });
      this.checkWaitHandles(poolAddress.toLowerCase());
    });
  }

  start(): Promise<void> {
    return new Promise((resolve) => {
      this.app.listen(REGISTRATION_PORT, () => {
        console.log(`[Server] Live at http://localhost:${REGISTRATION_PORT}`);
        resolve();
      });
    });
  }

  // ─── Private helpers ─────────────────────────────────────────────────────────

  private poolMemberCount(poolKey: string) {
    return [...this.members.values()].filter((m) => m.poolAddress === poolKey).length;
  }

  private checkWaitHandles(poolKey: string) {
    const pending = [...this.members.values()].filter(
      (m) => m.poolAddress === poolKey && m.status === "pending"
    );
    this.waitHandles = this.waitHandles.filter((h) => {
      if (h.poolAddress !== poolKey) return true;
      if (pending.length >= h.count) {
        h.resolve(pending.slice(0, h.count).map((m) => m.address as Address));
        return false;
      }
      return true;
    });
  }

  private tryJoin(rawAddress: string, rawPool: string) {
    const address = rawAddress.trim().toLowerCase();
    const poolKey = rawPool.trim().toLowerCase();

    if (!address.startsWith("0x") || address.length !== 42)
      return { ok: false, error: "Invalid Ethereum address." };

    const pool = this.pools.get(poolKey);
    if (!pool) return { ok: false, error: "Pool not found." };
    if (pool.status === "closed") return { ok: false, error: "Membership for this pool is closed." };

    const memberKey = `${poolKey}:${address}`;
    if (!this.members.has(memberKey)) {
      this.members.set(memberKey, { address, poolAddress: poolKey, status: "pending", joinedAt: new Date().toISOString() });
      console.log(`[Server] Member registered: ${address} → ${poolKey}`);

      const count = this.poolMemberCount(poolKey);
      if (count >= pool.requiredCount) {
        pool.status = "closed";
        console.log(`[Server] Pool ${poolKey} closed (${count}/${pool.requiredCount})`);
      }

      this.saveToDisk();
      this.checkWaitHandles(poolKey);
    }

    return { ok: true, pool };
  }

  // ─── Routes ──────────────────────────────────────────────────────────────────

  private setup() {
    this.app.use(express.json());
    this.app.use(express.urlencoded({ extended: true }));

    this.app.get("/", (_req, res) => res.send(this.renderPage()));

    this.app.post("/join", (req: Request, res: Response) => {
      const { address, pool_address } = req.body as { address?: string; pool_address?: string };
      const result = this.tryJoin(address ?? "", pool_address ?? "");
      if (req.accepts("html")) {
        return res.redirect(result.ok ? "/?joined=1" : `/?error=${encodeURIComponent(result.error ?? "error")}`);
      }
      if (!result.ok) return res.status(400).json({ error: result.error });
      return res.json({ poolAddress: result.pool!.poolAddress, status: "pending" });
    });

    this.app.get("/api/pools", (_req, res) => {
      const data = [...this.pools.values()].map((pool) => ({
        ...pool,
        memberCount: this.poolMemberCount(pool.poolAddress.toLowerCase()),
        members: this.getRegisteredMembers(pool.poolAddress),
        payouts: this.payouts.get(pool.poolAddress.toLowerCase()) ?? [],
        payoutWarning: this.payoutWarnings.get(pool.poolAddress.toLowerCase()) ?? null,
      }));
      res.json(data);
    });

    this.app.post("/api/pools/:address/clear-warning", (req: Request, res: Response) => {
      this.clearPayoutWarning(req.params.address);
      res.json({ ok: true });
    });

    this.app.get("/api/status/:address", (req: Request, res: Response) => {
      const address = req.params.address.toLowerCase();
      const memberships = [...this.members.values()].filter((m) => m.address === address);
      if (memberships.length === 0) return res.status(404).json({ status: "not_registered" });
      res.json(memberships);
    });

    // ── Agent-friendly transaction-builder endpoints ──────────────────────────
    // Returns encoded calldata so any agent (or wallet) can sign and broadcast.

    // GET /api/tx/approve?pool_address=0x...&amount=1000000
    // Returns the calldata to call token.approve(poolAddress, amount)
    this.app.get("/api/tx/approve", (req: Request, res: Response) => {
      const { pool_address, amount } = req.query as { pool_address?: string; amount?: string };
      if (!pool_address || !amount) return res.status(400).json({ error: "pool_address and amount (raw token units) are required" });

      const poolAddr = pool_address.trim();
      const pool = this.pools.get(poolAddr.toLowerCase());
      if (!pool) return res.status(404).json({ error: "Pool not found" });

      let amountBig: bigint;
      try { amountBig = BigInt(amount); } catch { return res.status(400).json({ error: "Invalid amount" }); }

      const data = encodeFunctionData({
        abi: erc20Abi,
        functionName: "approve",
        args: [poolAddr as Address, amountBig],
      });

      return res.json({
        to: TOKEN_ADDRESS,
        data,
        value: "0x0",
        chainId: 1,
        description: `Approve ${Number(amountBig) / 1e6} token spend for pool ${poolAddr}`,
      });
    });

    // GET /api/tx/contribute?pool_address=0x...&amount=1000000
    // Returns the calldata to call SavingsPool.contribute(amount)
    this.app.get("/api/tx/contribute", (req: Request, res: Response) => {
      const { pool_address, amount } = req.query as { pool_address?: string; amount?: string };
      if (!pool_address || !amount) return res.status(400).json({ error: "pool_address and amount (raw token units) are required" });

      const poolAddr = pool_address.trim();
      const pool = this.pools.get(poolAddr.toLowerCase());
      if (!pool) return res.status(404).json({ error: "Pool not found" });

      let amountBig: bigint;
      try { amountBig = BigInt(amount); } catch { return res.status(400).json({ error: "Invalid amount" }); }

      if (amountBig < BigInt(pool.contribution)) {
        return res.status(400).json({
          error: `Amount too low. Pool requires at least ${pool.contribution} raw units (${Number(pool.contribution) / 1e6} tokens)`,
        });
      }

      const data = encodeFunctionData({
        abi: savingsPoolAbi,
        functionName: "contribute",
        args: [amountBig],
      });

      return res.json({
        to: poolAddr,
        data,
        value: "0x0",
        chainId: 1,
        description: `Contribute ${Number(amountBig) / 1e6} tokens to pool ${poolAddr}`,
      });
    });

    // POST /api/broadcast  { signedTx: "0x..." }
    // Broadcasts a pre-signed raw transaction and returns the tx hash.
    this.app.post("/api/broadcast", async (req: Request, res: Response) => {
      const { signedTx } = req.body as { signedTx?: string };
      if (!signedTx?.startsWith("0x")) return res.status(400).json({ error: "signedTx (hex string) is required" });
      try {
        const txHash = await this.publicClient.sendRawTransaction({
          serializedTransaction: signedTx as `0x${string}`,
        });
        return res.json({ txHash });
      } catch (err) {
        return res.status(500).json({ error: String(err) });
      }
    });

    // SSE chat endpoint — streams Claude's response back to the browser
    this.app.post("/api/chat", async (req: Request, res: Response) => {
      const { message } = req.body as { message?: string };
      if (!message?.trim()) return res.status(400).json({ error: "Empty message" });
      if (!this.orchestrator) return res.status(503).json({ error: "Orchestrator not ready" });

      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");

      const send = (event: object) => res.write(`data: ${JSON.stringify(event)}\n\n`);

      await this.orchestrator.chat(message, (evt) => send(evt));
      res.end();
    });
  }

  // ─── HTML ─────────────────────────────────────────────────────────────────────

  private renderPage(): string {
    const pools = [...this.pools.values()];

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Ajo — Savings Pools</title>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/ethers/5.7.2/ethers.umd.min.js"></script>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, sans-serif; background: #f5f5f0; color: #1a1a1a; height: 100dvh; display: flex; flex-direction: column; overflow: hidden; }

    /* ── top bar ── */
    header { padding: .9rem 1.5rem; background: white; border-bottom: 1px solid #e8e8e4; display: flex; align-items: center; justify-content: space-between; gap: .75rem; flex-shrink: 0; }
    header h1 { font-size: 1.1rem; font-weight: 700; }
    header p { font-size: .8rem; color: #888; }
    .wallet-area { display: flex; flex-direction: column; align-items: flex-end; gap: .25rem; flex-shrink: 0; }
    .wallet-btn { background: #4f46e5; color: white; border: none; border-radius: 8px; padding: .45rem .9rem; font-size: .8rem; cursor: pointer; white-space: nowrap; }
    .wallet-btn.connected { background: #10b981; cursor: default; }
    .wallet-addr-display { font-size: .72rem; color: #10b981; font-family: monospace; }
    .disconnect-btn { background: none; border: 1px solid #fecaca; color: #991b1b; border-radius: 6px; padding: .18rem .55rem; font-size: .72rem; cursor: pointer; }
    .disconnect-btn:hover { background: #fef2f2; }
    /* ── wallet picker modal ── */
    .wallet-overlay { position: fixed; inset: 0; background: rgba(0,0,0,.45); z-index: 200; display: flex; align-items: center; justify-content: center; }
    .wallet-modal { background: white; border-radius: 14px; padding: 1.25rem 1.25rem 1rem; min-width: 230px; box-shadow: 0 8px 32px rgba(0,0,0,.18); }
    .wallet-modal-title { font-weight: 700; font-size: .9rem; margin-bottom: .85rem; }
    .wallet-option { display: flex; align-items: center; gap: .65rem; width: 100%; background: none; border: 1.5px solid #e8e8e4; border-radius: 9px; padding: .6rem .9rem; font-size: .85rem; font-weight: 500; cursor: pointer; margin-bottom: .45rem; text-align: left; transition: border-color .15s, background .15s; }
    .wallet-option:hover { border-color: #4f46e5; background: #f5f3ff; }
    .wallet-option-icon { font-size: 1.2rem; line-height: 1; }
    .wallet-modal-cancel { width: 100%; background: none; border: none; color: #aaa; font-size: .8rem; cursor: pointer; margin-top: .4rem; padding: .3rem; }
    .wallet-modal-cancel:hover { color: #555; }

    /* ── main layout ── */
    .layout { display: flex; flex: 1; overflow: hidden; }

    /* ── pools panel ── */
    .pools-panel { flex: 1; overflow-y: auto; padding: 1.25rem; display: flex; flex-direction: column; gap: 1rem; }
    .empty-notice { background: #ede9fe; color: #4338ca; border-radius: 10px; padding: .85rem 1rem; font-size: .85rem; }

    /* pool card */
    .pool-card { background: white; border-radius: 12px; padding: 1.25rem; box-shadow: 0 1px 6px rgba(0,0,0,.07); }
    .pool-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: .9rem; }
    .pool-title { font-size: .9rem; font-weight: 600; }
    .pool-address { font-size: .7rem; color: #aaa; word-break: break-all; margin-top: .1rem; font-family: monospace; }
    .pool-meta { display: grid; grid-template-columns: 1fr 1fr; gap: .5rem; margin-bottom: .9rem; }
    .meta-item .label { font-size: .68rem; color: #aaa; text-transform: uppercase; letter-spacing: .05em; }
    .meta-item .value { font-size: .85rem; font-weight: 600; margin-top: .1rem; }
    .progress-wrap { margin-bottom: .9rem; }
    .progress-label { display: flex; justify-content: space-between; font-size: .75rem; color: #666; margin-bottom: .3rem; }
    .progress-bar { background: #f0f0eb; border-radius: 999px; height: 7px; }
    .progress-fill { background: #4f46e5; height: 100%; border-radius: 999px; }
    .progress-fill.full { background: #10b981; }
    details.members-list summary { font-size: .75rem; color: #aaa; cursor: pointer; margin-bottom: .35rem; }
    .member-row { display: flex; justify-content: space-between; font-size: .75rem; padding: .28rem 0; border-bottom: 1px solid #f5f5f0; }
    .member-row:last-child { border-bottom: none; }
    .member-addr { font-family: monospace; color: #555; }
    form.join-form { display: flex; gap: .4rem; margin-top: .9rem; }
    form.join-form input { flex: 1; min-width: 0; padding: .5rem .8rem; border: 1.5px solid #ddd; border-radius: 8px; font-size: .8rem; }
    form.join-form input:focus { outline: none; border-color: #4f46e5; }
    form.join-form button { background: #4f46e5; color: white; border: none; border-radius: 8px; padding: .5rem 1rem; font-size: .8rem; cursor: pointer; }
    .closed-notice { background: #fef2f2; border: 1px solid #fecaca; border-radius: 8px; padding: .6rem .9rem; font-size: .8rem; color: #991b1b; margin-top: .9rem; }
    .payout-warning { background: #fffbeb; border: 1px solid #fcd34d; border-radius: 8px; padding: .6rem .9rem; font-size: .8rem; color: #92400e; margin-top: .9rem; display: flex; align-items: center; justify-content: space-between; gap: .5rem; }
    .dismiss-warning-btn { flex-shrink: 0; padding: .3rem .7rem; background: #92400e; color: #fff; border: none; border-radius: 5px; font-size: .75rem; cursor: pointer; }
    .dismiss-warning-btn:hover { background: #78350f; }
    .payout-tx { font-family: monospace; font-size: .72rem; color: #4f46e5; text-decoration: none; }
    .payout-tx:hover { text-decoration: underline; }

    /* badges */
    .badge { padding: .2rem .6rem; border-radius: 999px; font-size: .7rem; font-weight: 600; white-space: nowrap; }
    .badge.open { background: #d1fae5; color: #065f46; }
    .badge.closed { background: #fee2e2; color: #991b1b; }
    .badge.pending { background: #fef3c7; color: #92400e; }
    .badge.added { background: #d1fae5; color: #065f46; }

    /* ── pool actions (approve / contribute) ── */
    .pool-actions { border-top: 1px solid #f0f0eb; margin-top: .9rem; padding-top: .9rem; display: flex; flex-direction: column; gap: .75rem; }
    .action-group-title { font-size: .68rem; color: #aaa; text-transform: uppercase; letter-spacing: .05em; font-weight: 600; margin-bottom: .35rem; }
    .action-row { display: flex; gap: .4rem; align-items: center; }
    .action-row input[type="number"] { flex: 1; min-width: 0; padding: .45rem .7rem; border: 1.5px solid #ddd; border-radius: 8px; font-size: .8rem; }
    .action-row input[type="number"]:focus { outline: none; border-color: #4f46e5; }
    .action-btn { border: none; border-radius: 8px; padding: .45rem .9rem; font-size: .8rem; cursor: pointer; white-space: nowrap; font-weight: 600; }
    .action-btn.approve { background: #ede9fe; color: #4338ca; }
    .action-btn.approve:hover:not(:disabled) { background: #ddd6fe; }
    .action-btn.contribute { background: #d1fae5; color: #065f46; }
    .action-btn.contribute:hover:not(:disabled) { background: #a7f3d0; }
    .action-btn:disabled { opacity: .45; cursor: not-allowed; }
    .action-status { font-size: .72rem; padding: .3rem .6rem; border-radius: 6px; margin-top: .3rem; display: none; word-break: break-all; }
    .action-status.pending { display: block; background: #fef3c7; color: #92400e; }
    .action-status.success { display: block; background: #d1fae5; color: #065f46; }
    .action-status.error { display: block; background: #fee2e2; color: #991b1b; }
    .connect-prompt { font-size: .75rem; color: #aaa; margin-top: .9rem; padding-top: .9rem; border-top: 1px solid #f0f0eb; text-align: center; display: none; }

    /* ── divider ── */
    .divider { width: 1px; background: #e8e8e4; flex-shrink: 0; }

    /* ── chat panel ── */
    .chat-panel { width: 360px; display: flex; flex-direction: column; background: white; flex-shrink: 0; }
    .chat-panel-header { padding: .8rem 1rem; border-bottom: 1px solid #f0f0eb; font-size: .8rem; font-weight: 600; color: #555; flex-shrink: 0; }
    .chat-messages { flex: 1; overflow-y: auto; padding: .75rem; display: flex; flex-direction: column; gap: .6rem; }

    .msg { max-width: 90%; padding: .55rem .8rem; border-radius: 12px; font-size: .82rem; line-height: 1.45; word-break: break-word; }
    .msg.user { background: #4f46e5; color: white; align-self: flex-end; border-bottom-right-radius: 4px; }
    .msg.claude { background: #f4f4f1; color: #1a1a1a; align-self: flex-start; border-bottom-left-radius: 4px; }
    .msg.tool { background: #ede9fe; color: #4338ca; align-self: flex-start; font-size: .75rem; font-style: italic; border-radius: 8px; }
    .msg.error { background: #fef2f2; color: #991b1b; align-self: flex-start; font-size: .75rem; border-radius: 8px; }
    .msg a { color: inherit; text-decoration: underline; text-underline-offset: 2px; font-family: monospace; }
    .msg.user a { color: #c7d2fe; }
    .msg a:hover { opacity: .8; }

    .chat-input-wrap { padding: .75rem; border-top: 1px solid #f0f0eb; display: flex; gap: .4rem; flex-shrink: 0; }
    .chat-input-wrap textarea { flex: 1; padding: .55rem .8rem; border: 1.5px solid #ddd; border-radius: 10px; font-size: .82rem; resize: none; font-family: inherit; line-height: 1.4; height: 60px; }
    .chat-input-wrap textarea:focus { outline: none; border-color: #4f46e5; }
    .chat-input-wrap button { background: #4f46e5; color: white; border: none; border-radius: 10px; padding: 0 1rem; font-size: .82rem; cursor: pointer; align-self: stretch; }
    .chat-input-wrap button:disabled { opacity: .5; cursor: not-allowed; }

    @media (max-width: 700px) {
      .layout { flex-direction: column; }
      .chat-panel { width: 100%; height: 45dvh; }
      .divider { width: 100%; height: 1px; }
    }
  </style>
</head>
<body>
  <!-- Wallet picker modal -->
  <div id="wallet-overlay" class="wallet-overlay" style="display:none" role="dialog" aria-modal="true">
    <div class="wallet-modal">
      <div class="wallet-modal-title">Connect Wallet</div>
      <div id="wallet-options"></div>
      <button class="wallet-modal-cancel" id="wallet-cancel">Cancel</button>
    </div>
  </div>

  <header>
    <div>
      <h1>Ajo Savings Pools</h1>
      <p>Chat with the agent on the right · Members join via the pool cards · Page auto-refreshes every 60s</p>
    </div>
    <div class="wallet-area">
      <button id="wallet-btn" class="wallet-btn">Connect Wallet</button>
      <span id="wallet-addr-display" class="wallet-addr-display" style="display:none"></span>
      <button id="disconnect-btn" class="disconnect-btn" style="display:none">Disconnect</button>
    </div>
  </header>

  <div class="layout">
    <!-- Pools -->
    <div class="pools-panel" id="pools">
      ${pools.length === 0
        ? `<div class="empty-notice">No pools yet — ask the agent to create one.</div>`
        : pools.map((p) => this.renderPoolCard(p)).join("")}
    </div>

    <div class="divider"></div>

    <!-- Chat -->
    <div class="chat-panel">
      <div class="chat-panel-header">
        Agent
        <button id="clear-chat" style="float:right;background:none;border:none;font-size:.7rem;color:#bbb;cursor:pointer;padding:0">Clear</button>
      </div>
      <div class="chat-messages" id="messages"></div>
      <div class="chat-input-wrap">
        <textarea id="input" placeholder="Message the agent…" rows="2"></textarea>
        <button id="send">Send</button>
      </div>
    </div>
  </div>

  <script>
    // ── Constants ─────────────────────────────────────────────────────────────
    const TOKEN_ADDRESS = '${TOKEN_ADDRESS}';
    const ERC20_ABI = ['function approve(address spender, uint256 amount) returns (bool)'];
    const POOL_ABI = ['function contribute(uint256 amount)'];

    // ── Wallet state ─────────────────────────────────────────────────────────
    let connectedAddress = null;
    let activeProvider = null;

    // Detect all available wallet providers (Phantom first, then MetaMask, then generic)
    function getWalletProviders() {
      const list = [];
      if (window.phantom?.ethereum?.isPhantom) {
        list.push({ name: 'Phantom', icon: '◎', provider: window.phantom.ethereum });
      }
      if (window.ethereum?.isMetaMask && !window.ethereum?.isPhantom) {
        list.push({ name: 'MetaMask', icon: 'M', provider: window.ethereum });
      }
      if (list.length === 0 && window.ethereum) {
        list.push({ name: 'Browser Wallet', icon: '⬡', provider: window.ethereum });
      }
      return list;
    }

    async function connectWithProvider(provider, name) {
      try {
        const accounts = await provider.request({ method: 'eth_requestAccounts' });
        connectedAddress = accounts[0];
        activeProvider = provider;
        provider.on('accountsChanged', onAccountsChanged);
        updateWalletUI();
        setupAllPoolActions();
      } catch (err) {
        console.error('Wallet connection failed (' + name + '):', err);
      }
    }

    function onAccountsChanged(accounts) {
      connectedAddress = accounts.length > 0 ? accounts[0] : null;
      if (!connectedAddress) { activeProvider = null; }
      updateWalletUI();
      setupAllPoolActions();
    }

    function openWalletPicker() {
      const providers = getWalletProviders();
      if (providers.length === 0) {
        alert('No Web3 wallet detected. Please install Phantom or MetaMask.');
        return;
      }
      if (providers.length === 1) {
        connectWithProvider(providers[0].provider, providers[0].name);
        return;
      }
      // Multiple wallets — show picker modal
      const optionsEl = document.getElementById('wallet-options');
      optionsEl.innerHTML = providers.map((w, i) =>
        \`<button class="wallet-option" data-idx="\${i}">
          <span class="wallet-option-icon">\${w.icon}</span>
          <span>\${w.name}</span>
        </button>\`
      ).join('');
      optionsEl.querySelectorAll('.wallet-option').forEach((btn, i) => {
        btn.addEventListener('click', () => {
          closeWalletModal();
          connectWithProvider(providers[i].provider, providers[i].name);
        });
      });
      document.getElementById('wallet-overlay').style.display = 'flex';
    }

    function closeWalletModal() {
      document.getElementById('wallet-overlay').style.display = 'none';
    }

    function disconnectWallet() {
      connectedAddress = null;
      activeProvider = null;
      updateWalletUI();
      setupAllPoolActions();
    }

    document.getElementById('wallet-btn').addEventListener('click', openWalletPicker);
    document.getElementById('wallet-cancel').addEventListener('click', closeWalletModal);
    document.getElementById('wallet-overlay').addEventListener('click', (e) => {
      if (e.target === document.getElementById('wallet-overlay')) closeWalletModal();
    });
    document.getElementById('disconnect-btn').addEventListener('click', disconnectWallet);

    function updateWalletUI() {
      const btn = document.getElementById('wallet-btn');
      const addrEl = document.getElementById('wallet-addr-display');
      const discBtn = document.getElementById('disconnect-btn');
      if (connectedAddress) {
        btn.textContent = 'Connected';
        btn.classList.add('connected');
        addrEl.textContent = connectedAddress.slice(0, 6) + '…' + connectedAddress.slice(-4);
        addrEl.style.display = 'block';
        discBtn.style.display = 'block';
      } else {
        btn.textContent = 'Connect Wallet';
        btn.classList.remove('connected');
        addrEl.style.display = 'none';
        discBtn.style.display = 'none';
      }
      // Update per-card action visibility based on membership
      document.querySelectorAll('.pool-card[data-pool-address]').forEach(updateCardActions);
    }

    // Auto-detect if already connected (e.g. Phantom or MetaMask remembered)
    (async () => {
      const providers = getWalletProviders();
      for (const w of providers) {
        try {
          const accounts = await w.provider.request({ method: 'eth_accounts' });
          if (accounts.length > 0) {
            connectedAddress = accounts[0];
            activeProvider = w.provider;
            w.provider.on('accountsChanged', onAccountsChanged);
            updateWalletUI();
            setupAllPoolActions();
            break;
          }
        } catch { /* provider not ready yet */ }
      }
    })();

    // ── Approve token ─────────────────────────────────────────────────────────
    async function approveToken(poolAddress, amountStr, statusEl, btnEl) {
      const amount = parseFloat(amountStr);
      if (!amount || amount <= 0) { alert('Enter a valid amount.'); return; }
      statusEl.className = 'action-status pending';
      statusEl.textContent = 'Waiting for signature…';
      btnEl.disabled = true;
      try {
        const provider = new ethers.providers.Web3Provider(activeProvider);
        const signer = provider.getSigner();
        const token = new ethers.Contract(TOKEN_ADDRESS, ERC20_ABI, signer);
        const amountRaw = ethers.utils.parseUnits(amount.toFixed(6), 6);
        const tx = await token.approve(poolAddress, amountRaw);
        statusEl.textContent = 'Approving…';
        await tx.wait();
        statusEl.className = 'action-status success';
        statusEl.textContent = '✓ Approved! Tx: ' + tx.hash.slice(0, 10) + '…';
        // Re-check: hide approve section if allowance now covers the contribution
        const card = btnEl.closest('.pool-card');
        if (card) checkAllowance(card);
      } catch (err) {
        statusEl.className = 'action-status error';
        statusEl.textContent = err.reason || err.message || String(err);
      } finally {
        btnEl.disabled = false;
      }
    }

    // ── Contribute to pool ────────────────────────────────────────────────────
    async function contributeToPool(poolAddress, amountStr, contributionRaw, statusEl, btnEl) {
      const amount = parseFloat(amountStr);
      const minAmount = Number(contributionRaw) / 1e6;
      if (!amount || amount < minAmount) {
        alert('Amount must be at least ' + minAmount.toFixed(2) + ' tokens.');
        return;
      }
      statusEl.className = 'action-status pending';
      statusEl.textContent = 'Waiting for signature…';
      btnEl.disabled = true;
      try {
        const provider = new ethers.providers.Web3Provider(activeProvider);
        const signer = provider.getSigner();
        const pool = new ethers.Contract(poolAddress, POOL_ABI, signer);
        const amountRaw = ethers.utils.parseUnits(amount.toFixed(6), 6);
        const tx = await pool.contribute(amountRaw);
        statusEl.textContent = 'Contributing…';
        await tx.wait();
        statusEl.className = 'action-status success';
        statusEl.textContent = '✓ Contributed! Tx: ' + tx.hash.slice(0, 10) + '…';
      } catch (err) {
        statusEl.className = 'action-status error';
        statusEl.textContent = err.reason || err.message || String(err);
      } finally {
        btnEl.disabled = false;
      }
    }

    // ── Pool action wiring ────────────────────────────────────────────────────

    // Show/hide actions on a single card based on whether connectedAddress is a member
    function updateCardActions(card) {
      const membersStr = card.dataset.members || '';
      const members = membersStr ? membersStr.split(',').filter(Boolean) : [];
      const isMember = !!connectedAddress && members.some(m => m === connectedAddress.toLowerCase());

      const actionsEl = card.querySelector('.pool-actions');
      const promptEl = card.querySelector('.connect-prompt');
      if (actionsEl) actionsEl.style.display = isMember ? 'flex' : 'none';
      if (promptEl) promptEl.style.display = (!connectedAddress && members.length > 0) ? 'block' : 'none';
      if (isMember) checkAllowance(card);
    }

    function setupPoolActions(card) {
      // Avoid double-binding event listeners
      if (card.dataset.actionsWired) return;
      card.dataset.actionsWired = '1';

      const poolAddress = card.dataset.poolAddress;
      const contributionRaw = card.dataset.contributionRaw;

      const approveBtn = card.querySelector('.action-btn.approve');
      const approveInput = card.querySelector('.approve-input');
      const approveStatus = card.querySelector('.approve-status');
      if (approveBtn && approveInput && approveStatus) {
        approveBtn.addEventListener('click', () => {
          if (!connectedAddress) { openWalletPicker(); return; }
          approveToken(poolAddress, approveInput.value, approveStatus, approveBtn);
        });
      }

      const contributeBtn = card.querySelector('.action-btn.contribute');
      const contributeInput = card.querySelector('.contribute-input');
      const contributeStatus = card.querySelector('.contribute-status');
      if (contributeBtn && contributeInput && contributeStatus) {
        contributeBtn.addEventListener('click', () => {
          if (!connectedAddress) { openWalletPicker(); return; }
          contributeToPool(poolAddress, contributeInput.value, contributionRaw, contributeStatus, contributeBtn);
        });
      }

      updateCardActions(card);
    }

    function setupAllPoolActions() {
      document.querySelectorAll('.pool-card[data-pool-address]').forEach(card => {
        setupPoolActions(card);
        updateCardActions(card);
      });
      document.querySelectorAll('.dismiss-warning-btn').forEach(btn => {
        if (btn._warningWired) return;
        btn._warningWired = true;
        btn.addEventListener('click', async () => {
          const poolAddress = btn.dataset.pool;
          await fetch(\`/api/pools/\${poolAddress}/clear-warning\`, { method: 'POST' });
          btn.closest('.payout-warning').remove();
        });
      });
    }

    // ── Allowance check ───────────────────────────────────────────────────────
    // Hides the approve section if the current allowance already covers the pool contribution.
    async function checkAllowance(card) {
      if (!connectedAddress || !activeProvider) return;
      const poolAddress = card.dataset.poolAddress;
      const contributionRaw = card.dataset.contributionRaw;
      const approveSection = card.querySelector('.approve-section');
      if (!approveSection) return;
      try {
        const provider = new ethers.providers.Web3Provider(activeProvider);
        const token = new ethers.Contract(
          TOKEN_ADDRESS,
          ['function allowance(address owner, address spender) view returns (uint256)'],
          provider
        );
        const allowance = await token.allowance(connectedAddress, poolAddress);
        const needed = ethers.BigNumber.from(contributionRaw);
        approveSection.style.display = allowance.gte(needed) ? 'none' : 'block';
      } catch (err) {
        console.warn('[checkAllowance]', err);
      }
    }

    // ── localStorage helpers ──────────────────────────────────────────────────
    const STORAGE_KEY = 'ajo-chat-history';
    const messages = document.getElementById('messages');
    const input = document.getElementById('input');
    const sendBtn = document.getElementById('send');

    function loadHistory() {
      try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); }
      catch { return []; }
    }
    function saveHistory(history) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(history));
    }

    let history = loadHistory();

    // ── render chat ───────────────────────────────────────────────────────────
    function initChat() {
      messages.innerHTML = '';
      if (history.length === 0) {
        renderBubble('Hi! I am your Ajo pool agent. Tell me what you would like to do — e.g. create a pool for 3 members with a 7-day interval and 1 token contribution.', 'claude');
      } else {
        history.forEach(function(h) { renderBubble(h.content, h.type); });
      }
      messages.scrollTop = messages.scrollHeight;
    }
    initChat();

    document.getElementById('clear-chat').addEventListener('click', function() {
      history = [];
      saveHistory(history);
      initChat();
    });

    // ── pool panel auto-refresh every 60s ────────────────────────────────────
    setInterval(async () => {
      const poolsEl = document.getElementById('pools');
      const res = await fetch('/api/pools');
      const data = await res.json();
      // Full DOM rebuild — actionsWired flags reset automatically since elements are new
      poolsEl.innerHTML = data.length === 0
        ? '<div class="empty-notice">No pools yet — ask the agent to create one.</div>'
        : data.map(renderPool).join('');
      setupAllPoolActions();
    }, 60000);

    function renderPoolActions(contributionUsdc) {
      // Visibility is controlled by JS updateCardActions — always render HTML, hide by default
      return \`
        <div class="pool-actions" style="display:none;flex-direction:column;gap:.75rem;">
          <div class="approve-section" style="display:none;">
            <div class="action-group-title">Approve Token</div>
            <div class="action-row">
              <input type="number" class="approve-input" placeholder="Amount in tokens" min="\${contributionUsdc}" step="any" value="\${contributionUsdc}" />
              <button class="action-btn approve">Approve</button>
            </div>
            <div class="approve-status action-status"></div>
          </div>
          <div>
            <div class="action-group-title">Contribute</div>
            <div class="action-row">
              <input type="number" class="contribute-input" placeholder="\${contributionUsdc} tokens" min="\${contributionUsdc}" step="any" value="\${contributionUsdc}" />
              <button class="action-btn contribute">Contribute</button>
            </div>
            <div class="contribute-status action-status"></div>
          </div>
        </div>
        <div class="connect-prompt">Connect your wallet to approve &amp; contribute (members only).</div>
      \`;
    }

    function renderPool(pool) {
      const pct = Math.min(100, Math.round((pool.memberCount / pool.requiredCount) * 100));
      const contributionUsdc = (pool.contribution / 1_000_000).toFixed(2);
      const intervalSecs = pool.interval;
      const intervalLabel = intervalSecs < 86400
        ? Math.round(intervalSecs / 60) + ' min'
        : Math.round(intervalSecs / 86400) + ' days';
      const isClosed = pool.status === 'closed';
      const members = pool.members ?? [];
      const memberAddrs = members.map(m => m.address.toLowerCase()).join(',');

      return \`<div class="pool-card" data-pool-address="\${pool.poolAddress.toLowerCase()}" data-contribution-raw="\${pool.contribution}" data-members="\${memberAddrs}">
        <div class="pool-header">
          <div>
            <div class="pool-title">Savings Pool</div>
            <div class="pool-address">\${pool.poolAddress}</div>
          </div>
          <span class="badge \${pool.status}">\${isClosed ? 'Membership Closed' : 'Open'}</span>
        </div>
        <div class="pool-meta">
          <div class="meta-item"><div class="label">Contribution</div><div class="value">\${contributionUsdc} tokens</div></div>
          <div class="meta-item"><div class="label">Interval</div><div class="value">\${intervalLabel}</div></div>
        </div>
        <div class="progress-wrap">
          <div class="progress-label"><span>Members</span><span>\${pool.memberCount} / \${pool.requiredCount}</span></div>
          <div class="progress-bar"><div class="progress-fill \${pct === 100 ? 'full' : ''}" style="width:\${pct}%"></div></div>
        </div>
        \${members.length > 0 ? \`<details class="members-list"><summary>\${members.length} member\${members.length !== 1 ? 's' : ''} registered</summary>
          \${members.map(m => \`<div class="member-row"><span class="member-addr">\${m.address.slice(0,10)}…\${m.address.slice(-8)}</span><span class="badge \${m.status}">\${m.status}</span></div>\`).join('')}
        </details>\` : ''}
        \${(pool.payouts ?? []).length > 0 ? \`<details class="members-list"><summary>\${pool.payouts.length} payout\${pool.payouts.length !== 1 ? 's' : ''}</summary>
          \${pool.payouts.map(p => \`<div class="member-row">
            <span class="member-addr">\${p.recipient.slice(0,10)}…\${p.recipient.slice(-8)}</span>
            <a class="payout-tx" href="https://etherscan.io/tx/\${p.txHash}" target="_blank" rel="noopener">\${p.txHash.slice(0,8)}…</a>
          </div>\`).join('')}
        </details>\` : ''}
        \${pool.payoutWarning ? \`<div class="payout-warning"><span>\${pool.payoutWarning}</span><button class="dismiss-warning-btn" data-pool="\${pool.poolAddress.toLowerCase()}">Dismiss &amp; Retry</button></div>\` : ''}
        \${isClosed
          ? '<div class="closed-notice">Membership for this pool is closed.</div>'
          : \`<form class="join-form" method="POST" action="/join">
              <input type="hidden" name="pool_address" value="\${pool.poolAddress.toLowerCase()}" />
              <input type="text" name="address" placeholder="0x… your address" required />
              <button type="submit">Join</button>
            </form>\`}
        \${renderPoolActions(contributionUsdc)}
      </div>\`;
    }

    // ── chat helpers ──────────────────────────────────────────────────────────
    function escapeHtml(str) {
      return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    function linkifyTxHashes(text) {
      return escapeHtml(text).replace(
        /0x[a-fA-F0-9]{64}/g,
        hash => \`<a href="https://etherscan.io/tx/\${hash}" target="_blank" rel="noopener">\${hash.slice(0,10)}…\${hash.slice(-8)}</a>\`
      );
    }

    function renderBubble(text, type) {
      const div = document.createElement('div');
      div.className = 'msg ' + type;
      div.innerHTML = linkifyTxHashes(text);
      messages.appendChild(div);
      return div;
    }

    function addMessage(text, type) {
      const div = renderBubble(text, type);
      messages.scrollTop = messages.scrollHeight;
      history.push({ type, content: text });
      saveHistory(history);
      return div;
    }

    async function send() {
      const text = input.value.trim();
      if (!text) return;
      input.value = '';
      sendBtn.disabled = true;

      addMessage(text, 'user');
      let claudeMsg = null;
      let claudeText = '';

      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text }),
      });

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\\n');
        buf = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const evt = JSON.parse(line.slice(6));
          if (evt.type === 'text') {
            if (!claudeMsg) {
              claudeMsg = renderBubble('', 'claude');
              claudeText = '';
            }
            claudeText += evt.content;
            claudeMsg.innerHTML = linkifyTxHashes(claudeText);
            messages.scrollTop = messages.scrollHeight;
          } else if (evt.type === 'tool') {
            if (claudeMsg && claudeText) {
              history.push({ type: 'claude', content: claudeText });
              claudeMsg = null;
              claudeText = '';
            }
            addMessage('⚙ ' + evt.name.replace(/_/g, ' '), 'tool');
          } else if (evt.type === 'error') {
            addMessage('Error: ' + evt.message, 'error');
          } else if (evt.type === 'done') {
            if (claudeMsg && claudeText) {
              history.push({ type: 'claude', content: claudeText });
            }
            saveHistory(history);
          }
        }
      }

      sendBtn.disabled = false;
      input.focus();
    }

    sendBtn.addEventListener('click', send);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
    });

    // Wire up actions on server-rendered cards
    setupAllPoolActions();
  </script>
</body>
</html>`;
  }

  private renderPoolCard(pool: PoolRecord): string {
    const poolKey = pool.poolAddress.toLowerCase();
    const members = this.getRegisteredMembers(pool.poolAddress);
    const poolPayouts = this.payouts.get(poolKey) ?? [];
    const payoutWarning = this.payoutWarnings.get(poolKey) ?? null;
    const count = members.length;
    const pct = Math.min(100, Math.round((count / pool.requiredCount) * 100));
    const contributionUsdc = (Number(pool.contribution) / 1_000_000).toFixed(2);
    const intervalSecs = Number(pool.interval);
    const intervalLabel = intervalSecs < 86400
      ? Math.round(intervalSecs / 60) + " min"
      : Math.round(intervalSecs / 86400) + " days";
    const isClosed = pool.status === "closed";
    const memberAddrs = members.map((m) => m.address.toLowerCase()).join(",");

    return `
<div class="pool-card" data-pool-address="${poolKey}" data-contribution-raw="${pool.contribution}" data-members="${memberAddrs}">
  <div class="pool-header">
    <div>
      <div class="pool-title">Savings Pool</div>
      <div class="pool-address">${pool.poolAddress}</div>
    </div>
    <span class="badge ${pool.status}">${isClosed ? "Membership Closed" : "Open"}</span>
  </div>
  <div class="pool-meta">
    <div class="meta-item"><div class="label">Contribution</div><div class="value">${contributionUsdc} tokens</div></div>
    <div class="meta-item"><div class="label">Interval</div><div class="value">${intervalLabel}</div></div>
  </div>
  <div class="progress-wrap">
    <div class="progress-label"><span>Members</span><span>${count} / ${pool.requiredCount}</span></div>
    <div class="progress-bar"><div class="progress-fill ${pct === 100 ? "full" : ""}" style="width:${pct}%"></div></div>
  </div>
  ${members.length > 0 ? `<details class="members-list"><summary>${count} member${count !== 1 ? "s" : ""} registered</summary>
    ${members.map((m) => `<div class="member-row"><span class="member-addr">${m.address.slice(0, 10)}…${m.address.slice(-8)}</span><span class="badge ${m.status}">${m.status}</span></div>`).join("")}
  </details>` : ""}
  ${poolPayouts.length > 0 ? `<details class="members-list"><summary>${poolPayouts.length} payout${poolPayouts.length !== 1 ? "s" : ""}</summary>
    ${poolPayouts.map((p) => `<div class="member-row">
      <span class="member-addr">${p.recipient.slice(0, 10)}…${p.recipient.slice(-8)}</span>
      <a class="payout-tx" href="https://etherscan.io/tx/${p.txHash}" target="_blank" rel="noopener">${p.txHash.slice(0, 8)}…</a>
    </div>`).join("")}
  </details>` : ""}
  ${payoutWarning ? `<div class="payout-warning"><span>${payoutWarning}</span><button class="dismiss-warning-btn" data-pool="${poolKey}">Dismiss &amp; Retry</button></div>` : ""}
  ${isClosed
    ? `<div class="closed-notice">Membership for this pool is closed.</div>`
    : `<form class="join-form" method="POST" action="/join">
        <input type="hidden" name="pool_address" value="${poolKey}" />
        <input type="text" name="address" placeholder="0x… your address" required />
        <button type="submit">Join</button>
      </form>`}
  <!-- Approve & Contribute — visibility controlled by JS updateCardActions -->
  <div class="pool-actions" style="display:none;flex-direction:column;gap:.75rem;">
    <div class="approve-section" style="display:none;">
      <div class="action-group-title">Approve Token</div>
      <div class="action-row">
        <input type="number" class="approve-input" placeholder="Amount in tokens" min="${contributionUsdc}" step="any" value="${contributionUsdc}" />
        <button class="action-btn approve">Approve</button>
      </div>
      <div class="approve-status action-status"></div>
    </div>
    <div>
      <div class="action-group-title">Contribute</div>
      <div class="action-row">
        <input type="number" class="contribute-input" placeholder="${contributionUsdc} tokens" min="${contributionUsdc}" step="any" value="${contributionUsdc}" />
        <button class="action-btn contribute">Contribute</button>
      </div>
      <div class="contribute-status action-status"></div>
    </div>
  </div>
  <div class="connect-prompt">Connect your wallet to approve &amp; contribute (members only).</div>
</div>`;
  }
}
