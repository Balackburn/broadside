import { route } from "@/lib/http";
import { cancelPost, stopSeries } from "@/lib/posts";

/** Cancels this post. With { "series": true } in the body it stops the whole repeating series the post belongs to. */
export const POST = route<RouteContext<"/api/v1/posts/[id]/cancel">>(async (request, { params }) => {
  const { id } = await params;
  const input = (await request.json().catch(() => ({}))) as { series?: boolean } | null;
  return input?.series === true ? stopSeries(id) : cancelPost(id);
});
