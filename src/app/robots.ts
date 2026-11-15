import type { MetadataRoute } from "next";

/** The front page may be indexed; the app, its API and the MCP endpoint are private. */
export default function robots(): MetadataRoute.Robots {
  return { rules: [{ userAgent: "*", allow: "/", disallow: ["/app", "/api", "/mcp", "/login", "/media"] }] };
}
