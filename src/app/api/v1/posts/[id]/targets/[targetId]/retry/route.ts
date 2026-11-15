import { route } from "@/lib/http";
import { retryTarget } from "@/lib/posts";

export const POST = route<RouteContext<"/api/v1/posts/[id]/targets/[targetId]/retry">>({ role: "editor" }, async (_request, { params }) => {
  const { id, targetId } = await params;
  return retryTarget(id, targetId);
});
