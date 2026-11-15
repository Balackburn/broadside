import { body, route } from "@/lib/http";
import { createPost, listPosts, type PostInput, type PostStatus } from "@/lib/posts";

export const GET = route((request) => {
  const q = new URL(request.url).searchParams;
  return listPosts({
    status: (q.get("status") as PostStatus | null) ?? undefined,
    from: q.get("from") ?? undefined,
    to: q.get("to") ?? undefined,
    tag: q.get("tag") ?? undefined,
    limit: q.get("limit") ? Number(q.get("limit")) : undefined,
  });
});

export const POST = route(async (request) => {
  const input = await body<PostInput>(request);
  const sameOrigin = request.headers.get("sec-fetch-site") === "same-origin";
  return createPost({
    ...input,
    idempotency_key: request.headers.get("idempotency-key") ?? input.idempotency_key,
    origin: sameOrigin ? "ui" : "api",
  });
});
