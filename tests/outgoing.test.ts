import { createHmac, timingSafeEqual } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const dataDir = mkdtempSync(path.join(tmpdir(), "broadside-outgoing-"));
process.env.BROADSIDE_DATA_DIR = dataDir;
process.env.BROADSIDE_SECRET = "test-secret";
// The receivers in this file are not real hosts; the private-address rule has its own tests below.
process.env.BROADSIDE_ALLOW_PRIVATE_FETCH = "1";

const { connectAccount, InputError } = await import("@/lib/accounts");
const { all, get, migrate, run, SCHEMA } = await import("@/lib/db");
const { buildServer } = await import("@/lib/mcp");
const {
  createOutgoingWebhook,
  deleteOutgoingWebhook,
  deliver,
  deliverDue,
  dueDeliveries,
  EVENTS,
  getOutgoingWebhook,
  HEADERS,
  listOutgoingWebhooks,
  LOG_SIZE,
  MAX_ATTEMPTS,
  PAUSE_AFTER,
  RETRY_AFTER_MS,
  sendTest,
  signature,
  updateOutgoingWebhook,
} = await import("@/lib/outgoing");
const { createPost, getPost, recoverInterrupted, retryTarget, updatePost } = await import("@/lib/posts");
const { deliverWebhooks, tick } = await import("@/lib/scheduler");

type Seen = { url: string; method: string; headers: Record<string, string>; body: string };

/**
 * Stands in for the operator's receiver, and for Mastodon. Every request to
 * the receiver is kept whole, so a test can check exactly what was signed.
 */
let mode: "ok" | "down" | "redirect" | "hang" | "throw" = "ok";
let seen: Seen[] = [];
let elsewhere: Seen[] = [];
let mastodonDown = false;
const world = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
  const url = String(input);
  if (url.endsWith("verify_credentials")) return Response.json({ acct: "me", avatar: null });
  if (url.startsWith("https://m.example/")) return mastodonDown ? Response.json({ error: "Validation failed" }, { status: 422 }) : Response.json({ id: "1", url: "https://m.example/@me/1" });
  const request = { url, method: init.method ?? "GET", headers: Object.fromEntries(new Headers(init.headers)), body: String(init.body ?? "") };
  if (!url.startsWith("https://receiver.example/")) {
    elsewhere.push(request);
    return new Response("ok");
  }
  seen.push(request);
  if (mode === "down") return new Response("Internal Server Error with a body nobody should keep", { status: 500 });
  if (mode === "redirect") return new Response(null, { status: 307, headers: { location: "https://elsewhere.example/collect" } });
  if (mode === "throw") throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
  if (mode === "hang") {
    return new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(init.signal!.reason));
    });
  }
  return new Response("ok", { status: 200 });
}) as typeof fetch;

