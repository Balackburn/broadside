#!/usr/bin/env node
/**
 * The whole product, proven end to end:
 *   static checks → unit tests → production build → a real server →
 *   stand-in networks → a real MCP client over HTTP and stdio → the web pages.
 * Exits non-zero on the first thing that is not true.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
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

function step(title, command, args) {
  console.log(`\n▸ ${title}`);
  const result = spawnSync(command, args, { cwd: root, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
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
        received.mastodon.push(parsed());
        return json({ id: "101", url: `http://${req.headers.host}/@tester/101` });
      }
      // Bluesky
      if (url === "/xrpc/com.atproto.server.createSession") return json({ accessJwt: "jwt", did: "did:plc:test", handle: "tester.test" });
      if (url.startsWith("/xrpc/app.bsky.actor.getProfile")) return json({});
      if (url === "/xrpc/com.atproto.repo.uploadBlob") return json({ blob: { $type: "blob", ref: { $link: "bafy" }, mimeType: "image/png", size: raw.length } });
      if (url === "/xrpc/com.atproto.repo.createRecord") {
        received.bluesky.push(parsed().record);
        return json({ uri: "at://did:plc:test/app.bsky.feed.post/3abc", cid: "cid" });
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
        received.telegram.push(text);
        return json({ ok: true, result: { message_id: 7, chat: { username: "chan" } } });
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
    mastodon: await connect("mastodon", { instance: net, access_token: "tok" }),
    bluesky: await connect("bluesky", { identifier: "tester.test", app_password: "pw", service: net }),
    discord: await connect("discord", { webhook_url: `${net}/api/webhooks/1/token` }),
    telegram: await connect("telegram", { bot_token: "1:A", chat_id: "@chan", api_base: net }),
    slack: await connect("slack", { webhook_url: `${net}/slack`, channel: "#news" }),
    webhook: await connect("webhook", { url: `${net}/hook`, name: "Automation", secret: "s3" }),
  };
  const bad = await api("/api/v1/accounts", { method: "POST", headers: auth, body: JSON.stringify({ platform: "mastodon", credentials: { instance: net } }) });
  ok(bad.status === 400 && /Access token is required/.test(bad.body.error.message), "A missing credential is refused with the reason");
  const listed = await api("/api/v1/accounts", { headers: auth });
  ok(!JSON.stringify(listed.body).includes('"tok"') && !JSON.stringify(listed.body).includes("s3"), "Account listings never contain credentials");

  // MCP over Streamable HTTP, with the official client
  const client = new Client({ name: "verify", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  ok(client.getServerVersion().name === "broadside", "An MCP client completes the handshake over HTTP");
  const tools = (await client.listTools()).tools.map((t) => t.name).sort();
  const expected = ["cancel_post", "check_post", "connect_account", "create_post", "delete_post", "disconnect_account", "get_post", "list_accounts", "list_media", "list_platforms", "list_posts", "publish_post", "retry_target", "update_post", "upload_media"];
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
  await local.close();

  // REST parity and the web pages
  const rest = await api("/api/v1/posts", { method: "POST", headers: { ...auth, "idempotency-key": "rest-1" }, body: JSON.stringify({ content: "from REST", targets: [{ account_id: ids.sandbox }] }) });
  ok(rest.status === 200 && rest.body.data.status === "published" && rest.body.data.origin === "api", "The REST API publishes too");
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
  const posts = await fetch(`${base}/app/posts`).then((r) => r.text());
  ok(posts.includes("Broadside verify: one post, every network."), "The posts page shows what was published");

  // The optional password: a second boot with BROADSIDE_PASSWORD set
  app.kill("SIGTERM");
  const lockedPort = port + 1;
  const locked = `http://127.0.0.1:${lockedPort}`;
  app = spawn("npx", ["next", "start", "-p", String(lockedPort), "-H", "127.0.0.1"], { cwd: root, env: { ...env, BROADSIDE_PASSWORD: "correct horse" }, stdio: "ignore" });
  await until(async () => (await fetch(`${locked}/api/health`)).ok, "the password-protected server", 60000);
  const gate = await fetch(`${locked}/app`, { redirect: "manual" });
  ok(gate.status === 307 && gate.headers.get("location").includes("/login"), "With a password set, the app sends visitors to sign in");
  ok((await fetch(`${locked}/api/v1/accounts`, { headers: ui })).status === 401, "With a password set, a browser request without a session is refused");
  const wrong = await fetch(`${locked}/api/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "guess" }) });
  ok(wrong.status === 401 && !wrong.headers.get("set-cookie"), "A wrong password is refused");
  const right = await fetch(`${locked}/api/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "correct horse" }) });
  const cookie = (right.headers.get("set-cookie") ?? "").split(";")[0];
  ok(right.status === 200 && /HttpOnly/.test(right.headers.get("set-cookie")), "The right password starts an HttpOnly session");
  ok((await fetch(`${locked}/app`, { headers: { cookie }, redirect: "manual" })).status === 200 && (await fetch(`${locked}/api/v1/accounts`, { headers: { ...ui, cookie } })).status === 200, "A signed-in session reaches the app and its API");
  ok((await fetch(`${locked}/api/v1/accounts`, { headers: auth })).status === 200, "API keys keep working when a password is set");
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
