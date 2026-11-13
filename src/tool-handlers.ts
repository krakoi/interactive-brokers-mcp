import { promises as fs } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { IBClient } from "./ib-client.js";
import { Logger } from "./logger.js";
import { FlexQueryClient } from "./flex-query-client.js";
import { FlexQueryStorage } from "./flex-query-storage.js";
import {
  AuthenticateInput,
  GetAccountInfoInput,
  GetPositionsInput,
  GetPortfolioSnapshotInput,
  GetFxRatesInput,
  GetOptionChainInput,
  ResolveOptionConidInput,
  GetMarketDataInput,
  PlaceOrderInput,
  GetOrderStatusInput,
  GetLiveOrdersInput,
  ConfirmOrderInput,
  GetAlertsInput,
  CreateAlertInput,
  ActivateAlertInput,
  DeleteAlertInput,
  GetFlexQueryInput,
  ListFlexQueriesInput,
  ForgetFlexQueryInput,
} from "./tool-definitions.js";

export interface ToolHandlerContext {
  ibClient: IBClient;
  config: any;
  flexQueryClient?: FlexQueryClient;
  flexQueryStorage?: FlexQueryStorage;
}

type ToolHandlerResult = {
  content: Array<{
    type: "text";
    text: string;
  }>;
};

/** Account ids and periods from a parsed Flex statement (xml2js, mergeAttrs). */
const FlexStatementSummary = {
  from(parsed: any): { accountIds: string[]; periods: { accountId: string; fromDate: string; toDate: string; period?: string }[] } {
    const raw = parsed?.FlexQueryResponse?.FlexStatements?.FlexStatement;
    const list: any[] = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
    const periods = list.map((s) => ({
      accountId: String(s.accountId ?? ""),
      fromDate: String(s.fromDate ?? ""),
      toDate: String(s.toDate ?? ""),
      ...(s.period ? { period: String(s.period) } : {}),
    }));
    return { accountIds: periods.map((p) => p.accountId), periods };
  },
};

type AuthGuardResult =
  | { ok: true }
  | { ok: false; result: ToolHandlerResult };

export class ToolHandlers {
  private context: ToolHandlerContext;

  constructor(context: ToolHandlerContext) {
    this.context = context;
    
    // Initialize flex query client and storage if token is provided
    // Only initialize if not already set (useful for testing)
    if (context.config.IB_FLEX_TOKEN && !context.flexQueryClient) {
      this.context.flexQueryClient = new FlexQueryClient({
        token: context.config.IB_FLEX_TOKEN,
      });
    }
    
    if (context.config.IB_FLEX_TOKEN && !context.flexQueryStorage) {
      this.context.flexQueryStorage = new FlexQueryStorage();
      // Initialize storage asynchronously
      this.context.flexQueryStorage.initialize().catch((error) => {
        Logger.error("[FLEX-QUERY] Failed to initialize storage:", error);
      });
    }
  }

  private jsonResult(payload: unknown): ToolHandlerResult {
    return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
  }

  private buildAuthUrl(): string {
    return `https://${this.context.config.IB_GATEWAY_HOST}:${this.context.config.IB_GATEWAY_PORT}`;
  }

  // Authentication management. Login itself always happens manually in the
  // external gateway's web page; this only checks and revives the session.
  private async ensureAuth(): Promise<AuthGuardResult> {
    if (await this.context.ibClient.checkAuthenticationStatus()) {
      return { ok: true };
    }

    // The brokerage session expires long before the SSO session does, so a plain
    // reauthenticate normally revives it without a new login.
    if (await this.tryReauthenticate()) {
      return { ok: true };
    }

    throw new Error(`Authentication required. Please log in to the IB Client Portal Gateway at ${this.buildAuthUrl()} (or call the 'authenticate' tool).`);
  }

  /**
   * Cheapest rung of the recovery ladder: a plain reauthenticate against the gateway,
   * reusing the SSO session we still hold. Costs one HTTP round trip and, unlike a full
   * login, involves no browser, no 2FA and no login rate limit.
   */
  private async tryReauthenticate(): Promise<boolean> {
    try {
      Logger.info("Brokerage session is not authenticated; attempting reauthenticate before a full login.");
      await this.context.ibClient.reauthenticate();
      const recovered = await this.context.ibClient.checkAuthenticationStatus();
      if (recovered) {
        Logger.info("✅ Reauthenticate restored the brokerage session; skipping full login.");
      } else {
        Logger.info("Reauthenticate did not restore the session; a full login is required.");
      }
      return recovered;
    } catch (error) {
      Logger.warn("Reauthenticate failed; falling back to a full login:", error);
      return false;
    }
  }

