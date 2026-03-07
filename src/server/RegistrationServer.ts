import express, { type Request, type Response } from "express";
import type { Address } from "viem";
import { REGISTRATION_PORT } from "../config.js";

export type MemberStatus = "pending" | "added";

export interface PoolInfo {
  poolAddress: string;
  contribution: string;   // raw units
  interval: string;       // seconds
  memberCount: number;
  requiredCount: number;
}

interface RegisteredMember {
  address: Address;
  status: MemberStatus;
  joinedAt: string;
}

export class RegistrationServer {
  private app = express();
  private members = new Map<string, RegisteredMember>();
  private poolInfo: PoolInfo | null = null;
  private waitResolvers: Array<{ count: number; resolve: (addresses: Address[]) => void }> = [];

  constructor() {
    this.setup();
  }

  private setup() {
    this.app.use(express.json());
    this.app.use(express.urlencoded({ extended: true }));

    this.app.get("/", (_req: Request, res: Response) => {
      res.send(this.renderPage());
    });

    this.app.post("/join", (req: Request, res: Response) => {
      const address = (req.body.address as string)?.trim().toLowerCase();

      if (!address || !address.startsWith("0x") || address.length !== 42) {
        if (req.accepts("html")) {
          return res.redirect("/?error=invalid_address");
        }
        return res.status(400).json({ error: "Invalid Ethereum address" });
      }

      if (!this.poolInfo) {
        if (req.accepts("html")) {
          return res.redirect("/?error=pool_not_ready");
        }
        return res.status(503).json({ error: "Pool not ready yet, try again shortly" });
      }

      if (!this.members.has(address)) {
        this.members.set(address, {
          address: address as Address,
          status: "pending",
          joinedAt: new Date().toISOString(),
        });
        console.log(`[Server] New member registered: ${address}`);
        this.checkIfReady();
      }

      if (req.accepts("html")) {
        return res.redirect("/?joined=1");
      }
      return res.json({
        poolAddress: this.poolInfo.poolAddress,
        status: this.members.get(address)?.status,
      });
    });

    this.app.get("/api/pool", (_req: Request, res: Response) => {
      if (!this.poolInfo) return res.status(503).json({ error: "Pool not ready" });
      res.json({ ...this.poolInfo, members: [...this.members.values()] });
    });

    this.app.get("/api/status/:address", (req: Request, res: Response) => {
      const address = req.params.address.toLowerCase();
      const member = this.members.get(address);
      if (!member) return res.status(404).json({ status: "not_registered" });
      res.json({ status: member.status, poolAddress: this.poolInfo?.poolAddress });
    });
  }

  private checkWaiters() {
    const pending = [...this.members.values()].filter((m) => m.status === "pending");
    this.waitResolvers = this.waitResolvers.filter(({ count, resolve }) => {
      if (pending.length >= count) {
        resolve(pending.slice(0, count).map((m) => m.address));
        return false;
      }
      return true;
    });
  }

  /** Returns current registered members */
  getRegisteredMembers() {
    return [...this.members.values()];
  }

  /** Called by admin agent once pool is deployed */
  setPoolInfo(info: PoolInfo) {
    this.poolInfo = info;
    console.log(`[Server] Pool info set: ${info.poolAddress}`);
  }

  /** Called by admin agent after addMembers tx succeeds */
  markMembersAdded(addresses: Address[]) {
    for (const addr of addresses) {
      const member = this.members.get(addr.toLowerCase());
      if (member) member.status = "added";
    }
  }

  /** Resolves once `count` pending members have signed up */
  waitForMembers(count: number): Promise<Address[]> {
    return new Promise((resolve) => {
      this.waitResolvers.push({ count, resolve });
      this.checkWaiters();
    });
  }

  start(): Promise<void> {
    return new Promise((resolve) => {
      this.app.listen(REGISTRATION_PORT, () => {
        console.log(`[Server] Registration page live at http://localhost:${REGISTRATION_PORT}`);
        resolve();
      });
    });
  }

