import { get } from "@/lib/db";
import { VERSION } from "@/lib/mcp";

export const dynamic = "force-dynamic";

export function GET() {
  const { n } = get<{ n: number }>("SELECT COUNT(*) AS n FROM accounts")!;
  return Response.json({ ok: true, name: "broadside", version: VERSION, accounts: n });
}
