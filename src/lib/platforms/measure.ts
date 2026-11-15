import type { Limits } from "./types";

/** Pure rules shared by the server and the browser: the composer shows exactly what the server will enforce. */

export type Fits = { name: string; limits: Limits };

const segmenter = new Intl.Segmenter();

/** Length as the network counts it. X weights links at 23 and wide characters at 2. */
export function measure(text: string, count: Limits["count"]): number {
  if (count === "graphemes") return [...segmenter.segment(text)].length;
  const withoutLinks = text.replace(/https?:\/\/[^\s]+/g, "");
  const links = (text.match(/https?:\/\/[^\s]+/g) ?? []).length;
  let total = links * 23;
  for (const { segment } of segmenter.segment(withoutLinks)) {
    const code = segment.codePointAt(0)!;
    const narrow = code <= 0x10ff || (code >= 0x2000 && code <= 0x200d) || (code >= 0x2010 && code <= 0x201f) || (code >= 0x2032 && code <= 0x2037);
    total += narrow && segment.length === 1 ? 1 : 2;
  }
  return total;
}

export type MediaShape = { type: "image" | "video"; hasPublicUrl: boolean };

/**
 * Reasons this text and media cannot go to this network, in plain words.
 * Broadside refuses a post it knows a network will mangle; it never trims
 * text or drops media silently.
 */
export function problems(c: Fits, text: string, media: MediaShape[]): string[] {
  const out: string[] = [];
  const { limits } = c;
  const length = measure(text, limits.count);
  if (length > limits.maxChars) out.push(`${c.name} allows ${limits.maxChars} characters; this is ${length}.`);
  const imageCount = media.filter((m) => m.type === "image").length;
  const videoCount = media.filter((m) => m.type === "video").length;
  if (limits.requiresMedia && imageCount + videoCount === 0) {
    out.push(`${c.name} needs ${limits.maxImages === 0 ? "a video" : limits.maxVideos === 0 ? "an image" : "an image or a video"}.`);
  }
  if (!limits.requiresMedia && !text.trim() && media.length === 0) out.push("The post is empty.");
  if (imageCount > limits.maxImages) {
    out.push(limits.maxImages === 0 ? `${c.name} does not take images here.` : `${c.name} allows ${limits.maxImages} image${limits.maxImages === 1 ? "" : "s"}; this has ${imageCount}.`);
  }
  if (videoCount > limits.maxVideos) {
    out.push(limits.maxVideos === 0 ? `${c.name} does not take video here.` : `${c.name} allows ${limits.maxVideos} video; this has ${videoCount}.`);
  }
  if (limits.pullsMedia && media.some((m) => !m.hasPublicUrl)) {
    out.push(`${c.name} fetches media from a public URL. Set BROADSIDE_PUBLIC_URL or attach the media by URL.`);
  }
  return out;
}
