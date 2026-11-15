import { postAnalytics } from "@/lib/analytics";
import { route } from "@/lib/http";

/** The numbers held for one post, per published target, each with the time it was read. Asks no network. */
export const GET = route<RouteContext<"/api/v1/posts/[id]/analytics">>({ role: "viewer" }, async (_request, { params }) => {
  const { id } = await params;
  return postAnalytics(id);
});
