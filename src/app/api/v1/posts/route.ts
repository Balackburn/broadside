import { body, route } from "@/lib/http";
import { createPost, listPosts, type PostInput, type PostStatus } from "@/lib/posts";

export const GET = route({ role: "viewer" }, (request) => {
  const q = new URL(request.url).searchParams;
  return listPosts({
    status: (q.get("status") as PostStatus | null) ?? undefined,
    from: q.get("from") ?? undefined,
    to: q.get("to") ?? undefined,
    tag: q.get("tag") ?? undefined,
    origin: q.get("origin") ?? undefined,
    feed_id: q.get("feed_id") ?? undefined,
    limit: q.get("limit") ? Number(q.get("limit")) : undefined,
  });
});

export const POST = route({ role: "editor" }, async (request, _context, actor) => {
  const input = await body<PostInput>(request);
  const sameOrigin = request.headers.get("sec-fetch-site") === "same-origin";
  return createPost(
    {
      ...input,
      idempotency_key: request.headers.get("idempotency-key") ?? input.idempotency_key,
      origin: sameOrigin ? "ui" : "api",
    },
    fetch,
    // The author comes from who is asking, never from the request body.
    { created_by: actor.member?.id ?? null },
  );
});
