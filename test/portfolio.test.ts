import { describe, it, expect } from 'vitest';
import { getPortfolioSnapshot, getFxRates } from '../src/ib-client/portfolio.js';
import type { IBClientRequester } from '../src/ib-client/accounts.js';

type Route = (url: string, callIndex: number) => unknown;

/** Minimal fake requester: first route whose prefix matches the URL answers. */
function fakeClient(routes: Record<string, Route | unknown>) {
  const calls: string[] = [];
  const counts = new Map<string, number>();
  const client: IBClientRequester = {
    async request<T>(_method: string, url: string) {
      calls.push(url);
      const key = Object.keys(routes)
        .sort((a, b) => b.length - a.length)
        .find((prefix) => url.startsWith(prefix));
      if (!key) return { data: [] as unknown as T, status: 200, statusText: 'OK', headers: new Headers() };
      const n = counts.get(key) ?? 0;
      counts.set(key, n + 1);
      const route = routes[key];
      const data = typeof route === 'function' ? (route as Route)(url, n) : route;
      return { data: data as T, status: 200, statusText: 'OK', headers: new Headers() };
    },
  };
  return { client, calls };
}

const accounts = [
  { id: 'U1', accountAlias: 'TBSZ-2023', type: 'TBSZ', currency: 'HUF' },
  { id: 'U2', accountAlias: null, type: 'INDIVIDUAL', currency: 'EUR' },
];

const ledgerU1 = {
  BASE: { currency: 'BASE', cashbalance: 1000, netliquidationvalue: 5000, dividends: 12 },
  HUF: { currency: 'HUF', cashbalance: 800, settledcash: 800, stockmarketvalue: 0 },
  USD: { currency: 'USD', cashbalance: 0.5, settledcash: 0.5, stockmarketvalue: 10 },
  GBP: { currency: 'GBP', cashbalance: 0, settledcash: 0, stockmarketvalue: 0 },
};

const positionsU1 = [
  { conid: 1, contractDesc: 'NVDA', position: 10, currency: 'USD', mktPrice: 1, mktValue: 10, avgCost: 0.9, unrealizedPnl: 1, assetClass: 'STK', expiry: null },
  { conid: 2, contractDesc: 'OLD', position: 0, currency: 'USD', mktPrice: 1, mktValue: 0, avgCost: 1, unrealizedPnl: 0, assetClass: 'STK' },
];

const baseRoutes = {
  '/portfolio/accounts': accounts,
  '/portfolio/subaccounts2': { subaccounts: [] },
  '/portfolio/U1/ledger': ledgerU1,
  '/portfolio/U1/positions/0': positionsU1,
  '/portfolio/U2/ledger': { BASE: { cashbalance: 5 }, EUR: { currency: 'EUR', cashbalance: 5, settledcash: 5, stockmarketvalue: 0 } },
  '/portfolio/U2/positions/0': [],
};

describe('getPortfolioSnapshot', () => {
  it('builds compact per-account snapshot from ledger and positions', async () => {
    const { client } = fakeClient(baseRoutes);
    const result = await getPortfolioSnapshot(client);

    expect(result.accounts.map((a) => a.accountId)).toEqual(['U1', 'U2']);
    const u1 = result.accounts[0];
    expect(u1).toMatchObject({
      alias: 'TBSZ-2023', type: 'TBSZ', baseCurrency: 'HUF',
      netLiquidation: 5000, totalCash: 1000, accruedDividends: 12,
    });
    // BASE and all-zero currencies are dropped, sorted by currency
    expect(u1.cash).toEqual([
      { currency: 'HUF', cashBalance: 800, settledCash: 800, stockMarketValue: 0 },
      { currency: 'USD', cashBalance: 0.5, settledCash: 0.5, stockMarketValue: 10 },
    ]);
    // zero-quantity positions dropped, irrelevant fields removed
    expect(u1.positions).toEqual([{
      symbol: 'NVDA', description: 'NVDA', assetClass: 'STK', conid: 1, quantity: 10, currency: 'USD',
      marketPrice: 1, marketValue: 10, avgCost: 0.9, unrealizedPnl: 1,
    }]);
  });

  it('filters to requested accounts and pages positions', async () => {
    const page0 = Array.from({ length: 100 }, (_, i) => ({ conid: i + 1, contractDesc: `S${i}`, position: 1, currency: 'USD' }));
    const { client, calls } = fakeClient({
      ...baseRoutes,
      '/portfolio/U1/positions/0': page0,
      '/portfolio/U1/positions/1': [{ conid: 999, contractDesc: 'LAST', position: 1, currency: 'USD' }],
    });
    const result = await getPortfolioSnapshot(client, ['U1']);
    expect(result.accounts).toHaveLength(1);
    expect(result.accounts[0].positions).toHaveLength(101);
    expect(calls.some((url) => url.includes('/U2/'))).toBe(false);
  });

  it('rejects unknown account ids', async () => {
    const { client } = fakeClient(baseRoutes);
    await expect(getPortfolioSnapshot(client, ['NOPE'])).rejects.toThrow('Unknown account id(s): NOPE');
  });
});

