import { createHash } from "node:crypto";
import { schnorr } from "@noble/curves/secp256k1.js";
import { bech32 } from "@scure/base";
import { assertPublicUrl } from "../net";
import { tokenFields, withSession } from "./oauth2";
import { titleAndBody } from "./options";
import { call, callText, counted, images, json, videos, PublishError, withHint, type Choice, type Connector, type Context, type Credentials, type MetricsResult, type OAuthSpec, type Reports } from "./types";

// The rule for a title lives with the other option rules, where the browser can read it too.
export { titleAndBody };

const formBody = (params: Record<string, string>): URLSearchParams => new URLSearchParams(params);

/* Pinterest --------------------------------------------------------------- */

/**
 * Pinterest's access token lasts 30 days and its refresh token 60. Each
 * refresh returns a new refresh token good for another 60, so an account that
 * posts at least that often stays connected. A sign-in ends with a choice of
 * board, because a pin always goes to one.
 */
const pinterestOAuth: OAuthSpec = {
  authorizeUrl: "https://www.pinterest.com/oauth/",
  tokenUrl: "https://api.pinterest.com/v5/oauth/token",
  // pins:read is what lets a pin's numbers be read.
  scopes: ["boards:read", "pins:read", "pins:write", "user_accounts:read"],
  scopeSeparator: ",",
  client: { id: "app_id", secret: "app_secret" },
  pkce: "none",
  clientAuth: "basic",
  // Apps made before 25 September 2025 must ask for the refresh token that can itself be renewed. Newer apps get it anyway.
  exchangeParams: { continuous_refresh: "true" },
  choose: {
    prompt: "Pick the board to pin to.",
    multiple: false,
    empty: "This Pinterest account has no boards. Create one on Pinterest, then sign in again.",
    async list(c, ctx) {
      const boards: { id: string; name: string; privacy?: string }[] = [];
      let bookmark: string | undefined;
      for (let page = 0; page < 10; page++) {
        const batch: { items?: typeof boards; bookmark?: string | null } = await call(ctx, "Pinterest", `https://api.pinterest.com/v5/boards?page_size=100${bookmark ? `&bookmark=${encodeURIComponent(bookmark)}` : ""}`, {
          headers: { authorization: `Bearer ${c.access_token}` },
        });
        boards.push(...(batch.items ?? []));
        bookmark = batch.bookmark ?? undefined;
        if (!bookmark) break;
      }
      return boards.map((board): Choice => ({ id: board.id, name: board.name, detail: board.privacy && board.privacy !== "PUBLIC" ? "Not public" : undefined, credentials: { ...c, board_id: board.id, board_name: board.name } }));
    },
  },
  paste: {
    required: ["access_token", "board_id"],
    help: "Generate an access token for your app with pins:write, pins:read, boards:read and user_accounts:read. A board's id is listed by GET /v5/boards.",
  },
};

/** Pinterest counts a pin over a range of days, at most the last 90. Clicks here are clicks on the pin itself. */
const pinterestReports: Reports = { impressions: "Impressions", saves: "Saves", clicks: "Pin clicks" };
const DAY = 86_400_000;
const day = (time: number) => new Date(time).toISOString().slice(0, 10);

