import type { Address } from "viem";
import type { AdminAgent } from "./agents/AdminAgent.js";
import type { RegistrationServer } from "./server/RegistrationServer.js";

const POLL_INTERVAL_MS = 60_000;
const RETRY_DELAY_MS = 5_000;
const MAX_PAYOUT_ATTEMPTS = 3;

interface PoolState {
  poolAddress: Address;
  requiredCount: number;
  phase: "waiting" | "paying_out";
}

export class PoolManager {
  private pools = new Map<string, PoolState>();

  constructor(private admin: AdminAgent, private server: RegistrationServer) {}

  /** Start watching a newly created pool — waits for members, adds them, then begins payout loop. */
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

  /** Resume payout tracking for a pool that already has members added (e.g. on server restart). */
  resume(poolAddress: Address): void {
    const key = poolAddress.toLowerCase();
    if (this.pools.has(key)) {
      console.warn(`[PoolManager] Already watching ${poolAddress}`);
      return;
    }

    const state: PoolState = { poolAddress, requiredCount: 0, phase: "paying_out" };
    this.pools.set(key, state);

    this.payoutLoop(poolAddress).catch((err) => {
      console.error(`[PoolManager] Unhandled error resuming pool ${poolAddress}:`, err);
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
      await this.payoutLoop(poolAddress);
    } catch (err) {
      console.error(`[PoolManager] Loop terminated for pool ${poolAddress}:`, err);
    }
  }

  private async payoutLoop(poolAddress: Address): Promise<void> {
    const members = this.server
      .getRegisteredMembers(poolAddress)
      .filter((m) => m.status === "added");

    if (members.length === 0) {
      console.warn(`[PoolManager] No added members found for pool ${poolAddress} — cannot start payout loop`);
      return;
    }

    console.log(`[PoolManager] Beginning payout cycle for ${poolAddress} — ${members.length} recipient(s)`);

    let memberIndex = 0;

    while (true) {
      const recipient = members[memberIndex % members.length].address as Address;
      console.log(`[PoolManager] Waiting to pay ${recipient} from pool ${poolAddress}...`);

      // Wait until interval is ready
      let readyInfo = await this.admin.getPoolInfo(poolAddress);
      while (!readyInfo.canPayoutNow) {
        console.log(`[PoolManager] Pool ${poolAddress} not ready yet (nextIntervalEnd: ${readyInfo.nextIntervalEndTimestamp})`);
        await sleep(POLL_INTERVAL_MS);
        try {
          readyInfo = await this.admin.getPoolInfo(poolAddress);
        } catch (pollErr) {
          console.error(`[PoolManager] Poll error for ${poolAddress}, will retry:`, pollErr);
        }
      }

      // Attempt payout with retries
      const timestamp = Number(readyInfo.nextIntervalEndTimestamp);
      let success = false;
      let staleState = false; // contract rejected due to interval mismatch — need fresh state

      for (let attempt = 1; attempt <= MAX_PAYOUT_ATTEMPTS; attempt++) {
        try {
          const payoutTx = await this.admin.triggerPayout(poolAddress, timestamp, recipient);
          this.server.recordPayout(poolAddress, { recipient, txHash: payoutTx, timestamp });
          console.log(`[PoolManager] Payout to ${recipient} from ${poolAddress}: tx ${payoutTx}`);
          success = true;
          break;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          // Contract rejected because our interval count is off (0 or >1 unprocessed).
          // This happens when another process already paid this interval, or multiple
          // intervals elapsed before we acted. Re-reading state will give the correct
          // nextIntervalEndTimestamp — no point retrying with the same timestamp.
          if (msg.includes("only process one interval at a time") || msg.includes("No full interval has passed")) {
            console.warn(`[PoolManager] Interval state mismatch for ${poolAddress} — re-reading state before retry`);
            staleState = true;
            break;
          }
          console.error(`[PoolManager] Payout attempt ${attempt}/${MAX_PAYOUT_ATTEMPTS} failed for ${recipient}:`, err);
          if (attempt < MAX_PAYOUT_ATTEMPTS) await sleep(RETRY_DELAY_MS);
        }
      }

      // Re-read from chain and loop back — do NOT advance memberIndex
      if (staleState) continue;

      if (!success) {
        const warning = `Payout to ${recipient} failed after ${MAX_PAYOUT_ATTEMPTS} attempts. Dismiss to retry.`;
        console.warn(`[PoolManager] ${warning}`);
        this.server.setPayoutWarning(poolAddress, warning);

        // Wait until the user dismisses the warning, then retry the same recipient
        while (this.server.hasPayoutWarning(poolAddress)) {
          await sleep(POLL_INTERVAL_MS);
        }
        console.log(`[PoolManager] Warning cleared for ${poolAddress} — retrying payout to ${recipient}`);
        continue; // retry same memberIndex without advancing
      }

      memberIndex++;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
