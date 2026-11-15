import { createHash } from "node:crypto";
import { schnorr } from "@noble/curves/secp256k1.js";
import { bech32 } from "@scure/base";
import { assertPublicUrl } from "../net";
import { call, images, json, videos, PublishError, type Connector, type Context, type Credentials } from "./types";

/** The first line of a post doubles as its title on networks that want one. */
export function titleAndBody(text: string, options: Record<string, unknown>, max: number): { title: string; body: string } {
  const given = typeof options.title === "string" && options.title.trim();
  if (given) return { title: given.slice(0, max), body: text };
  const [first, ...rest] = text.split("\n");
  return { title: first.trim().slice(0, max), body: rest.join("\n").trim() };
}

const formBody = (params: Record<string, string>): URLSearchParams => new URLSearchParams(params);

/* Pinterest --------------------------------------------------------------- */

export const pinterest: Connector = {
  id: "pinterest",
  name: "Pinterest",
  docsUrl: "https://developers.pinterest.com/apps/",
  setup: [
    "Create an app at developers.pinterest.com and generate an access token with pins:write, boards:read and user_accounts:read.",
    "Open the board you want to pin to; its id is listed by GET /v5/boards.",
    "Paste the token and board id. Apps on trial access create pins only you can see until Pinterest approves the app.",
  ],
  fields: [
    { key: "access_token", label: "Access token", kind: "secret" },
    { key: "board_id", label: "Board id", kind: "text" },
  ],
  options: [
    { key: "title", label: "Title", kind: "text" },
    { key: "link", label: "Destination link", kind: "text" },
  ],
  limits: { maxChars: 800, count: "graphemes", maxImages: 1, maxVideos: 0, requiresMedia: true },

  async verify(c, ctx) {
    const me = await call<{ username: string; profile_image?: string }>(ctx, "Pinterest", "https://api.pinterest.com/v5/user_account", {
      headers: { authorization: `Bearer ${c.access_token}` },
    });
    return { handle: `@${me.username}`, avatarUrl: me.profile_image, credentials: { username: me.username } };
  },

  async publish(input, c, ctx) {
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
        { authorization: `Bearer ${c.access_token}` },
      ),
    );
    return { id: pin.id, url: `https://www.pinterest.com/pin/${pin.id}` };
  },
};

/* Reddit ------------------------------------------------------------------ */

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
  limits: { maxChars: 40000, count: "graphemes", maxImages: 0, maxVideos: 0, requiresMedia: false },

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
};

/* Lemmy ------------------------------------------------------------------- */

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
export function nostrEvent(secret: Uint8Array, content: string, createdAt = Math.floor(Date.now() / 1000)) {
  const pubkey = hex(schnorr.getPublicKey(secret));
  const tags: string[][] = [];
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
  limits: { maxChars: 100_000, count: "graphemes", maxImages: 10, maxVideos: 2, requiresMedia: false, pullsMedia: true },

  async verify(c) {
    const key = npub(nostrSecret(c.private_key));
    if (!relays(c).length) throw new PublishError("Add at least one relay address starting with wss://.");
    return { handle: `${key.slice(0, 12)}…${key.slice(-6)}` };
  },

  async publish(input, c) {
    const content = [input.text, ...input.media.map((m) => m.publicUrl)].filter(Boolean).join("\n");
    const event = nostrEvent(nostrSecret(c.private_key), content);
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
  },
};

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
  ],
  fields: [
    { key: "client_key", label: "Client key", kind: "text" },
    { key: "client_secret", label: "Client secret", kind: "secret" },
    { key: "scopes", label: "Scopes", kind: "text", optional: true, placeholder: "user.info.basic,video.upload,video.publish", help: "Leave empty unless your app lacks one of these; then list only the ones it has." },
    { key: "refresh_token", label: "Refresh token", kind: "secret", hidden: true },
  ],
  oauth: {
    authorizeUrl: "https://www.tiktok.com/v2/auth/authorize/",
    tokenUrl: "https://open.tiktokapis.com/v2/oauth/token/",
    scopes: ["user.info.basic", "video.upload", "video.publish"],
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
};

/* YouTube ----------------------------------------------------------------- */

export const youtube: Connector = {
  id: "youtube",
  name: "YouTube",
  docsUrl: "https://developers.google.com/youtube/v3/guides/uploading_a_video",
  setup: [
    "In Google Cloud create a project, enable YouTube Data API v3 and create an OAuth client.",
    "Authorise your channel for the scope youtube.upload with offline access (the OAuth Playground works) and keep the refresh token.",
    "Paste the client id, client secret and refresh token. The first line of each post becomes the video title.",
  ],
  fields: [
    { key: "client_id", label: "Client id", kind: "text" },
    { key: "client_secret", label: "Client secret", kind: "secret" },
    { key: "refresh_token", label: "Refresh token", kind: "secret" },
  ],
  options: [
    { key: "title", label: "Title", kind: "text" },
    { key: "privacy", label: "Visibility", kind: "select", choices: ["private", "unlisted", "public"] },
  ],
  limits: { maxChars: 5000, count: "graphemes", maxImages: 0, maxVideos: 1, requiresMedia: true },

  async verify(c, ctx) {
    const token = await youtubeToken(c, ctx);
    const mine = await call<{ items?: { snippet: { title: string; thumbnails?: { default?: { url: string } } } }[] }>(
      ctx,
      "YouTube",
      "https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true",
      { headers: { authorization: `Bearer ${token}` } },
    ).catch(() => ({ items: undefined }));
    const channel = mine.items?.[0]?.snippet;
    return { handle: channel?.title ?? "YouTube channel", avatarUrl: channel?.thumbnails?.default?.url };
  },

  async publish(input, c, ctx) {
    const token = await youtubeToken(c, ctx);
    const video = videos(input)[0];
    const bytes = await video.read();
    const { title, body } = titleAndBody(input.text, input.options, 100);
    let session: Response;
    try {
      session = await ctx.fetch("https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
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
  },
};

async function youtubeToken(c: Credentials, ctx: Context): Promise<string> {
  const granted = await call<{ access_token?: string }>(ctx, "YouTube", "https://oauth2.googleapis.com/token", {
    method: "POST",
    body: formBody({ client_id: c.client_id, client_secret: c.client_secret, refresh_token: c.refresh_token, grant_type: "refresh_token" }),
  });
  if (!granted.access_token) throw new PublishError("Google did not return an access token; check the client and refresh token.");
  return granted.access_token;
}