export const pinterest: Connector = {
  id: "pinterest",
  name: "Pinterest",
  docsUrl: "https://developers.pinterest.com/apps/",
  setup: [
    "Create an app at developers.pinterest.com and, on its Configure tab, add the redirect address shown below under Redirect URIs.",
    "Paste the App id and App secret key, then continue to Pinterest, approve, and pick the board to pin to.",
    "Pinterest signs you in for 30 days. Broadside renews that when it posts, as long as it posts at least once in 60 days.",
    "Apps on trial access create pins only you can see until Pinterest approves the app.",
    "pins:read is what lets Broadside read a pin's impressions, saves and clicks. Pinterest reports them for the last 90 days.",
  ],
  fields: [
    { key: "app_id", label: "App id", kind: "text", optional: true },
    { key: "app_secret", label: "App secret key", kind: "secret", optional: true },
    { key: "access_token", label: "Access token", kind: "secret", hidden: true },
    { key: "board_id", label: "Board id", kind: "text", hidden: true },
    { key: "refresh_token", label: "Refresh token", kind: "secret", optional: true, hidden: true },
  ],
  oauth: pinterestOAuth,
  options: [
    { key: "title", label: "Title", kind: "text" },
    { key: "link", label: "Destination link", kind: "text" },
  ],
  limits: { maxChars: 800, count: "graphemes", maxImages: 1, maxVideos: 0, requiresMedia: true },

  async verify(c, ctx) {
    return pinterestSession(c, ctx, async (live) => {
      const me = await call<{ username: string; profile_image?: string }>(ctx, "Pinterest", "https://api.pinterest.com/v5/user_account", {
        headers: { authorization: `Bearer ${live.access_token}` },
      });
      // An account made by signing in names its board, since one person may connect several.
      return { handle: c.board_name ? `@${me.username}, ${c.board_name}` : `@${me.username}`, avatarUrl: me.profile_image, credentials: { username: me.username } };
    });
  },

  async publish(input, c, ctx) {
    return pinterestSession(c, ctx, async (live) => {
      const image = images(input)[0];
      const pin = await call<{ id: string }>(
        ctx,
        "Pinterest",
        "https://api.pinterest.com/v5/pins",
        json(
          {
            board_id: c.board_id,
            title: typeof input.options.title === "string" ? input.options.title.slice(0, 100) : undefined,
            description: input.text,
            link: input.options.link || undefined,
            alt_text: image.alt || undefined,
            media_source: {
              source_type: "image_base64",
              content_type: image.contentType,
              data: Buffer.from(await image.read()).toString("base64"),
            },
          },
          { authorization: `Bearer ${live.access_token}` },
        ),
      );
      return { id: pin.id, url: `https://www.pinterest.com/pin/${pin.id}` };
    });
  },

  reports: pinterestReports,
  async metrics(input, c, ctx) {
    return pinterestSession<MetricsResult>(c, ctx, async (live) => {
      const now = Date.now();
      // Pinterest takes a start date no more than 90 days back, so an older pin is counted over the last 90 days only.
      const earliest = now - 89 * DAY;
      const published = input.publishedAt ? Date.parse(input.publishedAt) : earliest;
      const found = await call<Record<string, { summary_metrics?: Record<string, unknown> }>>(
        ctx,
        "Pinterest",
        `https://api.pinterest.com/v5/pins/${encodeURIComponent(input.id)}/analytics?start_date=${day(Math.max(published, earliest))}&end_date=${day(now)}&metric_types=IMPRESSION,OUTBOUND_CLICK,PIN_CLICK,SAVE`,
        { headers: { authorization: `Bearer ${live.access_token}` } },
      ).catch((error) => withHint(error, "Reading numbers needs the permission pins:read. If this account was connected without it, reconnect it."));
      // With no split asked for, the answer holds one group of numbers under a single key.
      const totals = Object.values(found)[0]?.summary_metrics;
      if (!totals) throw new PublishError("Pinterest returned no numbers for this pin.");
      return {
        metrics: counted(pinterestReports, { impressions: totals.IMPRESSION, saves: totals.SAVE, clicks: totals.PIN_CLICK }),
        note: published < earliest ? "Pinterest reports the last 90 days only, so these numbers leave out anything earlier." : undefined,
      };
    });
  },
};

/** A pasted token with nothing to renew it is used as it is; a signed-in account is renewed when its 30 days are nearly up. */
const pinterestSession = <T extends object>(c: Credentials, ctx: Context, work: (live: Credentials) => Promise<T>): Promise<T> =>
  c.refresh_token ? withSession("Pinterest", pinterestOAuth, c, ctx, work) : work(c);

/* Reddit ------------------------------------------------------------------ */

/** A score is upvotes less downvotes. Reddit does not give the two apart, or a view count. */
const redditReports: Reports = { score: "Score", comments: "Comments" };

