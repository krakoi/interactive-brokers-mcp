import { Logger } from "../logger.js";
import { getPortfolioAccounts, getAccountId, type IBClientRequester } from "./accounts.js";
import {
  type AccountEntry,
  type ContractSearch,
  AuthenticationError,
  isAuthenticationError,
} from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CurrencyBalance {
  currency: string;
  cashBalance: number | null;
  settledCash: number | null;
  stockMarketValue: number | null;
}

interface SnapshotPosition {
  symbol: string;
  description: string | null;
  assetClass: string | null;
  conid: number;
  quantity: number;
  currency: string;
  marketPrice: number | null;
  marketValue: number | null;
  avgCost: number | null;
  unrealizedPnl: number | null;
}

export interface AccountSnapshot {
  accountId: string;
  alias: string | null;
  type: string | null;
  baseCurrency: string | null;
  netLiquidation: number | null;
  totalCash: number | null;
  accruedDividends: number | null;
  cash: CurrencyBalance[];
  positions: SnapshotPosition[];
}

export interface PortfolioSnapshot {
  accounts: AccountSnapshot[];
}

export interface FxRate {
  /** 1 `from` = `mid` `to` */
  from: string;
  to: string;
  bid: number | null;
  ask: number | null;
  mid: number | null;
  /** IB pair used (e.g. "EUR.USD"); for derived rates, the pairs joined by "*" */
  source: string;
  inverted: boolean;
  derived: boolean;
  stale: boolean;
}

export interface FxRatesResult {
  currencies: string[];
  quoteCurrencies: string[];
  rates: FxRate[];
}

type LedgerEntry = Record<string, unknown>;
type Ledger = Record<string, LedgerEntry>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE_LEDGER_KEY = "BASE";

