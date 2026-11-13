import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createIBMCPServer, configSchema } from "./server.js";
import { Logger } from "./logger.js";

export { configSchema };

// Parse command line arguments (only --ib-read-only-mode is supported)
function parseArgs(argv: string[]): z.infer<typeof configSchema> {
  const args: z.infer<typeof configSchema> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const [rawKey, inlineValue] = arg.split("=", 2);
    const key = rawKey.replace(/^--/, "");
    if (key !== "ib-read-only-mode") continue;

    if (inlineValue !== undefined) {
      args.IB_READ_ONLY_MODE = inlineValue.toLowerCase() === "true";
    } else if (argv[i + 1] && !argv[i + 1].startsWith("--")) {
      args.IB_READ_ONLY_MODE = argv[i + 1].toLowerCase() === "true";
      i++;
    } else {
      args.IB_READ_ONLY_MODE = true;
    }
  }
  return args;
}

process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));

process.on("uncaughtException", (error) => {
  Logger.error("🚨 Uncaught exception:", error);
  process.exit(1);
});

process.on("unhandledRejection", (reason, promise) => {
  Logger.error("🚨 Unhandled rejection at:", promise, "reason:", reason);
  process.exit(1);
});

// Check if this module is being run directly (for stdio compatibility)
// This handles direct execution, npx, and bin script execution
const isMainModule = import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("index.js") ||
  process.argv[1]?.endsWith("dist/index.js") ||
  process.argv[1]?.endsWith("ib-mcp") ||
  process.argv[1]?.includes("/.bin/ib-mcp");

function IBMCP({ config: userConfig }: { config: z.infer<typeof configSchema> }) {
  return createIBMCPServer({ config: userConfig });
}

if (isMainModule) {
  // Suppress known problematic outputs that might interfere with JSON-RPC
  process.env.SUPPRESS_LOAD_MESSAGE = "1";
  process.env.NO_UPDATE_NOTIFIER = "1";

  Logger.logStartup();

  // Priority: args > env > defaults
  const finalConfig: z.infer<typeof configSchema> = {
    ...(process.env.IB_READ_ONLY_MODE !== undefined ? { IB_READ_ONLY_MODE: process.env.IB_READ_ONLY_MODE === "true" } : {}),
    ...parseArgs(process.argv.slice(2)),
  };

  const server = IBMCP({ config: finalConfig });
  server.connect(new StdioServerTransport());
}

export default IBMCP;
