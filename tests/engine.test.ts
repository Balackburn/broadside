import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { existsSync, writeFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.BROADSIDE_DATA_DIR = mkdtempSync(path.join(tmpdir(), "broadside-test-"));
process.env.BROADSIDE_SECRET = "test-secret";
// The stand-in networks in this file are not real hosts; the outbound guard has its own tests below.
process.env.BROADSIDE_ALLOW_PRIVATE_FETCH = "1";

const { connectAccount, credentialsOf, InputError, listAccounts } = await import("@/lib/accounts");
const { open, seal } = await import("@/lib/crypto");
const { get, run } = await import("@/lib/db");
const { authorized, createKey, revokeKey } = await import("@/lib/keys");
const { deleteMedia, getMedia, importMedia, saveMedia, sniff } = await import("@/lib/media");
const { guardedFetch, isPrivateAddress } = await import("@/lib/net");
const { hostAllowed } = await import("@/lib/hosts");
const { sessionValue, signedIn, SESSION_COOKIE } = await import("@/lib/session");
const { aggregate, cancelPost, createPost, dueTargets, getPost, publishNow, recoverInterrupted, retryTarget, updatePost } = await import("@/lib/posts");
const { tick } = await import("@/lib/scheduler");

/** Stands in for Mastodon; `mode` decides how the instance behaves. */
let mode: "ok" | "down" | "rejects" = "ok";
const sent: string[] = [];
const mastodon = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
  const url = String(input);
  if (url.endsWith("verify_credentials")) return Response.json({ acct: "me", avatar: null });
  if (mode === "down") return Response.json({ error: "Service unavailable" }, { status: 503 });
  if (mode === "rejects") return Response.json({ error: "Validation failed" }, { status: 422 });
  const body = JSON.parse(String(init.body)) as { status: string };
  sent.push(body.status);
  return Response.json({ id: String(sent.length), url: `https://m.example/@me/${sent.length}` });
}) as typeof fetch;

let sandboxA: string;
let sandboxB: string;
let masto: string;

beforeAll(async () => {
  sandboxA = (await connectAccount("sandbox", { name: "One" })).id;
  sandboxB = (await connectAccount("sandbox", { name: "Two" })).id;
  masto = (await connectAccount("mastodon", { instance: "https://m.example", access_token: "secret-token" }, mastodon)).id;
});

describe("secrets", () => {
  it("round-trips through encryption and never stores credentials in the clear", () => {
    expect(open(seal({ a: "b" }))).toEqual({ a: "b" });
    const row = get<{ credentials: string }>("SELECT credentials FROM accounts WHERE id = ?", masto)!;
    expect(row.credentials).not.toContain("secret-token");
    expect(credentialsOf(masto).access_token).toBe("secret-token");
    expect(JSON.stringify(listAccounts())).not.toContain("secret-token");
  });

  it("returns plain objects from the database, so pages can pass them to the browser", () => {
    const row = get<{ id: string }>("SELECT id FROM accounts LIMIT 1")!;
    expect(Object.getPrototypeOf(row)).toBe(Object.prototype);
  });

  it("accepts a live API key and rejects a revoked one", () => {
    const { key, token } = createKey("ci");
    const request = () => new Request("http://x/", { headers: { authorization: `Bearer ${token}` } });
    expect(authorized(request())).toBe(true);
    expect(authorized(new Request("http://x/", { headers: { authorization: "Bearer bs_wrong" } }))).toBe(false);
    revokeKey(key.id);
    expect(authorized(request())).toBe(false);
  });
});

describe("connecting", () => {
  it("refuses a network it does not know, and missing fields, in plain words", async () => {
    await expect(connectAccount("myspace", {})).rejects.toThrow('Broadside has no connector called "myspace".');
    await expect(connectAccount("mastodon", { instance: "https://m.example" })).rejects.toThrow("Access token is required to connect Mastodon.");
  });
});