describe('getFxRates', () => {
  const search = (known: Record<string, number>) => (url: string) => {
    const pair = decodeURIComponent(url.match(/symbol=([^&]+)/)![1]);
    const conid = known[pair];
    return conid ? [{ conid: String(conid), symbol: pair, sections: [{ secType: 'CASH', exchange: 'IDEALPRO', conid: String(conid) }] }] : [];
  };
  const fx = { 'EUR.USD': 10, 'USD.HUF': 20, 'EUR.HUF': 30 };
  const quotes: Record<number, Record<string, string>> = {
    10: { '84': '1.10', '86': '1.12' },
    20: { '84': '330', '86': '332' },
    30: { '84': '380', '86': '382' },
  };
  const snapshotRoute = (url: string) => {
    const conids = url.match(/conids=([^&]+)/)![1].split(',').map(Number);
    return conids.map((conid) => ({ conid, ...quotes[conid] }));
  };

  it('defaults to USD and pairs every portfolio currency, inverting when needed', async () => {
    const { client } = fakeClient({ ...baseRoutes, '/iserver/secdef/search': search(fx), '/iserver/marketdata/snapshot': snapshotRoute });
    const result = await getFxRates(client, { retry: { delayMs: 0 } });

    expect(result.currencies).toEqual(['EUR', 'HUF', 'USD']);
    expect(result.quoteCurrencies).toEqual(['USD']);
    expect(result.rates.map((r) => `${r.from}>${r.to}`)).toEqual(['EUR>USD', 'HUF>USD']);

    const eur = result.rates[0];
    expect(eur).toMatchObject({ bid: 1.1, ask: 1.12, source: 'EUR.USD', inverted: false, derived: false, stale: false });
    expect(eur.mid).toBeCloseTo(1.11);

    const huf = result.rates[1];
    expect(huf).toMatchObject({ source: 'USD.HUF', inverted: true, derived: false, stale: false });
    expect(huf.bid).toBeCloseTo(1 / 332); // bid/ask swap when inverting
    expect(huf.ask).toBeCloseTo(1 / 330);
  });

  it('derives via USD when no direct or inverted pair exists', async () => {
    const { client } = fakeClient({
      ...baseRoutes,
      '/iserver/secdef/search': search({ 'EUR.USD': 10, 'USD.HUF': 20 }),
      '/iserver/marketdata/snapshot': snapshotRoute,
    });
    const result = await getFxRates(client, { quoteCurrencies: ['eur'], retry: { delayMs: 0 } });
    const huf = result.rates.find((r) => r.from === 'HUF')!;
    expect(huf).toMatchObject({ to: 'EUR', derived: true, source: 'USD.HUF*EUR.USD', stale: false });
    expect(huf.bid).toBeCloseTo((1 / 332) * (1 / 1.12));
    expect(huf.ask).toBeCloseTo((1 / 330) * (1 / 1.10));
  });

  it('retries when the first market data snapshot is empty', async () => {
    const { client, calls } = fakeClient({
      ...baseRoutes,
      '/iserver/secdef/search': search(fx),
      '/iserver/marketdata/snapshot': (url: string, n: number) => (n === 0 ? [{ conid: 10 }, { conid: 20 }] : snapshotRoute(url)),
    });
    const result = await getFxRates(client, { retry: { delayMs: 0 } });
    expect(result.rates.every((r) => !r.stale)).toBe(true);
    expect(calls.filter((url) => url.startsWith('/iserver/marketdata/snapshot'))).toHaveLength(2);
  });

  it('marks rates stale when no quote ever arrives', async () => {
    const { client } = fakeClient({
      ...baseRoutes,
      '/iserver/secdef/search': search(fx),
      '/iserver/marketdata/snapshot': (url: string) => url.match(/conids=([^&]+)/)![1].split(',').map((c) => ({ conid: Number(c) })),
    });
    const result = await getFxRates(client, { retry: { attempts: 2, delayMs: 0 } });
    expect(result.rates.every((r) => r.stale && r.mid === null)).toBe(true);
  });
});

describe('getMarketData retry', () => {
  it('polls the snapshot until price fields appear', async () => {
    const { getMarketData } = await import('../src/ib-client/market-data.js');
    const { client, calls } = fakeClient({
      '/iserver/secdef/search': [{ conid: '4815747', symbol: 'NVDA' }],
      '/iserver/marketdata/snapshot': (_url: string, n: number) =>
        n < 2 ? [{ conid: 4815747 }] : [{ conid: 4815747, '31': '169.00', '84': '168.99', '86': '169.01' }],
    });
    const result = await getMarketData(client, 'NVDA', undefined, { delayMs: 0 });
    expect(result.marketData).toEqual([{ conid: 4815747, '31': '169.00', '84': '168.99', '86': '169.01' }]);
    expect(calls.filter((url) => url.startsWith('/iserver/marketdata/snapshot'))).toHaveLength(3);
  });

  it('returns the last (empty) snapshot after exhausting attempts', async () => {
    const { getMarketData } = await import('../src/ib-client/market-data.js');
    const { client, calls } = fakeClient({
      '/iserver/secdef/search': [{ conid: '1', symbol: 'X' }],
      '/iserver/marketdata/snapshot': [{ conid: 1 }],
    });
    const result = await getMarketData(client, 'X', undefined, { attempts: 3, delayMs: 0 });
    expect(result.marketData).toEqual([{ conid: 1 }]);
    expect(calls.filter((url) => url.startsWith('/iserver/marketdata/snapshot'))).toHaveLength(3);
  });
});
