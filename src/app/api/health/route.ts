import { get } from "@/lib/db";
import { open } from "@/lib/http";
import { VERSION } from "@/lib/mcp";

export const dynamic = "force-dynamic";

/** Liveness for monitors and containers. It proves the database opens and says nothing about what is in it. */
export const GET = open("A monitor or a container asks this with no credentials. It answers with the name and version and nothing else.", () => {
  get("SELECT 1 AS ok");
  return Response.json({ ok: true, name: "broadside", version: VERSION });
});
