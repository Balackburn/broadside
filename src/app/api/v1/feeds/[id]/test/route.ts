import { previewFeed } from "@/lib/feeds";
import { route } from "@/lib/http";

/** A dry run: reads the feed now and returns the post its newest item would make. Saves and sends nothing. */
export const POST = route<RouteContext<"/api/v1/feeds/[id]/test">>(async (_request, { params }) => {
  const { id } = await params;
  return previewFeed(id);
});
