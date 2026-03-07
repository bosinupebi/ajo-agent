import express, { type Request, type Response } from "express";
import type { Address } from "viem";
import { REGISTRATION_PORT } from "../config.js";
import type { Orchestrator } from "../orchestrator.js";

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
  private waitHandles: WaitHandle[] = [];
  private orchestrator: Orchestrator | null = null;

  constructor() {
    this.setup();
  }

  // ─── Public API ──────────────────────────────────────────────────────────────

  setOrchestrator(orchestrator: Orchestrator) {
    this.orchestrator = orchestrator;
  }

  addPool(info: Omit<PoolRecord, "status" | "createdAt">) {
    const key = info.poolAddress.toLowerCase();
    this.pools.set(key, { ...info, status: "open", createdAt: new Date().toISOString() });
    console.log(`[Server] Pool registered: ${info.poolAddress}`);
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
  }

  markMembersAdded(poolAddress: string, addresses: Address[]) {
    for (const addr of addresses) {
      const key = `${poolAddress.toLowerCase()}:${addr.toLowerCase()}`;
      const m = this.members.get(key);
      if (m) m.status = "added";
    }
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
      }));
      res.json(data);
    });

    this.app.get("/api/status/:address", (req: Request, res: Response) => {
      const address = req.params.address.toLowerCase();
      const memberships = [...this.members.values()].filter((m) => m.address === address);
      if (memberships.length === 0) return res.status(404).json({ status: "not_registered" });
      res.json(memberships);
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
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, sans-serif; background: #f5f5f0; color: #1a1a1a; height: 100dvh; display: flex; flex-direction: column; overflow: hidden; }

    /* ── top bar ── */
    header { padding: .9rem 1.5rem; background: white; border-bottom: 1px solid #e8e8e4; display: flex; align-items: center; gap: .75rem; flex-shrink: 0; }
    header h1 { font-size: 1.1rem; font-weight: 700; }
    header p { font-size: .8rem; color: #888; }

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
    .payout-tx { font-family: monospace; font-size: .72rem; color: #4f46e5; text-decoration: none; }
    .payout-tx:hover { text-decoration: underline; }

    /* badges */
    .badge { padding: .2rem .6rem; border-radius: 999px; font-size: .7rem; font-weight: 600; white-space: nowrap; }
    .badge.open { background: #d1fae5; color: #065f46; }
    .badge.closed { background: #fee2e2; color: #991b1b; }
    .badge.pending { background: #fef3c7; color: #92400e; }
    .badge.added { background: #d1fae5; color: #065f46; }

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
  <header>
    <div>
      <h1>Ajo Savings Pools</h1>
      <p>Chat with the agent on the right · Members join via the pool cards · Page auto-refreshes every 8s</p>
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
    const messages = document.getElementById('messages');
    const input = document.getElementById('input');
    const sendBtn = document.getElementById('send');
    const STORAGE_KEY = 'ajo-chat-history';

    // ── localStorage helpers ──────────────────────────────────────────────────
    function loadHistory() {
      try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); }
      catch { return []; }
    }

    function saveHistory(history) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(history));
    }

    // history entries: { type: 'user'|'claude'|'tool'|'error', content: string }
    let history = loadHistory();

    // ── render saved history on load ─────────────────────────────────────────
    if (history.length === 0) {
      const welcome = { type: 'claude', content: "Hi! I'm your Ajo pool agent. Tell me what you'd like to do — e.g. \"Create a pool for 3 members with a 7-day interval and 1 USDT contribution\"." };
      history.push(welcome);
      saveHistory(history);
    }
    history.forEach(({ type, content }) => renderBubble(content, type));
    messages.scrollTop = messages.scrollHeight;

    // ── clear button ─────────────────────────────────────────────────────────
    document.getElementById('clear-chat').addEventListener('click', () => {
      history = [];
      saveHistory(history);
      messages.innerHTML = '';
    });

    // ── pool panel auto-refresh every 8s ─────────────────────────────────────
    setInterval(async () => {
      const pools = document.getElementById('pools');
      const res = await fetch('/api/pools');
      const data = await res.json();
      pools.innerHTML = data.length === 0
        ? '<div class="empty-notice">No pools yet — ask the agent to create one.</div>'
        : data.map(renderPool).join('');
    }, 8000);

    function renderPool(pool) {
      const pct = Math.min(100, Math.round((pool.memberCount / pool.requiredCount) * 100));
      const contribution = (pool.contribution / 1_000_000).toFixed(2);
      const intervalDays = (pool.interval / 86400).toFixed(0);
      const isClosed = pool.status === 'closed';
      const members = pool.members ?? [];

      return \`<div class="pool-card">
        <div class="pool-header">
          <div>
            <div class="pool-title">Savings Pool</div>
            <div class="pool-address">\${pool.poolAddress}</div>
          </div>
          <span class="badge \${pool.status}">\${isClosed ? 'Membership Closed' : 'Open'}</span>
        </div>
        <div class="pool-meta">
          <div class="meta-item"><div class="label">Contribution</div><div class="value">\${contribution} USDT</div></div>
          <div class="meta-item"><div class="label">Interval</div><div class="value">\${intervalDays} days</div></div>
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
        \${isClosed
          ? '<div class="closed-notice">Membership for this pool is closed.</div>'
          : \`<form class="join-form" method="POST" action="/join">
              <input type="hidden" name="pool_address" value="\${pool.poolAddress.toLowerCase()}" />
              <input type="text" name="address" placeholder="0x… your address" required />
              <button type="submit">Join</button>
            </form>\`}
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
            // Save the accumulated claude bubble before the tool bubble
            if (claudeMsg && claudeText) {
              history.push({ type: 'claude', content: claudeText });
              claudeMsg = null;
              claudeText = '';
            }
            addMessage('⚙ ' + evt.name.replace(/_/g, ' '), 'tool');
          } else if (evt.type === 'error') {
            addMessage('Error: ' + evt.message, 'error');
          } else if (evt.type === 'done') {
            // Save final claude bubble if any
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
  </script>
</body>
</html>`;
  }

  private renderPoolCard(pool: PoolRecord): string {
    const poolKey = pool.poolAddress.toLowerCase();
    const members = this.getRegisteredMembers(pool.poolAddress);
    const poolPayouts = this.payouts.get(poolKey) ?? [];
    const count = members.length;
    const pct = Math.min(100, Math.round((count / pool.requiredCount) * 100));
    const contribution = (Number(pool.contribution) / 1_000_000).toFixed(2);
    const intervalDays = (Number(pool.interval) / 86400).toFixed(0);
    const isClosed = pool.status === "closed";

    return `
<div class="pool-card">
  <div class="pool-header">
    <div>
      <div class="pool-title">Savings Pool</div>
      <div class="pool-address">${pool.poolAddress}</div>
    </div>
    <span class="badge ${pool.status}">${isClosed ? "Membership Closed" : "Open"}</span>
  </div>
  <div class="pool-meta">
    <div class="meta-item"><div class="label">Contribution</div><div class="value">${contribution} USDT</div></div>
    <div class="meta-item"><div class="label">Interval</div><div class="value">${intervalDays} days</div></div>
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
  ${isClosed
    ? `<div class="closed-notice">Membership for this pool is closed.</div>`
    : `<form class="join-form" method="POST" action="/join">
        <input type="hidden" name="pool_address" value="${poolKey}" />
        <input type="text" name="address" placeholder="0x… your address" required />
        <button type="submit">Join</button>
      </form>`}
</div>`;
  }
}
