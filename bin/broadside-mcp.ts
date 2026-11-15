#!/usr/bin/env -S npx tsx
/**
 * Local MCP server over stdio. It opens the same database as the web app
 * (BROADSIDE_DATA_DIR, default ./data), so it works with the app stopped and
 * can read media straight from this machine's disk.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildServer } from "../src/lib/mcp";
import { startScheduler } from "../src/lib/scheduler";

async function main() {
  const baseUrl = (process.env.BROADSIDE_PUBLIC_URL || "http://localhost:3000").replace(/\/+$/, "");
  startScheduler();
  const server = buildServer({ baseUrl, local: true });
  await server.connect(new StdioServerTransport());
}

main().catch((error) => {
  console.error("[broadside] the MCP server could not start:", error);
  process.exit(1);
});