export const reddit: Connector = {
  id: "reddit",
  name: "Reddit",
  docsUrl: "https://www.reddit.com/prefs/apps",
  setup: [
    "At reddit.com/prefs/apps create an app of type script.",
    "Paste its client id and secret with your Reddit username and password, and the subreddit to post in.",
    "The first line of each post becomes its title.",
  ],
  fields: [
    { key: "client_id", label: "Client id", kind: "text" },
    { key: "client_secret", label: "Client secret", kind: "secret" },
    { key: "username", label: "Username", kind: "text" },
    { key: "password", label: "Password", kind: "secret" },
    { key: "subreddit", label: "Subreddit", kind: "text", placeholder: "test" },
  ],
  options: [{ key: "title", label: "Title", kind: "text" }],
  limits: { maxChars: 40000, count: "graphemes", maxImages: 0, maxVideos: 0, requiresMedia: false, maxReplyChars: 10000 },

  async verify(c, ctx) {
    await redditToken(c, ctx);
    return { handle: `u/${c.username} in r/${c.subreddit.replace(/^r\//, "")}` };
  },

  async publish(input, c, ctx) {
    const token = await redditToken(c, ctx);
    const { title, body } = titleAndBody(input.text, input.options, 300);
    const result = await call<{ json: { errors: string[][]; data?: { name: string; url: string } } }>(
      ctx,
      "Reddit",
      "https://oauth.reddit.com/api/submit",
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "user-agent": agent(c) },
        body: formBody({ api_type: "json", kind: "self", sr: c.subreddit.replace(/^r\//, ""), title, text: body }),
      },
    );
    if (result.json.errors.length || !result.json.data) {
      throw new PublishError(`Reddit refused the post: ${result.json.errors.map((e) => e.join(" ")).join("; ") || "no details"}`);
    }
    return { id: result.json.data.name, url: result.json.data.url };
  },

  async reply(input, c, ctx) {
    const token = await redditToken(c, ctx);
    const result = await call<{ json: { errors: string[][]; data?: { things?: { data: { name: string; permalink?: string } }[] } } }>(
      ctx,
      "Reddit",
      "https://oauth.reddit.com/api/comment",
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "user-agent": agent(c) },
        body: formBody({ api_type: "json", thing_id: input.parent.id, text: input.text }),
      },
    );
    const comment = result.json.data?.things?.[0]?.data;
    if (result.json.errors.length || !comment) {
      throw new PublishError(`Reddit refused the comment: ${result.json.errors.map((e) => e.join(" ")).join("; ") || "no details"}`);
    }
    return { id: comment.name, url: comment.permalink ? `https://www.reddit.com${comment.permalink}` : undefined };
  },

  reports: redditReports,
  async metrics(input, c, ctx) {
    const token = await redditToken(c, ctx);
    const found = await call<{ data?: { children?: { data?: { name?: string; score?: number; num_comments?: number } }[] } }>(
      ctx,
      "Reddit",
      `https://oauth.reddit.com/api/info?id=${encodeURIComponent(input.id)}&raw_json=1`,
      { headers: { authorization: `Bearer ${token}`, "user-agent": agent(c) } },
    );
    const link = found.data?.children?.find((child) => child.data?.name === input.id)?.data;
    if (!link) throw new PublishError("Reddit returned no post for this id. It may have been deleted.");
    return { metrics: counted(redditReports, { score: link.score, comments: link.num_comments }) };
  },
};

const agent = (c: Credentials) => `broadside/0.1 (by /u/${c.username})`;

async function redditToken(c: Credentials, ctx: Context): Promise<string> {
  const granted = await call<{ access_token?: string; error?: string }>(ctx, "Reddit", "https://www.reddit.com/api/v1/access_token", {
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from(`${c.client_id}:${c.client_secret}`).toString("base64")}`,
      "user-agent": agent(c),
    },
    body: formBody({ grant_type: "password", username: c.username, password: c.password }),
  });
  if (!granted.access_token) throw new PublishError(`Reddit rejected the credentials: ${granted.error ?? "unknown error"}`);
  return granted.access_token;
}

/* Dev.to ------------------------------------------------------------------ */

/** DEV documents a reaction count on the list of your own articles. Comments and page views are not in that documented answer, so they are not read. */
const devtoReports: Reports = { likes: "Reactions" };

export const devto: Connector = {
  id: "devto",
  name: "DEV",
  docsUrl: "https://dev.to/settings/extensions",
  setup: [
    "Open dev.to, Settings, Extensions, and generate a DEV Community API key.",
    "Paste it here. The first line of each post becomes the article title and the rest its Markdown body.",
  ],
  fields: [{ key: "api_key", label: "API key", kind: "secret" }],
  options: [
    { key: "title", label: "Title", kind: "text" },
    { key: "tags", label: "Tags, comma separated", kind: "text" },
  ],
  limits: { maxChars: 100_000, count: "graphemes", maxImages: 1, maxVideos: 0, requiresMedia: false, pullsMedia: true },

  async verify(c, ctx) {
    const me = await call<{ username: string; profile_image?: string }>(ctx, "DEV", "https://dev.to/api/users/me", {
      headers: { "api-key": c.api_key },
    });
    return { handle: `@${me.username}`, avatarUrl: me.profile_image };
  },

  async publish(input, c, ctx) {
    const { title, body } = titleAndBody(input.text, input.options, 128);
    const tags = typeof input.options.tags === "string" ? input.options.tags.split(",").map((t) => t.trim()).filter(Boolean).slice(0, 4) : [];
    const article = await call<{ id: number; url: string }>(
      ctx,
      "DEV",
      "https://dev.to/api/articles",
      json(
        { article: { title, body_markdown: body || title, published: true, tags, main_image: images(input)[0]?.publicUrl } },
        { "api-key": c.api_key },
      ),
    );
    return { id: String(article.id), url: article.url };
  },

  reports: devtoReports,
  async metrics(input, c, ctx) {
    // DEV has no documented answer for one article's counts, so the article is found in the list of your published ones.
    for (let page = 1; page <= 5; page++) {
      const listed = await call<{ id: number; public_reactions_count?: number }[]>(ctx, "DEV", `https://dev.to/api/articles/me/published?per_page=1000&page=${page}`, { headers: { "api-key": c.api_key } });
      const article = Array.isArray(listed) ? listed.find((a) => String(a.id) === input.id) : undefined;
      if (article) return { metrics: counted(devtoReports, { likes: article.public_reactions_count }) };
      if (!Array.isArray(listed) || listed.length < 1000) break;
    }
    throw new PublishError("DEV did not list this article among your published ones. It may have been unpublished or deleted.");
  },
};

