import { createHmac, randomBytes } from "node:crypto";
import { blob, call, images, videos, PublishError, type Connector, type Context, type Credentials } from "./types";

const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/**
 * OAuth 1.0a user-context header (HMAC-SHA1). JSON and multipart bodies are
 * not part of the signature base string; only the query and oauth_* params are.
 */
export function oauth1(
  method: string,
  url: string,
  c: Credentials,
  fixed?: { nonce: string; timestamp: string },
): string {
  const u = new URL(url);
  const oauth: Record<string, string> = {
    oauth_consumer_key: c.api_key,
    oauth_nonce: fixed?.nonce ?? randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: fixed?.timestamp ?? String(Math.floor(Date.now() / 1000)),
    oauth_token: c.access_token,
    oauth_version: "1.0",
  };
  const params = [...Object.entries(oauth), ...u.searchParams.entries()]
    .map(([k, v]) => [enc(k), enc(v)])
    .sort(([a, av], [b, bv]) => (a === b ? av.localeCompare(bv) : a.localeCompare(b)))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const base = [method.toUpperCase(), enc(`${u.origin}${u.pathname}`), enc(params)].join("&");
  const signature = createHmac("sha1", `${enc(c.api_secret)}&${enc(c.access_secret)}`).update(base).digest("base64");
  return `OAuth ${Object.entries({ ...oauth, oauth_signature: signature })
    .map(([k, v]) => `${enc(k)}="${enc(v)}"`)
    .join(", ")}`;
}

const API = "https://api.x.com/2";

async function signed<T>(ctx: Context, c: Credentials, method: string, url: string, init: RequestInit = {}): Promise<T> {
  return call<T>(ctx, "X", url, {
    ...init,
    method,
    headers: { ...(init.headers as Record<string, string>), authorization: oauth1(method, url, c) },
  });
}

export const x: Connector = {
  id: "x",
  name: "X",
  docsUrl: "https://developer.x.com/en/portal/dashboard",
  setup: [
    "Create a project and app in the X developer portal.",
    "Under User authentication settings set the app permission to Read and write.",
    "Under Keys and tokens generate the API key and secret, then the access token and secret, and paste all four.",
  ],
  fields: [
    { key: "api_key", label: "API key", kind: "secret" },
    { key: "api_secret", label: "API key secret", kind: "secret" },
    { key: "access_token", label: "Access token", kind: "secret" },
    { key: "access_secret", label: "Access token secret", kind: "secret" },
  ],
  limits: { maxChars: 280, count: "weighted", maxImages: 4, maxVideos: 0, requiresMedia: false },

  async verify(c, ctx) {
    const me = await signed<{ data: { username: string; profile_image_url?: string } }>(
      ctx,
      c,
      "GET",
      `${API}/users/me?user.fields=profile_image_url`,
    );
    return { handle: `@${me.data.username}`, avatarUrl: me.data.profile_image_url, credentials: { username: me.data.username } };
  },

  async publish(input, c, ctx) {
    if (videos(input).length) throw new PublishError("Video on X is not supported yet; attach images or post text.");
    const mediaIds: string[] = [];
    for (const image of images(input)) {
      const form = new FormData();
      form.set("media", blob(await image.read(), image.contentType), image.filename);
      form.set("media_category", "tweet_image");
      const uploaded = await signed<{ data: { id: string } }>(ctx, c, "POST", `${API}/media/upload`, { body: form });
      mediaIds.push(uploaded.data.id);
    }
    const body: Record<string, unknown> = { text: input.text };
    if (mediaIds.length) body.media = { media_ids: mediaIds };
    const tweet = await signed<{ data: { id: string } }>(ctx, c, "POST", `${API}/tweets`, {
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { id: tweet.data.id, url: `https://x.com/${c.username || "i"}/status/${tweet.data.id}` };
  },
};
