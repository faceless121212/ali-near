// Runs Ali as an MCP server over stdio. Start the app first (npm start), then
// point an MCP client at: npx tsx src/mcp/main.ts
//   ALI_APP_URL  the app, default http://localhost:3000
//   ALI_WALLET   "practice" (default), "demo:<account>" or "testnet:<account>"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createAliMcp } from "./server.js";

const server = createAliMcp({
  appUrl: process.env.ALI_APP_URL ?? "http://localhost:3000",
  wallet: process.env.ALI_WALLET ?? "practice",
});
await server.connect(new StdioServerTransport());
