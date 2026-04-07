import { formatUnits } from "viem";

export interface TokenMetadata {
  decimals: number;
  symbol: string;
  name?: string | null;
}

const FALLBACK_TOKEN_DECIMALS = 6;
const FALLBACK_TOKEN_SYMBOL = "token";

export function normalizeTokenDecimals(decimals?: number | null): number {
  if (Number.isInteger(decimals) && (decimals as number) >= 0) return decimals as number;
  return FALLBACK_TOKEN_DECIMALS;
}

export function normalizeTokenSymbol(symbol?: string | null): string {
  const value = symbol?.trim();
  return value ? value : FALLBACK_TOKEN_SYMBOL;
}

export function trimTrailingZeros(value: string): string {
  if (!value.includes(".")) return value;
  return value.replace(/(?:\.0+|(\.\d*?[1-9])0+)$/, "$1");
}

export function formatTokenAmount(
  rawAmount: bigint | number | string,
  decimals?: number | null
): string {
  return trimTrailingZeros(formatUnits(BigInt(rawAmount), normalizeTokenDecimals(decimals)));
}

export function formatTokenAmountWithSymbol(
  rawAmount: bigint | number | string,
  decimals?: number | null,
  symbol?: string | null
): string {
  return `${formatTokenAmount(rawAmount, decimals)} ${normalizeTokenSymbol(symbol)}`;
}