  private renderPage(): string {
    const pool = this.poolInfo;
    const members = [...this.members.values()];
    const contribution = pool
      ? (Number(pool.contribution) / 1_000_000).toFixed(2) + " USDT"
      : "—";
    const intervalDays = pool
      ? (Number(pool.interval) / 86400).toFixed(0) + " days"
      : "—";

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Ajo Pool — Join</title>
  <meta http-equiv="refresh" content="5" />
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, sans-serif; background: #f5f5f0; color: #1a1a1a; padding: 2rem; }
    .card { background: white; border-radius: 12px; padding: 2rem; max-width: 520px; margin: 0 auto; box-shadow: 0 2px 8px rgba(0,0,0,.08); }
    h1 { font-size: 1.5rem; margin-bottom: .25rem; }
    .subtitle { color: #666; font-size: .9rem; margin-bottom: 1.5rem; }
    .info { display: grid; grid-template-columns: 1fr 1fr; gap: .75rem; margin-bottom: 1.5rem; }
    .info-item { background: #f9f9f7; border-radius: 8px; padding: .75rem 1rem; }
    .info-item .label { font-size: .75rem; color: #888; text-transform: uppercase; letter-spacing: .05em; }
    .info-item .value { font-size: 1rem; font-weight: 600; margin-top: .2rem; word-break: break-all; }
    .pool-address { grid-column: 1 / -1; }
    form { display: flex; gap: .5rem; margin-bottom: 1.5rem; }
    input { flex: 1; padding: .6rem .9rem; border: 1.5px solid #ddd; border-radius: 8px; font-size: .9rem; }
    input:focus { outline: none; border-color: #4f46e5; }
    button { background: #4f46e5; color: white; border: none; border-radius: 8px; padding: .6rem 1.2rem; font-size: .9rem; cursor: pointer; }
    button:hover { background: #4338ca; }
    .members h2 { font-size: 1rem; margin-bottom: .75rem; color: #555; }
    .member { display: flex; justify-content: space-between; align-items: center; padding: .5rem 0; border-bottom: 1px solid #f0f0f0; font-size: .85rem; }
    .member:last-child { border-bottom: none; }
    .badge { padding: .2rem .6rem; border-radius: 999px; font-size: .75rem; font-weight: 600; }
    .badge.pending { background: #fef3c7; color: #92400e; }
    .badge.added { background: #d1fae5; color: #065f46; }
    .notice { background: #ede9fe; color: #4338ca; border-radius: 8px; padding: .75rem 1rem; font-size: .85rem; margin-bottom: 1rem; }
    .empty { color: #aaa; font-size: .85rem; padding: .5rem 0; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Ajo Savings Pool</h1>
    <p class="subtitle">Sign up below to join this rotating savings group.</p>

    ${pool ? `
    <div class="info">
      <div class="info-item pool-address">
        <div class="label">Pool address</div>
        <div class="value">${pool.poolAddress}</div>
      </div>
      <div class="info-item">
        <div class="label">Contribution</div>
        <div class="value">${contribution}</div>
      </div>
      <div class="info-item">
        <div class="label">Interval</div>
        <div class="value">${intervalDays}</div>
      </div>
      <div class="info-item">
        <div class="label">Members</div>
        <div class="value">${members.length} / ${this.requiredCount}</div>
      </div>
    </div>
    ` : `<div class="notice">Pool is being set up — check back in a moment.</div>`}

    <form method="POST" action="/join">
      <input name="address" type="text" placeholder="0x... your Ethereum address" required />
      <button type="submit">Join</button>
    </form>

    <div class="members">
      <h2>Registered members</h2>
      ${members.length === 0
        ? `<p class="empty">No members yet.</p>`
        : members.map((m) => `
          <div class="member">
            <span>${m.address.slice(0, 10)}…${m.address.slice(-8)}</span>
            <span class="badge ${m.status}">${m.status}</span>
          </div>`).join("")}
    </div>
  </div>
</body>
</html>`;
  }
}
