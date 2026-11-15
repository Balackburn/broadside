import { getMedia, readMedia } from "@/lib/media";

/**
 * Media is served without a key so networks that pull files (Instagram,
 * Threads, TikTok photos) can fetch them. Ids are 72 random bits.
 */
export async function GET(_request: Request, { params }: RouteContext<"/media/[id]/[name]">) {
  const { id } = await params;
  const media = getMedia(id);
  if (!media) return new Response("Not found", { status: 404 });
  return new Response(readMedia(id) as BodyInit, {
    headers: { "content-type": media.content_type, "cache-control": "public, max-age=31536000, immutable", "x-content-type-options": "nosniff" },
  });
}
