import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { buildServer } from "@/lib/mcp";
import { baseUrl, route } from "@/lib/http";

export const dynamic = "force-dynamic";

/** The endpoint speaks JSON-RPC, so it says no in JSON-RPC too. */
const refuse = (status: 401 | 403, message: string) =>
  Response.json({ jsonrpc: "2.0", error: { code: -32001, message }, id: null }, { status, headers: status === 401 ? { "www-authenticate": 'Bearer realm="broadside"' } : undefined });

/**
 * Streamable HTTP, stateless: every request gets a fresh server and answers
 * with plain JSON, so Broadside needs no sticky sessions behind a proxy.
 *
 * A key of any role may connect. Each tool then checks the role it needs
 * against this request's actor (see TOOL_ROLES in mcp.ts), and because every
 * request builds its own server, a role changed in the app holds from the
 * very next call.
 */
const handle = route({ role: "viewer", with: "key", refuse }, async (request, _context, actor) => {
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  const server = buildServer({ baseUrl: baseUrl(request), local: false, actor: () => actor });
  await server.connect(transport);
  return transport.handleRequest(request);
});

export const GET = handle;
export const POST = handle;
export const DELETE = handle;