describe("publishing", () => {
  it("fans one post out to every target and records each result", async () => {
    const post = await createPost({ content: "Hello, all at once", targets: [{ account_id: sandboxA }, { account_id: sandboxB }, { account_id: masto }] }, mastodon);
    expect(post.status).toBe("published");
    expect(post.targets.map((t) => t.status)).toEqual(["published", "published", "published"]);
    expect(post.targets[2].url).toMatch(/^https:\/\/m\.example\/@me\/\d+$/);
    expect(sent).toContain("Hello, all at once");
  });

  it("sends each account its own text when an override is given", async () => {
    await createPost({ content: "shared", targets: [{ account_id: sandboxA }, { account_id: masto, content_override: "just for mastodon" }] }, mastodon);
    expect(sent.at(-1)).toBe("just for mastodon");
  });

  it("refuses the whole post, sending nothing, when one network would reject it", async () => {
    const before = sent.length;
    const error = await createPost({ content: "x".repeat(501), targets: [{ account_id: sandboxA }, { account_id: masto }] }, mastodon).catch((e) => e);
    expect(error).toBeInstanceOf(InputError);
    expect(error.message).toContain("Mastodon allows 500 characters; this is 501.");
    expect(error.details).toEqual([{ account_id: masto, platform: "mastodon", problems: ["Mastodon allows 500 characters; this is 501."] }]);
    expect(sent.length).toBe(before);
  });

  it("keeps the networks that worked when another fails, and can retry just that one", async () => {
    mode = "rejects";
    const post = await createPost({ content: "partial", targets: [{ account_id: sandboxA }, { account_id: masto }] }, mastodon);
    expect(post.status).toBe("partial");
    const failed = post.targets.find((t) => t.platform === "mastodon")!;
    expect(failed.status).toBe("failed");
    expect(failed.error).toBe("Mastodon answered 422: Validation failed");
    mode = "ok";
    const retried = await retryTarget(post.id, failed.id, mastodon);
    expect(retried.status).toBe("published");
    await expect(retryTarget(post.id, failed.id, mastodon)).rejects.toThrow("Only a failed target can be retried.");
  });

  it("waits and tries again by itself when a network is briefly down", async () => {
    mode = "down";
    const post = await createPost({ content: "flaky", targets: [{ account_id: masto }] }, mastodon);
    expect(post.targets[0].status).toBe("retrying");
    expect(post.status).toBe("scheduled");
    mode = "ok";
    run("UPDATE targets SET next_attempt_at = '2000-01-01T00:00:00.000Z' WHERE id = ?", post.targets[0].id);
    await tick(mastodon);
    expect(getPost(post.id)!.status).toBe("published");
  });

  it("returns the first post when the same idempotency key is sent twice", async () => {
    const first = await createPost({ content: "once", targets: [{ account_id: sandboxA }], idempotency_key: "k-1" });
    const second = await createPost({ content: "once", targets: [{ account_id: sandboxA }], idempotency_key: "k-1" });
    expect(second.id).toBe(first.id);
  });

  it("stores media with a post and carries it to the network", async () => {
    const media = saveMedia(new Uint8Array([137, 80, 78, 71]), "one.png", "image/png", { alt: "alt" });
    const post = await createPost({ content: "with image", targets: [{ account_id: sandboxA }], media_ids: [media.id] });
    expect(post.media[0]).toMatchObject({ id: media.id, type: "image", alt: "alt" });
    await expect(createPost({ content: "x", targets: [{ account_id: sandboxA }], media_ids: ["med_missing"] })).rejects.toThrow(/No media with id med_missing/);
  });
});