  /**
   * Transport failures that mean "the connection died", not "the request was rejected".
   * A dropped socket to the gateway is recoverable by re-establishing the session, so it
   * has to be classified as an auth error - otherwise it surfaces raw to the caller and
   * the recovery path in ensureAuth never runs.
   */
  private isTransportError(error: any): boolean {
    const code = error?.code || error?.cause?.code;
    if (
      code === "ECONNRESET" ||
      code === "EPIPE" ||
      code === "ECONNREFUSED" ||
      code === "ETIMEDOUT" ||
      code === "ENOTFOUND" ||
      code === "UND_ERR_SOCKET" ||
      code === "UND_ERR_CONNECT_TIMEOUT"
    ) {
      return true;
    }

    const message = String(error?.message || "");
    return (
      message.includes("stream was destroyed") ||
      message.includes("socket hang up") ||
      message.includes("other side closed") ||
      message.includes("fetch failed")
    );
  }

  // Helper function to check for authentication errors
  private isAuthenticationError(error: any): boolean {
    if (!error) return false;

    const errorMessage = error.message || error.toString();
    const errorStatus = error.response?.status;
    const responseData = error.response?.data;

    return (
      errorStatus === 401 ||
      errorStatus === 403 ||
      errorStatus === 500 ||
      this.isTransportError(error) ||
      errorMessage.includes("authentication") ||
      errorMessage.includes("unauthorized") ||
      errorMessage.includes("not authenticated") ||
      errorMessage.includes("login") ||
      responseData?.error === "not authenticated"
    );
  }

  private getAuthenticationErrorMessage(): string {
    return `Authentication required. Please log in to the IB Client Portal Gateway at ${this.buildAuthUrl()} (or call the 'authenticate' tool). Make sure the gateway is running.`;
  }

  /**
   * After browser opens for OAuth, poll the gateway until authenticated,
   * then trigger reauthenticate to establish the REST API session.
   * This bridges the gap between browser-based OAuth and the REST API auth state.
   *
   * Polling is bounded by a deadline (~2 minutes from start) rather than by attempt
   * count, so the upper bound matches the documented timeout regardless of backoff.
   */
  private startBrowserAuthPolling(authUrl: string, port: number): void {
    const pollWindowMs = 120_000; // 2 minutes total
    const initialDelay = 2000; // 2 second initial delay
    const maxDelay = 10_000;
    const deadline = Date.now() + pollWindowMs;
    let attempts = 0;

    const poll = async () => {
      attempts++;
      Logger.log(`[BROWSER-AUTH-POLL] Polling ${authUrl} (port ${port}) attempt ${attempts} until ${new Date(deadline).toISOString()}`);

      try {
        if (typeof this.context.ibClient.initializeBrokerageSession === "function") {
          const initialized = await this.context.ibClient.initializeBrokerageSession();
          if (initialized) {
            Logger.log(`[BROWSER-AUTH-POLL] Brokerage session initialized for ${authUrl} (port ${port})`);
            return; // Success, stop polling
          }
        } else {
          const isAuth = await this.context.ibClient.checkAuthenticationStatus();
          if (isAuth) {
            Logger.log(`[BROWSER-AUTH-POLL] Authentication detected for ${authUrl} (port ${port}), reauthenticating REST session`);
            await this.context.ibClient.reauthenticate();
            Logger.log(`[BROWSER-AUTH-POLL] Reauthentication successful for ${authUrl} (port ${port}), REST session established`);
            return; // Success, stop polling
          }
        }
      } catch (error) {
        Logger.warn(`[BROWSER-AUTH-POLL] Poll attempt ${attempts} failed for ${authUrl} (port ${port}):`, error);
      }

      const delay = Math.min(initialDelay + (attempts * 500), maxDelay);
      if (Date.now() + delay < deadline) {
        setTimeout(poll, delay);
      } else {
        Logger.warn(`[BROWSER-AUTH-POLL] Timed out waiting for browser authentication at ${authUrl} (port ${port}) after ${attempts} attempts`);
      }
    };

    // Start polling after initial delay
    setTimeout(poll, initialDelay);
  }

  private formatError(error: unknown): string {
    if (this.isAuthenticationError(error)) {
      return this.getAuthenticationErrorMessage();
    }
    
    const errorMessage = error instanceof Error ? error.message : String(error);
    return `Error: ${errorMessage}`;
  }

