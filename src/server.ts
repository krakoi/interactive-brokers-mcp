import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { IBClient } from "./ib-client.js";
import { config } from "./config.js";
import { registerTools } from "./tools.js";
import { Logger } from "./logger.js";

export const configSchema = z.object({
  // Read-only mode configuration
  IB_READ_ONLY_MODE: z.boolean().optional(),
});

/**
 * Create the MCP server. It connects to an externally managed Client Portal Gateway
 * at IB_GATEWAY_HOST:IB_GATEWAY_PORT; it never downloads, starts or stops a gateway.
 */
export function createIBMCPServer({ config: userConfig }: { config: z.infer<typeof configSchema> }) {
  const mergedConfig = {
    ...config,
    ...userConfig,
  };

  const logConfig = { ...mergedConfig, IB_FLEX_TOKEN: mergedConfig.IB_FLEX_TOKEN ? "[REDACTED]" : "" };
  Logger.info(`🔍 Final merged config: ${JSON.stringify(logConfig, null, 2)}`);

  const ibClient = new IBClient({
    host: mergedConfig.IB_GATEWAY_HOST,
    port: mergedConfig.IB_GATEWAY_PORT,
  });

  const server = new McpServer({
    name: "interactive-brokers-mcp",
    version: "1.0.0",
  });

  registerTools(server, ibClient, mergedConfig);
  Logger.info(`Tools registered (gateway: https://${mergedConfig.IB_GATEWAY_HOST}:${mergedConfig.IB_GATEWAY_PORT})`);

  return server;
}