/* Lemmy ------------------------------------------------------------------- */

const lemmyReports: Reports = { likes: "Upvotes", score: "Score", comments: "Comments" };

export const lemmy: Connector = {
  id: "lemmy",
  name: "Lemmy",
  docsUrl: "https://join-lemmy.org/docs/",
  setup: [
    "Paste your instance address, username and password, and the community to post in.",
    "The first line of each post becomes its title.",
  ],
  fields: [
    { key: "instance", label: "Instance URL", kind: "url", placeholder: "https://lemmy.world" },
    { key: "username", label: "Username", kind: "text" },
    { key: "password", label: "Password", kind: "secret" },
    { key: "community", label: "Community", kind: "text", placeholder: "technology" },
  ],
  options: [{ key: "title", label: "Title", kind: "text" }],
  limits: { maxChars: 10000, count: "graphemes", maxImages: 0, maxVideos: 0, requiresMedia: false },

  async verify(c, ctx) {
    await lemmyLogin(c, ctx);
    return { handle: `${c.username} in ${c.community}` };
  },

  async publish(input, c, ctx) {
    const base = c.instance.replace(/\/+$/, "");
    const jwt = await lemmyLogin(c, ctx);
    const auth = { authorization: `Bearer ${jwt}` };
    const found = await call<{ community_view: { community: { id: number } } }>(
      ctx,
      "Lemmy",
      `${base}/api/v3/community?name=${encodeURIComponent(c.community)}`,
      { headers: auth },
    );
    const { title, body } = titleAndBody(input.text, input.options, 200);
    const made = await call<{ post_view: { post: { id: number } } }>(
      ctx,
      "Lemmy",
      `${base}/api/v3/post`,
      json({ community_id: found.community_view.community.id, name: title, body: body || undefined }, auth),
    );
    return { id: String(made.post_view.post.id), url: `${base}/post/${made.post_view.post.id}` };
  },

  async reply(input, c, ctx) {
    const base = c.instance.replace(/\/+$/, "");
    const jwt = await lemmyLogin(c, ctx);
    // Posts and comments are numbered separately, so the first reply names only the post and later ones name the comment above them.
    const made = await call<{ comment_view: { comment: { id: number } } }>(
      ctx,
      "Lemmy",
      `${base}/api/v3/comment`,
      json({ content: input.text, post_id: Number(input.root.id), parent_id: input.index > 1 ? Number(input.parent.id) : undefined }, { authorization: `Bearer ${jwt}` }),
    );
    return { id: String(made.comment_view.comment.id), url: `${base}/comment/${made.comment_view.comment.id}` };
  },

  reports: lemmyReports,
  async metrics(input, c, ctx) {
    const base = c.instance.replace(/\/+$/, "");
    const jwt = await lemmyLogin(c, ctx);
    const found = await call<{ post_view?: { counts?: { upvotes?: number; score?: number; comments?: number } } }>(ctx, "Lemmy", `${base}/api/v3/post?id=${encodeURIComponent(input.id)}`, {
      headers: { authorization: `Bearer ${jwt}` },
    });
    const counts = found.post_view?.counts;
    if (!counts) throw new PublishError("Lemmy returned no counts for this post.");
    return { metrics: counted(lemmyReports, { likes: counts.upvotes, score: counts.score, comments: counts.comments }) };
  },
};

async function lemmyLogin(c: Credentials, ctx: Context): Promise<string> {
  const login = await call<{ jwt?: string }>(
    ctx,
    "Lemmy",
    `${c.instance.replace(/\/+$/, "")}/api/v3/user/login`,
    json({ username_or_email: c.username, password: c.password }),
  );
  if (!login.jwt) throw new PublishError("Lemmy did not return a session; check the username and password.");
  return login.jwt;
}

/* Nostr ------------------------------------------------------------------- */

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

export function nostrSecret(input: string): Uint8Array {
  const value = input.trim();
  if (value.startsWith("nsec1")) {
    const decoded = bech32.decode(value as `${string}1${string}`, 200);
    return new Uint8Array(bech32.fromWords(decoded.words));
  }
  if (!/^[0-9a-f]{64}$/i.test(value)) throw new PublishError("The Nostr key must be an nsec1… key or 64 hex characters.");
  return new Uint8Array(Buffer.from(value, "hex"));
}

