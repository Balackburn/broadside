import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

process.env.BROADSIDE_DATA_DIR = mkdtempSync(path.join(tmpdir(), "broadside-test-"));
process.env.BROADSIDE_SECRET = "test-secret";

const { connectAccount, credentialsOf, InputError, listAccounts } = await import("@/lib/accounts");
const { open, seal } = await import("@/lib/crypto");
const { get, run } = await import("@/lib/db");
const { authorized, createKey, revokeKey } = await import("@/lib/keys");
const { saveMedia } = await import("@/lib/media");
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
