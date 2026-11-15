import { refreshPost } from "@/lib/analytics";
import { route } from "@/lib/http";

/** Reads one post's numbers from its networks now, and returns them with how each reading went. */
export const POST = route<RouteContext<"/api/v1/posts/[id]/analytics/refresh">>({ role: "editor" }, async (_request, { params }) => {
  const { id } = await params;
  return refreshPost(id);
});