describe("importing media by URL", () => {
  beforeAll(() => {
    delete process.env.BROADSIDE_ALLOW_PRIVATE_FETCH;
  });
  afterAll(() => {
    process.env.BROADSIDE_ALLOW_PRIVATE_FETCH = "1";
  });

  it("knows which addresses are not on the public internet", () => {
    for (const a of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.11", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "::", "[::1]", "::ffff:127.0.0.1", "::7f00:1", "64:ff9b::7f00:1", "fec0::1", "fd00::1", "fe80::1", "ff02::1", "not-an-ip"]) {
      expect(isPrivateAddress(a), a).toBe(true);
    }
    for (const a of ["93.184.216.34", "8.8.8.8", "172.32.0.1", "2606:4700:4700::1111"]) expect(isPrivateAddress(a), a).toBe(false);
  });

  it("refuses an IPv6 loopback literal instead of crashing on it", async () => {
    await expect(importMedia("http://[::1]/x.png", undefined, (async () => png()) as typeof fetch)).rejects.toThrow(/private network/);
    await expect(importMedia("http://[::ffff:127.0.0.1]/x.png", undefined, (async () => png()) as typeof fetch)).rejects.toThrow(/private network/);
  });

  it("drops credentials when a redirect changes host, and repeats a 307 as it was", async () => {
    const seen: { url: string; method: string; auth: string | null; body: unknown }[] = [];
    const hopping = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      seen.push({ url, method: init.method ?? "GET", auth: new Headers(init.headers).get("authorization"), body: init.body ?? null });
      if (url === "http://93.184.216.34/start") return new Response(null, { status: 307, headers: { location: "http://93.184.216.34/same-host" } });
      if (url === "http://93.184.216.34/same-host") return new Response(null, { status: 302, headers: { location: "http://8.8.8.8/other-host" } });
      return Response.json({ ok: true });
    }) as typeof fetch;
    await guardedFetch(hopping)("http://93.184.216.34/start", { method: "POST", headers: { authorization: "Bearer secret" }, body: "payload" });
    expect(seen).toEqual([
      { url: "http://93.184.216.34/start", method: "POST", auth: "Bearer secret", body: "payload" },
      { url: "http://93.184.216.34/same-host", method: "POST", auth: "Bearer secret", body: "payload" },
      { url: "http://8.8.8.8/other-host", method: "GET", auth: null, body: null },
    ]);
  });

  it("stops a download that has no declared size once it passes the limit", async () => {
    const { readCapped } = await import("@/lib/net");
    const endless = new Response(new ReadableStream({ pull: (controller) => controller.enqueue(new Uint8Array(1024)) }));
    await expect(readCapped(endless, 4096)).rejects.toThrow(/larger than/);
    expect((await readCapped(new Response(new Uint8Array(100)), 4096)).length).toBe(100);
  });

  it("guards connector requests the same way, and lets public ones through", async () => {
    const inner = (async () => Response.json({ ok: true })) as typeof fetch;
    await expect(guardedFetch(inner)("http://169.254.169.254/latest/meta-data")).rejects.toThrow(/private network/);
    await expect(guardedFetch(inner)("http://192.168.1.1/api/v1/accounts/verify_credentials")).rejects.toThrow(/private network/);
    expect((await guardedFetch(inner)("http://93.184.216.34/ok")).status).toBe(200);
  });

  const png = () => new Response(new Uint8Array([137, 80, 78, 71]), { headers: { "content-type": "image/png" } });

  it("refuses an address inside the private network", async () => {
    await expect(importMedia("http://127.0.0.1/secret.png", undefined, (async () => png()) as typeof fetch)).rejects.toThrow(/private network/);
    await expect(importMedia("http://169.254.169.254/latest/meta-data", undefined, (async () => png()) as typeof fetch)).rejects.toThrow(/private network/);
    await expect(importMedia("file:///etc/passwd")).rejects.toThrow(/http:\/\/ or https:\/\//);
  });

  it("checks every redirect hop, so a public address cannot bounce the fetch inward", async () => {
    const calls: string[] = [];
    const bouncing = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response(null, { status: 302, headers: { location: "http://10.0.0.5/internal.png" } });
    }) as typeof fetch;
    await expect(importMedia("http://93.184.216.34/pic.png", undefined, bouncing)).rejects.toThrow(/private network/);
    expect(calls).toEqual(["http://93.184.216.34/pic.png"]);
  });

  it("follows a redirect that stays public, and gives up on a loop", async () => {
    const once = (async (input: RequestInfo | URL) =>
      String(input).endsWith("/a.png") ? new Response(null, { status: 301, headers: { location: "/b.png" } }) : png()) as typeof fetch;
    expect((await importMedia("http://93.184.216.34/a.png", undefined, once)).content_type).toBe("image/png");
    const loop = (async () => new Response(null, { status: 302, headers: { location: "/again.png" } })) as typeof fetch;
    await expect(importMedia("http://93.184.216.34/x.png", undefined, loop)).rejects.toThrow(/too many times/);
  });

  it("refuses a file type that is not a picture or a video", async () => {
    const html = (async () => new Response("<script>alert(1)</script>", { headers: { "content-type": "text/html" } })) as typeof fetch;
    await expect(importMedia("http://93.184.216.34/page.html", undefined, html)).rejects.toThrow(/accepts JPEG/);
    const svg = (async () => new Response("<svg/>", { headers: { "content-type": "image/svg+xml" } })) as typeof fetch;
    await expect(importMedia("http://93.184.216.34/x.svg", undefined, svg)).rejects.toThrow(/accepts JPEG/);
  });
});

