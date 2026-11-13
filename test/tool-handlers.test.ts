// test/tool-handlers.test.ts
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { ToolHandlers, ToolHandlerContext } from '../src/tool-handlers.js';
import { IBClient } from '../src/ib-client.js';

// Mock dependencies
vi.mock('../src/ib-client.js');

describe('ToolHandlers', () => {
  let handlers: ToolHandlers;
  let mockIBClient: IBClient;
  let context: ToolHandlerContext;

  beforeEach(() => {
    vi.clearAllMocks();

    // Create mock IBClient
    mockIBClient = {
      checkAuthenticationStatus: vi.fn().mockResolvedValue(true),
      reauthenticate: vi.fn().mockResolvedValue(undefined),
      getAccountInfo: vi.fn().mockResolvedValue({ accounts: [] }),
      getPositions: vi.fn().mockResolvedValue([]),
      getMarketData: vi.fn().mockResolvedValue({ price: 150 }),
      placeOrder: vi.fn().mockResolvedValue({ orderId: '123' }),
      getOrderStatus: vi.fn().mockResolvedValue({ status: 'Filled' }),
      getOrders: vi.fn().mockResolvedValue([]),
      confirmOrder: vi.fn().mockResolvedValue({ confirmed: true }),
      destroy: vi.fn(),
      updatePort: vi.fn(),
      getAlerts: vi.fn().mockResolvedValue([]),
      createAlert: vi.fn().mockResolvedValue({ request_id: '1' }),
      activateAlert: vi.fn().mockResolvedValue({ success: true }),
      deleteAlert: vi.fn().mockResolvedValue({ success: true }),
    } as any;

    // Create context
    context = {
      ibClient: mockIBClient,
      config: {
        IB_GATEWAY_HOST: 'localhost',
        IB_GATEWAY_PORT: 5000,
      },
    };

    handlers = new ToolHandlers(context);
  });

  afterEach(() => {
    vi.useRealTimers();
  });


  describe('getAccountInfo', () => {
    it('should return account information', async () => {
      const mockAccounts = [{ id: 'U12345', accountId: 'U12345' }];
      mockIBClient.getAccountInfo = vi.fn().mockResolvedValue({ accounts: mockAccounts });

      const result = await handlers.getAccountInfo({ confirm: true });

      expect(result.content).toBeDefined();
      expect(result.content[0].type).toBe('text');
      expect(mockIBClient.getAccountInfo).toHaveBeenCalled();
    });

    it('should handle errors gracefully', async () => {
      mockIBClient.getAccountInfo = vi.fn().mockRejectedValue(new Error('API Error'));

      const result = await handlers.getAccountInfo({ confirm: true });

      expect(result.content).toBeDefined();
      expect(result.content[0].text).toContain('API Error');
    });
  });

  describe('getPositions', () => {
    it('should return positions for account', async () => {
      const mockPositions = [{ symbol: 'AAPL', position: 10 }];
      mockIBClient.getPositions = vi.fn().mockResolvedValue(mockPositions);

      const result = await handlers.getPositions({ accountId: 'U12345' });

      expect(result.content).toBeDefined();
      expect(mockIBClient.getPositions).toHaveBeenCalledWith('U12345');
    });

    it('should handle missing accountId', async () => {
      const result = await handlers.getPositions({} as any);

      expect(result.content).toBeDefined();
      expect(result.content[0].text).toContain('Account ID is required');
    });
  });

  describe('getMarketData', () => {
    it('should return market data for symbol', async () => {
      const mockData = { symbol: 'AAPL', price: 150.25 };
      mockIBClient.getMarketData = vi.fn().mockResolvedValue(mockData);

      const result = await handlers.getMarketData({ symbol: 'AAPL' });

      expect(result.content).toBeDefined();
      expect(mockIBClient.getMarketData).toHaveBeenCalledWith('AAPL', undefined);
    });

    it('should pass exchange parameter', async () => {
      const mockData = { symbol: 'AAPL', price: 150.25 };
      mockIBClient.getMarketData = vi.fn().mockResolvedValue(mockData);

      await handlers.getMarketData({ symbol: 'AAPL', exchange: 'NASDAQ' });

      expect(mockIBClient.getMarketData).toHaveBeenCalledWith('AAPL', 'NASDAQ');
    });
  });

  describe('placeOrder', () => {
    it('should place market order', async () => {
      const mockResponse = { orderId: '123', status: 'Submitted' };
      mockIBClient.placeOrder = vi.fn().mockResolvedValue(mockResponse);

      const orderInput = {
        accountId: 'U12345',
        symbol: 'AAPL',
        action: 'BUY' as const,
        orderType: 'MKT' as const,
        quantity: 10,
      };

      const result = await handlers.placeOrder(orderInput);

      expect(result.content).toBeDefined();
      expect(mockIBClient.placeOrder).toHaveBeenCalledWith(
        expect.objectContaining({
          accountId: 'U12345',
          symbol: 'AAPL',
          action: 'BUY',
          orderType: 'MKT',
          quantity: 10,
        })
      );
    });

    it('should place limit order with price', async () => {
      const mockResponse = { orderId: '123', status: 'Submitted' };
      mockIBClient.placeOrder = vi.fn().mockResolvedValue(mockResponse);

      const orderInput = {
        accountId: 'U12345',
        symbol: 'AAPL',
        action: 'BUY' as const,
        orderType: 'LMT' as const,
        quantity: 10,
        price: 150.50,
      };

      await handlers.placeOrder(orderInput);

      expect(mockIBClient.placeOrder).toHaveBeenCalledWith(
        expect.objectContaining({
          price: 150.50,
        })
      );
    });

    it('should forward exchange and tif to ibClient.placeOrder when provided', async () => {
      const mockResponse = { orderId: '123', status: 'Submitted' };
      mockIBClient.placeOrder = vi.fn().mockResolvedValue(mockResponse);

      const orderInput = {
        accountId: 'U12345',
        symbol: 'AAPL',
        action: 'BUY' as const,
        orderType: 'MKT' as const,
        quantity: 10,
        exchange: 'NASDAQ',
        tif: 'GTC' as const,
      };

      await handlers.placeOrder(orderInput);

      expect(mockIBClient.placeOrder).toHaveBeenCalledWith(
        expect.objectContaining({
          exchange: 'NASDAQ',
          tif: 'GTC',
        })
      );
    });

    it('should handle order placement errors', async () => {
      mockIBClient.placeOrder = vi.fn().mockRejectedValue(new Error('Order failed'));

      const orderInput = {
        accountId: 'U12345',
        symbol: 'AAPL',
        action: 'BUY' as const,
        orderType: 'MKT' as const,
        quantity: 10,
      };

      const result = await handlers.placeOrder(orderInput);

      expect(result.content[0].text).toContain('Order failed');
    });
  });

  describe('getLiveOrders', () => {
    it('should return all live orders', async () => {
      const mockOrders = [{ orderId: '123', status: 'Working' }];
      mockIBClient.getOrders = vi.fn().mockResolvedValue(mockOrders);

      const result = await handlers.getLiveOrders({});

      expect(result.content).toBeDefined();
      expect(mockIBClient.getOrders).toHaveBeenCalledWith(undefined);
    });

    it('should always fetch all orders without account parameter', async () => {
      const mockOrders = [{ orderId: '123', status: 'Working' }];
      mockIBClient.getOrders = vi.fn().mockResolvedValue(mockOrders);

      const result = await handlers.getLiveOrders({});

      expect(mockIBClient.getOrders).toHaveBeenCalledWith(undefined);
      expect(result.content).toBeDefined();
    });
  });

  describe('getOrderStatus', () => {
    it('should return order status', async () => {
      const mockStatus = { orderId: '123', status: 'Filled' };
      mockIBClient.getOrderStatus = vi.fn().mockResolvedValue(mockStatus);

      const result = await handlers.getOrderStatus({ orderId: '123' });

      expect(result.content).toBeDefined();
      expect(mockIBClient.getOrderStatus).toHaveBeenCalledWith('123');
    });
  });

  describe('confirmOrder', () => {
    it('should confirm order', async () => {
      const mockResponse = { confirmed: true };
      mockIBClient.confirmOrder = vi.fn().mockResolvedValue(mockResponse);

      const result = await handlers.confirmOrder({
        replyId: 'reply-123',
        messageIds: ['msg1', 'msg2'],
      });

      expect(result.content).toBeDefined();
      expect(mockIBClient.confirmOrder).toHaveBeenCalledWith('reply-123', ['msg1', 'msg2']);
    });
  });

  describe('authenticate', () => {
    it('reports an existing session without polling', async () => {
      const result = await handlers.authenticate({ confirm: true });

      const response = JSON.parse(result.content[0].text);
      expect(response).toEqual({ authenticated: true, authUrl: 'https://localhost:5000' });
      expect(mockIBClient.reauthenticate).not.toHaveBeenCalled();
    });

    it('revives an expired session via reauthenticate', async () => {
      vi.mocked(mockIBClient.checkAuthenticationStatus)
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true);

      const result = await handlers.authenticate({ confirm: true });

      const response = JSON.parse(result.content[0].text);
      expect(response.authenticated).toBe(true);
      expect(mockIBClient.reauthenticate).toHaveBeenCalledTimes(1);
    });

    it('returns manual login instructions and starts polling when not logged in', async () => {
      vi.mocked(mockIBClient.checkAuthenticationStatus).mockResolvedValue(false);
      const polling = vi.spyOn(handlers as any, 'startBrowserAuthPolling').mockImplementation(() => {});

      const result = await handlers.authenticate({ confirm: true });

      const response = JSON.parse(result.content[0].text);
      expect(response.authenticated).toBe(false);
      expect(response.polling).toBe(true);
      expect(response.authUrl).toBe('https://localhost:5000');
      expect(response.instructions[0]).toContain('https://localhost:5000');
      expect(polling).toHaveBeenCalledWith('https://localhost:5000', 5000);
    });

    it('says the gateway is unreachable on connection errors', async () => {
      const refused = Object.assign(new Error('fetch failed'), { code: 'ECONNREFUSED' });
      vi.mocked(mockIBClient.checkAuthenticationStatus).mockRejectedValue(refused);

      const result = await handlers.authenticate({ confirm: true });

      const response = JSON.parse(result.content[0].text);
      expect(response.authenticated).toBe(false);
      expect(response.message).toContain('not reachable');
    });
  });

  describe('ensureAuth', () => {
    it('should return early when already authenticated', async () => {
      mockIBClient.checkAuthenticationStatus = vi.fn().mockResolvedValue(true);
      mockIBClient.reauthenticate = vi.fn();

      await (handlers as any).ensureAuth();

      expect(mockIBClient.reauthenticate).not.toHaveBeenCalled();
    });

    it('should attempt reauthenticate before giving up, and throw when it does not help', async () => {
      mockIBClient.checkAuthenticationStatus = vi.fn()
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(false);
      mockIBClient.reauthenticate = vi.fn();

      await expect((handlers as any).ensureAuth())
        .rejects.toThrow('Authentication required');
      expect(mockIBClient.reauthenticate).toHaveBeenCalledTimes(1);
    });

    it('should recover via reauthenticate without forcing a manual browser login', async () => {
      mockIBClient.checkAuthenticationStatus = vi.fn()
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true);
      mockIBClient.reauthenticate = vi.fn();

      await expect((handlers as any).ensureAuth()).resolves.toEqual({ ok: true });
      expect(mockIBClient.reauthenticate).toHaveBeenCalledTimes(1);
    });
  });

  describe('startBrowserAuthPolling', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should poll and call reauthenticate when auth detected', async () => {
      mockIBClient.checkAuthenticationStatus = vi.fn()
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true);
      mockIBClient.reauthenticate = vi.fn().mockResolvedValue(undefined);

      (handlers as any).startBrowserAuthPolling('https://localhost:5000', 5000);
      await vi.advanceTimersByTimeAsync(120_000);

      expect(mockIBClient.checkAuthenticationStatus).toHaveBeenCalledTimes(2);
      expect(mockIBClient.reauthenticate).toHaveBeenCalledTimes(1);
    });
  });

  describe('getAlerts', () => {
    it('should return alerts for account', async () => {
      const mockAlerts = [{ alertId: '1', alertName: 'Price Alert' }];
      mockIBClient.getAlerts = vi.fn().mockResolvedValue(mockAlerts);

      const result = await handlers.getAlerts({ accountId: 'U12345' });

      expect(result.content).toBeDefined();
      expect(result.content[0].type).toBe('text');
      expect(mockIBClient.getAlerts).toHaveBeenCalledWith('U12345');
    });
  });

  describe('Error Handling', () => {
    it('should format authentication errors', async () => {
      const authError = new Error('Authentication required');
      (authError as any).isAuthError = true;
      
      mockIBClient.getAccountInfo = vi.fn().mockRejectedValue(authError);

      const result = await handlers.getAccountInfo({ confirm: true });

      expect(result.content[0].text).toContain('Authentication required');
    });

    it('should format generic errors', async () => {
      mockIBClient.getAccountInfo = vi.fn().mockRejectedValue(new Error('Generic error'));

      const result = await handlers.getAccountInfo({ confirm: true });

      expect(result.content[0].text).toContain('Generic error');
    });

    it('should handle non-Error objects', async () => {
      mockIBClient.getAccountInfo = vi.fn().mockRejectedValue('String error');

      const result = await handlers.getAccountInfo({ confirm: true });

      expect(result.content).toBeDefined();
      expect(result.content[0].text).toContain('String error');
    });
  });

  describe('Flex Query Tools', () => {
    describe('getFlexQuery', () => {
      it('should return error when flex query client is not configured', async () => {
        // Context without flex query client (using the one from beforeEach which has no flex client)
        const result = await handlers.getFlexQuery({
          queryId: '123456',  
          parseXml: false,  
        });

        const response = JSON.parse(result.content[0].text);
        expect(response.error).toBe('Flex Query feature not configured');
        expect(response.message).toContain('IB_FLEX_TOKEN');
      });
    });

    describe('listFlexQueries', () => {
      it('should return error when not configured', async () => {
        const result = await handlers.listFlexQueries({ confirm: true });

        const response = JSON.parse(result.content[0].text);
        expect(response.error).toBe('Flex Query feature not configured');
      });
    });

    describe('forgetFlexQuery', () => {
      it('should return error when not configured', async () => {
        const result = await handlers.forgetFlexQuery({ queryId: '123456' });

        const response = JSON.parse(result.content[0].text);
        expect(response.error).toBe('Flex Query feature not configured');
      });
    });
  });

  describe('Option tools', () => {
    it('should return option chain data', async () => {
      const mockChain = {
        symbol: 'AAPL',
        underlyingConid: 265598,
        expirations: [{ expiry: 'JAN27', call: [200], put: [200] }],
      };
      mockIBClient.getOptionChain = vi.fn().mockResolvedValue(mockChain);

      const result = await handlers.getOptionChain({ symbol: 'AAPL', exchange: 'SMART' });

      expect(mockIBClient.getOptionChain).toHaveBeenCalledWith('AAPL', 'SMART');
      expect(result.content[0].text).toContain('"underlyingConid": 265598');
    });

    it('should resolve option conids', async () => {
      const mockResolution = {
        symbol: 'AAPL',
        underlyingConid: 265598,
        option: { conid: 912345678, right: 'C', strike: 200 },
      };
      mockIBClient.resolveOptionConid = vi.fn().mockResolvedValue(mockResolution);

      const result = await handlers.resolveOptionConid({
        symbol: 'AAPL',
        expiry: 'JAN27',
        strike: 200,
        right: 'C',
        exchange: 'SMART',
      });

      expect(mockIBClient.resolveOptionConid).toHaveBeenCalledWith(
        'AAPL',
        'JAN27',
        200,
        'C',
        'SMART',
      );
      expect(result.content[0].text).toContain('"conid": 912345678');
    });

    it('should pass option order fields through to the IB client', async () => {
      mockIBClient.placeOrder = vi.fn().mockResolvedValue({ orderId: '123', status: 'Submitted' });

      await handlers.placeOrder({
        accountId: 'U12345',
        symbol: 'AAPL',
        secType: 'OPT',
        expiry: 'JAN27',
        strike: 200,
        right: 'C',
        action: 'BUY',
        orderType: 'LMT',
        quantity: 1,
        price: 4.5,
      });

      expect(mockIBClient.placeOrder).toHaveBeenCalledWith(
        expect.objectContaining({
          symbol: 'AAPL',
          secType: 'OPT',
          expiry: 'JAN27',
          strike: 200,
          right: 'C',
          price: 4.5,
        }),
      );
    });
  });
});
