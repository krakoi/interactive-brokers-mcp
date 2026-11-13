# Interactive Brokers MCP Server

<div align="center">
<img src="https://www.interactivebrokers.com/images/web/logos/ib-logo-text-black.svg" alt="Interactive Brokers" width="300">
</div>

> **Fork note**: This fork does **not** bundle the IB Client Portal Gateway,
> a Java runtime, or browser-automation login. It only connects to a Client
> Portal Gateway you install and run yourself from a trusted source.

> **DISCLAIMER**: This is an **unofficial**, community-developed MCP server
> and is **NOT** affiliated with or endorsed by Interactive Brokers. This
> software is in **Alpha state** and may not work perfectly.

A Model Context Protocol (MCP) server that provides integration with Interactive
Brokers' trading platform. This server allows AI assistants to interact with
your IB account to retrieve market data, check positions, and place trades.

<a href="https://glama.ai/mcp/servers/@code-rabi/interactive-brokers-mcp">
  <img width="380" height="200" src="https://glama.ai/mcp/servers/@code-rabi/interactive-brokers-mcp/badge" alt="Interactive Brokers Server MCP server" />
</a>

## 🔒 Security Notice
![Showcase of Interactive Brokers MCP](./IB-MCP.gif)


## Features

- **Interactive Brokers API Integration**: Full trading capabilities including account management, position tracking, real-time market data, and order management (market, limit, and stop orders)
- **Flex Query Support**: Execute Flex Queries to retrieve account statements, trade confirmations, and historical data. Queries are automatically remembered for easy reuse
- **Portfolio tools**: Compact per-account snapshot (cash per currency and positions) and live FX rates across all currencies in the portfolio
- **External gateway only**: Connects to your own Client Portal Gateway; you log in through its web page, credentials never pass through this server

## Security Notice

**IMPORTANT WARNINGS:**

- **Financial Risk**: Trading involves substantial risk of loss. Always test
  with paper trading first.
- **Security**: This software handles sensitive financial data. Only run
  locally, never on public servers.
- **No Warranty**: This unofficial software comes with no warranties. Use at
  your own risk.
- **Not Financial Advice**: This tool is for automation only, not financial
  advice.

## Prerequisites

- Interactive Brokers account (paper or live trading)
- Node.js 20+
- The [IB Client Portal Gateway](https://www.interactivebrokers.com/en/trading/ib-api.php#client-portal-api),
  installed from a trusted source and running (default `https://localhost:5000`)

## Quick Start

1. Start your Client Portal Gateway and log in at `https://localhost:5000`
   (accept the self-signed certificate warning). Choose paper or live trading at login.
2. Add this MCP server to your Cursor/Claude configuration:

```json
{
  "mcpServers": {
    "interactive-brokers": {
      "command": "node",
      "args": ["/path/to/interactive-brokers-mcp/dist/index.js"],
      "env": {
        "IB_GATEWAY_HOST": "localhost",
        "IB_GATEWAY_PORT": "5000"
      }
    }
  }
}
```

If the session is not logged in, tools return the gateway URL to log in at. The
`authenticate` tool checks the session, revives an expired one via
reauthenticate, or tells you where to log in and waits for it in the background.

## Flex Query Configuration (Optional)

To use Flex Queries for retrieving account statements and historical data, you need to configure your Flex Web Service Token:

```json
{
  "mcpServers": {
    "interactive-brokers": {
      "command": "node",
      "args": ["/path/to/interactive-brokers-mcp/dist/index.js"],
      "env": {
        "IB_FLEX_TOKEN": "your_flex_token_here"
      }
    }
  }
}
```

### How to Get Your Flex Token:

1. Log in to [Interactive Brokers Account Management](https://www.interactivebrokers.com/portal)
2. Go to **Settings** → **Account Settings**
3. Navigate to **Reporting** → **Flex Web Service**
4. Generate or retrieve your Flex Web Service Token

For detailed instructions on enabling Flex Web Service, see the [IB Flex Web Service Guide](https://www.ibkrguides.com/orgportal/performanceandstatements/flex-web-service.htm).

### Creating Flex Queries:

1. Go to **Reports** → **Flex Queries** in Account Management
2. Create or customize your query template
3. Click the info icon next to your query to find its Query ID

For a complete guide on creating and customizing Flex Queries, see the [IB Flex Queries Guide](https://www.ibkrguides.com/orgportal/performanceandstatements/flex.htm).

**Note**: When you execute a Flex Query for the first time, the MCP server automatically saves it with its name from the API. Future executions can reference the query by either its ID or its saved name.

### Flex Query Features:

- **Automatic Memory**: When you execute a Flex Query, it's automatically saved for future use
- **Easy Reuse**: Previously used queries are remembered - no need to copy query IDs repeatedly
- **Friendly Names**: Optionally provide a friendly name when first executing a query
- **Forget Queries**: Remove queries you no longer need with the `forget_flex_query` tool

## Configuration Variables

| Feature | Environment Variable | Command Line Argument |
|---------|---------------------|----------------------|
| Gateway host | `IB_GATEWAY_HOST` (default `localhost`) | N/A |
| Gateway port | `IB_GATEWAY_PORT` (default `5000`) | N/A |
| Flex Token | `IB_FLEX_TOKEN` | N/A |
| Read-only mode | `IB_READ_ONLY_MODE` | `--ib-read-only-mode` |

## Available MCP Tools

### Trading & Account Management

| Tool               | Description                               |
| ------------------ | ----------------------------------------- |
| `get_account_info` | Retrieve account information and balances |
| `get_positions`    | Get current positions and P&L             |
| `get_market_data`  | Real-time market data for symbols (retries until prices arrive) |
| `get_portfolio_snapshot` | Per-account cash per currency and all positions |
| `get_fx_rates`     | Live FX rates for every currency in the portfolio |
| `place_order`      | Place market, limit, or stop orders (only if read-only mode is disabled) |
| `get_order_status` | Check order execution status              |
| `get_live_orders`  | Get all live/open orders for monitoring   |

### Flex Queries (Requires IB_FLEX_TOKEN)

| Tool                | Description                                                          |
| ------------------- | -------------------------------------------------------------------- |
| `get_flex_query`    | Execute a Flex Query and retrieve statements (auto-saves for reuse) |
| `list_flex_queries` | List all previously used Flex Queries                               |
| `forget_flex_query` | Remove a saved Flex Query from memory                               |

## Troubleshooting

**Gateway not reachable:** make sure your Client Portal Gateway is running and
listening on `IB_GATEWAY_HOST:IB_GATEWAY_PORT`.

**Authentication problems:** open the gateway URL in a browser, log in and
complete 2FA, then retry. The brokerage session times out after inactivity; the
server keeps it alive and revives it with reauthenticate where possible.

## Support

- **This Server**: Open an issue in this repository.

## License

MIT License - see LICENSE file for details.

## Thanks to our contributors

A big thank you to everyone who has contributed to making this project better.

<a href="https://github.com/code-rabi/interactive-brokers-mcp/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=code-rabi/interactive-brokers-mcp" alt="Contributors" />
</a>