export const noteId = (id: string) => bech32.encode("note", bech32.toWords(Buffer.from(id, "hex")), 200);
export const npub = (secret: Uint8Array) => bech32.encode("npub", bech32.toWords(schnorr.getPublicKey(secret)), 200);

/** A signed kind-1 text note, as NIP-01 defines it. */
export function nostrEvent(secret: Uint8Array, content: string, createdAt = Math.floor(Date.now() / 1000), tags: string[][] = []) {
  const pubkey = hex(schnorr.getPublicKey(secret));
  const id = createHash("sha256").update(JSON.stringify([0, pubkey, createdAt, 1, tags, content])).digest("hex");
  const sig = hex(schnorr.sign(Buffer.from(id, "hex"), secret));
  return { id, pubkey, created_at: createdAt, kind: 1, tags, content, sig };
}

function sendToRelay(url: string, event: ReturnType<typeof nostrEvent>): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error("timed out"));
    }, 8000);
    const done = (error?: Error) => {
      clearTimeout(timer);
      socket.close();
      if (error) reject(error);
      else resolve();
    };
    socket.onopen = () => socket.send(JSON.stringify(["EVENT", event]));
    socket.onerror = () => done(new Error("connection failed"));
    socket.onmessage = (message) => {
      const data = JSON.parse(String(message.data)) as [string, string, boolean, string];
      if (data[0] === "OK" && data[1] === event.id) done(data[2] ? undefined : new Error(data[3] || "rejected"));
    };
  });
}

export const nostr: Connector = {
  id: "nostr",
  name: "Nostr",
  docsUrl: "https://nostr.how/en/get-started",
  setup: [
    "Paste your private key (nsec1…). It is encrypted on this machine and only used to sign your notes.",
    "List the relays to publish to, separated by commas.",
  ],
  fields: [
    { key: "private_key", label: "Private key", kind: "secret", placeholder: "nsec1…" },
    { key: "relays", label: "Relays", kind: "text", placeholder: "wss://relay.damus.io, wss://nos.lol" },
  ],
  // NIP-09 lets an author ask relays to delete a note and leaves each relay free to keep it.
  notice: "A note goes to every relay listed and is copied on from there. Relays can be asked to delete it later and are free to keep it, so treat a note as permanent.",
  limits: { maxChars: 100_000, count: "graphemes", maxImages: 10, maxVideos: 2, requiresMedia: false, pullsMedia: true },
  noMetrics: "Nostr keeps no count for a note. Reactions and replies are separate notes spread across relays, and no relay holds them all.",

  async verify(c) {
    const key = npub(nostrSecret(c.private_key));
    if (!relays(c).length) throw new PublishError("Add at least one relay address starting with wss://.");
    return { handle: `${key.slice(0, 12)}…${key.slice(-6)}` };
  },

  async publish(input, c) {
    const content = [input.text, ...input.media.map((m) => m.publicUrl)].filter(Boolean).join("\n");
    return broadcast(c, nostrEvent(nostrSecret(c.private_key), content));
  },

  async reply(input, c) {
    const secret = nostrSecret(c.private_key);
    return broadcast(c, nostrEvent(secret, input.text, undefined, replyTags(input.root.id, input.index > 1 ? input.parent.id : null, hex(schnorr.getPublicKey(secret)))));
  },
};

/**
 * NIP-10 marked tags: the thread's first note is the root, and a note that
 * answers a later one names it as the reply. The p tag names the author being
 * answered, which here is always the same key.
 */
export function replyTags(root: string, parent: string | null, author: string): string[][] {
  const tags = [["e", root, "", "root"]];
  if (parent) tags.push(["e", parent, "", "reply"]);
  return [...tags, ["p", author]];
}

async function broadcast(c: Credentials, event: ReturnType<typeof nostrEvent>) {
  // A relay address is user-typed like any other, so it gets the same private-network check before a socket is opened.
  const results = await Promise.allSettled(
    relays(c).map(async (url) => {
      await assertPublicUrl(new URL(url.replace(/^ws/, "http")));
      return sendToRelay(url, event);
    }),
  );
  if (!results.some((r) => r.status === "fulfilled")) {
    const reasons = results.map((r, i) => `${relays(c)[i]}: ${(r as PromiseRejectedResult).reason.message}`).join("; ");
    throw new PublishError(`No relay accepted the note (${reasons}).`, true);
  }
  return { id: event.id, url: `https://njump.me/${noteId(event.id)}` };
}

