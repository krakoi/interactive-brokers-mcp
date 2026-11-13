import { Logger } from "../logger.js";
import type { IBClientRequester } from "./accounts.js";
import {
  type ContractSearch,
  type OptionContractInfo,
  AuthenticationError,
  SymbolNotFoundError,
  isAuthenticationError,
} from "./types.js";

function matchesExchange(contract: ContractSearch | OptionContractInfo, exchange?: string): boolean {
  if (!exchange) return true;

  const target = exchange.toUpperCase();
  const values = [
    "exchange" in contract ? contract.exchange : undefined,
    "validExchanges" in contract ? contract.validExchanges : undefined,
    "description" in contract ? contract.description : undefined,
    "companyHeader" in contract ? contract.companyHeader : undefined,
  ]
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.toUpperCase());

  return values.some((value) => value.includes(target));
}

export function pickContract<T extends ContractSearch | OptionContractInfo>(
  contracts: T[],
  exchange?: string,
): T {
  const match = contracts.find((contract) => matchesExchange(contract, exchange));
  return match ?? contracts[0];
}

export async function searchContracts(client: IBClientRequester, symbol: string): Promise<ContractSearch[]> {
  const response = await client.request<ContractSearch[]>(
    "GET",
    `/iserver/secdef/search?symbol=${encodeURIComponent(symbol)}`,
  );

  if (!response.data || response.data.length === 0) {
    throw new SymbolNotFoundError(`Symbol ${symbol} not found`);
  }

  return response.data;
}

export interface SnapshotRetryOptions {
  attempts?: number;
  delayMs?: number;
}

const SNAPSHOT_FIELDS = "31,70,71,82,83,84,85,86,87,88";
const PRICE_FIELDS = ["31", "84", "86"]; // last, bid, ask

function hasPrice(data: unknown): boolean {
  if (!Array.isArray(data)) return false;
  return data.some((row) =>
    row && typeof row === "object" && PRICE_FIELDS.some((field) => (row as Record<string, unknown>)[field] !== undefined),
  );
}

/**
 * IB's snapshot endpoint usually answers the first request for a conid without prices
 * (it only starts the subscription). Poll until last/bid/ask appear or attempts run out.
 */
async function fetchSnapshotWithRetry(
  client: IBClientRequester,
  conid: number | string,
  options: SnapshotRetryOptions = {},
): Promise<unknown> {
  const attempts = options.attempts ?? 5;
  const delayMs = options.delayMs ?? 700;
  let data: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    const response = await client.request("GET", `/iserver/marketdata/snapshot?conids=${conid}&fields=${SNAPSHOT_FIELDS}`);
    data = response.data;
    if (hasPrice(data)) return data;
  }
  Logger.warn(`[MARKET-DATA] No price fields for conid ${conid} after ${attempts} attempts`);
  return data;
}

export async function getMarketData(
  client: IBClientRequester,
  symbol: string,
  exchange?: string,
  retry?: SnapshotRetryOptions,
): Promise<{ symbol: string; contract: ContractSearch; marketData: unknown }> {
  try {
    let searchUrl = `/iserver/secdef/search?symbol=${encodeURIComponent(symbol)}`;
    if (exchange) searchUrl += `&name=${encodeURIComponent(exchange)}`;
    const searchResponse = await client.request<ContractSearch[]>("GET", searchUrl);

    if (!searchResponse.data || searchResponse.data.length === 0) {
      throw new SymbolNotFoundError(`Symbol ${symbol}${exchange ? " on " + exchange : ""} not found`);
    }

    const contract = searchResponse.data[0];
    const marketData = await fetchSnapshotWithRetry(client, contract.conid, retry);
    return { symbol, contract, marketData };
  } catch (error: unknown) {
    Logger.error("Failed to get market data:", error);
    if (isAuthenticationError(error)) {
      throw new AuthenticationError(`Authentication required to retrieve market data for ${symbol}. Please authenticate with Interactive Brokers first.`);
    }
    if (error instanceof SymbolNotFoundError) throw error;
    throw new Error(`Failed to retrieve market data for ${symbol}`);
  }
}