describe("stored media", () => {
  it("takes its type from the bytes, and refuses a text file dressed as a picture", () => {
    expect(sniff(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniff(new TextEncoder().encode("-----BEGIN OPENSSH PRIVATE KEY-----"))).toBeNull();
    expect(() => saveMedia(new TextEncoder().encode("-----BEGIN OPENSSH PRIVATE KEY-----"), "key.png", "image/png")).toThrow(/is not a JPEG/);
    expect(saveMedia(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), "really-a-jpeg.png", "image/png").content_type).toBe("image/jpeg");
  });

  it("deletes only a file that belongs to a stored record, never a path", () => {
    const canary = path.join(process.env.BROADSIDE_DATA_DIR!, "canary.txt");
    writeFileSync(canary, "keep me");
    for (const id of ["../canary.txt", "..%2Fcanary.txt", "../../etc/hosts", "med_../canary.txt", ""]) {
      expect(deleteMedia(id), id).toBe(false);
      expect(getMedia(id), id).toBeUndefined();
    }
    expect(existsSync(canary)).toBe(true);
    const real = saveMedia(new Uint8Array([137, 80, 78, 71]), "one.png", "image/png");
    expect(deleteMedia(real.id)).toBe(true);
    expect(deleteMedia(real.id)).toBe(false);
  });
});

describe("who may use the app without a key", () => {
  const from = (host: string) => new Request("http://x/", { headers: { host } });

  it("answers only on localhost when no password is set", () => {
    delete process.env.BROADSIDE_PASSWORD;
    expect(hostAllowed(from("localhost:3000"))).toBe(true);
    expect(hostAllowed(from("127.0.0.1:3000"))).toBe(true);
    expect(hostAllowed(from("evil.example"))).toBe(false);
    expect(hostAllowed(from("192.168.1.11:3000"))).toBe(false);
    process.env.BROADSIDE_PUBLIC_URL = "https://post.example.com";
    expect(hostAllowed(from("post.example.com"))).toBe(true);
    delete process.env.BROADSIDE_PUBLIC_URL;
  });

  it("issues sessions that expire and cannot be forged", async () => {
    process.env.BROADSIDE_PASSWORD = "correct horse";
    const value = await sessionValue();
    const withCookie = (v: string) => new Request("http://x/", { headers: { cookie: `${SESSION_COOKIE}=${v}` } });
    expect(value).toMatch(/^\d+\.[0-9a-f]{64}$/);
    expect(await signedIn(withCookie(value))).toBe(true);
    expect(await signedIn(withCookie(value), Date.now() + 31 * 24 * 3600 * 1000)).toBe(false);
    const [expires, signature] = value.split(".");
    expect(await signedIn(withCookie(`${Number(expires) + 999}.${signature}`))).toBe(false);
    // Even a correctly signed cookie is refused if it is dated further ahead than this server issues.
    const farFuture = await sessionValue(Date.now() + 400 * 24 * 3600 * 1000);
    expect(await signedIn(withCookie(farFuture))).toBe(false);
    expect(await signedIn(withCookie("anything"))).toBe(false);
    process.env.BROADSIDE_PASSWORD = "changed";
    expect(await signedIn(withCookie(value))).toBe(false);
    delete process.env.BROADSIDE_PASSWORD;
  });
});