const relays = (c: Credentials) => (c.relays || "").split(",").map((r) => r.trim()).filter((r) => /^wss?:\/\//.test(r));

/* TikTok ------------------------------------------------------------------ */

const TT = "https://open.tiktokapis.com/v2";

async function tiktokToken(c: Credentials, ctx: Context): Promise<Credentials> {
  const fresh = await call<{ access_token?: string; refresh_token?: string; error_description?: string }>(ctx, "TikTok", `${TT}/oauth/token/`, {
    method: "POST",
    body: formBody({ client_key: c.client_key, client_secret: c.client_secret, grant_type: "refresh_token", refresh_token: c.refresh_token }),
  });
  if (!fresh.access_token) throw new PublishError(`TikTok would not refresh the session: ${fresh.error_description ?? "reconnect the account"}`);
  return { ...c, access_token: fresh.access_token, refresh_token: fresh.refresh_token ?? c.refresh_token };
}

const tiktokReports: Reports = { views: "Views", likes: "Likes", comments: "Comments", shares: "Shares" };

export const tiktok: Connector = {
  id: "tiktok",
  name: "TikTok",
  docsUrl: "https://developers.tiktok.com/doc/content-posting-api-get-started",
  setup: [
    "Create an app at developers.tiktok.com and add two products: Login Kit and Content Posting API.",
    "In Login Kit choose Desktop and add the redirect address shown below, exactly as written.",
    "While the app is in sandbox, add your own TikTok account under Sandbox, Target users.",
    "Paste the client key and client secret here, then continue to TikTok and approve.",
    "Until TikTok audits your app, posts are private or arrive in your TikTok inbox as drafts.",
    "Add the scope video.list to the app as well. It is what lets Broadside read a public post's views, likes, comments and shares. TikTok gives no numbers for a draft or a private post.",
  ],
  fields: [
    { key: "client_key", label: "Client key", kind: "text" },
    { key: "client_secret", label: "Client secret", kind: "secret" },
    { key: "scopes", label: "Scopes", kind: "text", optional: true, placeholder: "user.info.basic,video.upload,video.publish,video.list", help: "Leave empty unless your app lacks one of these; then list only the ones it has. Without video.list, posts go out and their numbers are not read." },
    { key: "refresh_token", label: "Refresh token", kind: "secret", hidden: true },
  ],
  oauth: {
    authorizeUrl: "https://www.tiktok.com/v2/auth/authorize/",
    tokenUrl: "https://open.tiktokapis.com/v2/oauth/token/",
    // video.list is what lets a published post's numbers be read.
    scopes: ["user.info.basic", "video.upload", "video.publish", "video.list"],
    scopeSeparator: ",",
    client: { id: "client_key", secret: "client_secret", param: "client_key" },
    // TikTok wants the challenge as the hex SHA-256 of the verifier, not the usual base64url.
    pkce: "S256-hex",
    clientAuth: "body",
    // Only the refresh token is kept: TikTok's access token lasts a day, and every post starts by trading the refresh token for a new one.
    async exchange(tokens, app) {
      if (!tokens.refresh_token) throw new PublishError("TikTok returned no refresh token, so the account could not stay connected.");
      return { ...app, refresh_token: tokens.refresh_token };
    },
    paste: { required: ["client_key", "client_secret", "refresh_token"] },
  },
  options: [
    { key: "publish_mode", label: "Publish as", kind: "select", choices: ["draft", "direct"], help: "Draft sends it to your TikTok inbox to finish in the app." },
    { key: "privacy", label: "Who can watch", kind: "select", choices: ["SELF_ONLY", "MUTUAL_FOLLOW_FRIENDS", "FOLLOWER_OF_CREATOR", "PUBLIC_TO_EVERYONE"] },
  ],
  limits: { maxChars: 2200, count: "graphemes", maxImages: 35, maxVideos: 1, requiresMedia: true },

  async verify(c, ctx) {
    const session = await tiktokToken(c, ctx);
    const me = await call<{ data: { user: { display_name: string; avatar_url?: string } } }>(
      ctx,
      "TikTok",
      `${TT}/user/info/?fields=display_name,avatar_url`,
      { headers: { authorization: `Bearer ${session.access_token}` } },
    );
    return { handle: me.data.user.display_name, avatarUrl: me.data.user.avatar_url, credentials: { refresh_token: session.refresh_token } };
  },

  async publish(input, c, ctx) {
    const session = await tiktokToken(c, ctx);
    const auth = { authorization: `Bearer ${session.access_token}`, "content-type": "application/json; charset=UTF-8" };
    const direct = input.options.publish_mode === "direct";
    const info = {
      title: input.text,
      privacy_level: input.options.privacy ?? "SELF_ONLY",
      disable_duet: false,
      disable_comment: false,
      disable_stitch: false,
    };
    const video = videos(input)[0];
    let publishId: string;
    if (video) {
      const bytes = await video.read();
      if (bytes.length > 64_000_000) throw new PublishError("TikTok videos over 64 MB are not supported yet.");
      const source = { source: "FILE_UPLOAD", video_size: bytes.length, chunk_size: bytes.length, total_chunk_count: 1 };
      const init = await call<{ data: { publish_id: string; upload_url: string } }>(
        ctx,
        "TikTok",
        direct ? `${TT}/post/publish/video/init/` : `${TT}/post/publish/inbox/video/init/`,
        { method: "POST", headers: auth, body: JSON.stringify(direct ? { post_info: info, source_info: source } : { source_info: source }) },
      );
      await call(ctx, "TikTok", init.data.upload_url, {
        method: "PUT",
        headers: { "content-type": video.contentType, "content-range": `bytes 0-${bytes.length - 1}/${bytes.length}` },
        body: bytes as BodyInit,
      });
      publishId = init.data.publish_id;
    } else {
      const urls = images(input).map((image) => {
        if (!image.publicUrl) throw new PublishError("TikTok fetches photos from a public URL on a domain verified in your TikTok app. Set BROADSIDE_PUBLIC_URL.");
        return image.publicUrl;
      });
      const init = await call<{ data: { publish_id: string } }>(ctx, "TikTok", `${TT}/post/publish/content/init/`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({
          post_info: { ...info, title: input.text.slice(0, 90), description: input.text },
          source_info: { source: "PULL_FROM_URL", photo_images: urls, photo_cover_index: 0 },
          post_mode: direct ? "DIRECT_POST" : "MEDIA_UPLOAD",
          media_type: "PHOTO",
        }),
      });
      publishId = init.data.publish_id;
    }
    return { id: publishId, credentials: session };
  },

  reports: tiktokReports,
  async metrics(input, c, ctx): Promise<MetricsResult> {
    const session = await tiktokToken(c, ctx);
    const auth = { authorization: `Bearer ${session.access_token}`, "content-type": "application/json; charset=UTF-8" };
    try {
      // Broadside holds the id of the upload. TikTok gives the post's own id only once the post is public and has passed moderation.
      const status = await callText(ctx, "TikTok", `${TT}/post/publish/status/fetch/`, { method: "POST", headers: auth, body: JSON.stringify({ publish_id: input.id }) });
      // Post ids are longer than a JavaScript number holds, so they are read from the text as digits. The misspelt name is TikTok's own.
      const videoId = status.match(/"publicaly_available_post_id"\s*:\s*\[([^\]]*)\]/)?.[1].match(/\d+/)?.[0];
      if (!videoId) {
        const inbox = /"status"\s*:\s*"SEND_TO_USER_INBOX"/.test(status);
        throw new PublishError(inbox ? "This post is a draft in your TikTok inbox. TikTok reports numbers once you publish it there and it is public." : "TikTok has not made this post public, so it reports no numbers for it.");
      }
      const found = await call<{ data?: { videos?: { id?: string; view_count?: number; like_count?: number; comment_count?: number; share_count?: number }[] } }>(
        ctx,
        "TikTok",
        `${TT}/video/query/?fields=id,like_count,comment_count,share_count,view_count`,
        { method: "POST", headers: auth, body: JSON.stringify({ filters: { video_ids: [videoId] } }) },
      ).catch((error) => withHint(error, "Reading numbers needs the scope video.list. If this account was connected without it, add the scope to your TikTok app and reconnect."));
      const video = found.data?.videos?.find((v) => v.id === videoId);
      if (!video) throw new PublishError("TikTok returned no video for this post.");
      return { metrics: counted(tiktokReports, { views: video.view_count, likes: video.like_count, comments: video.comment_count, shares: video.share_count }), credentials: session };
    } catch (error) {
      // The refresh at the top may have replaced the refresh token, so the new one is kept however the reading went.
      if (error instanceof PublishError) error.credentials = session;
      throw error;
    }
  },
};

