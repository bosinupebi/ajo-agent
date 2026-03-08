import {
  createPublicClient,
  http,
  encodeFunctionData,
  decodeEventLog,
  formatEther,
  type Address,
  type PublicClient,
} from "viem";
import { mainnet } from "viem/chains";
import { ETH_RPC_URL, USDC_ADDRESS } from "../config.js";
import { factoryAbi, savingsPoolAbi } from "../abis.js";

interface PoolInfo {
  balance: string;
  interval: string;
  contribution: string;
  lastProcessedInterval: string;
  lastPayoutTimestamp: string;
  nextIntervalEndTimestamp: string;
  canPayoutNow: boolean;
}

interface CreatePoolResult {
  poolAddress: Address;
  txHash: string;
}

interface WdkAccount {
  getAddress(): Promise<string>;
  sendTransaction: (tx: { to: string; value: number | bigint; data?: string }) => Promise<{ hash: string }>;
}

export class AdminAgent {
  private account: WdkAccount;
  private publicClient: PublicClient;

  constructor(wdkAccount: WdkAccount) {
    this.account = wdkAccount;
    this.publicClient = createPublicClient({
      chain: mainnet,
      transport: http(ETH_RPC_URL),
    });
  }

  async getAddress(): Promise<Address> {
    return (await this.account.getAddress()) as Address;
  }

  async getEthBalance(): Promise<string> {
    const address = (await this.account.getAddress()) as Address;
    const balance = await this.publicClient.getBalance({ address });
    return formatEther(balance);
  }

  async createSavingsPool(
    factoryAddress: Address,
    intervalSeconds: number | bigint,
    contributionRaw: number | bigint
  ): Promise<CreatePoolResult> {
    const data = encodeFunctionData({
      abi: factoryAbi,
      functionName: "createSavingsPool",
      args: [USDC_ADDRESS, BigInt(intervalSeconds), BigInt(contributionRaw)],
    });

    const { hash: txHash } = await this.account.sendTransaction({
      to: factoryAddress,
      value: 0n,
      data,
    });

    console.log(`[AdminAgent] createSavingsPool tx: ${txHash}`);
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash: txHash as `0x${string}` });

    for (const log of receipt.logs) {
      try {
        const decoded = decodeEventLog({
          abi: factoryAbi,
          eventName: "SavingsPoolCreated",
          data: log.data,
          topics: log.topics,
        });
        const poolAddress = (decoded.args as { poolAddress: Address }).poolAddress;
        console.log(`[AdminAgent] Pool deployed at: ${poolAddress}`);
        return { poolAddress, txHash };
      } catch {
        // not the event we're looking for
      }
    }

    throw new Error("SavingsPoolCreated event not found in receipt");
  }

  async addMembers(poolAddress: Address, memberAddresses: Address[]): Promise<string> {
    const data = encodeFunctionData({
      abi: savingsPoolAbi,
      functionName: "addMembers",
      args: [memberAddresses],
    });

    const { hash: txHash } = await this.account.sendTransaction({
      to: poolAddress,
      value: 0n,
      data,
    });

    console.log(`[AdminAgent] addMembers tx: ${txHash}`);
    await this.publicClient.waitForTransactionReceipt({ hash: txHash as `0x${string}` });
    return txHash;
  }

  async triggerPayout(
    poolAddress: Address,
    timestamp: number | bigint,
    recipient: Address
  ): Promise<string> {
    const data = encodeFunctionData({
      abi: savingsPoolAbi,
      functionName: "payout",
      args: [BigInt(timestamp), recipient],
    });

    const { hash: txHash } = await this.account.sendTransaction({
      to: poolAddress,
      value: 0n,
      data,
    });

    console.log(`[AdminAgent] payout tx: ${txHash}`);
    await this.publicClient.waitForTransactionReceipt({ hash: txHash as `0x${string}` });
    return txHash;
  }

  async getPoolInfo(poolAddress: Address): Promise<PoolInfo> {
    const [balance, interval, contribution, lastProcessedInterval, lastPayoutTimestamp, totalIntervalCount] =
      await Promise.all([
        this.publicClient.readContract({
          address: poolAddress,
          abi: savingsPoolAbi,
          functionName: "contractBalance",
        }),
        this.publicClient.readContract({
          address: poolAddress,
          abi: savingsPoolAbi,
          functionName: "interval",
        }),
        this.publicClient.readContract({
          address: poolAddress,
          abi: savingsPoolAbi,
          functionName: "contribution",
        }),
        this.publicClient.readContract({
          address: poolAddress,
          abi: savingsPoolAbi,
          functionName: "lastProcessedInterval",
        }),
        this.publicClient.readContract({
          address: poolAddress,
          abi: savingsPoolAbi,
          functionName: "lastPayoutTimestamp",
        }),
        this.publicClient.readContract({
          address: poolAddress,
          abi: savingsPoolAbi,
          functionName: "getAllIntervals",
        }),
      ]);

    const lpi = lastProcessedInterval as bigint;
    const lpt = lastPayoutTimestamp as bigint;
    const totalCount = totalIntervalCount as bigint;

    // The next interval to pay out is index 0 if no payout has ever happened,
    // otherwise it is lastProcessedInterval + 1.
    const nextIndex = lpi === 0n && lpt === 0n ? 0n : lpi + 1n;

    let nextIntervalEndTimestamp = "N/A — next interval not created yet (members must contribute first)";
    let canPayoutNow = false;

    if (nextIndex < totalCount) {
      const nextInterval = await this.publicClient.readContract({
        address: poolAddress,
        abi: savingsPoolAbi,
        functionName: "intervals",
        args: [nextIndex],
      }) as readonly [bigint, bigint];

      nextIntervalEndTimestamp = nextInterval[1].toString();
      canPayoutNow = nextInterval[1] <= BigInt(Math.floor(Date.now() / 1000));
    }

    return {
      balance: (balance as bigint).toString(),
      interval: (interval as bigint).toString(),
      contribution: (contribution as bigint).toString(),
      lastProcessedInterval: lpi.toString(),
      lastPayoutTimestamp: lpt.toString(),
      nextIntervalEndTimestamp,
      canPayoutNow,
    };
  }
}
