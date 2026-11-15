#!/usr/bin/env node
/**
 * The whole product, proven end to end:
 *   static checks → unit tests → production build → a real server →
 *   stand-in networks → a real MCP client over HTTP and stdio → the web pages.
 * Exits non-zero on the first thing that is not true.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const quick = process.argv.includes("--e2e-only");
let checks = 0;

function ok(condition, label, detail = "") {
  if (!condition) {
    console.error(`\n  ✗ ${label}${detail ? `\n    ${detail}` : ""}`);
    throw new Error(label);
  }
  checks++;
  console.log(`  ✓ ${label}`);
}

// verify builds into its own folder, so a Broadside already running from .next keeps working.
process.env.BROADSIDE_DIST_DIR = ".next-verify";

function step(title, command, args) {
  console.log(`\n▸ ${title}`);
  const result = spawnSync(command, args, { cwd: root, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", env: process.env });
  if (result.status !== 0) {
    console.error(result.stdout.slice(-4000), result.stderr.slice(-4000));
    throw new Error(`${title} failed`);
  }
  checks++;
  console.log(`  ✓ ${title}`);
}

/* Stand-in networks -------------------------------------------------------- */

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const received = { mastodon: [], bluesky: [], discord: [], telegram: [], webhook: [], slack: [] };
// Texts the stand-in Mastodon turns away the first time it sees them, so a thread can fail part of the way and be retried.
const rejectedOnce = new Set();
received.telegramReplies = [];
// Analytics: every read of a post's numbers the stand-ins were asked for, the counts they answer with, and the posts they refuse to report on.
const numberReads = { mastodon: [], bluesky: [], discord: [], x: [], facebook: [], pinterest: [] };
const standinCounts = { mastodon: {}, bluesky: { likeCount: 7, repostCount: 3, replyCount: 1, quoteCount: 0 } };
const MASTODON_COUNTS = { replies_count: 1, reblogs_count: 2, favourites_count: 4 };
const numbersDown = new Set();

