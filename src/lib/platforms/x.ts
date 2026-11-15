import { createHmac, randomBytes } from "node:crypto";
import { withSession } from "./oauth2";
import { blob, call, counted, images, videos, PublishError, type Connector, type Context, type Credentials, type MetricsResult, type OAuthSpec, type Reports } from "./types";

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

/**
 * X connects two ways. Signing in uses OAuth 2.0 with PKCE: the access token
 * lasts two hours and each refresh spends the refresh token and returns a new
 * one. Accounts connected before that, or by pasting, carry the four OAuth
 * 1.0a keys, which sign every request and do not expire.
 */
const oauth: OAuthSpec = {
  authorizeUrl: "https://x.com/i/oauth2/authorize",
  tokenUrl: "https://api.x.com/2/oauth2/token",
  // media.write is for images; offline.access is what makes X issue a refresh token.
  scopes: ["tweet.read", "tweet.write", "users.read", "media.write", "offline.access"],
  client: { id: "client_id", secret: "client_secret", secretOptional: true },
  pkce: "S256",
  // An app with a secret proves itself with a Basic header. A Native App has no secret and names itself in the body.
  clientAuth: "basic",
  // X refuses localhost in a callback address and accepts 127.0.0.1.
  loopback: "127.0.0.1",
  paste: {
    required: ["api_key", "api_secret", "access_token", "access_secret"],
    help: "These are the OAuth 1.0a values under Keys and tokens: the API key and secret, then an access token and secret generated with Read and write permission. They do not expire.",
  },
};

/** A post's public_metrics, under X's own names. */
const reports: Reports = { impressions: "Impressions", likes: "Likes", comments: "Replies", shares: "Reposts", quotes: "Quotes", saves: "Bookmarks" };
type PublicMetrics = { impression_count?: number; like_count?: number; reply_count?: number; retweet_count?: number; quote_count?: number; bookmark_count?: number };

type Send = <T>(method: string, url: string, init?: RequestInit) => Promise<T>;

/** Runs `work` with a way to send requests as this account, whichever way it was connected. */
async function as<T extends object>(c: Credentials, ctx: Context, work: (send: Send) => Promise<T>): Promise<T> {
  // The four OAuth 1.0a keys win where an account holds both, since they need no renewing.
  if (c.client_id && !c.api_key) {
    return withSession("X", oauth, c, ctx, (session) =>
      work((method, url, init = {}) => call(ctx, "X", url, { ...init, method, headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${session.access_token}` } })),
    );
  }
  for (const key of oauth.paste.required) {
    if (!c[key]) throw new PublishError("X needs either a sign-in, or all four OAuth 1.0a values: API key, API key secret, access token and access token secret.");
  }
  return work((method, url, init = {}) => call(ctx, "X", url, { ...init, method, headers: { ...(init.headers as Record<string, string>), authorization: oauth1(method, url, c) } }));
}

export const x: Connector = {
  id: "x",
  name: "X",
  docsUrl: "https://developer.x.com/en/portal/dashboard",
  setup: [
    "Create a project and app in the X developer portal.",
    "Under User authentication settings choose Read and write, the app type Web App, Automated App or Bot, and add the redirect address shown below as a Callback URI.",
    "Copy the OAuth 2.0 Client ID and Client Secret from Keys and tokens, paste them here, then continue to X and approve.",
    "X signs you in for two hours at a time. Broadside renews that each time it posts, for as long as it posts at least once in six months.",
    "Reading a post's numbers is a read of the X API, which X bills from your app's credits. Without credits X refuses, and Broadside shows its answer.",
  ],
  fields: [
    { key: "client_id", label: "Client ID", kind: "text", optional: true },
    { key: "client_secret", label: "Client Secret", kind: "secret", optional: true, help: "Leave empty for a Native App. X gives those no secret." },
    { key: "refresh_token", label: "Refresh token", kind: "secret", optional: true, hidden: true },
    { key: "api_key", label: "API key", kind: "secret", optional: true, hidden: true },
    { key: "api_secret", label: "API key secret", kind: "secret", optional: true, hidden: true },
    { key: "access_token", label: "Access token", kind: "secret", optional: true, hidden: true },
    { key: "access_secret", label: "Access token secret", kind: "secret", optional: true, hidden: true },
  ],
  oauth,
  limits: { maxChars: 280, count: "weighted", maxImages: 4, maxVideos: 0, requiresMedia: false },

  async verify(c, ctx) {
    return as(c, ctx, async (send) => {
      const me = await send<{ data: { username: string; profile_image_url?: string } }>("GET", `${API}/users/me?user.fields=profile_image_url`);
      return { handle: `@${me.data.username}`, avatarUrl: me.data.profile_image_url, credentials: { username: me.data.username } };
    });
  },

  async publish(input, c, ctx) {
    if (videos(input).length) throw new PublishError("Video on X is not supported yet; attach images or post text.");
    return as(c, ctx, async (send) => {
      const mediaIds: string[] = [];
      for (const image of images(input)) {
        const form = new FormData();
        form.set("media", blob(await image.read(), image.contentType), image.filename);
        form.set("media_category", "tweet_image");
        const uploaded = await send<{ data: { id: string } }>("POST", `${API}/media/upload`, { body: form });
        mediaIds.push(uploaded.data.id);
      }
      const body: Record<string, unknown> = { text: input.text };
      if (mediaIds.length) body.media = { media_ids: mediaIds };
      const tweet = await send<{ data: { id: string } }>("POST", `${API}/tweets`, {
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return { id: tweet.data.id, url: `https://x.com/${c.username || "i"}/status/${tweet.data.id}` };
    });
  },

  async reply(input, c, ctx) {
    return as(c, ctx, async (send) => {
      const tweet = await send<{ data: { id: string } }>("POST", `${API}/tweets`, {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: input.text, reply: { in_reply_to_tweet_id: input.parent.id } }),
      });
      return { id: tweet.data.id, url: `https://x.com/${c.username || "i"}/status/${tweet.data.id}` };
    });
  },

  reports,
  async metrics(input, c, ctx) {
    return as<MetricsResult>(c, ctx, async (send) => {
      const found = await send<{ data?: { public_metrics?: PublicMetrics }; errors?: { title?: string; detail?: string }[] }>("GET", `${API}/tweets/${encodeURIComponent(input.id)}?tweet.fields=public_metrics`);
      const counts = found.data?.public_metrics;
      // X answers 200 with an errors list for a post it will not show, such as one that was deleted.
      if (!counts) throw new PublishError(`X returned no counts for this post: ${found.errors?.[0]?.detail ?? found.errors?.[0]?.title ?? "no details"}`);
      return {
        metrics: counted(reports, { impressions: counts.impression_count, likes: counts.like_count, comments: counts.reply_count, shares: counts.retweet_count, quotes: counts.quote_count, saves: counts.bookmark_count }),
      };
    });
  },
};