function num(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    // IB market data may prefix values (e.g. "C1.0823" for a closing price)
    const cleaned = value.replace(/^[A-Za-z]+/, "").replace(/,/g, "");
    if (cleaned === "") return null;
    const parsed = Number(cleaned);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function rethrow(error: unknown, what: string): never {
  Logger.error(`Failed to ${what}:`, error);
  if (isAuthenticationError(error)) {
    throw new AuthenticationError(`Authentication required to ${what}. Please authenticate with Interactive Brokers first.`);
  }
  throw new Error(`Failed to ${what}`);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function selectAccounts(
  client: IBClientRequester,
  accountIds?: string[],
): Promise<AccountEntry[]> {
  const accounts = await getPortfolioAccounts(client);
  const withId = accounts.filter((account) => getAccountId(account));
  if (!accountIds || accountIds.length === 0) return withId;

  const byId = new Map(withId.map((account) => [getAccountId(account)!, account]));
  const unknown = accountIds.filter((id) => !byId.has(id));
  if (unknown.length > 0) {
    throw new Error(`Unknown account id(s): ${unknown.join(", ")}`);
  }
  return accountIds.map((id) => byId.get(id)!);
}

async function getLedger(client: IBClientRequester, accountId: string): Promise<Ledger> {
  const response = await client.request<Ledger>("GET", `/portfolio/${accountId}/ledger`);
  return response.data && typeof response.data === "object" ? response.data : {};
}

async function getAllPositions(client: IBClientRequester, accountId: string): Promise<Array<Record<string, unknown>>> {
  // IB pages positions (100 per page); fetch until a short page is returned
  const all: Array<Record<string, unknown>> = [];
  for (let page = 0; page < 50; page++) {
    const response = await client.request<Array<Record<string, unknown>>>(
      "GET",
      `/portfolio/${accountId}/positions/${page}`,
    );
    const rows = Array.isArray(response.data) ? response.data : [];
    all.push(...rows);
    if (rows.length < 100) break;
  }
  return all;
}

function toCurrencyBalances(ledger: Ledger): CurrencyBalance[] {
  return Object.entries(ledger)
    .filter(([key]) => key !== BASE_LEDGER_KEY)
    .map(([key, entry]) => ({
      currency: str(entry.currency) ?? key,
      cashBalance: num(entry.cashbalance),
      settledCash: num(entry.settledcash),
      stockMarketValue: num(entry.stockmarketvalue),
    }))
    .filter((balance) =>
      [balance.cashBalance, balance.settledCash, balance.stockMarketValue].some((v) => v !== null && v !== 0),
    )
    .sort((a, b) => a.currency.localeCompare(b.currency));
}

function toPosition(row: Record<string, unknown>): SnapshotPosition {
  return {
    symbol: str(row.ticker) ?? str(row.contractDesc) ?? String(row.conid),
    description: str(row.name) ?? str(row.contractDesc),
    assetClass: str(row.assetClass),
    conid: Number(row.conid),
    quantity: num(row.position) ?? 0,
    currency: str(row.currency) ?? "",
    marketPrice: num(row.mktPrice),
    marketValue: num(row.mktValue),
    avgCost: num(row.avgCost),
    unrealizedPnl: num(row.unrealizedPnl),
  };
}

// ---------------------------------------------------------------------------
// Portfolio snapshot
// ---------------------------------------------------------------------------

export async function getPortfolioSnapshot(
  client: IBClientRequester,
  accountIds?: string[],
): Promise<PortfolioSnapshot> {
  try {
    const accounts = await selectAccounts(client, accountIds);
    const snapshots: AccountSnapshot[] = [];

    for (const account of accounts) {
      const id = getAccountId(account)!;
      const [ledger, positions] = await Promise.all([
        getLedger(client, id),
        getAllPositions(client, id),
      ]);
      const base = ledger[BASE_LEDGER_KEY] ?? {};

      snapshots.push({
        accountId: id,
        alias: str(account.accountAlias),
        type: str(account.type),
        baseCurrency: str(account.currency),
        netLiquidation: num(base.netliquidationvalue),
        totalCash: num(base.cashbalance),
        accruedDividends: num(base.dividends),
        cash: toCurrencyBalances(ledger),
        positions: positions
          .filter((row) => num(row.position) !== 0)
          .map(toPosition),
      });
    }

    return { accounts: snapshots };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Unknown account id")) throw error;
    rethrow(error, "retrieve portfolio snapshot");
  }
}

// ---------------------------------------------------------------------------
// FX rates
// ---------------------------------------------------------------------------

interface PairQuote {
  bid: number | null;
  ask: number | null;
  stale: boolean;
}

const FX_FIELDS = "31,84,86"; // last, bid, ask

async function findCashConid(client: IBClientRequester, pair: string): Promise<number | null> {
  try {
    const response = await client.request<ContractSearch[]>(
      "GET",
      `/iserver/secdef/search?symbol=${encodeURIComponent(pair)}&secType=CASH`,
    );
    const results = Array.isArray(response.data) ? response.data : [];
    for (const result of results) {
      if (String(result.symbol ?? "").toUpperCase() !== pair) continue;
      const sections = result.sections ?? [];
      const cash = sections.find((section) => section.secType === "CASH" && section.conid);
      if (cash) return Number(cash.conid);
      if (result.conid) return Number(result.conid);
    }
    return null;
  } catch (error) {
    if (isAuthenticationError(error)) throw error;
    Logger.warn(`[FX] Contract search for ${pair} failed`, error);
    return null;
  }
}

async function fetchQuotes(
  client: IBClientRequester,
  conids: number[],
  options: { attempts?: number; delayMs?: number } = {},
): Promise<Map<number, PairQuote>> {
  const attempts = options.attempts ?? 4;
  const delayMs = options.delayMs ?? 500;
  const quotes = new Map<number, PairQuote>();
  if (conids.length === 0) return quotes;

  let pending = [...conids];
  for (let attempt = 0; attempt < attempts && pending.length > 0; attempt++) {
    if (attempt > 0) await sleep(delayMs);
    const response = await client.request<Array<Record<string, unknown>>>(
      "GET",
      `/iserver/marketdata/snapshot?conids=${pending.join(",")}&fields=${FX_FIELDS}`,
    );
    const rows = Array.isArray(response.data) ? response.data : [];
    for (const row of rows) {
      const conid = Number(row.conid);
      const bid = num(row["84"]);
      const ask = num(row["86"]);
      if (bid !== null && ask !== null) {
        quotes.set(conid, { bid, ask, stale: false });
      } else {
        const last = num(row["31"]);
        if (last !== null) quotes.set(conid, { bid: bid ?? last, ask: ask ?? last, stale: true });
      }
    }
    pending = pending.filter((conid) => !quotes.get(conid) || quotes.get(conid)!.stale);
  }
  return quotes;
}

function mid(bid: number | null, ask: number | null): number | null {
  return bid !== null && ask !== null ? (bid + ask) / 2 : null;
}

/** Trim float noise (e.g. 365.26300000000003) to 8 significant digits. */
function round(value: number | null): number | null {
  return value === null ? null : Number(value.toPrecision(8));
}

function invert(quote: PairQuote): PairQuote {
  return {
    bid: quote.ask ? 1 / quote.ask : null,
    ask: quote.bid ? 1 / quote.bid : null,
    stale: quote.stale,
  };
}

async function collectPortfolioCurrencies(
  client: IBClientRequester,
  accountIds?: string[],
): Promise<string[]> {
  const snapshot = await getPortfolioSnapshot(client, accountIds);
  const currencies = new Set<string>();
  for (const account of snapshot.accounts) {
    if (account.baseCurrency) currencies.add(account.baseCurrency.toUpperCase());
    for (const balance of account.cash) currencies.add(balance.currency.toUpperCase());
    for (const position of account.positions) {
      if (position.currency) currencies.add(position.currency.toUpperCase());
    }
  }
  return [...currencies].sort();
}

export async function getFxRates(
  client: IBClientRequester,
  options: {
    accountIds?: string[];
    quoteCurrencies?: string[];
    retry?: { attempts?: number; delayMs?: number };
  } = {},
): Promise<FxRatesResult> {
  try {
    const quoteCurrencies = [...new Set((options.quoteCurrencies?.length ? options.quoteCurrencies : ["USD"]).map((c) => c.toUpperCase()))];
    const currencies = await collectPortfolioCurrencies(client, options.accountIds);

    const wanted: Array<[string, string]> = [];
    for (const from of currencies) {
      for (const to of quoteCurrencies) {
        if (from !== to) wanted.push([from, to]);
      }
    }

    // Resolve an IB pair (direct or inverted) for every currency combination we may need,
    // including legs via USD for derived rates.
    const pairConids = new Map<string, { conid: number; inverted: boolean; pair: string } | null>();
    const resolve = async (from: string, to: string) => {
      const key = `${from}>${to}`;
      if (pairConids.has(key)) return pairConids.get(key)!;
      let resolved: { conid: number; inverted: boolean; pair: string } | null = null;
      const direct = await findCashConid(client, `${from}.${to}`);
      if (direct !== null) {
        resolved = { conid: direct, inverted: false, pair: `${from}.${to}` };
      } else {
        const reverse = await findCashConid(client, `${to}.${from}`);
        if (reverse !== null) resolved = { conid: reverse, inverted: true, pair: `${to}.${from}` };
      }
      pairConids.set(key, resolved);
      pairConids.set(`${to}>${from}`, resolved && { ...resolved, inverted: !resolved.inverted });
      return resolved;
    };

    const plans: Array<{ from: string; to: string; legs: Array<{ conid: number; inverted: boolean; pair: string }> | null }> = [];
    for (const [from, to] of wanted) {
      const direct = await resolve(from, to);
      if (direct) {
        plans.push({ from, to, legs: [direct] });
        continue;
      }
      if (from !== "USD" && to !== "USD") {
        const first = await resolve(from, "USD");
        const second = await resolve("USD", to);
        if (first && second) {
          plans.push({ from, to, legs: [first, second] });
          continue;
        }
      }
      plans.push({ from, to, legs: null });
    }

    const conids = [...new Set(plans.flatMap((plan) => plan.legs?.map((leg) => leg.conid) ?? []))];
    const quotes = await fetchQuotes(client, conids, options.retry);

    const rates: FxRate[] = plans.map(({ from, to, legs }) => {
      if (!legs) {
        return { from, to, bid: null, ask: null, mid: null, source: "unavailable", inverted: false, derived: false, stale: true };
      }
      let combined: PairQuote = { bid: 1, ask: 1, stale: false };
      for (const leg of legs) {
        const raw = quotes.get(leg.conid);
        const quote = raw ? (leg.inverted ? invert(raw) : raw) : { bid: null, ask: null, stale: true };
        combined = {
          bid: combined.bid !== null && quote.bid !== null ? combined.bid * quote.bid : null,
          ask: combined.ask !== null && quote.ask !== null ? combined.ask * quote.ask : null,
          stale: combined.stale || quote.stale,
        };
      }
      return {
        from,
        to,
        bid: round(combined.bid),
        ask: round(combined.ask),
        mid: round(mid(combined.bid, combined.ask)),
        source: legs.map((leg) => leg.pair).join("*"),
        inverted: legs.length === 1 && legs[0].inverted,
        derived: legs.length > 1,
        stale: combined.stale || combined.bid === null || combined.ask === null,
      };
    });

    return { currencies, quoteCurrencies, rates };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Unknown account id")) throw error;
    rethrow(error, "retrieve FX rates");
  }
}
