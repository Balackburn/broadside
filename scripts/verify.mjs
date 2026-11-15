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
import { fileURLToPath } from "node:url";
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
      json({ error: `unexpected ${req.method} ${url}` }, 404);
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
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
  const expected = ["cancel_post", "check_post", "connect_account", "create_post", "delete_post", "disconnect_account", "get_post", "list_accounts", "list_media", "list_platforms", "list_posts", "publish_post", "retry_target", "stop_series", "update_post", "upload_media"];
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
    ["/app/accounts", "Accounts"],
    ["/app/connect", "/mcp"],
    ["/login", "Sign in"],
  ];
  for (const [pathname, marker] of pages) {
    const response = await fetch(`${base}${pathname}`);
    const html = await response.text();
    ok(response.status === 200 && html.includes(marker), `Page ${pathname} renders`, `status ${response.status}`);
  }
  // Signing in with a network
  const begun = await api("/api/v1/oauth/tiktok/start", { method: "POST", headers: auth, body: JSON.stringify({ credentials: { client_key: "ck", client_secret: "verify-client-secret" } }) });
  const authorize = new URL(begun.body.data.url);
  ok(authorize.host === "www.tiktok.com" && authorize.searchParams.get("redirect_uri") === `${base}/oauth/tiktok/callback` && /^[0-9a-f]{64}$/.test(authorize.searchParams.get("code_challenge")) && !begun.body.data.url.includes("verify-client-secret"), "Continue with TikTok sends the browser to TikTok with the local redirect address and no secret in the URL");
  const forged = await fetch(`${base}/oauth/tiktok/callback?code=x&state=made-up`, { redirect: "manual" });
  ok(forged.status === 303 && (new URL(forged.headers.get("location")).searchParams.get("error") ?? "").includes("not started here"), "A callback with a state this Broadside never issued connects nothing");
  const tiktokSpec = platforms.find((p) => p.id === "tiktok");
  ok(tiktokSpec.oauth?.callback_path === "/oauth/tiktok/callback" && !tiktokSpec.fields.some((f) => f.key === "refresh_token"), "The TikTok connect form asks for the app's key and secret only");

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