/** What a careful receiver does: recompute the signature over time, id and body, and refuse a time too far from its own clock. */
function receiverAccepts(request: Seen, secret: string, nowSeconds = Math.floor(Date.now() / 1000), toleranceSeconds = 300): boolean {
  const timestamp = request.headers[HEADERS.timestamp];
  const given = request.headers[HEADERS.signature] ?? "";
  if (!/^\d+$/.test(timestamp ?? "") || Math.abs(nowSeconds - Number(timestamp)) > toleranceSeconds) return false;
  const expected = `v1=${createHmac("sha256", secret).update(`${timestamp}.${request.headers[HEADERS.delivery]}.${request.body}`).digest("hex")}`;
  return given.length === expected.length && timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

let sandbox: string;
let masto: string;

beforeAll(async () => {
  sandbox = (await connectAccount("sandbox", { name: "Rehearsal" })).id;
  masto = (await connectAccount("mastodon", { instance: "https://m.example", access_token: "mastodon-secret-token" }, world)).id;
});

beforeEach(() => {
  mode = "ok";
  mastodonDown = false;
  seen = [];
  elsewhere = [];
  process.env.BROADSIDE_ALLOW_PRIVATE_FETCH = "1";
  run("DELETE FROM outgoing_webhooks");
  run("DELETE FROM posts");
});

const hook = async (events?: string[], url = "https://receiver.example/hooks/broadside") => createOutgoingWebhook({ name: "My receiver", url, events });
const publish = (content = "hello", accounts = [sandbox]) => createPost({ content, targets: accounts.map((account_id) => ({ account_id })) }, world);
const deliveriesOf = (id: string) => getOutgoingWebhook(id)!.deliveries;
/** Moves a waiting retry's time into the past, as if its wait were over. */
const waitOut = (id: string) => run("UPDATE outgoing_deliveries SET next_attempt_at = ? WHERE webhook_id = ? AND status = 'retrying'", new Date(Date.now() - 1000).toISOString(), id);

describe("an outgoing webhook", () => {
  it("is created with its own secret, shown once and stored sealed", async () => {
    const first = await hook();
    const second = await hook(undefined, "https://receiver.example/other");
    expect(first.secret).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
    expect(second.secret).not.toBe(first.secret);
    expect(first.webhook).toMatchObject({ name: "My receiver", url: "https://receiver.example/hooks/broadside", events: [...EVENTS], status: "active", paused_reason: null, deliveries: [] });
    // Nothing that lists or reads a webhook carries the secret, and the database holds it encrypted.
    expect(JSON.stringify([listOutgoingWebhooks(), getOutgoingWebhook(first.webhook.id)])).not.toContain(first.secret);
    expect(JSON.stringify(first.webhook)).not.toContain("secret");
    const stored = get<{ secret: string }>("SELECT secret FROM outgoing_webhooks WHERE id = ?", first.webhook.id)!.secret;
    expect(stored).not.toContain(first.secret);
    expect(stored.split(".")).toHaveLength(3);
  });

  it("refuses a name, an address or an event it cannot use, with the reason", async () => {
    await expect(createOutgoingWebhook({ name: " ", url: "https://receiver.example/" })).rejects.toThrow("needs a name");
    await expect(createOutgoingWebhook({ name: "x", url: "ftp://receiver.example/" })).rejects.toThrow("must start with https:// or http://");
    await expect(createOutgoingWebhook({ name: "x", url: "not an address" })).rejects.toThrow("not a valid address");
    await expect(createOutgoingWebhook({ name: "x", url: "https://user:pass@receiver.example/" })).rejects.toThrow("Leave the user name and password out");
    await expect(createOutgoingWebhook({ name: "x", url: "https://receiver.example/", events: ["post.deleted"] })).rejects.toThrow("events must be a list of these names");
    await expect(createOutgoingWebhook({ name: "x", url: "https://receiver.example/", events: [] })).rejects.toThrow("Choose at least one event");
    expect(listOutgoingWebhooks()).toEqual([]);
  });

  it("refuses an address on this machine or a private network unless that is allowed", async () => {
    delete process.env.BROADSIDE_ALLOW_PRIVATE_FETCH;
    await expect(hook(undefined, "http://127.0.0.1:8080/hook")).rejects.toThrow("points inside a private network");
    await expect(hook(undefined, "http://169.254.169.254/latest/meta-data")).rejects.toThrow("points inside a private network");
    await expect(hook(undefined, "http://[::1]/hook")).rejects.toThrow(InputError);
    expect(listOutgoingWebhooks()).toEqual([]);
    process.env.BROADSIDE_ALLOW_PRIVATE_FETCH = "1";
    expect((await hook(undefined, "http://127.0.0.1:8080/hook")).webhook.url).toBe("http://127.0.0.1:8080/hook");
  });

  it("is renamed, repointed, narrowed, and deleted with its log", async () => {
    const { webhook } = await hook();
    const changed = await updateOutgoingWebhook(webhook.id, { name: "Renamed", url: "https://receiver.example/v2", events: ["post.failed", "target.failed"] });
    expect(changed).toMatchObject({ name: "Renamed", url: "https://receiver.example/v2", events: ["post.failed", "target.failed"] });
    await publish();
    expect(deliveriesOf(webhook.id)).toEqual([]);
    await publish("goes wrong [fail]");
    expect(deliveriesOf(webhook.id).map((d) => d.event).sort()).toEqual(["post.failed", "target.failed"]);
    expect(deleteOutgoingWebhook(webhook.id)).toBe(true);
    expect(all("SELECT id FROM outgoing_deliveries")).toEqual([]);
    await expect(updateOutgoingWebhook(webhook.id, { name: "gone" })).rejects.toThrow("No outgoing webhook with id");
  });
});

describe("events", () => {
  it("queues post.published with the post as the API returns it, and sends it signed", async () => {
    const { webhook, secret } = await hook();
    const post = await publish("one post, every network", [sandbox, masto]);
    expect(post.status).toBe("published");
    // Publishing only queued the delivery: the receiver has heard nothing yet.
    expect(seen).toEqual([]);
    expect(deliveriesOf(webhook.id)).toMatchObject([{ event: "post.published", post_id: post.id, status: "pending", attempts: 0, response_code: null }]);

    expect(await deliverWebhooks(world)).toBe(1);
    expect(seen).toHaveLength(1);
    const [request] = seen;
    expect(request.method).toBe("POST");
    expect(request.url).toBe("https://receiver.example/hooks/broadside");
    expect(request.headers["content-type"]).toBe("application/json");
    expect(request.headers[HEADERS.event]).toBe("post.published");
    const body = JSON.parse(request.body) as { id: string; event: string; created_at: string; post: Record<string, unknown> };
    expect(body.event).toBe("post.published");
    expect(body.id).toBe(request.headers[HEADERS.delivery]);
    expect(body.id).toMatch(/^dlv_/);
    expect(Math.abs(Date.parse(body.created_at) - Date.now())).toBeLessThan(5000);
    // The post is the one GET /api/v1/posts/{id} returns, and no credential is anywhere in what was sent.
    expect(body.post).toEqual(JSON.parse(JSON.stringify(getPost(post.id))));
    expect(JSON.stringify(request)).not.toContain("mastodon-secret-token");
    expect(JSON.stringify(request)).not.toContain(secret);
    expect(deliveriesOf(webhook.id)).toMatchObject([{ status: "delivered", attempts: 1, response_code: 200, error: null, next_attempt_at: null }]);
    expect(receiverAccepts(request, secret)).toBe(true);
  });

  it("announces a failed target and the post's outcome, and a later success once", async () => {
    const { webhook } = await hook();
    mastodonDown = true;
    const partial = await publish("half way", [sandbox, masto]);
    expect(partial.status).toBe("partial");
    const failedTarget = partial.targets.find((t) => t.status === "failed")!;
    expect(deliveriesOf(webhook.id).map((d) => d.event).sort()).toEqual(["post.partial", "target.failed"]);
    await deliverDue(world);
    const failure = JSON.parse(seen.find((r) => r.headers[HEADERS.event] === "target.failed")!.body) as { post: { id: string }; target: { id: string; error: string; platform: string } };
    expect(failure.target).toMatchObject({ id: failedTarget.id, platform: "mastodon", status: "failed" });
    expect(failure.target.error).toContain("422");
    expect(failure.post.id).toBe(partial.id);

    // A retry that fails again changes nothing about the post, so only the target is announced a second time.
    await retryTarget(partial.id, failedTarget.id, world).catch(() => undefined);
    expect(deliveriesOf(webhook.id).map((d) => d.event).sort()).toEqual(["post.partial", "target.failed", "target.failed"]);
    mastodonDown = false;
    const fixed = await retryTarget(partial.id, failedTarget.id, world);
    expect(fixed.status).toBe("published");
    expect(deliveriesOf(webhook.id).filter((d) => d.event === "post.published")).toHaveLength(1);
    // Ticks that find nothing to publish announce nothing more.
    await tick(world);
    await tick(world);
    expect(deliveriesOf(webhook.id)).toHaveLength(4);
  });

  it("announces a post that fails everywhere as post.failed, and a target left mid-send by a crash", async () => {
    const { webhook } = await hook(["post.failed", "target.failed"]);
    const failed = await publish("nothing works [fail]");
    expect(failed.status).toBe("failed");
    expect(deliveriesOf(webhook.id).map((d) => d.event).sort()).toEqual(["post.failed", "target.failed"]);
    const stuck = await createPost({ content: "interrupted", targets: [{ account_id: sandbox }], publish_at: new Date(Date.now() + 3600_000).toISOString() }, world);
    run("UPDATE targets SET status = 'publishing' WHERE post_id = ?", stuck.id);
    expect(recoverInterrupted()).toBe(1);
    expect(deliveriesOf(webhook.id).filter((d) => d.post_id === stuck.id).map((d) => d.event).sort()).toEqual(["post.failed", "target.failed"]);
  });

  it("announces a scheduled post when it is scheduled, and again when its time is changed", async () => {
    const { webhook } = await hook(["post.scheduled", "post.published"]);
    const when = new Date(Date.now() + 3600_000).toISOString();
    const post = await createPost({ content: "later", targets: [{ account_id: sandbox }], publish_at: when }, world);
    expect(deliveriesOf(webhook.id)).toMatchObject([{ event: "post.scheduled", post_id: post.id }]);
    await updatePost(post.id, { publish_at: new Date(Date.now() + 7200_000).toISOString() }, world);
    expect(deliveriesOf(webhook.id).map((d) => d.event)).toEqual(["post.scheduled", "post.scheduled"]);
    // A draft is not scheduled, and says nothing.
    await createPost({ content: "a draft", targets: [{ account_id: sandbox }], draft: true }, world);
    expect(deliveriesOf(webhook.id)).toHaveLength(2);
    // When its time comes the scheduler publishes it, and that is announced too.
    run("UPDATE posts SET publish_at = ? WHERE id = ?", new Date(Date.now() - 1000).toISOString(), post.id);
    await tick(world);
    expect(deliveriesOf(webhook.id)[0]).toMatchObject({ event: "post.published", post_id: post.id });
  });

  it("creates the next occurrence of a repeating post and announces it as scheduled", async () => {
    const { webhook } = await hook(["post.scheduled"]);
    const first = await createPost({ content: "daily", targets: [{ account_id: sandbox }], publish_at: new Date(Date.now() + 3600_000).toISOString(), repeat: { every: "day" } }, world);
    run("UPDATE posts SET publish_at = ? WHERE id = ?", new Date(Date.now() - 1000).toISOString(), first.id);
    await tick(world);
    const announced = deliveriesOf(webhook.id).map((d) => d.post_id);
    expect(announced).toHaveLength(2);
    expect(new Set(announced).size).toBe(2);
  });

  it("sends each webhook only the events it asked for, each under its own secret", async () => {
    const a = await hook(["post.published"], "https://receiver.example/a");
    const b = await hook(["post.failed"], "https://receiver.example/b");
    await publish();
    await deliverDue(world);
    expect(seen.map((r) => r.url)).toEqual(["https://receiver.example/a"]);
    expect(receiverAccepts(seen[0], a.secret)).toBe(true);
    expect(receiverAccepts(seen[0], b.secret)).toBe(false);
  });
});

describe("the signature", () => {
  it("covers the time, the delivery id and the body, so none can be changed", async () => {
    const { secret } = await hook();
    await publish();
    await deliverDue(world);
    const [request] = seen;
    expect(request.headers[HEADERS.signature]).toBe(signature(secret, request.headers[HEADERS.timestamp], request.headers[HEADERS.delivery], request.body));
    expect(request.headers[HEADERS.signature]).toMatch(/^v1=[0-9a-f]{64}$/);
    expect(receiverAccepts(request, secret)).toBe(true);
    const tampered = (change: Partial<Seen> | Record<string, string>) => ("body" in change ? { ...request, ...change } : { ...request, headers: { ...request.headers, ...change } }) as Seen;
    expect(receiverAccepts(tampered({ body: request.body.replace("hello", "HELLO") }), secret)).toBe(false);
    expect(receiverAccepts(tampered({ [HEADERS.delivery]: "dlv_another" }), secret)).toBe(false);
    expect(receiverAccepts(tampered({ [HEADERS.timestamp]: String(Number(request.headers[HEADERS.timestamp]) + 1) }), secret)).toBe(false);
    expect(receiverAccepts(request, "whsec_wrong")).toBe(false);
  });

  it("lets a receiver refuse a captured delivery replayed outside its window", async () => {
    const { secret } = await hook();
    await publish();
    await deliverDue(world);
    const [captured] = seen;
    const sentAt = Number(captured.headers[HEADERS.timestamp]);
    expect(Math.abs(sentAt - Date.now() / 1000)).toBeLessThan(5);
    // Inside five minutes it is accepted. Ten minutes on, the same bytes are refused, and the time cannot be moved forward without breaking the signature.
    expect(receiverAccepts(captured, secret, sentAt + 299)).toBe(true);
    expect(receiverAccepts(captured, secret, sentAt + 600)).toBe(false);
    const moved = { ...captured, headers: { ...captured.headers, [HEADERS.timestamp]: String(sentAt + 600) } };
    expect(receiverAccepts(moved, secret, sentAt + 600)).toBe(false);
  });

  it("signs a retry afresh under the same delivery id, so a late retry is inside the window and a receiver can drop a duplicate", async () => {
    const { webhook, secret } = await hook();
    await publish();
    mode = "down";
    await deliverDue(world);
    // The first try is aged, as if it had been made twenty minutes ago.
    const old = { ...seen[0], headers: { ...seen[0].headers } };
    old.headers[HEADERS.timestamp] = String(Number(old.headers[HEADERS.timestamp]) - 1200);
    mode = "ok";
    waitOut(webhook.id);
    await deliverDue(world);
    expect(seen).toHaveLength(2);
    expect(seen[1].headers[HEADERS.delivery]).toBe(seen[0].headers[HEADERS.delivery]);
    expect(seen[1].body).toBe(seen[0].body);
    expect(receiverAccepts(seen[1], secret)).toBe(true);
    expect(Number(seen[1].headers[HEADERS.timestamp])).toBeGreaterThanOrEqual(Number(seen[0].headers[HEADERS.timestamp]));
  });
});

describe("a delivery that fails", () => {
  it("is retried with a longer wait each time, then given up on", async () => {
    const { webhook } = await hook();
    await publish();
    mode = "down";
    for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt++) {
      const before = Date.now();
      await deliverDue(world);
      const [delivery] = deliveriesOf(webhook.id);
      expect(delivery).toMatchObject({ status: "retrying", attempts: attempt, response_code: 500, error: "receiver.example answered 500." });
      const wait = Date.parse(delivery.next_attempt_at!) - before;
      expect(wait).toBeGreaterThanOrEqual(RETRY_AFTER_MS[attempt - 1] - 50);
      expect(wait).toBeLessThan(RETRY_AFTER_MS[attempt - 1] + 5000);
      // Until the wait is over nothing is due, however often the clock ticks.
      expect(dueDeliveries()).toEqual([]);
      expect(await deliverWebhooks(world)).toBe(0);
      waitOut(webhook.id);
    }
    await deliverDue(world);
    expect(deliveriesOf(webhook.id)).toMatchObject([{ status: "failed", attempts: MAX_ATTEMPTS, response_code: 500, next_attempt_at: null }]);
    expect(seen).toHaveLength(MAX_ATTEMPTS);
    expect(dueDeliveries()).toEqual([]);
    // The receiver's own words are not kept: only its status code.
    expect(JSON.stringify(deliveriesOf(webhook.id))).not.toContain("nobody should keep");
    // One delivery given up on does not pause the webhook.
    expect(getOutgoingWebhook(webhook.id)!.status).toBe("active");
  });

  it("records a receiver that cannot be reached or does not answer in time", async () => {
    const { webhook } = await hook();
    await publish();
    mode = "throw";
    await deliverDue(world);
    expect(deliveriesOf(webhook.id)[0]).toMatchObject({ status: "retrying", response_code: null, error: "Could not reach receiver.example: ECONNREFUSED" });
    mode = "hang";
    waitOut(webhook.id);
    await deliverDue(world, { timeoutMs: 40 });
    expect(deliveriesOf(webhook.id)[0]).toMatchObject({ status: "retrying", attempts: 2, response_code: null, error: "receiver.example did not answer within 0 seconds." });
  });

  it("pauses the webhook once deliveries keep failing, says why, and sends nothing while paused", async () => {
    const { webhook } = await hook(["post.published"]);
    mode = "down";
    for (let n = 1; n <= PAUSE_AFTER; n++) {
      await publish(`post ${n}`);
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        await deliverDue(world);
        waitOut(webhook.id);
      }
      expect(getOutgoingWebhook(webhook.id)!.status).toBe(n < PAUSE_AFTER ? "active" : "paused");
    }
    const paused = getOutgoingWebhook(webhook.id)!;
    expect(paused.paused_reason).toBe(`Paused after ${PAUSE_AFTER} deliveries in a row failed. The last one: receiver.example answered 500.`);
    const calls = seen.length;
    expect(calls).toBe(PAUSE_AFTER * MAX_ATTEMPTS);
    // Paused: a new post queues nothing and the receiver is left alone.
    mode = "ok";
    await publish("while paused");
    await deliverDue(world);
    expect(seen).toHaveLength(calls);
    expect(deliveriesOf(webhook.id).some((d) => d.status === "pending" || d.status === "retrying")).toBe(false);

    // Resumed, it starts with a clean count and delivers again.
    const resumed = await updateOutgoingWebhook(webhook.id, { paused: false });
    expect(resumed).toMatchObject({ status: "active", paused_reason: null });
    await publish("after resuming");
    await deliverDue(world);
    expect(seen).toHaveLength(calls + 1);
    expect(deliveriesOf(webhook.id)[0]).toMatchObject({ status: "delivered", response_code: 200 });
  });

  it("starts the count again after a delivery that works", async () => {
    const { webhook } = await hook(["post.published"]);
    const giveUpOnOne = async () => {
      mode = "down";
      await publish();
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        await deliverDue(world);
        waitOut(webhook.id);
      }
    };
    for (let n = 1; n < PAUSE_AFTER; n++) await giveUpOnOne();
    mode = "ok";
    await publish();
    await deliverDue(world);
    await giveUpOnOne();
    expect(getOutgoingWebhook(webhook.id)!.status).toBe("active");
  });

  it("gives up on what is waiting when a person pauses the webhook", async () => {
    const { webhook } = await hook();
    await publish();
    const paused = await updateOutgoingWebhook(webhook.id, { paused: true });
    expect(paused).toMatchObject({ status: "paused", paused_reason: null });
    expect(paused.deliveries).toMatchObject([{ status: "failed", error: "Not sent: the webhook was paused." }]);
    await deliverDue(world);
    expect(seen).toEqual([]);
  });

  it("never follows a redirect, so the signed body reaches no other host", async () => {
    const { webhook } = await hook();
    await publish();
    mode = "redirect";
    await deliverDue(world);
    expect(seen).toHaveLength(1);
    expect(elsewhere).toEqual([]);
    const [delivery] = deliveriesOf(webhook.id);
    // Trying again would be redirected again, so it is not retried.
    expect(delivery).toMatchObject({ status: "failed", attempts: 1, response_code: null });
    expect(delivery.error).toContain("answered with a redirect");
    expect(dueDeliveries()).toEqual([]);
  });

  it("refuses to call an address that has become private, without sending anything", async () => {
    const { webhook } = await hook(undefined, "http://127.0.0.1:9/hook");
    await publish();
    delete process.env.BROADSIDE_ALLOW_PRIVATE_FETCH;
    await deliverDue(world);
    expect(seen).toEqual([]);
    expect(elsewhere).toEqual([]);
    const [delivery] = deliveriesOf(webhook.id);
    expect(delivery).toMatchObject({ status: "failed", attempts: 1 });
    expect(delivery.error).toContain("points inside a private network");
  });

  it("is sent once when two clocks reach for it together", async () => {
    const { webhook } = await hook();
    await publish();
    const [id] = dueDeliveries();
    const results = await Promise.all([deliver(id, world), deliver(id, world), deliverDue(world)]);
    expect(seen).toHaveLength(1);
    expect(results.flat().filter(Boolean)).toHaveLength(1);
    expect(deliveriesOf(webhook.id)).toMatchObject([{ status: "delivered", attempts: 1 }]);
  });

  it("picks up a delivery a dead process left half sent, under the same id", async () => {
    const { webhook } = await hook();
    await publish();
    const [id] = dueDeliveries();
    run("UPDATE outgoing_deliveries SET status = 'delivering', attempts = 1, attempted_at = ? WHERE id = ?", new Date(Date.now() - 30_000).toISOString(), id);
    // Half a minute old could still be on its way: it is left alone.
    expect(dueDeliveries()).toEqual([]);
    run("UPDATE outgoing_deliveries SET attempted_at = ? WHERE id = ?", new Date(Date.now() - 10 * 60_000).toISOString(), id);
    await deliverDue(world);
    expect(seen.map((r) => r.headers[HEADERS.delivery])).toEqual([id]);
    expect(deliveriesOf(webhook.id)).toMatchObject([{ status: "delivered", attempts: 2 }]);
  });
});