  async authenticate(_input: AuthenticateInput): Promise<ToolHandlerResult> {
    const authUrl = this.buildAuthUrl();
    try {
      if (await this.context.ibClient.checkAuthenticationStatus()) {
        return this.jsonResult({ authenticated: true, authUrl });
      }
      if (await this.tryReauthenticate()) {
        return this.jsonResult({ authenticated: true, authUrl, note: "Session revived via reauthenticate" });
      }
    } catch (error) {
      if (this.isTransportError(error)) {
        return this.jsonResult({
          authenticated: false,
          authUrl,
          message: `The Client Portal Gateway is not reachable at ${authUrl}. Start your gateway and try again.`,
        });
      }
    }

    // Not logged in: the user logs in manually; poll in the background so the
    // REST session is initialized as soon as the login completes.
    this.startBrowserAuthPolling(authUrl, this.context.config.IB_GATEWAY_PORT);
    return this.jsonResult({
      authenticated: false,
      authUrl,
      instructions: [
        `Open ${authUrl} in your browser (accept the self-signed certificate warning)`,
        "Log in with your Interactive Brokers credentials and complete 2FA",
        "Then retry the tool call",
      ],
      polling: true,
    });
  }

  async getAccountInfo(input: GetAccountInfoInput): Promise<ToolHandlerResult> {
    const auth = await this.ensureAuth();
    if (!auth.ok) {
      return auth.result;
    }
    try {
      const result = await this.context.ibClient.getAccountInfo();
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: this.formatError(error),
          },
        ],
      };
    }
  }

  async getPositions(input: GetPositionsInput): Promise<ToolHandlerResult> {
    if (!input.accountId) {
      return {
        content: [
          {
            type: "text",
            text: "Account ID is required",
          },
        ],
      };
    }
    const auth = await this.ensureAuth();
    if (!auth.ok) {
      return auth.result;
    }
    try {
      const result = await this.context.ibClient.getPositions(input.accountId);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: this.formatError(error),
          },
        ],
      };
    }
  }

  async getPortfolioSnapshot(input: GetPortfolioSnapshotInput): Promise<ToolHandlerResult> {
    const auth = await this.ensureAuth();
    if (!auth.ok) {
      return auth.result;
    }
    try {
      const result = await this.context.ibClient.getPortfolioSnapshot(input.accountIds);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: this.formatError(error) }] };
    }
  }

  async getFxRates(input: GetFxRatesInput): Promise<ToolHandlerResult> {
    const auth = await this.ensureAuth();
    if (!auth.ok) {
      return auth.result;
    }
    try {
      const result = await this.context.ibClient.getFxRates(input.accountIds, input.quoteCurrencies);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: this.formatError(error) }] };
    }
  }

  async getMarketData(input: GetMarketDataInput): Promise<ToolHandlerResult> {
    const auth = await this.ensureAuth();
    if (!auth.ok) {
      return auth.result;
    }
    try {
      const result = await this.context.ibClient.getMarketData(input.symbol, input.exchange);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: this.formatError(error),
          },
        ],
      };
    }
  }

  async getOptionChain(input: GetOptionChainInput): Promise<ToolHandlerResult> {
    const auth = await this.ensureAuth();
    if (!auth.ok) {
      return auth.result;
    }
    try {
      const result = await this.context.ibClient.getOptionChain(input.symbol, input.exchange);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: this.formatError(error),
          },
        ],
      };
    }
  }

  async resolveOptionConid(input: ResolveOptionConidInput): Promise<ToolHandlerResult> {
    const auth = await this.ensureAuth();
    if (!auth.ok) {
      return auth.result;
    }
    try {
      const result = await this.context.ibClient.resolveOptionConid(
        input.symbol,
        input.expiry,
        input.strike,
        input.right,
        input.exchange,
      );
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: this.formatError(error),
          },
        ],
      };
    }
  }

  async placeOrder(input: PlaceOrderInput): Promise<ToolHandlerResult> {
    const auth = await this.ensureAuth();
    if (!auth.ok) {
      return auth.result;
    }
    try {
      const result = await this.context.ibClient.placeOrder({
        accountId: input.accountId,
        symbol: input.symbol,
        conid: input.conid,
        secType: input.secType,
        expiry: input.expiry,
        strike: input.strike,
        right: input.right,
        action: input.action,
        orderType: input.orderType,
        quantity: input.quantity, // Already converted by Zod schema
        price: input.price,
        stopPrice: input.stopPrice,
        suppressConfirmations: input.suppressConfirmations,
        exchange: input.exchange,
        tif: input.tif,
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: this.formatError(error),
          },
        ],
      };
    }
  }

  async getOrderStatus(input: GetOrderStatusInput): Promise<ToolHandlerResult> {
    const auth = await this.ensureAuth();
    if (!auth.ok) {
      return auth.result;
    }
    try {
      const result = await this.context.ibClient.getOrderStatus(input.orderId);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: this.formatError(error),
          },
        ],
      };
    }
  }

  async getLiveOrders(input: GetLiveOrdersInput): Promise<ToolHandlerResult> {
    const auth = await this.ensureAuth();
    if (!auth.ok) {
      return auth.result;
    }
    try {
      // Pass accountId as query parameter if provided
      const result = await this.context.ibClient.getOrders(input.accountId);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: this.formatError(error),
          },
        ],
      };
    }
  }

  async confirmOrder(input: ConfirmOrderInput): Promise<ToolHandlerResult> {
    const auth = await this.ensureAuth();
    if (!auth.ok) {
      return auth.result;
    }
    try {
      const result = await this.context.ibClient.confirmOrder(input.replyId, input.messageIds);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: this.formatError(error),
          },
        ],
      };
    }
  }

  async getAlerts(input: GetAlertsInput): Promise<ToolHandlerResult> {
    const auth = await this.ensureAuth();
    if (!auth.ok) {
      return auth.result;
    }
    try {
      const result = await this.context.ibClient.getAlerts(input.accountId);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: this.formatError(error),
          },
        ],
      };
    }
  }

  async createAlert(input: CreateAlertInput): Promise<ToolHandlerResult> {
    const auth = await this.ensureAuth();
    if (!auth.ok) {
      return auth.result;
    }
    try {
      const result = await this.context.ibClient.createAlert(input.accountId, input.alertRequest);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: this.formatError(error),
          },
        ],
      };
    }
  }

  async activateAlert(input: ActivateAlertInput): Promise<ToolHandlerResult> {
    const auth = await this.ensureAuth();
    if (!auth.ok) {
      return auth.result;
    }
    try {
      const result = await this.context.ibClient.activateAlert(input.accountId, input.alertId);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: this.formatError(error),
          },
        ],
      };
    }
  }

  async deleteAlert(input: DeleteAlertInput): Promise<ToolHandlerResult> {
    const auth = await this.ensureAuth();
    if (!auth.ok) {
      return auth.result;
    }
    try {
      const result = await this.context.ibClient.deleteAlert(input.accountId, input.alertId);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: this.formatError(error),
          },
        ],
      };
    }
  }

  // ── Flex Query Methods ──────────────────────────────────────────────────────

  async getFlexQuery(input: GetFlexQueryInput): Promise<ToolHandlerResult> {
    try {
      if (!this.context.flexQueryClient) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: "Flex Query feature not configured",
                message: "Please set the IB_FLEX_TOKEN environment variable to use Flex Queries",
                instructions: [
                  "1. Get your Flex Web Service Token from Interactive Brokers",
                  "2. Set the IB_FLEX_TOKEN environment variable",
                  "3. Restart the MCP server"
                ]
              }, null, 2),
            },
          ],
        };
      }

      if (!this.context.flexQueryStorage) {
        throw new Error("Flex Query storage not initialized");
      }

      if ((input.fromDate === undefined) !== (input.toDate === undefined)) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: "fromDate and toDate must be given together",
                queryId: input.queryId,
              }, null, 2),
            },
          ],
        };
      }
      const dateRange = input.fromDate !== undefined && input.toDate !== undefined
        ? { fromDate: input.fromDate, toDate: input.toDate }
        : undefined;

      Logger.log(
        `[FLEX-QUERY] Executing flex query: ${input.queryId}` +
          (dateRange ? ` (${dateRange.fromDate}..${dateRange.toDate})` : ""),
      );

      // Check if this query was used before (by IB's query ID)
      const existingQuery = await this.context.flexQueryStorage.getQueryByQueryId(input.queryId);

      // Execute the query
      const result = await this.context.flexQueryClient.executeQuery(
        input.queryId,
        undefined,
        undefined,
        dateRange,
      );

      if (result.error) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: result.error,
                errorCode: result.errorCode,
                queryId: input.queryId,
              }, null, 2),
            },
          ],
        };
      }

      // Parse XML to extract query name from the response
      let parsedData;
      let queryNameFromApi: string | undefined;
      
      if (result.data) {
        try {
          parsedData = await this.context.flexQueryClient.parseStatement(result.data);
          
          // Extract query name from the parsed XML
          // The queryName is directly under FlexQueryResponse
          if (parsedData?.FlexQueryResponse) {
            queryNameFromApi = parsedData.FlexQueryResponse.queryName;
          }
          
          Logger.log(`[FLEX-QUERY] Extracted query name from API: ${queryNameFromApi}`);
        } catch (parseError) {
          Logger.warn("[FLEX-QUERY] Failed to parse XML for query name extraction:", parseError);
        }
      }

      // Auto-save the query if it's new or update last used
      if (existingQuery) {
        await this.context.flexQueryStorage.markQueryUsed(existingQuery.id);
        Logger.log(`[FLEX-QUERY] Updated last used timestamp for query: ${input.queryId}`);
      } else {
        // Save new query with the name from API, input, or fallback to queryId
        const queryName = queryNameFromApi || input.queryName || input.queryId;
        await this.context.flexQueryStorage.saveQuery({
          name: queryName,
          queryId: input.queryId,
          description: `Auto-saved on ${new Date().toLocaleDateString()}`,
        });
        Logger.log(`[FLEX-QUERY] Auto-saved new query: ${queryName}`);
      }

      // Save the raw statement XML to a file (e.g. for importing into Portfolio Performance).
      // Returns only a summary, so the large statement is not sent back to the client.
      if (input.saveTo) {
        if (!isAbsolute(input.saveTo)) {
          return {
            content: [{ type: "text", text: JSON.stringify({ error: "saveTo must be an absolute path", saveTo: input.saveTo }, null, 2) }],
          };
        }
        const statements = FlexStatementSummary.from(parsedData);
        await fs.mkdir(dirname(input.saveTo), { recursive: true });
        // flag "wx": fail instead of overwriting an existing file
        await fs.writeFile(input.saveTo, result.data ?? "", { encoding: "utf8", flag: "wx" });
        Logger.log(`[FLEX-QUERY] Saved raw statement to ${input.saveTo}`);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                queryId: input.queryId,
                queryName: queryNameFromApi,
                savedTo: input.saveTo,
                accountIds: statements.accountIds,
                statementPeriods: statements.periods,
                requestedDateRange: dateRange ?? null,
              }, null, 2),
            },
          ],
        };
      }

      // Return parsed data if requested (and we haven't parsed it yet)
      if (input.parseXml && !parsedData && result.data) {
        try {
          parsedData = await this.context.flexQueryClient.parseStatement(result.data);
        } catch (parseError) {
          Logger.warn("[FLEX-QUERY] Failed to parse XML, returning raw data:", parseError);
        }
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: true,
              queryId: input.queryId,
              queryName: queryNameFromApi,
              autoSaved: !existingQuery,
              data: parsedData || result.data,
              note: existingQuery 
                ? "Query was previously saved and has been marked as used" 
                : "Query has been automatically saved for future reference"
            }, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: this.formatError(error),
          },
        ],
      };
    }
  }

  async listFlexQueries(input: ListFlexQueriesInput): Promise<ToolHandlerResult> {
    try {
      if (!this.context.flexQueryStorage) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: "Flex Query feature not configured",
                message: "Please set the IB_FLEX_TOKEN environment variable to use Flex Queries"
              }, null, 2),
            },
          ],
        };
      }

      const queries = await this.context.flexQueryStorage.listQueries();
      
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              count: queries.length,
              queries: queries.map(q => ({
                name: q.name,
                queryId: q.queryId,
                description: q.description,
                createdAt: q.createdAt,
                lastUsed: q.lastUsed,
              })),
              storageLocation: this.context.flexQueryStorage.getStorageFilePath(),
            }, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: this.formatError(error),
          },
        ],
      };
    }
  }

  async forgetFlexQuery(input: ForgetFlexQueryInput): Promise<ToolHandlerResult> {
    try {
      if (!this.context.flexQueryStorage) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: "Flex Query feature not configured",
                message: "Please set the IB_FLEX_TOKEN environment variable to use Flex Queries"
              }, null, 2),
            },
          ],
        };
      }

      // Try to find the query by IB's queryId first, then by name as fallback
      let query = await this.context.flexQueryStorage.getQueryByQueryId(input.queryId);
      
      if (!query) {
        // Try to find by name as fallback (in case user provides a friendly name)
        query = await this.context.flexQueryStorage.getQueryByName(input.queryId);
      }

      if (!query) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: "Query not found",
                message: `No saved query found with ID: ${input.queryId}`,
                suggestion: "Use list_flex_queries to see all saved queries"
              }, null, 2),
            },
          ],
        };
      }

      const deleted = await this.context.flexQueryStorage.deleteQuery(query.id);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: deleted,
              message: deleted 
                ? `Query "${query.name}" (${query.queryId}) has been forgotten` 
                : "Failed to delete query",
              queryId: input.queryId,
            }, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: this.formatError(error),
          },
        ],
      };
    }
  }
}