/* YouTube ----------------------------------------------------------------- */

/**
 * Google's access token lasts an hour and its refresh token does not rotate.
 * access_type=offline is what makes Google issue the refresh token, and
 * prompt=consent makes it issue one again for an account that approved the
 * app before. An app whose consent screen is still in Testing gets a refresh
 * token that stops after seven days.
 */
const youtubeOAuth: OAuthSpec = {
  authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  // youtube.upload sends the video; youtube.readonly reads the channel's name for the account list.
  scopes: ["https://www.googleapis.com/auth/youtube.upload", "https://www.googleapis.com/auth/youtube.readonly"],
  authorize: { access_type: "offline", prompt: "consent" },
  client: { id: "client_id", secret: "client_secret" },
  pkce: "none",
  clientAuth: "body",
  async exchange(tokens, app) {
    if (!tokens.refresh_token) throw new PublishError("Google returned no refresh token, so the channel could not stay connected. Remove Broadside's access at myaccount.google.com/permissions and sign in again.");
    return { ...app, ...tokenFields(tokens) };
  },
  paste: {
    required: ["client_id", "client_secret", "refresh_token"],
    help: "Authorise your channel for the scope youtube.upload with offline access (the OAuth Playground works) and keep the refresh token.",
  },
};

const youtubeReports: Reports = { views: "Views", likes: "Likes", comments: "Comments" };

