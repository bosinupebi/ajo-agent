import type { Address } from "viem";
import type { AdminAgent } from "./agents/AdminAgent.js";
import type { RegistrationServer } from "./server/RegistrationServer.js";

const POLL_INTERVAL_MS = 60_000;

interface PoolState {
  poolAddress: Address;
  requiredCount: number;
  phase: "waiting" | "paying_out" | "done";
}

export class PoolManager {
  private pools = new Map<string, PoolState>();

  constructor(private admin: AdminAgent, private server: RegistrationServer) {}

  watch(poolAddress: Address, requiredCount: number): void {
    const key = poolAddress.toLowerCase();
    if (this.pools.has(key)) {
      console.warn(`[PoolManager] Already watching ${poolAddress}`);
      return;
    }

    const state: PoolState = { poolAddress, requiredCount, phase: "waiting" };
    this.pools.set(key, state);

    this.runLoop(state).catch((err) => {
      console.error(`[PoolManager] Unhandled error for pool ${poolAddress}:`, err);
    });
  }

  private async runLoop(state: PoolState): Promise<void> {
    const { poolAddress, requiredCount } = state;

    try {
      // Phase 1: wait for required members
      console.log(`[PoolManager] Watching pool ${poolAddress} — waiting for ${requiredCount} members`);
      const addresses = await this.server.waitForMembers(poolAddress, requiredCount);
      console.log(`[PoolManager] ${requiredCount} member(s) signed up for ${poolAddress}`);

      // Phase 2: add members on-chain
      const addTx = await this.admin.addMembers(poolAddress, addresses);
      this.server.markMembersAdded(poolAddress, addresses);
      console.log(`[PoolManager] addMembers tx for ${poolAddress}: ${addTx}`);

      // Phase 3: payout loop
      state.phase = "paying_out";
      const members = this.server
        .getRegisteredMembers(poolAddress)
        .filter((m) => m.status === "added");

      console.log(`[PoolManager] Beginning payout cycle for ${poolAddress} — ${members.length} recipient(s)`);

      for (const member of members) {
        const recipient = member.address as Address;
        console.log(`[PoolManager] Waiting to pay ${recipient} from pool ${poolAddress}...`);

        // Poll until interval is ready — check immediately, then sleep
        while (true) {
          try {
            const info = await this.admin.getPoolInfo(poolAddress);
            if (info.canPayoutNow) break;
            console.log(`[PoolManager] Pool ${poolAddress} not ready yet (nextIntervalEnd: ${info.nextIntervalEndTimestamp})`);
          } catch (pollErr) {
            console.error(`[PoolManager] Poll error for ${poolAddress}, will retry:`, pollErr);
          }
          await sleep(POLL_INTERVAL_MS);
        }

        const timestamp = Math.floor(Date.now() / 1000);
        const payoutTx = await this.admin.triggerPayout(poolAddress, timestamp, recipient);
        this.server.recordPayout(poolAddress, { recipient, txHash: payoutTx, timestamp });
        console.log(`[PoolManager] Payout to ${recipient} from ${poolAddress}: tx ${payoutTx}`);
      }

      state.phase = "done";
      console.log(`[PoolManager] All payouts complete for pool ${poolAddress}`);
    } catch (err) {
      console.error(`[PoolManager] Loop terminated for pool ${poolAddress}:`, err);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