describe("scheduling", () => {
  it("holds a scheduled post until its time, then the clock sends it", async () => {
    const at = new Date(Date.now() + 3_600_000).toISOString();
    const post = await createPost({ content: "later", targets: [{ account_id: sandboxA }, { account_id: sandboxB }], publish_at: at });
    expect(post.status).toBe("scheduled");
    expect(dueTargets()).toEqual([]);
    expect(await tick()).toBe(0);
    run("UPDATE posts SET publish_at = '2000-01-01T00:00:00.000Z' WHERE id = ?", post.id);
    expect(await tick()).toBe(2);
    expect(getPost(post.id)!.status).toBe("published");
  });

  it("never sends the same target twice when two clocks tick together", async () => {
    const post = await createPost({ content: "race", targets: [{ account_id: masto }], publish_at: new Date(Date.now() + 3_600_000).toISOString() }, mastodon);
    run("UPDATE posts SET publish_at = '2000-01-01T00:00:00.000Z' WHERE id = ?", post.id);
    const before = sent.length;
    await Promise.all([tick(mastodon), tick(mastodon), tick(mastodon)]);
    expect(sent.length).toBe(before + 1);
  });

  it("requires a time zone so a post cannot go out at the wrong hour", async () => {
    await expect(createPost({ content: "x", targets: [{ account_id: sandboxA }], publish_at: "2030-01-01T09:00:00" })).rejects.toThrow(/has no time zone/);
    await expect(createPost({ content: "x", targets: [{ account_id: sandboxA }], publish_at: "next tuesday" })).rejects.toThrow(/not a date/);
  });

  it("lets a scheduled post be edited, published early or cancelled, but not a published one", async () => {
    const at = new Date(Date.now() + 3_600_000).toISOString();
    const post = await createPost({ content: "v1", targets: [{ account_id: sandboxA }], publish_at: at });
    const edited = await updatePost(post.id, { content: "v2", targets: [{ account_id: sandboxA }, { account_id: sandboxB }] });
    expect(edited.content).toBe("v2");
    expect(edited.targets).toHaveLength(2);
    const published = await publishNow(post.id);
    expect(published.status).toBe("published");
    await expect(updatePost(post.id, { content: "v3" })).rejects.toThrow("This post is published; only drafts and scheduled posts can be changed.");
    expect(() => cancelPost(post.id)).toThrow(/nothing left to cancel/);

    const other = await createPost({ content: "doomed", targets: [{ account_id: sandboxA }], publish_at: at });
    expect(cancelPost(other.id).status).toBe("cancelled");
    run("UPDATE posts SET publish_at = '2000-01-01T00:00:00.000Z' WHERE id = ?", other.id);
    expect(await tick()).toBe(0);
  });

  it("saves a draft that goes nowhere until it is published", async () => {
    const draft = await createPost({ content: "idea", targets: [{ account_id: sandboxA }], draft: true });
    expect(draft.status).toBe("draft");
    expect(await tick()).toBe(0);
    expect((await publishNow(draft.id)).status).toBe("published");
  });

  it("fails, rather than resends, a target that was mid-flight when the server stopped", async () => {
    const post = await createPost({ content: "interrupted", targets: [{ account_id: sandboxA }], draft: true });
    run("UPDATE targets SET status = 'publishing' WHERE post_id = ?", post.id);
    expect(recoverInterrupted()).toBe(1);
    const target = getPost(post.id)!.targets[0];
    expect(target.status).toBe("failed");
    expect(target.error).toMatch(/in case it went out/);
  });
});

describe("aggregate status", () => {
  it("derives one status from the targets", () => {
    expect(aggregate(["published", "published"])).toBe("published");
    expect(aggregate(["published", "failed"])).toBe("partial");
    expect(aggregate(["failed", "failed"])).toBe("failed");
    expect(aggregate(["scheduled", "scheduled"])).toBe("scheduled");
    expect(aggregate(["published", "publishing"])).toBe("publishing");
    expect(aggregate(["published", "cancelled"])).toBe("published");
    expect(aggregate(["cancelled"])).toBe("cancelled");
    expect(aggregate(["draft"])).toBe("draft");
  });
});
