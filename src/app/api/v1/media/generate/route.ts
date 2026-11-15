import { body, route } from "@/lib/http";
import { generateImage, generationStatus } from "@/lib/images";

/** Whether images can be generated here and how many are left today: { available, remaining, limit, model, resets_at }. Never the key. */
export const GET = route({ role: "viewer" }, () => generationStatus());

/**
 * Makes one image from JSON { prompt, shape } and keeps it in the media library.
 * Each call is billed to the operator's OpenAI account and counts against the daily cap.
 * Answers { media, remaining, limit, resets_at }.
 */
export const POST = route({ role: "editor" }, async (request, _context, actor) => {
  const input = await body<{ prompt?: unknown; shape?: unknown }>(request);
  return generateImage(input, { createdBy: actor.member?.id ?? null });
});