describe("publishing is never held up", () => {
  it("publishes at once while the receiver hangs, and the scheduler's tick does not wait for it either", async () => {
    const { webhook } = await hook();
    mode = "hang";
    const started = Date.now();
    const post = await publish("must not wait");
    expect(post.status).toBe("published");
    expect(Date.now() - started).toBeLessThan(1000);
    expect(seen).toEqual([]);

    // The delivery sweep is started and left running; a post that comes due is published by tick while it hangs.
    const sweep = deliverDue(world, { timeoutMs: 400 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(seen).toHaveLength(1);
    const due = await createPost({ content: "due now", targets: [{ account_id: sandbox }], publish_at: new Date(Date.now() + 3600_000).toISOString() }, world);
    run("UPDATE posts SET publish_at = ? WHERE id = ?", new Date(Date.now() - 1000).toISOString(), due.id);
    expect(await tick(world)).toBe(1);
    expect(getPost(due.id)!.status).toBe("published");
    expect(deliveriesOf(webhook.id).find((d) => d.post_id === post.id)!.status).toBe("delivering");
    await sweep;
    expect(deliveriesOf(webhook.id).find((d) => d.post_id === post.id)!.status).toBe("retrying");
  });

  it("publishes even when the event cannot be queued at all", async () => {
    await hook();
    // The worst case: the delivery log itself is broken.
    run("ALTER TABLE outgoing_deliveries RENAME TO outgoing_deliveries_broken");
    try {
      const post = await publish("still goes out", [sandbox, masto]);
      expect(post.status).toBe("published");
      const failed = await publish("still fails honestly [fail]");
      expect(failed.status).toBe("failed");
      expect(failed.targets[0].error).toContain("asked to fail");
    } finally {
      run("ALTER TABLE outgoing_deliveries_broken RENAME TO outgoing_deliveries");
    }
  });

  it("does nothing at all when no webhook is listening", async () => {
    const post = await publish();
    expect(post.status).toBe("published");
    expect(all("SELECT id FROM outgoing_deliveries")).toEqual([]);
  });
});

describe("the delivery log and the test action", () => {
  it("sends a signed test now, and reports how the receiver answered", async () => {
    const { webhook, secret } = await hook(["post.failed"]);
    const sent = await sendTest(webhook.id, world);
    expect(sent).toMatchObject({ event: "webhook.test", status: "delivered", attempts: 1, response_code: 200, post_id: null });
    expect(receiverAccepts(seen[0], secret)).toBe(true);
    expect(JSON.parse(seen[0].body)).toMatchObject({ id: sent.id, event: "webhook.test", post: null });
    expect(deliveriesOf(webhook.id)[0].id).toBe(sent.id);
    await expect(sendTest("owh_missing", world)).rejects.toThrow("No outgoing webhook with id");
  });

  it("tries a failing test once, and a test never counts toward a pause", async () => {
    const { webhook } = await hook();
    mode = "down";
    for (let n = 0; n < PAUSE_AFTER + 2; n++) expect(await sendTest(webhook.id, world)).toMatchObject({ status: "failed", attempts: 1, response_code: 500, next_attempt_at: null });
    expect(getOutgoingWebhook(webhook.id)!.status).toBe("active");
    expect(dueDeliveries()).toEqual([]);
    // A paused webhook can still be tested, to see whether the receiver is back.
    await updateOutgoingWebhook(webhook.id, { paused: true });
    mode = "ok";
    expect(await sendTest(webhook.id, world)).toMatchObject({ status: "delivered" });
    expect(getOutgoingWebhook(webhook.id)!.status).toBe("paused");
  });

  it("keeps a short log: the newest deliveries, with status, time, response code and attempt", async () => {
    const { webhook } = await hook(["post.published"]);
    for (let n = 0; n < LOG_SIZE + 6; n++) {
      await publish(`post ${n}`);
      await deliverDue(world);
    }
    const log = deliveriesOf(webhook.id);
    expect(log).toHaveLength(LOG_SIZE);
    expect(get<{ n: number }>("SELECT COUNT(*) AS n FROM outgoing_deliveries WHERE webhook_id = ?", webhook.id)!.n).toBeLessThanOrEqual(LOG_SIZE + 1);
    expect(log[0]).toMatchObject({ event: "post.published", status: "delivered", attempts: 1, response_code: 200 });
    expect(Date.parse(log[0].attempted_at!)).toBeGreaterThanOrEqual(Date.parse(log.at(-1)!.attempted_at!));
    expect(Object.keys(log[0]).sort()).toEqual(["attempted_at", "attempts", "created_at", "error", "event", "id", "next_attempt_at", "post_id", "response_code", "status"]);
  });
});

describe("agents", () => {
  let client: Client;

  beforeAll(async () => {
    const [a, b] = InMemoryTransport.createLinkedPair();
    await buildServer({ baseUrl: "http://localhost:3000", local: false }).connect(a);
    client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(b);
  });

  afterAll(async () => {
    await client.close();
  });

  it("can list outgoing webhooks and nothing else: no tool creates, changes, tests or deletes one", async () => {
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain("list_outgoing_webhooks");
    expect(names.filter((name) => /webhook/.test(name))).toEqual(["list_outgoing_webhooks"]);
    const tool = (await client.listTools()).tools.find((t) => t.name === "list_outgoing_webhooks")!;
    expect(tool.annotations?.readOnlyHint).toBe(true);
    expect(tool.inputSchema.properties ?? {}).toEqual({});
  });

  it("shows a webhook's site, events and deliveries, never its secret or its full address", async () => {
    const { webhook, secret } = await hook(["post.published"], "https://receiver.example/hooks/T0K3N-in-the-path?key=also-secret");
    await publish();
    await deliverDue(world);
    const reply = await client.callTool({ name: "list_outgoing_webhooks", arguments: {} });
    const text = (reply.content as { text: string }[])[0].text;
    const [listed] = JSON.parse(text) as Record<string, unknown>[];
    expect(listed).toMatchObject({ id: webhook.id, name: "My receiver", site: "https://receiver.example", events: ["post.published"], status: "active" });
    expect((listed.deliveries as unknown[]).length).toBe(1);
    expect(text).not.toContain(secret);
    expect(text).not.toContain("T0K3N");
    expect(text).not.toContain("also-secret");
    expect(listed).not.toHaveProperty("url");
  });
});

describe("an existing database", () => {
  it("gains the webhook tables and the new post columns, and keeps its rows", () => {
    const old = new DatabaseSync(path.join(dataDir, "old.db"));
    // SCHEMA is the first release's tables; everything since arrives through migrate().
    old.exec(SCHEMA);
    old.prepare("INSERT INTO posts (id, content, created_at, updated_at) VALUES ('post_old', 'from before', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')").run();
    migrate(old);
    migrate(old);
    const tables = old.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((t) => t.name);
    expect(tables).toEqual(expect.arrayContaining(["outgoing_webhooks", "outgoing_deliveries", "feeds", "feed_accounts", "feed_items"]));
    const row = old.prepare("SELECT content, origin, feed_id, held_reason, announced FROM posts WHERE id = 'post_old'").get();
    expect({ ...row }).toEqual({ content: "from before", origin: "ui", feed_id: null, held_reason: null, announced: null });
    old.close();
  });
});
