import { get } from "@/lib/db";
import { VERSION } from "@/lib/mcp";

export const dynamic = "force-dynamic";

/** Liveness for monitors and containers. It proves the database opens and says nothing about what is in it. */
export function GET() {
  get("SELECT 1 AS ok");
  return Response.json({ ok: true, name: "broadside", version: VERSION });
}
