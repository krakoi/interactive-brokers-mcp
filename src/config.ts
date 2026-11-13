import { config as dotenvConfig } from "dotenv";

// Load environment variables
dotenvConfig();

export const config = {
  // External Client Portal Gateway to connect to (this server never starts one itself)
  IB_GATEWAY_HOST: process.env.IB_GATEWAY_HOST || "localhost",
  IB_GATEWAY_PORT: parseInt(process.env.IB_GATEWAY_PORT || "5000"),

  // Read-only mode configuration
  IB_READ_ONLY_MODE: process.env.IB_READ_ONLY_MODE === "true",

  // Flex Query configuration
  IB_FLEX_TOKEN: process.env.IB_FLEX_TOKEN || "",
};
