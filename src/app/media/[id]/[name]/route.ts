import { open } from "@/lib/http";
import { getMedia, streamMedia } from "@/lib/media";

/**
 * Media is served without a key so networks that pull files (Instagram,
 * Threads, TikTok photos) can fetch them. Ids are 72 random bits.
 */
export const GET = open("Networks fetch media by address when a post goes out, and they hold no key or session. The id is the secret.", async (_request: Request, { params }: RouteContext<"/media/[id]/[name]">) => {
  const { id } = await params;
  const media = getMedia(id);
  if (!media) return new Response("Not found", { status: 404 });
  return new Response(streamMedia(id), {
    headers: {
      "content-type": media.content_type,
      "cache-control": "public, max-age=86400",
      "content-length": String(media.size),
      "x-content-type-options": "nosniff",
      // An upload is only ever a picture or a video: no scripts, no framing, no plugins, whatever its bytes claim.
      "content-security-policy": "default-src 'none'; sandbox",
      "cross-origin-resource-policy": "cross-origin",
    },
  });
});