export const youtube: Connector = {
  id: "youtube",
  name: "YouTube",
  docsUrl: "https://console.cloud.google.com/apis/credentials",
  setup: [
    "In Google Cloud create a project, enable YouTube Data API v3 and create an OAuth client of type Web application.",
    "Add the redirect address shown below under Authorized redirect URIs.",
    "Paste the client id and client secret, then continue to Google and approve. Broadside connects the channel of the Google account you sign in with.",
    "While the app's consent screen is in Testing, Google ends the sign-in after 7 days. Publish the app to production to stay connected.",
    "The first line of each post becomes the video title.",
  ],
  fields: [
    { key: "client_id", label: "Client id", kind: "text" },
    { key: "client_secret", label: "Client secret", kind: "secret" },
    { key: "refresh_token", label: "Refresh token", kind: "secret", hidden: true },
  ],
  oauth: youtubeOAuth,
  options: [
    { key: "title", label: "Title", kind: "text" },
    { key: "privacy", label: "Visibility", kind: "select", choices: ["private", "unlisted", "public"] },
  ],
  limits: { maxChars: 5000, count: "graphemes", maxImages: 0, maxVideos: 1, requiresMedia: true },

  async verify(c, ctx) {
    return withSession("YouTube", youtubeOAuth, c, ctx, async (live) => {
      const mine = await call<{ items?: { snippet: { title: string; thumbnails?: { default?: { url: string } } } }[] }>(
        ctx,
        "YouTube",
        "https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true",
        { headers: { authorization: `Bearer ${live.access_token}` } },
      ).catch(() => ({ items: undefined }));
      const channel = mine.items?.[0]?.snippet;
      return { handle: channel?.title ?? "YouTube channel", avatarUrl: channel?.thumbnails?.default?.url };
    });
  },

  async publish(input, c, ctx) {
    return withSession("YouTube", youtubeOAuth, c, ctx, async (live) => {
      const video = videos(input)[0];
      const bytes = await video.read();
      const { title, body } = titleAndBody(input.text, input.options, 100);
      let session: Response;
      try {
        session = await ctx.fetch("https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status", {
          method: "POST",
          headers: {
            authorization: `Bearer ${live.access_token}`,
            "content-type": "application/json",
            "x-upload-content-type": video.contentType,
            "x-upload-content-length": String(bytes.length),
          },
          body: JSON.stringify({
            snippet: { title, description: body, categoryId: "22" },
            status: { privacyStatus: input.options.privacy ?? "private", selfDeclaredMadeForKids: false },
          }),
        });
      } catch (cause) {
        throw new PublishError(`YouTube could not be reached: ${(cause as Error).message}`, true);
      }
      const location = session.headers.get("location");
      if (!session.ok || !location) {
        throw new PublishError(`YouTube answered ${session.status}: ${(await session.text()).slice(0, 300)}`, session.status >= 500);
      }
      const uploaded = await call<{ id: string }>(ctx, "YouTube", location, {
        method: "PUT",
        headers: { "content-type": video.contentType },
        body: bytes as BodyInit,
      });
      return { id: uploaded.id, url: `https://www.youtube.com/watch?v=${uploaded.id}` };
    });
  },

  reports: youtubeReports,
  async metrics(input, c, ctx) {
    return withSession<MetricsResult>("YouTube", youtubeOAuth, c, ctx, async (live) => {
      const found = await call<{ items?: { statistics?: { viewCount?: string; likeCount?: string; commentCount?: string } }[] }>(
        ctx,
        "YouTube",
        `https://www.googleapis.com/youtube/v3/videos?part=statistics&id=${encodeURIComponent(input.id)}`,
        { headers: { authorization: `Bearer ${live.access_token}` } },
      ).catch((error) => withHint(error, "Reading numbers needs the scope youtube.readonly. If this channel was connected without it, reconnect it."));
      const statistics = found.items?.[0]?.statistics;
      if (!statistics) throw new PublishError("YouTube returned no video for this id. It may have been deleted.");
      return { metrics: counted(youtubeReports, { views: statistics.viewCount, likes: statistics.likeCount, comments: statistics.commentCount }) };
    });
  },
};
