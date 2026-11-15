import { analytics, parsePeriod } from "@/lib/analytics";
import { route } from "@/lib/http";

/** Totals, a per-network breakdown and one row per published target, for posts from the last 7, 30 or 90 days. Reads stored readings only. */
export const GET = route((request) => {
  const q = new URL(request.url).searchParams;
  return analytics({ days: parsePeriod(q.get("period")), account_id: q.get("account_id"), tag: q.get("tag") });
});
