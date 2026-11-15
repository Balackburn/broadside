import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { authorized } from "@/lib/keys";
import { buildServer } from "@/lib/mcp";
import { baseUrl } from "@/lib/http";

export const dynamic = "force-dynamic";

/**
 * Streamable HTTP, stateless: every request gets a fresh server and answers
 * with plain JSON, so Broadside needs no sticky sessions behind a proxy.
 */
async function handle(request: Request): Promise<Response> {
  if (!authorized(request)) {
    return Response.json(
      { jsonrpc: "2.0", error: { code: -32001, message: "Send a Broadside API key as a Bearer token. Create one under Connect in the app." }, id: null },
      { status: 401, headers: { "www-authenticate": 'Bearer realm="broadside"' } },
    );
  }
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  const server = buildServer({ baseUrl: baseUrl(request), local: false });
  await server.connect(transport);
  return transport.handleRequest(request);
}

export { handle as GET, handle as POST, handle as DELETE };
