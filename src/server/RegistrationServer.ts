import express, { type Request, type Response } from "express";
import type { Address } from "viem";
import { REGISTRATION_PORT } from "../config.js";

export type MemberStatus = "pending" | "added";
export type PoolStatus = "open" | "closed";

export interface PoolRecord {
  poolAddress: string;
  contribution: string;   // raw units
  interval: string;       // seconds
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

interface WaitHandle {
  poolAddress: string;
  count: number;
  resolve: (addresses: Address[]) => void;
}

export class RegistrationServer {
  private app = express();
  // keyed by lowercased pool address
  private pools = new Map<string, PoolRecord>();
  // keyed by `${poolAddress}:${memberAddress}`
  private members = new Map<string, MemberRecord>();
  private waitHandles: WaitHandle[] = [];

  constructor() {
    this.setup();
  }

  // ─── Public API ──────────────────────────────────────────────────────────────

  addPool(info: Omit<PoolRecord, "status" | "createdAt">) {
    const key = info.poolAddress.toLowerCase();
    this.pools.set(key, {
      ...info,
      status: "open",
      createdAt: new Date().toISOString(),
    });
    console.log(`[Server] Pool registered: ${info.poolAddress}`);
  }

  getRegisteredMembers(poolAddress?: string) {
    const all = [...this.members.values()];
    if (!poolAddress) return all;
    const key = poolAddress.toLowerCase();
    return all.filter((m) => m.poolAddress === key);
  }

  markMembersAdded(poolAddress: string, addresses: Address[]) {
    for (const addr of addresses) {
      const key = `${poolAddress.toLowerCase()}:${addr.toLowerCase()}`;
      const member = this.members.get(key);
      if (member) member.status = "added";
    }
  }

  /** Resolves once `count` pending members have signed up for the given pool */
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

  private tryJoin(rawAddress: string, rawPool: string): { ok: boolean; error?: string; pool?: PoolRecord } {
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

      // Check if pool is now full
      const count = this.poolMemberCount(poolKey);
      if (count >= pool.requiredCount) {
        pool.status = "closed";
        console.log(`[Server] Pool ${poolKey} membership closed (${count}/${pool.requiredCount})`);
      }

      this.checkWaitHandles(poolKey);
    }

    return { ok: true, pool };
  }

  // ─── Routes ──────────────────────────────────────────────────────────────────