function networks() {
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      const text = raw.toString("utf8");
      const json = (body, status = 200) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      const parsed = () => {
        try {
          return JSON.parse(text);
        } catch {
          return {};
        }
      };
      const url = req.url;
      if (url === "/pixel.png") {
        res.writeHead(200, { "content-type": "image/png" });
        return res.end(PNG);
      }
      // Mastodon
      if (url === "/api/v1/accounts/verify_credentials") return json({ acct: "tester", avatar: null });
      if (url === "/api/v2/media") return json({ id: "media-1" });
      const statusRead = req.method === "GET" && url.match(/^\/api\/v1\/statuses\/(\w+)$/);
      if (statusRead) {
        // A read of one status, as GET /api/v1/statuses/:id answers it: the status with its counts.
        numberReads.mastodon.push({ id: statusRead[1], auth: req.headers.authorization ?? null });
        if (numbersDown.has(statusRead[1])) return json({ error: "The stand-in is not reporting on this status" }, 503);
        const known = received.mastodon.find((status) => status.id === statusRead[1]);
        if (!known) return json({ error: "Record not found" }, 404);
        return json({ id: known.id, content: known.status, visibility: "public", ...MASTODON_COUNTS, ...standinCounts.mastodon[known.id] });
      }
      if (url === "/api/v1/statuses") {
        const status = parsed();
        if (status.status?.includes("[reject once]") && !rejectedOnce.has(status.status)) {
          rejectedOnce.add(status.status);
          return json({ error: "Validation failed: the stand-in refused this once" }, 422);
        }
        // Each status gets its own id and remembers which status it answers.
        const id = String(101 + received.mastodon.length);
        received.mastodon.push({ ...status, id });
        return json({ id, url: `http://${req.headers.host}/@tester/${id}` });
      }
      // Bluesky
      if (url === "/xrpc/com.atproto.server.createSession") return json({ accessJwt: "jwt", did: "did:plc:test", handle: "tester.test" });
      if (url.startsWith("/xrpc/app.bsky.actor.getProfile")) return json({});
      if (url.startsWith("/xrpc/app.bsky.feed.getPosts")) {
        // The post views for the addresses asked for, each with its counts.
        const uris = new URL(url, "http://standin").searchParams.getAll("uris");
        numberReads.bluesky.push({ uris, auth: req.headers.authorization ?? null });
        return json({ posts: received.bluesky.filter((post) => uris.includes(post.uri)).map((post) => ({ uri: post.uri, cid: post.cid, author: { did: "did:plc:test", handle: "tester.test" }, record: { text: post.text }, ...standinCounts.bluesky, indexedAt: new Date().toISOString() })) });
      }
      if (url === "/xrpc/com.atproto.repo.uploadBlob") return json({ blob: { $type: "blob", ref: { $link: "bafy" }, mimeType: "image/png", size: raw.length } });
      if (url === "/xrpc/com.atproto.repo.createRecord") {
        // Each record gets its own uri and cid; a reply must quote both for its root and its parent.
        const n = received.bluesky.length;
        const made = { uri: `at://did:plc:test/app.bsky.feed.post/3abc${n || ""}`, cid: `cid-${n}` };
        received.bluesky.push({ ...parsed().record, ...made });
        return json(made);
      }
      // Discord
      if (url === "/api/webhooks/1/token") return json({ name: "Announcements", guild_id: "g1", channel_id: "c1" });
      if (url === "/api/webhooks/1/token?wait=true") {
        received.discord.push(text);
        return json({ id: "m1", channel_id: "c1" });
      }
      if (req.method === "GET" && url.startsWith("/api/webhooks/1/token/messages/")) {
        // A webhook reading back its own message: two reactions of one emoji and one of another.
        numberReads.discord.push(url.split("/").pop());
        return json({ id: url.split("/").pop(), channel_id: "c1", content: "", reactions: [{ count: 2, emoji: { id: null, name: "🔥" } }, { count: 1, emoji: { id: null, name: "👍" } }] });
      }
      // Telegram
      if (url.endsWith("/getMe")) return json({ ok: true, result: { id: 1 } });
      if (url.endsWith("/getChat")) return json({ ok: true, result: { title: "Channel", username: "chan" } });
      if (url.endsWith("/sendMessage") || url.endsWith("/sendPhoto")) {
        // Each message gets its own id; a reply names the message it answers in reply_parameters.
        const message_id = 7 + received.telegram.length;
        received.telegram.push(text);
        received.telegramReplies.push({ message_id, text: parsed().text, reply_to: parsed().reply_parameters?.message_id ?? null });
        return json({ ok: true, result: { message_id, chat: { username: "chan" } } });
      }
      // Slack + generic webhook
      if (url === "/slack") {
        received.slack.push(parsed());
        res.writeHead(200);
        return res.end("ok");
      }
      if (url === "/hook") {
        received.webhook.push({ body: parsed(), signature: req.headers["x-broadside-signature"] });
        return json({ id: "ext-9", url: "https://example.com/p/9" });
      }
      // The networks that sign in. They live at fixed addresses, so scripts/standin-fetch.mjs sends them here as /<host>/<path>.
      const signedIn = signInNetworks(req, url, new URLSearchParams(text), parsed);
      if (signedIn) return json(signedIn.body, signedIn.status ?? 200);
      json({ error: `unexpected ${req.method} ${url}` }, 404);
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

/* Stand-ins for the networks that sign in ---------------------------------- */

const APP = {
  x: { client_id: "verify-x-client-id", client_secret: "verify-x-client-secret-51ab" },
  linkedin: { client_id: "verify-li-client-id", client_secret: "verify-li-client-secret-77c0" },
  facebook: { app_id: "verify-fb-app-id", app_secret: "verify-fb-app-secret-3d9e" },
  instagram: { app_id: "verify-ig-app-id", app_secret: "verify-ig-app-secret-8a2f" },
  youtube: { client_id: "verify-yt-client-id", client_secret: "verify-yt-client-secret-c41d" },
  pinterest: { app_id: "verify-pin-app-id", app_secret: "verify-pin-app-secret-e06b" },
  threads: { app_id: "verify-th-app-id", app_secret: "verify-th-app-secret-b915" },
};
const PAGE_TOKENS = { 111: "verify-page-token-111-6c2a", 222: "verify-page-token-222-f0d4" };
// Tokens that work once, as X's and Pinterest's refresh tokens do. Each lives 60 seconds, so Broadside must renew before every use.
// An access token stays good after a newer one is issued, as it does on the real networks until it expires: the refresh token is the one that works once.
const rotating = { x: { n: 0, access: null, refresh: null, spent: [], issued: new Set() }, pinterest: { n: 0, access: null, refresh: null, spent: [], issued: new Set() } };
const signIns = { tokenRequests: [], tweets: [], feed: [], pins: [], queriesOnTokenEndpoints: [] };

function signInNetworks(req, url, form, parsed) {
  const { pathname, search, searchParams } = new URL(url, "http://standin");
  const auth = req.headers.authorization ?? "";
  const basic = (app) => `Basic ${Buffer.from(`${Object.values(app)[0]}:${Object.values(app)[1]}`).toString("base64")}`;
  const grant = form.get("grant_type");
  const token = (name, fields) => {
    signIns.tokenRequests.push({ name, auth, ...Object.fromEntries(form) });
    if (search) signIns.queriesOnTokenEndpoints.push(url);
    return fields;
  };
  const rotate = (name, prefix) => {
    const kept = rotating[name];
    if (grant === "authorization_code" && form.get("code") !== "good-code") return { status: 400, body: { error: "invalid_request", error_description: "Value passed for the authorization code was invalid." } };
    if (grant === "refresh_token" && form.get("refresh_token") !== kept.refresh) return { status: 400, body: { error: "invalid_request", error_description: "Value passed for the token was invalid." } };
    if (grant === "refresh_token") kept.spent.push(kept.refresh);
    kept.n++;
    kept.access = `${prefix}-access-${kept.n}`;
    kept.refresh = `${prefix}-refresh-${kept.n}`;
    kept.issued.add(`Bearer ${kept.access}`);
    return { body: { token_type: "bearer", expires_in: 60, access_token: kept.access, refresh_token: kept.refresh } };
  };

  // X: a Basic header, two-hour tokens, single-use refresh tokens.
  if (pathname === "/api.x.com/2/oauth2/token") {
    token("x");
    if (auth !== basic(APP.x)) return { status: 401, body: { error: "unauthorized_client", error_description: "Missing valid authorization header" } };
    return rotate("x", "verify-x");
  }
  if (pathname.startsWith("/api.x.com/2/")) {
    if (!rotating.x.issued.has(auth)) return { status: 401, body: { title: "Unauthorized", detail: "Unauthorized", status: 401 } };
    if (pathname.endsWith("/users/me")) return { body: { data: { username: "verify_x" } } };
    const tweetRead = req.method === "GET" && pathname.match(/\/2\/tweets\/(\d+)$/);
    if (tweetRead) {
      // A read of one post's public_metrics. It is not a tweet, so it is counted apart from them.
      numberReads.x.push({ id: tweetRead[1], fields: searchParams.get("tweet.fields") });
      return { body: { data: { id: tweetRead[1], text: "", edit_history_tweet_ids: [tweetRead[1]], public_metrics: { retweet_count: 1, reply_count: 1, like_count: 9, quote_count: 0, bookmark_count: 2, impression_count: 120 } } } };
    }
    signIns.tweets.push(parsed());
    return { body: { data: { id: String(9000 + signIns.tweets.length) } } };
  }
  // LinkedIn: id and secret in the body, a 60-day token and no refresh token.
  if (pathname === "/www.linkedin.com/oauth/v2/accessToken") {
    token("linkedin");
    if (form.get("client_secret") !== APP.linkedin.client_secret || form.get("code") !== "good-code") return { status: 401, body: { error: "invalid_request", error_description: "Unable to retrieve access token: authorization code not found" } };
    return { body: { access_token: "verify-li-access-2b7e", expires_in: 5184000, scope: "openid,profile,w_member_social" } };
  }
  if (pathname === "/api.linkedin.com/v2/userinfo") return auth === "Bearer verify-li-access-2b7e" ? { body: { sub: "li-member-1", name: "Verify Member" } } : { status: 401, body: { message: "Invalid access token" } };
  // Google: id and secret in the body, an hour-long token and a refresh token that stays.
  if (pathname === "/oauth2.googleapis.com/token") {
    token("youtube");
    if (form.get("client_secret") !== APP.youtube.client_secret) return { status: 401, body: { error: "invalid_client", error_description: "Unauthorized" } };
    if (grant === "authorization_code") return form.get("code") === "good-code" ? { body: { access_token: "verify-yt-access-1", expires_in: 3599, refresh_token: "verify-yt-refresh-90aa", token_type: "Bearer" } } : { status: 400, body: { error: "invalid_grant", error_description: "Malformed auth code." } };
    return { body: { access_token: "verify-yt-access-2", expires_in: 3599, token_type: "Bearer" } };
  }
  if (pathname === "/www.googleapis.com/youtube/v3/channels") return { body: { items: [{ snippet: { title: "Verify Channel" } }] } };
  // Facebook Login, for Pages and for Instagram: the code, then the long-lived trade, both read from the body.
  if (pathname === "/graph.facebook.com/v27.0/oauth/access_token") {
    token("facebook");
    const app = form.get("client_id") === APP.instagram.app_id ? APP.instagram : APP.facebook;
    if (form.get("client_secret") !== app.app_secret) return { status: 400, body: { error: { message: "Error validating client secret.", type: "OAuthException", code: 1 } } };
    if (grant === "fb_exchange_token") return form.get("fb_exchange_token") === "verify-fb-user-short" ? { body: { access_token: "verify-fb-user-long-4e1c", token_type: "bearer", expires_in: 5183944 } } : { status: 400, body: { error: { message: "Invalid OAuth access token.", type: "OAuthException", code: 190 } } };
    if (form.get("code") !== "good-code") return { status: 400, body: { error: { message: "This authorization code has been used.", type: "OAuthException", code: 100 } } };
    return { body: { access_token: "verify-fb-user-short", token_type: "bearer", expires_in: 5400 } };
  }
  if (pathname === "/graph.facebook.com/v27.0/me/accounts") {
    if (searchParams.get("access_token") !== "verify-fb-user-long-4e1c") return { status: 400, body: { error: { message: "Invalid OAuth access token.", type: "OAuthException", code: 190 } } };
    return { body: { data: [{ id: "111", name: "Verify Press", access_token: PAGE_TOKENS[111], tasks: ["CREATE_CONTENT"] }, { id: "222", name: "Verify Bindery", access_token: PAGE_TOKENS[222], tasks: ["CREATE_CONTENT"] }] } };
  }
  // A Page post's numbers: its reaction, comment and share totals, then its insights.
  const pagePost = req.method === "GET" && pathname.match(/^\/graph\.facebook\.com\/(\d+)_(\d+)(\/insights)?$/);
  if (pagePost) {
    const [, pageId, , insights] = pagePost;
    if (searchParams.get("access_token") !== PAGE_TOKENS[pageId]) return { status: 400, body: { error: { message: "Invalid OAuth access token.", type: "OAuthException", code: 190 } } };
    numberReads.facebook.push({ page: pageId, insights: Boolean(insights), asked: searchParams.get(insights ? "metric" : "fields") });
    if (insights) return { body: { data: [{ name: "post_media_view", period: "lifetime", values: [{ value: 64 }] }, { name: "post_clicks", period: "lifetime", values: [{ value: 3 }] }] } };
    return { body: { id: `${pageId}_1`, shares: { count: 1 }, reactions: { data: [], summary: { total_count: 5 } }, comments: { data: [], summary: { order: "chronological", total_count: 0 } } } };
  }
  const graph = pathname.match(/^\/graph\.facebook\.com\/(?:v27\.0\/)?(\w+)(\/feed)?$/);
  if (graph) {
    const [, id, feed] = graph;
    if (feed) {
      signIns.feed.push({ page: id, ...Object.fromEntries(form) });
      return form.get("access_token") === PAGE_TOKENS[id] ? { body: { id: `${id}_1`, permalink_url: `https://www.facebook.com/${id}/posts/1` } } : { status: 400, body: { error: { message: "Invalid OAuth access token.", type: "OAuthException", code: 190 } } };
    }
    // Only the first Page has an Instagram account behind it.
    if (searchParams.get("fields")?.startsWith("instagram_business_account")) return { body: id === "111" ? { instagram_business_account: { id: "17841400000000111", username: "verify_gram" }, id } : { id } };
    if (id === "17841400000000111") return { body: { username: "verify_gram" } };
    return { body: { name: id === "111" ? "Verify Press" : "Verify Bindery" } };
  }
  // Pinterest: a Basic header, 30-day tokens and a refresh token that is replaced each time.
  if (pathname === "/api.pinterest.com/v5/oauth/token") {
    token("pinterest");
    if (auth !== basic(APP.pinterest)) return { status: 401, body: { code: 2, message: "Authentication failed." } };
    return rotate("pinterest", "verify-pin");
  }
  if (pathname.startsWith("/api.pinterest.com/v5/")) {
    if (!rotating.pinterest.issued.has(auth)) return { status: 401, body: { code: 2, message: "Authentication failed." } };
    const pinRead = req.method === "GET" && pathname.match(/\/v5\/pins\/([\w-]+)\/analytics$/);
    if (pinRead) {
      // A pin's analytics over a range of days, summed in summary_metrics.
      numberReads.pinterest.push({ id: pinRead[1], start: searchParams.get("start_date"), end: searchParams.get("end_date"), metrics: searchParams.get("metric_types") });
      return { body: { all: { lifetime_metrics: {}, daily_metrics: [], summary_metrics: { IMPRESSION: 30, OUTBOUND_CLICK: 1, PIN_CLICK: 4, SAVE: 2 } } } };
    }
    if (pathname.endsWith("/boards")) return { body: { items: [{ id: "board-1", name: "Verify Specimens", privacy: "PUBLIC" }, { id: "board-2", name: "Verify Drafts", privacy: "SECRET" }], bookmark: null } };
    if (pathname.endsWith("/user_account")) return { body: { username: "verify_pins" } };
    signIns.pins.push(parsed());
    return { body: { id: `pin-${signIns.pins.length}` } };
  }
  // Threads, reached only by pasting a token here: its sign-in needs an https address.
  if (pathname === "/graph.threads.net/v1.0/me") return { body: { id: "th-1", username: "verify_threads" } };
  return null;
}

/* Helpers ------------------------------------------------------------------ */

// Long, distinctive stand-in secrets: a short one could collide with a random id and fail the leak check by chance.
const SECRET_TOKEN = "verify-mastodon-access-token-7f3a";
const SECRET_SIGNING = "verify-webhook-signing-secret-9c1e";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(fn, label, timeout = 30000) {
  const start = Date.now();
  for (;;) {
    try {
      const value = await fn();
      if (value) return value;
    } catch {
      /* not yet */
    }
    if (Date.now() - start > timeout) throw new Error(`timed out waiting for ${label}`);
    await sleep(250);
  }
}

const result = (toolReply) => JSON.parse(toolReply.content[0].text);

/* Run ---------------------------------------------------------------------- */

const dataDir = mkdtempSync(path.join(tmpdir(), "broadside-verify-"));
let app;
let fake;
let failed = false;

try {
  if (!quick) {
    step("Types check", "npx", ["tsc", "--noEmit"]);
    step("Lint is clean", "npx", ["eslint", "--max-warnings", "0"]);
    step("Unit tests pass", "npx", ["vitest", "run"]);
    step("Design tokens hold", "node", ["scripts/check-design.mjs"]);
    step("Production build succeeds", "npx", ["next", "build"]);
  }

  console.log("\n▸ Live system");
  fake = await networks();
  const net = `http://127.0.0.1:${fake.address().port}`;
  const port = 4100 + Math.floor(Math.random() * 800);
  const base = `http://127.0.0.1:${port}`;
  const env = {
    ...process.env,
    BROADSIDE_DATA_DIR: dataDir,
    BROADSIDE_SECRET: "verify-secret",
    BROADSIDE_TICK_MS: "400",
    BROADSIDE_ALLOW_PRIVATE_FETCH: "1",
    BROADSIDE_ALLOW_ANY_WEBHOOK: "1",
    BROADSIDE_PUBLIC_URL: "",
    BROADSIDE_PASSWORD: "",
    // Requests for the networks that sign in are sent to the stand-in by a file loaded into the server under test. Nothing in src reads this.
    BROADSIDE_VERIFY_STANDIN: net,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${pathToFileURL(path.join(root, "scripts", "standin-fetch.mjs")).href}`.trim(),
  };
  app = spawn("npx", ["next", "start", "-p", String(port), "-H", "127.0.0.1"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  app.stdout.on("data", (d) => (log += d));
  app.stderr.on("data", (d) => (log += d));
  const health = await until(async () => (await fetch(`${base}/api/health`)).json(), "the server to start", 60000).catch((e) => {
    console.error(log.slice(-3000));
    throw e;
  });
  ok(health.ok === true && health.name === "broadside", "Server is up and reports healthy");

  const ui = { "sec-fetch-site": "same-origin", "content-type": "application/json" };
  const api = async (pathname, init = {}) => {
    const response = await fetch(`${base}${pathname}`, init);
    return { status: response.status, body: await response.json() };
  };

  // Analytics with nothing published: the screen says what will appear and shows no figure at all
  const emptyAnalytics = await fetch(`${base}/app/analytics`).then((r) => r.text());
  ok(
    emptyAnalytics.includes("Nothing published yet.") && emptyAnalytics.includes("Once a post goes out, the numbers each network reports for it appear here") && emptyAnalytics.includes("Write a post") && /href="\/app"/.test(emptyAnalytics) && !emptyAnalytics.includes("Totals"),
    "With nothing published, the analytics page says what will appear and links to Compose, with no figures",
  );

  // Access control
  ok((await api("/api/v1/accounts")).status === 401, "The API refuses a request with no key");
  const unauthorized = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  ok(unauthorized.status === 401, "The MCP endpoint refuses a request with no key");
  const made = await api("/api/v1/keys", { method: "POST", headers: ui, body: JSON.stringify({ name: "verify" }) });
  const token = made.body.data.token;
  ok(/^bs_/.test(token), "The app issues an API key");
  const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };

  // Connect one account per stand-in network
  const connect = async (platform, credentials) => {
    const r = await api("/api/v1/accounts", { method: "POST", headers: auth, body: JSON.stringify({ platform, credentials }) });
    ok(r.status === 200, `Connects ${platform} as ${r.body.data?.handle}`, JSON.stringify(r.body));
    return r.body.data.id;
  };
  const ids = {
    sandbox: await connect("sandbox", { name: "Rehearsal" }),
    mastodon: await connect("mastodon", { instance: net, access_token: SECRET_TOKEN }),
    bluesky: await connect("bluesky", { identifier: "tester.test", app_password: "pw", service: net }),
    discord: await connect("discord", { webhook_url: `${net}/api/webhooks/1/token` }),
    telegram: await connect("telegram", { bot_token: "1:A", chat_id: "@chan", api_base: net }),
    slack: await connect("slack", { webhook_url: `${net}/slack`, channel: "#news" }),
    webhook: await connect("webhook", { url: `${net}/hook`, name: "Automation", secret: SECRET_SIGNING }),
  };
  const bad = await api("/api/v1/accounts", { method: "POST", headers: auth, body: JSON.stringify({ platform: "mastodon", credentials: { instance: net } }) });
  ok(bad.status === 400 && /Access token is required/.test(bad.body.error.message), "A missing credential is refused with the reason");
  const listed = await api("/api/v1/accounts", { headers: auth });
  ok(listed.body.data.length === 7 && !JSON.stringify(listed.body).includes(SECRET_TOKEN) && !JSON.stringify(listed.body).includes(SECRET_SIGNING), "Account listings never contain credentials");

  // MCP over Streamable HTTP, with the official client
  const client = new Client({ name: "verify", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  ok(client.getServerVersion().name === "broadside", "An MCP client completes the handshake over HTTP");
  const tools = (await client.listTools()).tools.map((t) => t.name).sort();
  const expected = ["cancel_post", "check_post", "connect_account", "create_post", "delete_post", "disconnect_account", "get_analytics", "get_post", "get_post_analytics", "list_accounts", "list_groups", "list_media", "list_platforms", "list_posts", "list_signatures", "list_tags", "publish_post", "retry_target", "stop_series", "update_post", "upload_media"];
  ok(expected.every((name) => tools.includes(name)), `The server offers its ${expected.length} tools`, `got ${tools.join(", ")}`);
  const call = async (name, args = {}) => client.callTool({ name, arguments: args });

  const platforms = result(await call("list_platforms"));
  ok(platforms.length >= 19 && platforms.every((p) => p.limits.maxChars > 0 && p.setup.length > 0), `list_platforms describes ${platforms.length} networks`);
  const accounts = result(await call("list_accounts"));
  ok(accounts.length === 7 && accounts.every((a) => a.limits), "list_accounts returns the seven connected accounts with their limits");
  const link = result(await call("connect_account", { platform: "x" }));
  ok(link.connect_url === `${base}/app/accounts?connect=x` && !("credentials" in link), "connect_account hands back a link, not a credential prompt");

  const media = result(await call("upload_media", { url: `${net}/pixel.png`, alt: "One pixel" }));
  ok(/^med_/.test(media.id) && media.type === "image", "upload_media imports an image by URL");
  const served = await fetch(`${base}${media.url}`);
  ok(served.status === 200 && served.headers.get("content-type") === "image/png", "The stored media is served back");

  const everyone = Object.values(ids).map((account_id) => ({ account_id }));
  const tooLong = "x".repeat(501);
  const checked = result(await call("check_post", { content: tooLong, targets: everyone }));
  ok(checked.find((c) => c.platform === "mastodon").ok === false && checked.find((c) => c.platform === "sandbox").ok === true, "check_post reports which networks a text does not fit");
  const refused = await call("create_post", { content: tooLong, targets: everyone });
  ok(refused.isError === true && /Mastodon allows 500 characters; this is 501/.test(refused.content[0].text), "create_post refuses an over-long post and says which network and by how much");
  ok(received.mastodon.length === 0 && received.discord.length === 0, "Nothing was sent to any network by the refused post");

  const text = "Broadside verify: one post, every network. https://example.com #launch";
  const posted = result(await call("create_post", { content: text, targets: everyone, media_ids: [media.id], idempotency_key: "verify-1" }));
  ok(posted.status === "published", "create_post publishes to all seven accounts at once", JSON.stringify(posted.targets.map((t) => [t.platform, t.status, t.error])));
  ok(posted.targets.every((t) => t.status === "published"), "Every target reports its own published status");
  ok(received.mastodon[0]?.status === text && received.mastodon[0].media_ids[0] === "media-1", "Mastodon received the text and the uploaded media");
  ok(received.bluesky[0]?.text === text && received.bluesky[0].embed.images.length === 1 && received.bluesky[0].facets.length === 2, "Bluesky received the text, the image and link/hashtag facets");
  ok(received.discord[0]?.includes(text) && received.telegram[0]?.includes(text), "Discord and Telegram received the text");
  ok(received.slack[0]?.text === text && received.webhook[0]?.body.text === text && /^[0-9a-f]{64}$/.test(received.webhook[0].signature), "Slack and the signed webhook received the text");
  const url = (platform) => posted.targets.find((t) => t.platform === platform).url;
  ok(url("bluesky") === "https://bsky.app/profile/tester.test/post/3abc" && url("telegram") === "https://t.me/chan/7" && url("discord") === "https://discord.com/channels/g1/c1/m1", "Each target carries the public link to its post");
  const again = result(await call("create_post", { content: text, targets: everyone, media_ids: [media.id], idempotency_key: "verify-1" }));
  ok(again.id === posted.id && received.mastodon.length === 1, "Repeating a call with the same idempotency key does not post twice");

  // Per-account text, partial failure, retry
  const partial = result(await call("create_post", { content: "shared text [fail]", targets: [{ account_id: ids.sandbox }, { account_id: ids.mastodon, content_override: "only for mastodon" }] }));
  ok(partial.status === "partial" && received.mastodon.at(-1).status === "only for mastodon", "A per-account override is sent, and one failing network leaves the other published");
  const failedTarget = partial.targets.find((t) => t.status === "failed");
  ok(/asked to fail/.test(failedTarget.error), "The failed target says why it failed");

  // Scheduling: the server's own clock must fire
  const soon = new Date(Date.now() + 2500).toISOString();
  const scheduled = result(await call("create_post", { content: "scheduled by verify", targets: [{ account_id: ids.sandbox }, { account_id: ids.mastodon }], publish_at: soon }));
  ok(scheduled.status === "scheduled", "A post with a future time is scheduled, not sent");
  const fired = await until(async () => {
    const post = result(await call("get_post", { post_id: scheduled.id }));
    return post.status === "published" ? post : null;
  }, "the scheduler to publish the post", 20000);
  ok(fired.targets.every((t) => t.status === "published") && received.mastodon.at(-1).status === "scheduled by verify", "The scheduler publishes it when its time comes");

  const later = result(await call("create_post", { content: "to be changed", targets: [{ account_id: ids.sandbox }], publish_at: new Date(Date.now() + 3600000).toISOString() }));
  const edited = result(await call("update_post", { post_id: later.id, content: "changed" }));
  ok(edited.content === "changed" && edited.status === "scheduled", "A scheduled post can be edited");
  ok(result(await call("cancel_post", { post_id: later.id })).status === "cancelled", "A scheduled post can be cancelled");
  const draft = result(await call("create_post", { content: "a draft", targets: [{ account_id: ids.sandbox }], draft: true }));
  ok(draft.status === "draft" && result(await call("publish_post", { post_id: draft.id })).status === "published", "A draft is held until publish_post sends it");
  const noZone = await call("create_post", { content: "x", targets: [{ account_id: ids.sandbox }], publish_at: "2030-01-01T09:00:00" });
  ok(noZone.isError && /no time zone/.test(noZone.content[0].text), "A time without a zone is refused");
  ok(result(await call("list_posts", { status: "published" })).length >= 3, "list_posts filters by status");

  // Threads: parts after the main post, each a reply to the one before
  ok(platforms.find((p) => p.id === "mastodon").threads === true && platforms.find((p) => p.id === "discord").threads === false, "list_platforms says which networks can take a thread");
  const threaders = [ids.mastodon, ids.bluesky, ids.telegram, ids.sandbox].map((account_id) => ({ account_id }));
  const counts = () => [received.mastodon.length, received.bluesky.length, received.telegram.length, received.discord.length].join(",");
  const beforeThreads = counts();
  const threadCheck = result(await call("check_post", { content: "main", thread: ["second", "y".repeat(501)], targets: [{ account_id: ids.mastodon }, { account_id: ids.discord }] }));
  ok(
    threadCheck[0].ok === false && threadCheck[0].thread[1].length === 501 && threadCheck[0].thread[1].max_chars === 500 && /part 3 is 501/.test(threadCheck[0].problems.join(" ")) && threadCheck[1].problems[0] === "Discord cannot post a thread from a webhook.",
    "check_post measures every thread part and names a network that cannot thread",
  );
  const noThread = await call("create_post", { content: "main", thread: ["first comment"], targets: [...threaders, { account_id: ids.discord }] });
  ok(noThread.isError === true && /Discord cannot post a thread from a webhook\./.test(noThread.content[0].text), "create_post refuses a thread for Discord by name instead of dropping the parts");
  const longPart = await call("create_post", { content: "main", thread: ["fine", "y".repeat(501)], targets: threaders });
  ok(longPart.isError === true && /Mastodon allows 500 characters in a reply; part 3 is 501/.test(longPart.content[0].text), "create_post refuses a thread when one part does not fit one network");
  ok(counts() === beforeThreads, "Nothing was sent to any network by the refused threads");

  const threaded = result(await call("create_post", { content: "verify thread: one", thread: ["verify thread: two", "verify thread: three"], targets: threaders }));
  ok(threaded.status === "published" && threaded.thread.length === 2, "create_post publishes a three-part thread", JSON.stringify(threaded.targets.map((t) => [t.platform, t.status, t.error])));
  ok(
    threaded.targets.every((t) => t.parts.length === 3 && t.parts.every((p, i) => p.part === i + 1 && p.status === "published" && p.id)),
    "Every target reports each part's own status",
  );
  const [m1, m2, m3] = received.mastodon.slice(-3);
  ok(
    m1.status === "verify thread: one" && !m1.in_reply_to_id && m2.status === "verify thread: two" && m2.in_reply_to_id === m1.id && m3.status === "verify thread: three" && m3.in_reply_to_id === m2.id,
    "Mastodon received the parts in order, each in reply to the one before",
  );
  const [b1, b2, b3] = received.bluesky.slice(-3);
  ok(
    !b1.reply && b2.reply.root.uri === b1.uri && b2.reply.root.cid === b1.cid && b2.reply.parent.uri === b1.uri && b3.reply.root.uri === b1.uri && b3.reply.root.cid === b1.cid && b3.reply.parent.uri === b2.uri && b3.reply.parent.cid === b2.cid,
    "Bluesky received each reply with the root's and the parent's uri and cid",
  );
  const [t1, t2, t3] = received.telegramReplies.slice(-3);
  ok(t1.reply_to === null && t2.reply_to === t1.message_id && t3.reply_to === t2.message_id && t3.text === "verify thread: three", "Telegram received each part as a reply to the message before it");
  const partUrls = threaded.targets.find((t) => t.platform === "mastodon").parts.map((p) => p.url);
  ok(partUrls.every((u, i) => u === `${net}/@tester/${[m1, m2, m3][i].id}`) && threaded.targets.find((t) => t.platform === "telegram").parts[2].url === `https://t.me/chan/${t3.message_id}`, "Each part carries the public link to its own post");

  // A thread that stops part of the way keeps what went out, and a retry continues from there
  const mastodonBefore = received.mastodon.length;
  const broken = result(await call("create_post", { content: "resume: one", thread: ["resume: two", "resume: three [reject once]", "resume: four"], targets: [{ account_id: ids.mastodon }] }));
  const stuck = broken.targets[0];
  ok(
    broken.status === "partial" && stuck.status === "failed" && /^Part 3 of 4: Mastodon answered 422/.test(stuck.error) && stuck.parts.map((p) => p.status).join(",") === "published,published,failed,waiting",
    "A thread that fails at part 3 says so, and keeps parts 1 and 2 as published",
    JSON.stringify(stuck),
  );
  ok(received.mastodon.length === mastodonBefore + 2, "Only the first two parts reached the network");
  const resumed = result(await call("retry_target", { post_id: broken.id, target_id: stuck.id }));
  const resumedTexts = received.mastodon.slice(mastodonBefore).map((x) => x.status);
  ok(
    resumed.status === "published" && resumedTexts.join("|") === "resume: one|resume: two|resume: three [reject once]|resume: four",
    "Retrying resumes at part 3: every part reached the network exactly once",
    resumedTexts.join("|"),
  );
  const chain = received.mastodon.slice(mastodonBefore);
  ok(chain[2].in_reply_to_id === chain[1].id && chain[3].in_reply_to_id === chain[2].id, "The resumed parts answer the parts that were already out");

  // Repeating posts: the next occurrence is its own scheduled post, created once
  const firstAt = new Date(Date.now() + 2500);
  const repeating = result(await call("create_post", { content: "repeats daily, says verify", thread: ["with its first comment"], targets: [{ account_id: ids.sandbox }, { account_id: ids.mastodon }], publish_at: firstAt.toISOString(), repeat: { every: "day" } }));
  ok(repeating.status === "scheduled" && repeating.repeat.every === "day" && /^ser_/.test(repeating.series.id) && repeating.series.active === true, "A post with repeat is scheduled and starts a series");
  const seriesPosts = async () => result(await call("list_posts", { limit: 100 })).filter((p) => p.series?.id === repeating.series.id).sort((a, b) => a.publish_at.localeCompare(b.publish_at));
  await until(async () => (result(await call("get_post", { post_id: repeating.id })).status === "published" ? true : null), "the first occurrence to publish", 20000);
  await sleep(1500); // several more ticks pass; they must not create a second copy
  let occurrences = await seriesPosts();
  const dayLater = new Date(firstAt.getTime() + 86400000).toISOString();
  ok(
    occurrences.length === 2 && occurrences[1].status === "scheduled" && occurrences[1].publish_at === dayLater && occurrences[1].id !== repeating.id && occurrences[1].thread[0] === "with its first comment" && occurrences[1].targets.length === 2,
    "When the occurrence goes out, the next one is created once, as its own scheduled post a day later",
    JSON.stringify(occurrences.map((p) => [p.status, p.publish_at])),
  );
  ok(received.mastodon.filter((x) => x.status === "repeats daily, says verify").length === 1, "The occurrence itself was sent once");
  const skipped = result(await call("cancel_post", { post_id: occurrences[1].id }));
  occurrences = await seriesPosts();
  ok(
    skipped.status === "cancelled" && occurrences.length === 3 && occurrences[2].status === "scheduled" && occurrences[2].publish_at === new Date(firstAt.getTime() + 2 * 86400000).toISOString(),
    "Cancelling one occurrence cancels only it: the one after is lined up",
  );
  const ended = result(await call("stop_series", { post_id: repeating.id }));
  occurrences = await seriesPosts();
  ok(
    ended.series.active === false && ended.repeat === null && occurrences.map((p) => p.status).join(",") === "published,cancelled,cancelled",
    "stop_series ends the series: the waiting occurrence is cancelled and nothing new is created",
    occurrences.map((p) => p.status).join(","),
  );
  const monthEnd = result(await call("create_post", { content: "monthly", targets: [{ account_id: ids.sandbox }], publish_at: "2031-01-31T09:00:00Z", repeat: { every: "month", until: "2031-12-31" } }));
  await call("publish_post", { post_id: monthEnd.id });
  const february = result(await call("list_posts", { limit: 100 })).find((p) => p.series?.id === monthEnd.series.id && p.status === "scheduled");
  ok(monthEnd.repeat.until === "2031-12-31T23:59:59.999Z" && february.publish_at === "2031-02-28T09:00:00.000Z", "A monthly post set for 31 January comes round on the last day of February");
  await call("stop_series", { post_id: monthEnd.id });
  const needsTime = await call("create_post", { content: "x", targets: [{ account_id: ids.sandbox }], repeat: { every: "week" } });
  ok(needsTime.isError && /needs a first time/.test(needsTime.content[0].text), "A repeat with no first time is refused");
  await client.close();

  // The same database through the local stdio server
  const diskImage = path.join(dataDir, "from-disk.png");
  writeFileSync(diskImage, PNG);
  const local = new Client({ name: "verify-stdio", version: "1.0.0" });
  await local.connect(new StdioClientTransport({ command: "npx", args: ["tsx", "bin/broadside-mcp.ts"], cwd: root, env: { ...env, BROADSIDE_PUBLIC_URL: base } }));
  const localAccounts = result(await local.callTool({ name: "list_accounts", arguments: {} }));
  ok(localAccounts.length === 7, "The stdio MCP server sees the same accounts");
  const fromDisk = result(await local.callTool({ name: "upload_media", arguments: { path: diskImage } }));
  const localPost = result(await local.callTool({ name: "create_post", arguments: { content: "from stdio", targets: [{ account_id: ids.sandbox }], media_ids: [fromDisk.id] } }));
  ok(localPost.status === "published" && localPost.media[0].id === fromDisk.id, "The stdio server uploads a file from disk and publishes with it");
  const secret = path.join(dataDir, "not-a-picture.png");
  writeFileSync(secret, "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n");
  const dressed = await local.callTool({ name: "upload_media", arguments: { path: secret, content_type: "image/png" } });
  const wrongKind = await local.callTool({ name: "upload_media", arguments: { path: "/etc/hosts", content_type: "image/png" } });
  ok(dressed.isError && /is not a JPEG/.test(dressed.content[0].text) && wrongKind.isError && /can be uploaded from disk/.test(wrongKind.content[0].text), "The stdio server will not read a non-media file, whatever type the caller claims");
  await local.close();
  const careful = new Client({ name: "verify-drafts-only", version: "1.0.0" });
  await careful.connect(new StdioClientTransport({ command: "npx", args: ["tsx", "bin/broadside-mcp.ts"], cwd: root, env: { ...env, BROADSIDE_PUBLIC_URL: base, BROADSIDE_MCP_DRAFTS_ONLY: "1" } }));
  const held = result(await careful.callTool({ name: "create_post", arguments: { content: "an agent's idea", targets: [{ account_id: ids.sandbox }] } }));
  const pushed = result(await careful.callTool({ name: "update_post", arguments: { post_id: held.id, draft: false } }));
  const timed = result(await careful.callTool({ name: "update_post", arguments: { post_id: held.id, draft: false, publish_at: new Date(Date.now() + 60000).toISOString() } }));
  const forced = await careful.callTool({ name: "publish_post", arguments: { post_id: held.id } });
  ok(held.status === "draft" && pushed.status === "draft" && timed.status === "draft" && forced.isError, "In drafts-only mode an agent cannot publish or schedule by any tool");
  const preparedAt = new Date(Date.now() + 1200).toISOString();
  const prepared = result(await careful.callTool({ name: "create_post", arguments: { content: "an agent's weekly idea", thread: ["and its first comment"], targets: [{ account_id: ids.sandbox }], publish_at: preparedAt, repeat: { every: "day" } } }));
  const reworked = result(await careful.callTool({ name: "update_post", arguments: { post_id: prepared.id, draft: false, thread: ["a reworded comment"], repeat: { every: "week" } } }));
  await sleep(2500); // its time passes while it is still a draft
  const afterTime = result(await careful.callTool({ name: "get_post", arguments: { post_id: prepared.id } }));
  const dropped = result(await careful.callTool({ name: "cancel_post", arguments: { post_id: prepared.id } }));
  const agentSeries = result(await careful.callTool({ name: "list_posts", arguments: { limit: 100 } })).filter((p) => p.series?.id === prepared.series.id);
  ok(
    prepared.status === "draft" && prepared.thread.length === 1 && prepared.repeat.every === "day" && reworked.status === "draft" && reworked.repeat.every === "week" && afterTime.status === "draft" && afterTime.targets[0].parts.every((p) => p.status === "draft") && dropped.status === "cancelled" && agentSeries.length === 1,
    "In drafts-only mode a thread and a repeat stay a draft: nothing goes out at its time, and no occurrence is created",
    JSON.stringify([prepared.status, reworked.status, afterTime.status, dropped.status, agentSeries.length]),
  );
  await careful.close();

  // REST parity and the web pages
  const rest = await api("/api/v1/posts", { method: "POST", headers: { ...auth, "idempotency-key": "rest-1" }, body: JSON.stringify({ content: "from REST", targets: [{ account_id: ids.sandbox }] }) });
  ok(rest.status === 200 && rest.body.data.status === "published" && rest.body.data.origin === "api", "The REST API publishes too");
  const restThread = await api("/api/v1/posts", { method: "POST", headers: auth, body: JSON.stringify({ content: "REST thread", thread: ["REST first comment"], targets: [{ account_id: ids.mastodon }, { account_id: ids.sandbox }] }) });
  const restRead = await api(`/api/v1/posts/${restThread.body.data.id}`, { headers: auth });
  const restParts = restRead.body.data.targets.find((t) => t.platform === "mastodon").parts;
  ok(
    restThread.status === 200 && restRead.body.data.thread[0] === "REST first comment" && restParts.length === 2 && restParts.every((p) => p.status === "published" && p.url.startsWith(`${net}/@tester/`)) && received.mastodon.at(-1).in_reply_to_id === received.mastodon.at(-2).id,
    "REST: a first comment is a thread of one extra part, and GET returns each part's status and url",
  );
  const restBad = await api("/api/v1/posts", { method: "POST", headers: auth, body: JSON.stringify({ content: "REST thread", thread: ["comment"], targets: [{ account_id: ids.slack }] }) });
  ok(restBad.status === 400 && restBad.body.error.details[0].problems[0] === "Slack cannot post a thread from an incoming webhook.", "REST: a thread for a network that cannot thread is refused with the reason");
  const restCheck = await api("/api/v1/check", { method: "POST", headers: auth, body: JSON.stringify({ content: "main", thread: ["two"], targets: [{ account_id: ids.mastodon }] }) });
  ok(restCheck.body.data[0].ok === true && restCheck.body.data[0].thread[0].part === 2 && restCheck.body.data[0].thread[0].length === 3, "REST: the dry run measures thread parts");
  const restRepeat = await api("/api/v1/posts", { method: "POST", headers: auth, body: JSON.stringify({ content: "REST weekly", thread: ["REST weekly comment"], targets: [{ account_id: ids.sandbox }], publish_at: "2031-03-03T09:00:00+01:00", repeat: { every: "week", until: "2031-06-30", timezone: "Europe/Paris" } }) });
  const restPatched = await api(`/api/v1/posts/${restRepeat.body.data.id}`, { method: "PATCH", headers: auth, body: JSON.stringify({ thread: ["REST weekly comment", "and a second"], repeat: { every: "month" } }) });
  ok(
    restRepeat.body.data.status === "scheduled" && restRepeat.body.data.repeat.every === "week" && restRepeat.body.data.repeat.timezone === "Europe/Paris" && restRepeat.body.data.series.active === true && restPatched.body.data.thread.length === 2 && restPatched.body.data.repeat.every === "month" && restPatched.body.data.series.id === restRepeat.body.data.series.id,
    "REST: POST and PATCH accept thread and repeat, and GET returns them with the series",
    JSON.stringify(restPatched.body),
  );
  const seriesPage = await fetch(`${base}/app/posts?post=${restRepeat.body.data.id}`).then((r) => r.text());
  ok(seriesPage.includes("Stop repeating") && seriesPage.includes("Repeats every month") && seriesPage.includes("and a second") && seriesPage.includes("Thread of 3"), "The posts page shows a thread's parts, the series and Stop repeating");
  const threadPage = await fetch(`${base}/app/posts?post=${broken.id}`).then((r) => r.text());
  ok(threadPage.includes("resume: three [reject once]") && threadPage.includes("Part 4"), "The posts page lists each part of a thread under its target");
  const restEdit = await fetch(`${base}/app?edit=${restRepeat.body.data.id}`).then((r) => r.text());
  ok(restEdit.includes("Edit post") && restEdit.includes("and a second") && restEdit.includes("Add to thread") && restEdit.includes("Part 3"), "The composer opens a scheduled thread for editing, with its parts and Add to thread");
  const restStopped = await api(`/api/v1/posts/${restRepeat.body.data.id}/cancel`, { method: "POST", headers: auth, body: JSON.stringify({ series: true }) });
  const restAgain = await api(`/api/v1/posts/${restRepeat.body.data.id}/cancel`, { method: "POST", headers: auth, body: JSON.stringify({ series: true }) });
  ok(restStopped.body.data.status === "cancelled" && restStopped.body.data.series.active === false && restAgain.status === 400 && /already stopped/.test(restAgain.body.error.message), "REST: cancel with series true stops the whole series");
  const pages = [
    ["/", "Broadside"],
    ["/app", "Compose"],
    ["/app/posts", "Posts"],
    ["/app/calendar", "Calendar"],
    ["/app/analytics", "Analytics"],
    ["/app/media", "Media library"],
    ["/app/accounts", "Accounts"],
    ["/app/connect", "/mcp"],
    ["/login", "Sign in"],
  ];
  for (const [pathname, marker] of pages) {
    const response = await fetch(`${base}${pathname}`);
    const html = await response.text();
    ok(response.status === 200 && html.includes(marker), `Page ${pathname} renders`, `status ${response.status}`);
  }
  // Organising: the media library, tags, account groups and signatures
  const page = (pathname) => fetch(`${base}${pathname}`).then((r) => r.text());
  const via = async (method, pathname, payload) => api(`/api/v1${pathname}`, { method, headers: auth, body: payload === undefined ? undefined : JSON.stringify(payload) });
  const inAnHour = () => new Date(Date.now() + 3600000).toISOString();

  // Media library
  const uploadFile = async (name) => {
    const form = new FormData();
    form.set("file", new Blob([PNG], { type: "image/png" }), name);
    return (await fetch(`${base}/api/v1/media`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: form })).json();
  };
  const older = (await uploadFile("verify-older.png")).data;
  const newer = (await uploadFile("verify-newer.png")).data;
  const libraryStart = await via("GET", "/media");
  ok(
    libraryStart.status === 200 && libraryStart.body.data[0].id === newer.id && libraryStart.body.data[1].id === older.id && libraryStart.body.data[0].used_by.length === 0 && libraryStart.body.data.some((m) => m.id === media.id && m.source_url === `${net}/pixel.png` && m.used_by.length > 0),
    "REST: the media library lists uploads and imports newest first, each with the posts that use it",
  );
  const mediaDraft = await via("POST", "/posts", { content: "verify: a draft with a picture", targets: [{ account_id: ids.sandbox }], media_ids: [older.id], draft: true });
  const mediaScheduled = await via("POST", "/posts", { content: "verify: scheduled with a picture", targets: [{ account_id: ids.sandbox }], media_ids: [older.id], publish_at: inAnHour() });
  const keptOne = await via("DELETE", `/media/${older.id}`);
  ok(
    keptOne.status === 400 && /^2 posts that have not gone out yet still use this file\./.test(keptOne.body.error.message) && keptOne.body.error.details.post_ids.length === 2 && (await fetch(`${base}${older.url}`)).status === 200,
    "REST: deleting media that a draft and a scheduled post still use is refused, naming how many posts, and the file stays",
    JSON.stringify(keptOne.body),
  );
  const described = await via("PATCH", `/media/${older.id}`, { alt: "A single verify pixel" });
  const libraryPage = await page("/app/media");
  ok(
    described.body.data.alt === "A single verify pixel" && libraryPage.includes("verify-older.png") && libraryPage.includes("verify-newer.png") && libraryPage.includes("A single verify pixel") && libraryPage.includes("Used in 2 posts") && libraryPage.includes("PNG image") && libraryPage.includes("Not used in a post yet.") && libraryPage.includes("Upload") && libraryPage.includes("Import"),
    "The media page shows each file with its type, size, description and where it is used, with upload and import",
  );
  ok(libraryPage.indexOf("verify-newer.png") < libraryPage.indexOf("verify-older.png"), "The media page lists the newest file first");
  await via("POST", `/posts/${mediaDraft.body.data.id}/publish`);
  const stillOne = await via("DELETE", `/media/${older.id}`);
  await via("PATCH", `/posts/${mediaScheduled.body.data.id}`, { media_ids: [] });
  const gone = await via("DELETE", `/media/${older.id}`);
  const afterDelete = await via("GET", `/posts/${mediaDraft.body.data.id}`);
  ok(
    /^1 post that has not gone out yet still uses this file\./.test(stillOne.body.error?.message ?? "") && gone.status === 200 && (await fetch(`${base}${older.url}`)).status === 404 && afterDelete.body.data.status === "published" && afterDelete.body.data.media.length === 0,
    "REST: once only a published post uses the file it can be deleted, and the post keeps its record",
    JSON.stringify([stillOne.body, gone.body]),
  );
  ok((await via("DELETE", `/media/${newer.id}`)).status === 200, "REST: media no post uses is deleted");
  const composePage = await page("/app");
  ok(composePage.includes("Choose from library") && composePage.includes("Add media"), "The composer offers Choose from library beside Add media");

  // Tags
  const tagged = await via("POST", "/posts", { content: "verify: a tagged post", targets: [{ account_id: ids.sandbox }], tags: ["Verify Launch", "verify weekly"], publish_at: inAnHour() });
  const taggedAgain = await via("POST", "/posts", { content: "verify: tagged again", targets: [{ account_id: ids.sandbox }], tags: ["verify launch"], draft: true });
  const tagList = await via("GET", "/tags");
  const launchTag = tagList.body.data.find((t) => t.name === "Verify Launch");
  ok(
    tagged.body.data.tags.join("|") === "Verify Launch|verify weekly" && taggedAgain.body.data.tags.join("|") === "Verify Launch" && launchTag.posts === 2 && tagList.body.data.find((t) => t.name === "verify weekly").posts === 1,
    "REST: posts accept and return tags, created on the fly and reused whatever their case",
    JSON.stringify(tagList.body),
  );
  const byTag = await api(`/api/v1/posts?tag=${encodeURIComponent("VERIFY LAUNCH")}&limit=100`, { headers: auth });
  const byOther = await api(`/api/v1/posts?tag=${encodeURIComponent("verify weekly")}&limit=100`, { headers: auth });
  ok(byTag.body.data.map((p) => p.id).sort().join() === [tagged.body.data.id, taggedAgain.body.data.id].sort().join() && byOther.body.data.length === 1 && byOther.body.data[0].id === tagged.body.data.id, "REST: GET /posts filters by tag");
  const editTagged = await page(`/app?edit=${tagged.body.data.id}`);
  ok(editTagged.includes("Edit post") && editTagged.includes("Remove the tag Verify Launch") && editTagged.includes("Remove the tag verify weekly"), "Opening a post for editing loads its tags into the composer");
  const retagged = await via("PATCH", `/posts/${taggedAgain.body.data.id}`, { tags: ["Verify Launch", "verify extra"] });
  const untouched = await via("PATCH", `/posts/${taggedAgain.body.data.id}`, { content: "verify: tagged again, reworded" });
  ok(retagged.body.data.tags.join("|") === "verify extra|Verify Launch" && untouched.body.data.tags.join("|") === "verify extra|Verify Launch", "REST: PATCH replaces a post's tags, and leaves them alone when it does not mention them");
  const renamed = await via("PATCH", `/tags/${launchTag.id}`, { name: "Verify Release" });
  const clash = await via("PATCH", `/tags/${launchTag.id}`, { name: "VERIFY WEEKLY" });
  const afterRename = await via("GET", `/posts/${tagged.body.data.id}`);
  ok(
    renamed.body.data.name === "Verify Release" && renamed.body.data.posts === 2 && afterRename.body.data.tags.join("|") === "Verify Release|verify weekly" && clash.status === 400 && /already exists/.test(clash.body.error.message),
    "REST: renaming a tag renames it on every post, and a name another tag has is refused",
  );
  const taggedPosts = await page("/app/posts");
  ok(taggedPosts.includes("Verify Release") && taggedPosts.includes("Filter by tag") && taggedPosts.includes("Manage tags") && !taggedPosts.includes("Verify Launch"), "The posts page shows tags on posts, the tag filter and Manage tags");
  const postsBeforeTagDelete = (await api("/api/v1/posts?limit=100", { headers: auth })).body.data.length;
  const tagDeleted = await via("DELETE", `/tags/${launchTag.id}`);
  const afterTagDelete = await via("GET", `/posts/${tagged.body.data.id}`);
  ok(
    tagDeleted.status === 200 && afterTagDelete.body.data.tags.join("|") === "verify weekly" && afterTagDelete.body.data.content === "verify: a tagged post" && (await api("/api/v1/posts?limit=100", { headers: auth })).body.data.length === postsBeforeTagDelete && !(await via("GET", "/tags")).body.data.some((t) => t.id === launchTag.id),
    "REST: deleting a tag takes it off its posts and deletes no post",
  );
  const badTag = await via("POST", "/posts", { content: "x", targets: [{ account_id: ids.sandbox }], tags: ["one, two"], draft: true });
  ok(badTag.status === 400 && /cannot contain a comma/.test(badTag.body.error.message), "REST: a tag that is not a short single-line name is refused");

  // Account groups
  const leaver = (await via("POST", "/accounts", { platform: "sandbox", credentials: { name: "Verify Leaver" } })).body.data.id;
  const group = await via("POST", "/groups", { name: "Verify launch day", account_ids: [ids.sandbox, ids.mastodon, leaver] });
  ok(
    group.status === 200 && /^grp_/.test(group.body.data.id) && group.body.data.account_ids.join() === [ids.sandbox, ids.mastodon, leaver].join() && group.body.data.accounts[1].platform === "mastodon" && !JSON.stringify(group.body).includes(SECRET_TOKEN) && !JSON.stringify(group.body).includes("credentials"),
    "REST: a group is created with its accounts, and holds no credentials",
    JSON.stringify(group.body),
  );
  const groupPost = await via("POST", "/posts", { content: "verify: to the whole group", group_id: group.body.data.id });
  ok(
    groupPost.body.data.status === "published" && groupPost.body.data.targets.map((t) => t.account_id).join() === [ids.sandbox, ids.mastodon, leaver].join() && received.mastodon.at(-1).status === "verify: to the whole group",
    "REST: a post with group_id goes to exactly the group's accounts",
    JSON.stringify(groupPost.body),
  );
  const groupAndTargets = await via("POST", "/posts", { content: "x", targets: [{ account_id: ids.sandbox }], group_id: group.body.data.id });
  const noSuchGroup = await via("POST", "/posts", { content: "x", group_id: "grp_nothing" });
  ok(groupAndTargets.status === 400 && /not both/.test(groupAndTargets.body.error.message) && noSuchGroup.status === 400 && /No group with id grp_nothing/.test(noSuchGroup.body.error.message), "REST: targets together with group_id, or an unknown group, are refused");
  const groupsPage = await page("/app/accounts");
  const groupCompose = await page("/app");
  ok(groupsPage.includes("Verify launch day") && groupsPage.includes("New group") && groupsPage.includes("3 accounts") && groupCompose.includes("Verify launch day"), "The Accounts page lists the group with its accounts, and the composer offers it");
  await via("DELETE", `/accounts/${leaver}`);
  const smaller = await via("GET", `/groups/${group.body.data.id}`);
  const smallerPost = await via("POST", "/posts", { content: "verify: after one left", group_id: group.body.data.id, draft: true });
  ok(
    smaller.body.data.account_ids.join() === [ids.sandbox, ids.mastodon].join() && smallerPost.body.data.targets.length === 2 && (await via("GET", "/accounts")).body.data.length === 7,
    "A group whose account was disconnected has one fewer member, and still names the rest",
    JSON.stringify(smaller.body),
  );
  const regrouped = await via("PATCH", `/groups/${group.body.data.id}`, { name: "Verify dev channels", account_ids: [ids.sandbox, ids.discord] });
  const dupGroup = await via("POST", "/groups", { name: "verify DEV channels", account_ids: [ids.sandbox] });
  ok(regrouped.body.data.name === "Verify dev channels" && regrouped.body.data.accounts.map((a) => a.platform).join() === "sandbox,discord" && dupGroup.status === 400, "REST: a group can be renamed and its members replaced, and two groups cannot share a name");

  // Signatures
  const signature = await via("POST", "/signatures", { name: "Verify sign-off", content: "sent by the verify script #verify", default_for: [ids.mastodon] });
  const withDefault = (await via("GET", "/accounts")).body.data.find((a) => a.id === ids.mastodon);
  ok(
    signature.status === 200 && /^sig_/.test(signature.body.data.id) && signature.body.data.default_for.join() === ids.mastodon && withDefault.signature_id === signature.body.data.id && !JSON.stringify((await via("GET", "/signatures")).body).includes(SECRET_TOKEN),
    "REST: a signature is saved, and an account can offer it by default",
    JSON.stringify(signature.body),
  );
  const unsigned = await via("POST", "/posts", { content: "verify: no signature was asked for", targets: [{ account_id: ids.mastodon }] });
  ok(unsigned.body.data.status === "published" && received.mastodon.at(-1).status === "verify: no signature was asked for", "An account's default signature is never added by itself: the network received the text exactly as written");
  const nearLimit = "s".repeat(480);
  const signedText = `${nearLimit}\n\n${signature.body.data.content}`;
  const signedCheck = await via("POST", "/check", { content: signedText, targets: [{ account_id: ids.mastodon }] });
  const signedPost = await via("POST", "/posts", { content: signedText, targets: [{ account_id: ids.mastodon }] });
  ok(
    signedCheck.body.data[0].ok === false && signedCheck.body.data[0].length === 515 && signedPost.status === 400 && /Mastodon allows 500 characters; this is 515/.test(signedPost.body.error.message) && received.mastodon.at(-1).status === "verify: no signature was asked for",
    "A signature added to a post counts against the network's limit like any other text",
    JSON.stringify(signedCheck.body),
  );
  const signedCompose = await page("/app");
  const signaturesPage = await page("/app/accounts");
  ok(
    signedCompose.includes("Add signature") && signedCompose.includes("This account offers the signature Verify sign-off.") && signedCompose.includes("Add it to this account") && signaturesPage.includes("Verify sign-off") && signaturesPage.includes("sent by the verify script #verify") && signaturesPage.includes("New signature") && signaturesPage.includes("Offered by default for @tester@"),
    "The composer offers Add signature and the account's default, and the Accounts page lists signatures",
  );
  const resigned = await via("PATCH", `/signatures/${signature.body.data.id}`, { content: "sent by verify" });
  const cleared = await via("PATCH", `/accounts/${ids.mastodon}`, { signature_id: null });
  const reset = await via("PATCH", `/accounts/${ids.mastodon}`, { signature_id: signature.body.data.id });
  const unsaved = await via("DELETE", `/signatures/${signature.body.data.id}`);
  const afterUnsave = (await via("GET", "/accounts")).body.data.find((a) => a.id === ids.mastodon);
  ok(
    resigned.body.data.content === "sent by verify" && cleared.body.data.signature_id === null && reset.body.data.signature_id === signature.body.data.id && !("credentials" in reset.body.data) && unsaved.status === 200 && afterUnsave.signature_id === null,
    "REST: a signature can be edited, set or cleared as an account's default, and deleting it clears the default",
  );
  ok(
    (await api("/api/v1/tags")).status === 401 && (await api("/api/v1/groups")).status === 401 && (await api("/api/v1/signatures")).status === 401 && (await api(`/api/v1/groups/${group.body.data.id}`, { method: "DELETE" })).status === 401,
    "Tags, groups and signatures refuse a request with no key",
  );

  // The same four through MCP
  const organiser = new Client({ name: "verify-organise", version: "1.0.0" });
  await organiser.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  const ask = async (name, args = {}) => organiser.callTool({ name, arguments: args });
  const kept = result(await ask("upload_media", { url: `${net}/pixel.png`, alt: "Kept for the agent" }));
  const agentSignature = (await via("POST", "/signatures", { name: "Verify agent sign-off", content: "#agents" })).body.data;
  const mcpGroups = result(await ask("list_groups"));
  const mcpGroup = mcpGroups.find((g) => g.name === "Verify dev channels");
  const mcpSignatures = result(await ask("list_signatures"));
  ok(
    mcpGroup.account_ids.join() === [ids.sandbox, ids.discord].join() && mcpSignatures.find((s) => s.id === agentSignature.id).content === "#agents" && result(await ask("list_tags")).some((t) => t.name === "verify weekly") && !JSON.stringify([mcpGroups, mcpSignatures]).includes(SECRET_TOKEN),
    "MCP: list_groups, list_signatures and list_tags return what the app holds, without credentials",
  );
  const discordBefore = received.discord.length;
  const mcpPost = result(await ask("create_post", { content: "verify: an agent posts to a group\n\n#agents", group_id: mcpGroup.id, tags: ["verify agent", "verify weekly"], media_ids: [kept.id] }));
  ok(
    mcpPost.status === "published" && mcpPost.targets.map((t) => t.platform).join() === "sandbox,discord" && mcpPost.tags.join("|") === "verify agent|verify weekly" && received.discord.length === discordBefore + 1 && received.discord.at(-1).includes("#agents"),
    "MCP: create_post with group_id publishes to the group's accounts and carries its tags",
    JSON.stringify(mcpPost.targets?.map((t) => [t.platform, t.status, t.error]) ?? mcpPost),
  );
  const mcpByTag = result(await ask("list_posts", { tag: "Verify Agent" }));
  ok(mcpByTag.length === 1 && mcpByTag[0].id === mcpPost.id, "MCP: list_posts filters by tag");
  const mcpDraft = result(await ask("create_post", { content: "verify: an agent's draft", targets: [{ account_id: ids.sandbox }], draft: true }));
  const mcpEdited = result(await ask("update_post", { post_id: mcpDraft.id, group_id: mcpGroup.id, tags: ["verify agent"] }));
  const mcpChecked = result(await ask("check_post", { content: "fits", group_id: mcpGroup.id }));
  const mcpBoth = await ask("create_post", { content: "x", targets: [{ account_id: ids.sandbox }], group_id: mcpGroup.id });
  ok(
    mcpEdited.tags.join() === "verify agent" && mcpEdited.targets.map((t) => t.platform).join() === "sandbox,discord" && mcpChecked.map((c) => c.platform).join() === "sandbox,discord" && mcpBoth.isError === true && /not both/.test(mcpBoth.content[0].text),
    "MCP: update_post takes tags and group_id, check_post takes group_id, and targets with group_id are refused",
  );
  const mcpLibrary = result(await ask("list_media"));
  ok(mcpLibrary.find((m) => m.id === kept.id).used_by.some((u) => u.post_id === mcpPost.id && u.waiting === false), "MCP: list_media shows where a file is used");
  await organiser.close();
  const cautious = new Client({ name: "verify-organise-drafts-only", version: "1.0.0" });
  await cautious.connect(new StdioClientTransport({ command: "npx", args: ["tsx", "bin/broadside-mcp.ts"], cwd: root, env: { ...env, BROADSIDE_PUBLIC_URL: base, BROADSIDE_MCP_DRAFTS_ONLY: "1" } }));
  const discordHeld = received.discord.length;
  const heldGroup = result(await cautious.callTool({ name: "create_post", arguments: { content: "verify: an agent's idea for the group", group_id: mcpGroup.id, tags: ["verify held"] } }));
  const heldPushed = result(await cautious.callTool({ name: "update_post", arguments: { post_id: heldGroup.id, group_id: mcpGroup.id, tags: ["verify held", "verify pushed"], draft: false } }));
  const heldForced = await cautious.callTool({ name: "publish_post", arguments: { post_id: heldGroup.id } });
  ok(
    heldGroup.status === "draft" && heldGroup.targets.length === 2 && heldGroup.tags.join() === "verify held" && heldPushed.status === "draft" && heldPushed.tags.length === 2 && heldForced.isError === true && received.discord.length === discordHeld,
    "In drafts-only mode a post made with group_id and tags stays a draft, and nothing reaches a network",
    JSON.stringify([heldGroup.status, heldPushed.status, heldForced.isError]),
  );
  await cautious.close();
  await via("DELETE", `/groups/${group.body.data.id}`);
  ok((await via("GET", "/groups")).body.data.length === 0 && (await via("GET", "/accounts")).body.data.length === 7, "REST: deleting a group leaves its accounts connected");

  // Signing in with a network
  const begun = await api("/api/v1/oauth/tiktok/start", { method: "POST", headers: auth, body: JSON.stringify({ credentials: { client_key: "ck", client_secret: "verify-client-secret" } }) });
  const authorize = new URL(begun.body.data.url);
  ok(authorize.host === "www.tiktok.com" && authorize.searchParams.get("redirect_uri") === `${base}/oauth/tiktok/callback` && /^[0-9a-f]{64}$/.test(authorize.searchParams.get("code_challenge")) && !begun.body.data.url.includes("verify-client-secret"), "Continue with TikTok sends the browser to TikTok with the local redirect address and no secret in the URL");
  const forged = await fetch(`${base}/oauth/tiktok/callback?code=x&state=made-up`, { redirect: "manual" });
  ok(forged.status === 303 && (new URL(forged.headers.get("location")).searchParams.get("error") ?? "").includes("not started here"), "A callback with a state this Broadside never issued connects nothing");
  const tiktokSpec = platforms.find((p) => p.id === "tiktok");
  ok(tiktokSpec.oauth?.callback_path === "/oauth/tiktok/callback" && !tiktokSpec.fields.some((f) => f.key === "refresh_token"), "The TikTok connect form asks for the app's key and secret only");

  // Signing in with the other networks, against stand-ins for each: the browser's two hops are played by this script.
  const viaHost = (pathname, host) =>
    new Promise((resolve, reject) => {
      const req = httpRequest({ host: "127.0.0.1", port, path: pathname, method: "GET", headers: { host } }, (res) => {
        res.resume();
        res.on("end", () => resolve({ status: res.statusCode, location: res.headers.location ?? "" }));
      });
      req.on("error", reject);
      req.end();
    });
  const signIn = async (platform, code = "good-code") => {
    const started = await api(`/api/v1/oauth/${platform}/start`, { method: "POST", headers: auth, body: JSON.stringify({ credentials: APP[platform] }) });
    const address = new URL(started.body.data.url);
    const redirect = new URL(address.searchParams.get("redirect_uri"));
    // The network sends the browser to the redirect address, under whichever name for this machine that address uses.
    const landed = await viaHost(`${redirect.pathname}?code=${code}&state=${encodeURIComponent(address.searchParams.get("state"))}`, redirect.host);
    return { address, redirect, landed, back: landed.location ? new URL(landed.location) : null, url: started.body.data.url };
  };
  const signInSpecs = Object.fromEntries(platforms.map((p) => [p.id, p.oauth]));
  const seven = ["x", "linkedin", "threads", "facebook", "instagram", "youtube", "pinterest"];
  ok(
    seven.every((id) => signInSpecs[id]?.callback_path === `/oauth/${id}/callback` && signInSpecs[id].scopes.length > 0 && signInSpecs[id].paste.length > 0),
    "list_platforms gives each of the seven its redirect path, the scopes it asks for and the fields to paste instead",
  );
  for (const id of seven) {
    const forgedCallback = await fetch(`${base}/oauth/${id}/callback?code=x&state=made-up`, { redirect: "manual" });
    ok(forgedCallback.status === 303 && (new URL(forgedCallback.headers.get("location")).searchParams.get("error") ?? "").includes("not started here"), `A ${id} callback with a state this Broadside never issued connects nothing`);
  }
  const foreignStart = await fetch(`${base}/api/v1/oauth/x/start`, { method: "POST", headers: { "content-type": "application/json", "sec-fetch-site": "cross-site" }, body: JSON.stringify({ credentials: APP.x }) });
  const noKeyChoice = await fetch(`${base}/api/v1/oauth/choices/anything`, { method: "POST", headers: { "content-type": "application/json", "sec-fetch-site": "cross-site" }, body: JSON.stringify({ choices: ["111"] }) });
  ok(foreignStart.status === 401 && noKeyChoice.status === 401, "Another site cannot start a sign-in or make a choice: both need a key or the app's own session");
  const accountsBefore = (await api("/api/v1/accounts", { headers: auth })).body.data.length;

  // X: PKCE, a Basic header, and refresh tokens that work once
  const xIn = await signIn("x");
  ok(
    xIn.address.origin + xIn.address.pathname === "https://x.com/i/oauth2/authorize" && xIn.redirect.href === `http://127.0.0.1:${port}/oauth/x/callback` && /^[\w-]{43}$/.test(xIn.address.searchParams.get("code_challenge")) && xIn.address.searchParams.get("scope") === "tweet.read tweet.write users.read media.write offline.access" && !xIn.url.includes(APP.x.client_secret),
    "Continue with X sends the browser to X with PKCE, the posting scopes and a 127.0.0.1 redirect address, and no secret in the URL",
  );
  ok(xIn.landed.status === 303 && xIn.back.pathname === "/app/accounts" && xIn.back.searchParams.get("connected") === "@verify_x", "X: the callback exchanges the code and lands back on Accounts, connected", xIn.landed.location);
  const xExchange = signIns.tokenRequests.find((r) => r.name === "x" && r.grant_type === "authorization_code");
  ok(xExchange.code === "good-code" && xExchange.redirect_uri === xIn.redirect.href && /^[\w.~-]{64}$/.test(xExchange.code_verifier) && !("client_secret" in xExchange), "X: the code is exchanged with its verifier, and the secret travels in the Basic header only");
  const replayed = await viaHost(`${xIn.redirect.pathname}?code=good-code&state=${encodeURIComponent(xIn.address.searchParams.get("state"))}`, xIn.redirect.host);
  ok((new URL(replayed.location).searchParams.get("error") ?? "").includes("already used"), "X: the same state does not work a second time");
  const xAccount = (await api("/api/v1/accounts", { headers: auth })).body.data.find((a) => a.platform === "x");
  const tweetOne = await api("/api/v1/posts", { method: "POST", headers: auth, body: JSON.stringify({ content: "verify: signed in to X", thread: ["verify: and a reply"], targets: [{ account_id: xAccount.id }] }) });
  const tweetTwo = await api("/api/v1/posts", { method: "POST", headers: auth, body: JSON.stringify({ content: "verify: X again", targets: [{ account_id: xAccount.id }] }) });
  ok(
    tweetOne.body.data.status === "published" && tweetTwo.body.data.status === "published" && signIns.tweets.length === 3 && signIns.tweets[1].reply.in_reply_to_tweet_id === "9001",
    "X: posts and a reply go out with tokens renewed before each use",
    JSON.stringify([tweetOne.body.data?.targets, tweetTwo.body.data?.targets]),
  );
  ok(rotating.x.spent.length >= 3 && new Set(rotating.x.spent).size === rotating.x.spent.length, `X: each refresh token was spent once (${rotating.x.spent.length} renewals), so the rotated one was stored every time`);
  const xRefused = await signIn("x", "stale-code");
  ok((xRefused.back.searchParams.get("error") ?? "").includes("Value passed for the authorization code was invalid"), "X: a refused code comes back with X's own reason", xRefused.landed.location);

  // LinkedIn and YouTube: no choice to make
  const liIn = await signIn("linkedin");
  ok(liIn.address.host === "www.linkedin.com" && liIn.address.searchParams.get("scope") === "openid profile w_member_social" && liIn.back.searchParams.get("connected") === "Verify Member" && !liIn.url.includes(APP.linkedin.client_secret), "Continue with LinkedIn connects the member who approved", liIn.landed.location);
  const ytIn = await signIn("youtube");
  ok(ytIn.address.host === "accounts.google.com" && ytIn.address.searchParams.get("access_type") === "offline" && ytIn.back.searchParams.get("connected") === "Verify Channel" && !ytIn.url.includes(APP.youtube.client_secret), "Continue with YouTube asks Google for offline access and connects the signed-in account's channel", ytIn.landed.location);

  // Facebook Pages: sign in, then choose
  const fbIn = await signIn("facebook");
  const fbChoice = fbIn.back.searchParams.get("choose");
  ok(
    fbIn.address.host === "www.facebook.com" && fbIn.redirect.href === `http://localhost:${port}/oauth/facebook/callback` && fbIn.back.origin === base && Boolean(fbChoice) && !fbIn.back.searchParams.get("connected"),
    "Continue with Facebook uses localhost for the redirect, then returns to where it started with a choice to make",
    fbIn.landed.location,
  );
  ok(signIns.tokenRequests.filter((r) => r.name === "facebook").map((r) => r.grant_type).join(",") === "authorization_code,fb_exchange_token" && signIns.queriesOnTokenEndpoints.length === 0, "Facebook: the code is exchanged and then traded for a long-lived token, with nothing in the address of either request");
  const choosePage = await fetch(`${base}${fbIn.back.pathname}${fbIn.back.search}`).then((r) => r.text());
  ok(choosePage.includes("Verify Press") && choosePage.includes("Verify Bindery") && choosePage.includes("Pick the Pages to connect") && !choosePage.includes(PAGE_TOKENS[111]) && !choosePage.includes("verify-fb-user-long-4e1c"), "The Accounts page lists the Pages to choose from, and none of their tokens");
  const offered = await api(`/api/v1/oauth/choices/${fbChoice}`, { headers: auth });
  ok(offered.body.data.multiple === true && offered.body.data.choices.length === 2 && !JSON.stringify(offered.body).includes("verify-page-token"), "The API offers the same choice by name only");
  const pickedPages = await api(`/api/v1/oauth/choices/${fbChoice}`, { method: "POST", headers: ui, body: JSON.stringify({ choices: ["111", "222"] }) });
  ok(pickedPages.status === 200 && pickedPages.body.data.connected.map((a) => a.handle).join(",") === "Verify Press,Verify Bindery", "Picking two Pages connects two accounts", JSON.stringify(pickedPages.body));
  const pickedAgain = await api(`/api/v1/oauth/choices/${fbChoice}`, { method: "POST", headers: ui, body: JSON.stringify({ choices: ["111"] }) });
  ok(pickedAgain.status === 400 && /already made/.test(pickedAgain.body.error.message), "A choice is made once");
  const pagePost = await api("/api/v1/posts", { method: "POST", headers: auth, body: JSON.stringify({ content: "verify: to a Page", targets: [{ account_id: pickedPages.body.data.connected[1].id }] }) });
  ok(pagePost.body.data.status === "published" && signIns.feed.at(-1).page === "222" && signIns.feed.at(-1).access_token === PAGE_TOKENS[222], "Facebook: a post to the second Page goes out with that Page's own token");

  // Instagram: the accounts behind the Pages
  const igIn = await signIn("instagram");
  const igOffered = await api(`/api/v1/oauth/choices/${igIn.back.searchParams.get("choose")}`, { headers: auth });
  const igPicked = await api(`/api/v1/oauth/choices/${igIn.back.searchParams.get("choose")}`, { method: "POST", headers: ui, body: JSON.stringify({ choices: ["17841400000000111"] }) });
  ok(igOffered.body.data.choices.length === 1 && igOffered.body.data.choices[0].name === "@verify_gram" && igPicked.body.data.connected[0].handle === "@verify_gram", "Continue with Instagram offers the Instagram account behind a Page and connects it", JSON.stringify([igOffered.body, igPicked.body]));

  // Pinterest: sign in, choose a board, pin with a renewed token
  const pinIn = await signIn("pinterest");
  const pinChoice = pinIn.back.searchParams.get("choose");
  const pinTwo = await api(`/api/v1/oauth/choices/${pinChoice}`, { method: "POST", headers: ui, body: JSON.stringify({ choices: ["board-1", "board-2"] }) });
  const pinPicked = await api(`/api/v1/oauth/choices/${pinChoice}`, { method: "POST", headers: ui, body: JSON.stringify({ choices: ["board-2"] }) });
  ok(
    pinIn.address.host === "www.pinterest.com" && pinTwo.status === 400 && /one at a time/.test(pinTwo.body.error.message) && pinPicked.body.data.connected[0].handle === "@verify_pins, Verify Drafts",
    "Continue with Pinterest lists the boards and connects the one picked",
    JSON.stringify([pinTwo.body, pinPicked.body]),
  );
  const pinPost = await api("/api/v1/posts", { method: "POST", headers: auth, body: JSON.stringify({ content: "verify: a pin", media_ids: [media.id], targets: [{ account_id: pinPicked.body.data.connected[0].id }] }) });
  ok(pinPost.body.data.status === "published" && signIns.pins.at(-1).board_id === "board-2" && rotating.pinterest.spent.length >= 2 && new Set(rotating.pinterest.spent).size === rotating.pinterest.spent.length, "Pinterest: the pin goes to the chosen board, and each rotated refresh token was stored", JSON.stringify(pinPost.body.data?.targets));

  // Threads: no sign-in from an http address, and tokens can still be pasted
  const thStart = await api("/api/v1/oauth/threads/start", { method: "POST", headers: auth, body: JSON.stringify({ credentials: APP.threads }) });
  const thPasted = await api("/api/v1/accounts", { method: "POST", headers: auth, body: JSON.stringify({ platform: "threads", credentials: { access_token: "verify-threads-pasted-token-5f77" } }) });
  ok(thStart.status === 400 && /only accepts an https redirect address/.test(thStart.body.error.message) && thPasted.body.data?.handle === "@verify_threads", "Threads refuses to start a sign-in from an http address and says why, and a pasted token still connects", JSON.stringify([thStart.body, thPasted.body]));

  // Nothing above leaked a secret, and the dialog says what to register
  const afterSignIns = await api("/api/v1/accounts", { headers: auth });
  const everySecret = [...Object.values(APP).map((app) => Object.values(app)[1]), ...Object.values(PAGE_TOKENS), "verify-fb-user-long-4e1c", "verify-li-access-2b7e", "verify-yt-refresh-90aa", "verify-threads-pasted-token-5f77", rotating.x.refresh, rotating.pinterest.refresh];
  ok(afterSignIns.body.data.length === accountsBefore + 8 && everySecret.every((secret) => !JSON.stringify(afterSignIns.body).includes(secret)), "Eight accounts were connected by signing in or pasting, and the account list holds none of their secrets");
  const xDialog = await fetch(`${base}/app/accounts?connect=x`).then((r) => r.text());
  ok(xDialog.includes("Continue with X") && xDialog.includes("Paste tokens instead") && xDialog.includes("Permissions it will ask for") && xDialog.includes("offline.access") && xDialog.includes("Redirect address to add in your"), "The X connect dialog shows the redirect address to register, the scopes, and a way to paste tokens instead");
  const xLink = result(await (async () => {
    const again = new Client({ name: "verify-link", version: "1.0.0" });
    await again.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    const reply = await again.callTool({ name: "connect_account", arguments: { platform: "x" } });
    await again.close();
    return reply;
  })());
  ok(xLink.connect_url === `${base}/app/accounts?connect=x` && xLink.signs_in === true && xLink.needs.join(",") === "Client ID,Client Secret" && !("credentials" in xLink), "connect_account still hands an agent a link, and names only what the form will ask for");

  // Editing a saved post in the app
  const toEdit = await api("/api/v1/posts", { method: "POST", headers: auth, body: JSON.stringify({ content: "editable in the app", targets: [{ account_id: ids.sandbox }, { account_id: ids.mastodon, content_override: "mastodon wording" }], publish_at: new Date(Date.now() + 3600000).toISOString() }) });
  const editPage = await fetch(`${base}/app?edit=${toEdit.body.data.id}`).then((r) => r.text());
  ok(editPage.includes("Edit post") && editPage.includes("editable in the app") && editPage.includes("mastodon wording"), "The composer opens a scheduled post for editing, with its per-account version");
  const sentPage = await fetch(`${base}/app?edit=${posted.id}`).then((r) => r.text());
  ok(sentPage.includes("Compose") && !sentPage.includes("Edit post"), "A post that already went out cannot be opened for editing");
  const saved = await api(`/api/v1/posts/${toEdit.body.data.id}`, { method: "PATCH", headers: ui, body: JSON.stringify({ content: "edited in the app", targets: [{ account_id: ids.sandbox }], media_ids: [], publish_at: null, draft: false }) });
  ok(saved.status === 200 && saved.body.data.status === "published" && saved.body.data.content === "edited in the app" && saved.body.data.targets.length === 1, "Saving the edit as Now publishes the changed post to the chosen accounts only");
  ok(!JSON.stringify(health).includes("accounts"), "The public health check reveals nothing about the install");

  const posts = await fetch(`${base}/app/posts`).then((r) => r.text());
  ok(posts.includes("Broadside verify: one post, every network."), "The posts page shows what was published");

  // Findings from the security audit, each pinned
  const asHost = (pathname, host, method = "GET") =>
    new Promise((resolve) => {
      const req = httpRequest({ host: "127.0.0.1", port, path: pathname, method, headers: { host, "sec-fetch-site": "same-origin", "content-type": "application/json" } }, (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode));
      });
      req.end(method === "POST" ? "{}" : undefined);
    });
  ok((await asHost("/api/v1/keys", "evil.example", "POST")) === 401 && (await asHost("/api/v1/accounts", "192.168.1.11:3000")) === 401, "Under another host name, a forged same-origin header gets nothing (no key can be minted)");
  ok((await asHost("/app", "evil.example")) === 403 && (await asHost("/app", `localhost:${port}`)) === 200, "The app's pages answer on localhost and refuse a rebound domain");
  const canary = path.join(dataDir, "canary.txt");
  writeFileSync(canary, "keep me");
  const traversal = await api("/api/v1/media/..%2Fcanary.txt", { method: "DELETE", headers: auth });
  ok(traversal.status === 400 && existsSync(canary), "A path in place of a media id deletes nothing");

  // Response hardening
  const front = await fetch(`${base}/`);
  const csp = front.headers.get("content-security-policy") ?? "";
  ok(csp.includes("frame-ancestors 'none'") && csp.includes("object-src 'none'") && front.headers.get("x-frame-options") === "DENY" && front.headers.get("x-content-type-options") === "nosniff" && !front.headers.get("x-powered-by"), "Pages carry a closed content security policy and cannot be framed");
  const file = await fetch(`${base}${media.url}`);
  ok((file.headers.get("content-security-policy") ?? "").includes("sandbox") && file.headers.get("x-content-type-options") === "nosniff", "Uploaded media is served sandboxed, so it can never run as a page");
  const notMedia = new FormData();
  notMedia.set("file", new Blob(["<script>alert(1)</script>"], { type: "text/html" }), "page.html");
  const rejected = await fetch(`${base}/api/v1/media`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: notMedia });
  ok(rejected.status === 400, "An HTML file is refused as an upload");

  // Analytics: numbers read back from the networks, stored with their time, and never invented
  const numbersOf = async (postId) => (await via("GET", `/posts/${postId}/analytics`)).body.data;
  const on = (data, platform) => data.targets.find((t) => t.platform === platform);
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const metric = (kind, label, value) => ({ kind, label, value });
  const restPlatforms = (await via("GET", "/platforms")).body.data;
  ok(
    same(restPlatforms.find((p) => p.id === "mastodon").metrics.reports.map((r) => r.label), ["Favourites", "Replies", "Boosts", "Quotes"]) && restPlatforms.find((p) => p.id === "telegram").metrics.available === false && restPlatforms.find((p) => p.id === "linkedin").metrics.reason.startsWith("LinkedIn gives post statistics only to apps it has approved"),
    "REST: each network says which counts it reports under its own words, or why it has none",
  );
  const firstStatus = received.mastodon[0].id;
  const background = await until(async () => {
    const data = await numbersOf(posted.id);
    return on(data, "mastodon").as_of && on(data, "bluesky").as_of && on(data, "discord").as_of ? data : null;
  }, "the scheduler to read the first post's numbers", 60000);
  ok(
    same(on(background, "mastodon").metrics, [metric("likes", "Favourites", 4), metric("comments", "Replies", 1), metric("shares", "Boosts", 2)]) && !Number.isNaN(Date.parse(on(background, "mastodon").as_of)) && on(background, "mastodon").error === null,
    "The scheduler read the first post's numbers from Mastodon in the background and stored them with the time they were read",
    JSON.stringify(on(background, "mastodon")),
  );
  const firstReads = numberReads.mastodon.filter((r) => r.id === firstStatus);
  ok(firstReads.length === 1 && firstReads[0].auth === `Bearer ${SECRET_TOKEN}`, "Over every tick since, Mastodon was asked for that post's numbers exactly once, as the account", JSON.stringify(firstReads));
  ok(
    same(on(background, "bluesky").metrics, [metric("likes", "Likes", 7), metric("comments", "Replies", 1), metric("shares", "Reposts", 3), metric("quotes", "Quotes", 0)]) && numberReads.bluesky.some((r) => r.uris.length === 1 && r.uris[0] === "at://did:plc:test/app.bsky.feed.post/3abc" && r.auth === "Bearer jwt"),
    "Bluesky: the post view's counts were read by the post's at:// address, signed in as the account",
    JSON.stringify(on(background, "bluesky")),
  );
  ok(same(on(background, "discord").metrics, [metric("likes", "Reactions", 3)]) && numberReads.discord.includes("m1"), "Discord: the webhook read back its own message and its reactions were added up");
  const silent = ["telegram", "slack", "webhook", "sandbox"].map((platform) => on(background, platform));
  ok(
    silent.every((t) => t.available === false && t.metrics.length === 0 && t.as_of === null && t.error === null && t.unavailable_reason.length > 20) && on(background, "telegram").unavailable_reason.startsWith("Telegram's Bot API has no way"),
    "Networks with no numbers to read say so with the reason, and carry no counts and no reading time",
  );

  // Refresh on demand: the networks are asked again and the new reading replaces the old one on screen
  standinCounts.mastodon[firstStatus] = { replies_count: 5, reblogs_count: 6, favourites_count: 40 };
  standinCounts.bluesky = { likeCount: 70, repostCount: 30, replyCount: 10, quoteCount: 2 };
  let lastRefresh;
  const refreshedNumbers = await until(async () => {
    // A refresh pressed within half a minute of a reading is not sent to the network, so this asks until both are let through.
    lastRefresh = await via("POST", `/posts/${posted.id}/analytics/refresh`);
    const data = await numbersOf(posted.id);
    return on(data, "mastodon").metrics[0].value === 40 && on(data, "bluesky").metrics[0].value === 70 ? data : null;
  }, "a refresh to reach Mastodon and Bluesky", 60000);
  ok(
    lastRefresh.status === 200 && lastRefresh.body.data.refreshed.length === 7 && same(on(refreshedNumbers, "mastodon").metrics, [metric("likes", "Favourites", 40), metric("comments", "Replies", 5), metric("shares", "Boosts", 6)]) && on(refreshedNumbers, "mastodon").as_of > on(background, "mastodon").as_of && on(refreshedNumbers, "bluesky").metrics[3].value === 2,
    "REST: refreshing a post reads its networks again, and the new numbers carry a later time",
    JSON.stringify(lastRefresh.body),
  );
  ok(
    numberReads.mastodon.filter((r) => r.id === firstStatus).length === 2 && lastRefresh.body.data.refreshed.find((r) => r.target_id === on(background, "sandbox").target_id).message === "Numbers are not available for Sandbox. The sandbox publishes nowhere, so there is nothing to count.",
    "The refresh asked Mastodon once more and no oftener, and told a network without numbers why nothing was read",
  );

  // A failed reading keeps the last good one
  const partialTarget = partial.targets.find((t) => t.platform === "mastodon");
  const beforeFailure = await until(async () => {
    const mine = on(await numbersOf(partial.id), "mastodon");
    return mine.as_of ? mine : null;
  }, "the scheduler to read the second post's numbers", 60000);
  numbersDown.add(partialTarget.external_id);
  const afterFailure = await until(async () => {
    const tried = await via("POST", `/posts/${partial.id}/analytics/refresh`);
    return tried.body.data.refreshed.find((r) => r.target_id === partialTarget.id).outcome === "failed" ? on(tried.body.data, "mastodon") : null;
  }, "a refresh to reach the stand-in while it is down", 60000);
  numbersDown.delete(partialTarget.external_id);
  ok(
    afterFailure.as_of === beforeFailure.as_of && same(afterFailure.metrics, beforeFailure.metrics) && afterFailure.metrics.length === 3 && afterFailure.error.message === "Mastodon answered 503: The stand-in is not reporting on this status" && afterFailure.error.at > beforeFailure.as_of,
    "A failed reading keeps the last good numbers and their time, and records why the new one failed",
    JSON.stringify(afterFailure),
  );
  const failedNumbersPage = await page(`/app/posts?post=${partial.id}`);
  const numbersPage = await page(`/app/posts?post=${posted.id}`);
  ok(
    numbersPage.includes("Refresh numbers") && numbersPage.includes("Favourites") && numbersPage.includes(">40<") && numbersPage.includes("As of") && numbersPage.includes("Numbers are not available for Telegram.") && failedNumbersPage.includes("The last try failed at") && failedNumbersPage.includes("Mastodon answered 503: The stand-in is not reporting on this status") && failedNumbersPage.includes("The numbers shown are from the reading before."),
    "The posts page shows each target's numbers as of their time, a Refresh action, the reason a reading failed, and the networks with no numbers",
  );

  // The overview: totals, the per-network breakdown and a row per published copy, all from stored readings
  const totalOf = (data, kind) => data.totals.find((t) => t.kind === kind);
  const overview = await until(async () => {
    const data = (await api("/api/v1/analytics?period=7", { headers: auth })).body.data;
    const seen = (kind) => (totalOf(data, kind)?.networks ?? []).map((p) => p.platform).sort().join();
    return seen("views") === "facebook" && seen("impressions") === "pinterest,x" ? data : null;
  }, "the scheduler to read the numbers of the posts made after signing in", 60000);
  const sumOfRows = (kind) => overview.rows.reduce((sum, row) => sum + (row.metrics.find((x) => x.kind === kind)?.value ?? 0), 0);
  ok(
    overview.totals.length >= 6 && overview.totals.every((t) => t.value === sumOfRows(t.kind) && t.value === t.networks.reduce((sum, p) => sum + p.value, 0)) && overview.rows.every((row) => (row.metrics.length === 0 || row.as_of) && (row.available || (row.metrics.length === 0 && row.as_of === null))),
    "REST: every total is the sum of the stored readings in its rows, one kind at a time, and every number has a reading time",
    JSON.stringify(overview.totals.map((t) => [t.kind, t.value, sumOfRows(t.kind)])),
  );
  ok(
    totalOf(overview, "views").value === 64 && totalOf(overview, "views").networks[0].network === "Facebook Page" && same(totalOf(overview, "impressions").networks.map((p) => [p.platform, p.label]), [["x", "Impressions"], ["pinterest", "Impressions"]]) && totalOf(overview, "impressions").missing.some((x) => x.platform === "facebook" && x.reason === "Facebook Page does not report impressions."),
    "REST: views and impressions are separate totals, and each names the networks it leaves out",
    JSON.stringify([totalOf(overview, "views"), totalOf(overview, "impressions")]),
  );
  const likes = totalOf(overview, "likes");
  ok(
    likes.networks.some((p) => p.platform === "mastodon" && p.label === "Favourites") && likes.networks.some((p) => p.platform === "discord" && p.label === "Reactions") && likes.missing.find((x) => x.platform === "telegram").reason.startsWith("Not available for Telegram. Telegram's Bot API") && likes.missing.find((x) => x.platform === "pinterest").reason === "Pinterest does not report likes." && overview.networks.find((n) => n.platform === "telegram").available === false,
    "REST: a total carries each network's own word for the count, and says which networks are missing and why",
    JSON.stringify(likes.missing),
  );
  ok(numberReads.x.every((r) => r.fields === "public_metrics") && numberReads.x.length >= 2 && signIns.tweets.length === 3 && numberReads.pinterest.every((r) => r.metrics === "IMPRESSION,OUTBOUND_CLICK,PIN_CLICK,SAVE" && /^\d{4}-\d\d-\d\d$/.test(r.start) && r.end >= r.start) && numberReads.facebook.some((r) => r.insights && r.asked === "post_media_view,post_clicks"), "X, Pinterest and Facebook were asked for numbers in their documented shapes, and reading numbers posted nothing");
  const byAccount = (await api(`/api/v1/analytics?period=30&account_id=${ids.bluesky}`, { headers: auth })).body.data;
  const byTagged = (await api(`/api/v1/analytics?period=90&tag=${encodeURIComponent("VERIFY WEEKLY")}`, { headers: auth })).body.data;
  const badPeriod = await api("/api/v1/analytics?period=14", { headers: auth });
  ok(
    byAccount.rows.length > 0 && byAccount.rows.every((row) => row.platform === "bluesky") && byAccount.networks.length === 1 && byTagged.rows.length === 2 && byTagged.rows.every((row) => row.post_id === mcpPost.id) && badPeriod.status === 400 && /period must be 7, 30 or 90/.test(badPeriod.body.error.message),
    "REST: analytics takes a period of 7, 30 or 90 days and filters by account and by tag",
    JSON.stringify([byAccount.rows.length, byTagged.rows.map((row) => row.post_id), badPeriod.body]),
  );
  ok(
    (await api("/api/v1/analytics")).status === 401 && (await api(`/api/v1/posts/${posted.id}/analytics`)).status === 401 && (await api(`/api/v1/posts/${posted.id}/analytics/refresh`, { method: "POST" })).status === 401 && [SECRET_TOKEN, SECRET_SIGNING, ...everySecret].every((secret) => !JSON.stringify([overview, refreshedNumbers, lastRefresh.body]).includes(secret)),
    "Analytics refuses a request with no key, and none of its answers holds a credential",
  );

  // The same numbers through MCP, read-only
  const analyst = new Client({ name: "verify-analytics", version: "1.0.0" });
  await analyst.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  const analystTools = (await analyst.listTools()).tools.filter((t) => t.name === "get_analytics" || t.name === "get_post_analytics");
  ok(analystTools.length === 2 && analystTools.every((t) => t.annotations?.readOnlyHint === true && /Read-only: it reports stored readings and asks no network/.test(t.description)), "MCP: get_analytics and get_post_analytics are offered as read-only tools that ask no network");
  // The scheduler may still be taking first readings of the newest posts, so the comparison is made across a moment in which it took none.
  const storedIn = (data) => ({ posts: data.posts, totals: data.totals, networks: data.networks, rows: data.rows });
  const quiet = await until(async () => {
    const readsBefore = JSON.stringify(numberReads);
    const rest = (await api("/api/v1/analytics?period=7", { headers: auth })).body.data;
    const viaMcp = result(await analyst.callTool({ name: "get_analytics", arguments: { period: 7 } }));
    const post = result(await analyst.callTool({ name: "get_post_analytics", arguments: { post_id: posted.id } }));
    const restAfter = (await api("/api/v1/analytics?period=7", { headers: auth })).body.data;
    return same(storedIn(rest), storedIn(restAfter)) && JSON.stringify(numberReads) === readsBefore ? { rest, viaMcp, post } : null;
  }, "the scheduler to finish its first readings", 60000);
  const mcpBadPeriod = await analyst.callTool({ name: "get_analytics", arguments: { period: 14 } });
  ok(
    same(storedIn(quiet.viaMcp), storedIn(quiet.rest)) && quiet.viaMcp.period.days === 7 && same(on(quiet.post, "mastodon").metrics, on(refreshedNumbers, "mastodon").metrics) && on(quiet.post, "mastodon").as_of === on(refreshedNumbers, "mastodon").as_of && quiet.post.manage_url === `${base}/app/posts?post=${posted.id}` && mcpBadPeriod.isError === true,
    "MCP: get_analytics and get_post_analytics return the same stored numbers and times as REST, and asked no network for them",
    JSON.stringify([quiet.viaMcp.totals?.map((t) => [t.kind, t.value]), quiet.rest.totals.map((t) => [t.kind, t.value])]),
  );
  await analyst.close();

  // The screen
  const analyticsPage = await page("/app/analytics?period=7");
  const shown = (await api("/api/v1/analytics?period=7", { headers: auth })).body.data;
  ok(
    analyticsPage.includes("Totals") && analyticsPage.includes('id="chart-title"') && analyticsPage.includes("Views by network") && analyticsPage.includes("Favourites") && analyticsPage.includes("Not available for Telegram.") && analyticsPage.includes("Not in this total:") && analyticsPage.includes("One row for each copy of a post on a network.") && analyticsPage.includes(`/app/posts?post=${posted.id}`) && analyticsPage.includes("Broadside verify: one post, every network."),
    "The analytics page shows totals, a chart by network, the per-network breakdown and a row for each published copy linking to its post",
  );
  ok(shown.totals.every((t) => analyticsPage.includes(`>${new Intl.NumberFormat("en-US").format(t.value)}<`)) && shown.totals.every((t) => analyticsPage.includes(`>${t.label}<`)), "Every total on the analytics page is a figure the API holds, under its own name", JSON.stringify(shown.totals.map((t) => [t.label, t.value])));
  const quietPeriod = await page(`/app/analytics?account=${ids.slack}`);
  ok(quietPeriod.includes("No numbers have been read for these posts yet.") && quietPeriod.includes("Not available for Slack.") && !quietPeriod.includes('id="chart-title"'), "For an account whose network has no numbers, the page says so and draws no chart");
  ok((await page("/app")).includes('href="/app/analytics"'), "The rail links to Analytics");

  // The optional password: a second boot with BROADSIDE_PASSWORD set
  app.kill("SIGTERM");
  const lockedPort = port + 1;
  const locked = `http://127.0.0.1:${lockedPort}`;
  app = spawn("npx", ["next", "start", "-p", String(lockedPort), "-H", "127.0.0.1"], { cwd: root, env: { ...env, BROADSIDE_PASSWORD: "correct horse", BROADSIDE_LOGIN_DELAY_MS: "20" }, stdio: "ignore" });
  await until(async () => (await fetch(`${locked}/api/health`)).ok, "the password-protected server", 60000);
  const gate = await fetch(`${locked}/app`, { redirect: "manual" });
  ok(gate.status === 307 && gate.headers.get("location").includes("/login"), "With a password set, the app sends visitors to sign in");
  ok((await fetch(`${locked}/api/v1/accounts`, { headers: ui })).status === 401, "With a password set, a browser request without a session is refused");
  const wrong = await fetch(`${locked}/api/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "guess" }) });
  ok(wrong.status === 401 && !wrong.headers.get("set-cookie"), "A wrong password is refused");
  const right = await fetch(`${locked}/api/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "correct horse" }) });
  const cookie = (right.headers.get("set-cookie") ?? "").split(";")[0];
  ok(right.status === 200 && /HttpOnly/.test(right.headers.get("set-cookie")) && /^broadside_session=\d+\.[0-9a-f]{64}$/.test(cookie), "The right password starts an HttpOnly session that carries its own expiry");
  const crossSite = await fetch(`${locked}/api/login`, { method: "POST", headers: { "content-type": "application/json", "sec-fetch-site": "cross-site" }, body: JSON.stringify({ password: "correct horse" }) });
  ok(crossSite.status === 403, "A sign-in posted from another site is refused");
  const signedInPage = await fetch(`${locked}/app`, { headers: { cookie } }).then((r) => r.text());
  const out = await fetch(`${locked}/api/login`, { method: "DELETE" });
  ok(signedInPage.includes("Sign out") && /Max-Age=0/.test(out.headers.get("set-cookie") ?? ""), "A signed-in page offers Sign out, and signing out clears the session cookie");
  ok((await fetch(`${locked}/app`, { headers: { cookie }, redirect: "manual" })).status === 200 && (await fetch(`${locked}/api/v1/accounts`, { headers: { ...ui, cookie } })).status === 200, "A signed-in session reaches the app and its API");
  ok((await fetch(`${locked}/api/v1/accounts`, { headers: auth })).status === 200, "API keys keep working when a password is set");
  const began = Date.now();
  let wrongGuesses = 0;
  for (let i = 0; i < 12; i++) {
    const guess = await fetch(`${locked}/api/login`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": `10.0.0.${i}` }, body: JSON.stringify({ password: `guess-${i}` }) });
    if (guess.status === 401) wrongGuesses++;
  }
  const after = await fetch(`${locked}/api/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "correct horse" }) });
  ok(wrongGuesses === 12 && after.status === 200 && Date.now() - began > 900, "Wrong passwords are slowed however the caller labels itself, and the right password still gets in");
} catch (error) {
  failed = true;
  console.error(`\nverify: FAIL after ${checks} passing checks — ${error.message}`);
} finally {
  app?.kill("SIGTERM");
  fake?.close();
  rmSync(dataDir, { recursive: true, force: true });
}

if (!failed) console.log(`\nverify: PASS — ${checks} checks`);
process.exit(failed ? 1 : 0);
