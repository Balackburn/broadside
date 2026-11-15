import { checkFeed } from "@/lib/feeds";
import { route } from "@/lib/http";

/** Reads the feed now instead of waiting for its turn, and turns what is new into posts. */
export const POST = route<RouteContext<"/api/v1/feeds/[id]/check">>({ role: "admin" }, async (_request, { params }) => {
  const { id } = await params;
  return checkFeed(id, fetch, { manual: true });
});