  private setup() {
    this.app.use(express.json());
    this.app.use(express.urlencoded({ extended: true }));

    this.app.get("/", (_req: Request, res: Response) => {
      res.send(this.renderPage());
    });

    this.app.post("/join", (req: Request, res: Response) => {
      const { address, pool_address } = req.body as { address?: string; pool_address?: string };
      const result = this.tryJoin(address ?? "", pool_address ?? "");

      if (req.accepts("html")) {
        return res.redirect(result.ok ? "/?joined=1" : `/?error=${encodeURIComponent(result.error ?? "error")}`);
      }
      if (!result.ok) return res.status(400).json({ error: result.error });
      return res.json({ poolAddress: result.pool!.poolAddress, status: "pending" });
    });

    this.app.get("/api/pools", (_req: Request, res: Response) => {
      const data = [...this.pools.values()].map((pool) => ({
        ...pool,
        memberCount: this.poolMemberCount(pool.poolAddress.toLowerCase()),
        members: this.getRegisteredMembers(pool.poolAddress),
      }));
      res.json(data);
    });

    this.app.get("/api/status/:address", (req: Request, res: Response) => {
      const address = req.params.address.toLowerCase();
      const memberships = [...this.members.values()].filter((m) => m.address === address);
      if (memberships.length === 0) return res.status(404).json({ status: "not_registered" });
      res.json(memberships);
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
  <meta http-equiv="refresh" content="5" />
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, sans-serif; background: #f5f5f0; color: #1a1a1a; padding: 2rem; }
    h1 { font-size: 1.6rem; margin-bottom: .25rem; }
    .subtitle { color: #666; font-size: .9rem; margin-bottom: 2rem; }

    .pools { display: grid; gap: 1.25rem; max-width: 640px; }
    .pool-card { background: white; border-radius: 12px; padding: 1.5rem; box-shadow: 0 2px 8px rgba(0,0,0,.07); }
    .pool-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 1rem; }
    .pool-title { font-size: 1rem; font-weight: 600; }
    .pool-address { font-size: .75rem; color: #888; word-break: break-all; margin-top: .15rem; }

    .badge { padding: .25rem .7rem; border-radius: 999px; font-size: .75rem; font-weight: 600; white-space: nowrap; }
    .badge.open { background: #d1fae5; color: #065f46; }
    .badge.closed { background: #fee2e2; color: #991b1b; }
    .badge.pending { background: #fef3c7; color: #92400e; }
    .badge.added { background: #d1fae5; color: #065f46; }

    .pool-meta { display: grid; grid-template-columns: 1fr 1fr; gap: .5rem; margin-bottom: 1rem; }
    .meta-item .label { font-size: .7rem; color: #999; text-transform: uppercase; letter-spacing: .05em; }
    .meta-item .value { font-size: .9rem; font-weight: 600; margin-top: .1rem; }

    .progress-wrap { margin-bottom: 1rem; }
    .progress-label { display: flex; justify-content: space-between; font-size: .8rem; color: #555; margin-bottom: .35rem; }
    .progress-bar { background: #f0f0eb; border-radius: 999px; height: 8px; overflow: hidden; }
    .progress-fill { background: #4f46e5; height: 100%; border-radius: 999px; transition: width .4s; }
    .progress-fill.full { background: #10b981; }

    .members-list { margin-bottom: 1rem; }
    .members-list summary { font-size: .8rem; color: #888; cursor: pointer; margin-bottom: .4rem; }
    .member-row { display: flex; justify-content: space-between; align-items: center; font-size: .8rem; padding: .3rem 0; border-bottom: 1px solid #f5f5f0; }
    .member-row:last-child { border-bottom: none; }
    .member-addr { font-family: monospace; color: #444; }

    form.join-form { display: flex; gap: .5rem; flex-wrap: wrap; }
    form.join-form input[type=text] { flex: 1; min-width: 0; padding: .55rem .85rem; border: 1.5px solid #ddd; border-radius: 8px; font-size: .875rem; }
    form.join-form input:focus { outline: none; border-color: #4f46e5; }
    form.join-form button { background: #4f46e5; color: white; border: none; border-radius: 8px; padding: .55rem 1.1rem; font-size: .875rem; cursor: pointer; }
    form.join-form button:hover { background: #4338ca; }
    .closed-notice { background: #fef2f2; border: 1px solid #fecaca; border-radius: 8px; padding: .65rem 1rem; font-size: .85rem; color: #991b1b; }

    .empty { color: #aaa; font-size: .875rem; }
    .notice { background: #ede9fe; color: #4338ca; border-radius: 8px; padding: .75rem 1rem; font-size: .875rem; max-width: 640px; margin-bottom: 1.5rem; }
  </style>
</head>
<body>
  <h1>Ajo Savings Pools</h1>
  <p class="subtitle">Submit your Ethereum address to join an open pool. Page refreshes every 5 seconds.</p>

  ${pools.length === 0
    ? `<div class="notice">No pools have been created yet — check back shortly.</div>`
    : `<div class="pools">${pools.map((pool) => this.renderPoolCard(pool)).join("")}</div>`}
</body>
</html>`;
  }

  private renderPoolCard(pool: PoolRecord): string {
    const poolKey = pool.poolAddress.toLowerCase();
    const members = this.getRegisteredMembers(pool.poolAddress);
    const count = members.length;
    const pct = Math.min(100, Math.round((count / pool.requiredCount) * 100));
    const contribution = (Number(pool.contribution) / 1_000_000).toFixed(2);
    const intervalDays = (Number(pool.interval) / 86400).toFixed(0);
    const isClosed = pool.status === "closed";
    const shortAddr = `${pool.poolAddress.slice(0, 10)}…${pool.poolAddress.slice(-8)}`;

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
    <div class="meta-item">
      <div class="label">Contribution</div>
      <div class="value">${contribution} USDT</div>
    </div>
    <div class="meta-item">
      <div class="label">Interval</div>
      <div class="value">${intervalDays} days</div>
    </div>
  </div>

  <div class="progress-wrap">
    <div class="progress-label">
      <span>Members</span>
      <span>${count} / ${pool.requiredCount}</span>
    </div>
    <div class="progress-bar">
      <div class="progress-fill ${pct === 100 ? "full" : ""}" style="width:${pct}%"></div>
    </div>
  </div>

  ${members.length > 0 ? `
  <details class="members-list">
    <summary>${count} member${count !== 1 ? "s" : ""} registered</summary>
    ${members.map((m) => `
    <div class="member-row">
      <span class="member-addr">${m.address.slice(0, 10)}…${m.address.slice(-8)}</span>
      <span class="badge ${m.status}">${m.status}</span>
    </div>`).join("")}
  </details>` : ""}

  ${isClosed
    ? `<div class="closed-notice">Membership for this pool is closed.</div>`
    : `<form class="join-form" method="POST" action="/join">
        <input type="hidden" name="pool_address" value="${poolKey}" />
        <input type="text" name="address" placeholder="0x… your Ethereum address" required />
        <button type="submit">Join</button>
      </form>`}
</div>`;
  }
}
