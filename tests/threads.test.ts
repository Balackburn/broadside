import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

process.env.BROADSIDE_DATA_DIR = mkdtempSync(path.join(tmpdir(), "broadside-threads-"));
process.env.BROADSIDE_SECRET = "test-secret";
// The stand-in networks in this file are not real hosts.
process.env.BROADSIDE_ALLOW_PRIVATE_FETCH = "1";

const { connectAccount, InputError } = await import("@/lib/accounts");
const { all, get, migrate, run, SCHEMA } = await import("@/lib/db");
const { cancelPost, createPost, deletePost, getPost, inspectPost, listPosts, publishNow, publishTarget, recoverInterrupted, retryTarget, stopSeries, updatePost } = await import("@/lib/posts");
const { nextOccurrence, occurrence } = await import("@/lib/repeat");
const { tick } = await import("@/lib/scheduler");

/* Stand-in networks -------------------------------------------------------- */

type Status = { id: string; status: string; in_reply_to_id?: string };
type Record_ = { text: string; reply?: { root: { uri: string; cid: string }; parent: { uri: string; cid: string } } };

/** Everything the stand-in Mastodon accepted, in order. `refuse` and `down` name a status text it turns away. */
const sent: Status[] = [];
const records: Record_[] = [];
let refuse: string | null = null;
let down: string | null = null;
let discordCalls = 0;
/** Runs while the stand-in Mastodon is handling a status, as something happening elsewhere at that moment would. */
let meanwhile: ((status: string) => void) | null = null;

const network = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
  const url = String(input);
  if (url.startsWith("https://discord.example/")) {
    discordCalls++;
    return Response.json({ name: "Announcements", id: "m1", channel_id: "c1" });
  }
  if (url.endsWith("createSession")) return Response.json({ accessJwt: "jwt", did: "did:plc:abc", handle: "me.bsky.example" });
  if (url.includes("getProfile")) return Response.json({});
  if (url.endsWith("createRecord")) {
    const { record } = JSON.parse(String(init.body)) as { record: Record_ };
    if (record.text === refuse) return Response.json({ error: "InvalidRequest", message: "Record refused" }, { status: 400 });
    records.push(record);
    return Response.json({ uri: `at://did:plc:abc/app.bsky.feed.post/r${records.length}`, cid: `cid-${records.length}` });
  }
  if (url.endsWith("verify_credentials")) return Response.json({ acct: "me", avatar: null });
  const body = JSON.parse(String(init.body)) as { status: string; in_reply_to_id?: string };
  if (body.status === refuse) return Response.json({ error: "Validation failed" }, { status: 422 });
  if (body.status === down) return Response.json({ error: "Service unavailable" }, { status: 503 });
  const id = String(sent.length + 1);
  sent.push({ id, status: body.status, in_reply_to_id: body.in_reply_to_id });
  meanwhile?.(body.status);
  return Response.json({ id, url: `https://m.example/@me/${id}` });
}) as typeof fetch;

let sandbox: string;
let sandboxB: string;
let masto: string;
let discord: string;
let bluesky: string;

beforeAll(async () => {
  sandbox = (await connectAccount("sandbox", { name: "One" })).id;
  sandboxB = (await connectAccount("sandbox", { name: "Two" })).id;
  masto = (await connectAccount("mastodon", { instance: "https://m.example", access_token: "token" }, network)).id;
  discord = (await connectAccount("discord", { webhook_url: "https://discord.example/api/webhooks/1/t" }, network)).id;
  bluesky = (await connectAccount("bluesky", { identifier: "me.bsky.example", app_password: "pw", service: "https://bsky.example" }, network)).id;
});

beforeEach(() => {
  sent.length = 0;
  records.length = 0;
  refuse = null;
  down = null;
  discordCalls = 0;
  meanwhile = null;
});

const mastodonOf = (post: { targets: { platform: string }[] }) => post.targets.find((t) => t.platform === "mastodon")! as NonNullable<ReturnType<typeof getPost>>["targets"][number];
const due = (id: string) => run("UPDATE posts SET publish_at = '2000-01-01T00:00:00.000Z' WHERE id = ?", id);
const inSeries = (id: string) => listPosts({ limit: 200 }).filter((p) => p.series?.id === id).sort((a, b) => a.publish_at!.localeCompare(b.publish_at!));

/* Threads ------------------------------------------------------------------ */

describe("threads", () => {
  it("publishes the parts in order, each as a reply to the one before", async () => {
    const post = await createPost({ content: "one", thread: ["two", "three"], targets: [{ account_id: masto }, { account_id: sandbox }] }, network);
    expect(post.status).toBe("published");
    expect(post.thread).toEqual(["two", "three"]);
    expect(sent).toEqual([
      { id: "1", status: "one", in_reply_to_id: undefined },
      { id: "2", status: "two", in_reply_to_id: "1" },
      { id: "3", status: "three", in_reply_to_id: "2" },
    ]);
    const target = mastodonOf(post);
    expect(target.url).toBe("https://m.example/@me/1");
    expect(target.parts).toEqual([
      { part: 1, status: "published", id: "1", url: "https://m.example/@me/1" },
      { part: 2, status: "published", id: "2", url: "https://m.example/@me/2" },
      { part: 3, status: "published", id: "3", url: "https://m.example/@me/3" },
    ]);
    expect(post.targets.find((t) => t.platform === "sandbox")!.parts.map((p) => p.status)).toEqual(["published", "published", "published"]);
  });

  it("gives a post with no thread exactly one part", async () => {
    const post = await createPost({ content: "alone", targets: [{ account_id: masto }] }, network);
    expect(post.thread).toEqual([]);
    expect(post.targets[0].parts).toEqual([{ part: 1, status: "published", id: "1", url: "https://m.example/@me/1" }]);
  });

  it("sends a per-account version as the first part and the shared thread after it", async () => {
    await createPost({ content: "shared", thread: ["comment"], targets: [{ account_id: masto, content_override: "for mastodon" }] }, network);
    expect(sent.map((s) => s.status)).toEqual(["for mastodon", "comment"]);
  });

  it("stops at the part that fails, names it, and a retry resumes there without resending the earlier parts", async () => {
    refuse = "three";
    const post = await createPost({ content: "one", thread: ["two", "three", "four"], targets: [{ account_id: masto }] }, network);
    const failed = mastodonOf(post);
    expect(failed.status).toBe("failed");
    expect(failed.error).toBe("Part 3 of 4: Mastodon answered 422: Validation failed");
    expect(failed.parts.map((p) => p.status)).toEqual(["published", "published", "failed", "waiting"]);
    expect(failed.parts[1].url).toBe("https://m.example/@me/2");
    // Two parts are out there, so the post is partly published rather than failed.
    expect(post.status).toBe("partial");
    expect(sent.map((s) => s.status)).toEqual(["one", "two"]);

    refuse = null;
    const retried = await retryTarget(post.id, failed.id, network);
    expect(retried.status).toBe("published");
    expect(sent).toEqual([
      { id: "1", status: "one", in_reply_to_id: undefined },
      { id: "2", status: "two", in_reply_to_id: "1" },
      { id: "3", status: "three", in_reply_to_id: "2" },
      { id: "4", status: "four", in_reply_to_id: "3" },
    ]);
    expect(mastodonOf(retried).parts.map((p) => p.status)).toEqual(["published", "published", "published", "published"]);
  });

  it("records how far each target got in its own columns", async () => {
    refuse = "two";
    const post = await createPost({ content: "one", thread: ["two"], targets: [{ account_id: masto }] }, network);
    const row = get<{ parts_done: number; parts: string }>("SELECT parts_done, parts FROM targets WHERE id = ?", post.targets[0].id)!;
    expect(row.parts_done).toBe(1);
    expect(JSON.parse(row.parts)).toEqual([{ id: "1", url: "https://m.example/@me/1" }]);
  });

  it("waits and resumes by itself when a network is briefly down in the middle of a thread", async () => {
    down = "two";
    const post = await createPost({ content: "one", thread: ["two", "three"], targets: [{ account_id: masto }] }, network);
    const target = mastodonOf(post);
    expect(target.status).toBe("retrying");
    expect(target.parts.map((p) => p.status)).toEqual(["published", "retrying", "waiting"]);
    down = null;
    run("UPDATE targets SET next_attempt_at = '2000-01-01T00:00:00.000Z' WHERE id = ?", target.id);
    await tick(network);
    expect(getPost(post.id)!.status).toBe("published");
    expect(sent.map((s) => s.status)).toEqual(["one", "two", "three"]);
  });

  it("fails a target interrupted in the middle of a thread, and no clock resends it", async () => {
    refuse = "three";
    const post = await createPost({ content: "one", thread: ["two", "three", "four"], targets: [{ account_id: masto }] }, network);
    refuse = null;
    // As a process that died while part 3 was on the wire would leave it.
    run("UPDATE targets SET status = 'publishing', error = NULL WHERE post_id = ?", post.id);
    expect(recoverInterrupted()).toBe(1);
    const target = getPost(post.id)!.targets[0];
    expect(target.status).toBe("failed");
    expect(target.error).toBe("Broadside stopped while part 3 of 4 was being sent. Check the network before retrying, in case it went out.");
    await tick(network);
    await tick(network);
    expect(sent.map((s) => s.status)).toEqual(["one", "two"]);
    // A person decides: retrying continues at part 3.
    await retryTarget(post.id, target.id, network);
    expect(sent.map((s) => s.status)).toEqual(["one", "two", "three", "four"]);
  });

  it("stops between parts when another process has failed the target under it, and the retry does not repeat a part", async () => {
    // A second Broadside process starts while part 2 is on the wire and runs its recovery.
    meanwhile = (status) => {
      if (status === "two") recoverInterrupted();
    };
    const post = await createPost({ content: "one", thread: ["two", "three", "four"], targets: [{ account_id: masto }] }, network);
    expect(sent.map((s) => s.status)).toEqual(["one", "two"]);
    const target = post.targets[0];
    expect(target.status).toBe("failed");
    expect(target.parts.map((p) => p.status)).toEqual(["published", "published", "failed", "waiting"]);
    meanwhile = null;
    await retryTarget(post.id, target.id, network);
    expect(sent.map((s) => s.status)).toEqual(["one", "two", "three", "four"]);
    expect(sent[2].in_reply_to_id).toBe("2");
  });

  it("never sends a part twice when the same target is published from two places at once", async () => {
    const post = await createPost({ content: "one", thread: ["two", "three"], targets: [{ account_id: masto }], publish_at: new Date(Date.now() + 3_600_000).toISOString() }, network);
    due(post.id);
    await Promise.all([tick(network), tick(network), publishTarget(post.targets[0].id, network)]);
    expect(sent.map((s) => s.status)).toEqual(["one", "two", "three"]);
  });

  it("keeps what a later reply needs beyond the id (Bluesky's cid) across a retry", async () => {
    refuse = "c";
    const post = await createPost({ content: "a", thread: ["b", "c"], targets: [{ account_id: bluesky }] }, network);
    expect(post.targets[0].error).toBe("Part 3 of 3: Bluesky answered 400: Record refused");
    expect(records[1].reply).toEqual({
      root: { uri: "at://did:plc:abc/app.bsky.feed.post/r1", cid: "cid-1" },
      parent: { uri: "at://did:plc:abc/app.bsky.feed.post/r1", cid: "cid-1" },
    });
    refuse = null;
    await retryTarget(post.id, post.targets[0].id, network);
    expect(records.map((r) => r.text)).toEqual(["a", "b", "c"]);
    // Root and parent come back from the database: the first part's cid and the second's.
    expect(records[2].reply).toEqual({
      root: { uri: "at://did:plc:abc/app.bsky.feed.post/r1", cid: "cid-1" },
      parent: { uri: "at://did:plc:abc/app.bsky.feed.post/r2", cid: "cid-2" },
    });
  });

  it("refuses the whole post, sending nothing, when a part does not fit one network", async () => {
    const error = await createPost({ content: "fine", thread: ["ok", "x".repeat(501)], targets: [{ account_id: sandbox }, { account_id: masto }] }, network).catch((e) => e);
    expect(error).toBeInstanceOf(InputError);
    expect(error.details).toEqual([{ account_id: masto, platform: "mastodon", problems: ["Mastodon allows 500 characters in a reply; part 3 is 501."] }]);
    expect(sent).toEqual([]);
    await expect(createPost({ content: "fine", thread: ["  "], targets: [{ account_id: sandbox }] })).rejects.toThrow("Part 2 of the thread is empty.");
    await expect(createPost({ content: "fine", thread: "two" as unknown as string[], targets: [{ account_id: sandbox }] })).rejects.toThrow(/thread must be a list of strings/);
  });

  it("refuses a thread for a network that cannot post one, by name, and drops nothing", async () => {
    const before = listPosts({ limit: 200 }).length;
    const error = await createPost({ content: "hello", thread: ["first comment"], targets: [{ account_id: masto }, { account_id: discord }] }, network).catch((e) => e);
    expect(error).toBeInstanceOf(InputError);
    expect(error.message).toContain("Discord cannot post a thread from a webhook.");
    expect(error.details).toEqual([{ account_id: discord, platform: "discord", problems: ["Discord cannot post a thread from a webhook."] }]);
    expect(sent).toEqual([]);
    expect(discordCalls).toBe(0);
    expect(listPosts({ limit: 200 }).length).toBe(before);
    // Without the thread the same accounts are fine.
    expect((await createPost({ content: "hello", targets: [{ account_id: masto }, { account_id: discord }] }, network)).status).toBe("published");
  });

  it("checks a thread without sending it, part by part", () => {
    const [m, d] = inspectPost({ content: "main", thread: ["two", "x".repeat(600)], targets: [{ account_id: masto }, { account_id: discord }] });
    expect(m).toMatchObject({ ok: false, length: 4, max_chars: 500, problems: ["Mastodon allows 500 characters in a reply; part 3 is 600."] });
    expect(m.thread).toEqual([
      { part: 2, length: 3, max_chars: 500 },
      { part: 3, length: 600, max_chars: 500 },
    ]);
    expect(d).toMatchObject({ ok: false, problems: ["Discord cannot post a thread from a webhook."] });
    expect(sent).toEqual([]);
  });

  it("lets a scheduled thread be edited, and holds the edit to the same rules", async () => {
    const at = new Date(Date.now() + 3_600_000).toISOString();
    const post = await createPost({ content: "one", thread: ["two"], targets: [{ account_id: masto }], publish_at: at }, network);
    expect(post.targets[0].parts.map((p) => p.status)).toEqual(["scheduled", "scheduled"]);
    const edited = await updatePost(post.id, { thread: ["two, reworded", "three"] }, network);
    expect(edited.thread).toEqual(["two, reworded", "three"]);
    expect((await updatePost(post.id, { content: "only text changes" }, network)).thread).toEqual(["two, reworded", "three"]);
    await expect(updatePost(post.id, { thread: ["x".repeat(501)] }, network)).rejects.toThrow(/part 2 is 501/);
    await expect(updatePost(post.id, { targets: [{ account_id: discord }] }, network)).rejects.toThrow("Discord cannot post a thread from a webhook.");
    expect((await updatePost(post.id, { thread: [] }, network)).thread).toEqual([]);
    expect(sent).toEqual([]);
  });

  it("will not let a thread that has started going out be edited and sent again", async () => {
    down = "two";
    const post = await createPost({ content: "one", thread: ["two"], targets: [{ account_id: masto }] }, network);
    expect(post.status).toBe("scheduled");
    await expect(updatePost(post.id, { content: "changed" }, network)).rejects.toThrow(/has started going out/);
    expect(sent.map((s) => s.status)).toEqual(["one"]);
    // Cancelled while it waits to retry: the part that went out stays on record, and the post says it is partly out.
    const cancelled = cancelPost(post.id);
    expect(cancelled.status).toBe("partial");
    expect(cancelled.targets[0].parts.map((p) => p.status)).toEqual(["published", "cancelled"]);
    expect(await tick(network)).toBe(0);
  });
});

/* Repeating posts ---------------------------------------------------------- */

describe("when a repeating post comes round", () => {
  it("counts months from the first occurrence, so the 31st does not drift", () => {
    const anchor = "2031-01-31T09:00:00.000Z";
    expect(occurrence(anchor, "month", 0)).toBe("2031-01-31T09:00:00.000Z");
    expect(occurrence(anchor, "month", 1)).toBe("2031-02-28T09:00:00.000Z");
    expect(occurrence(anchor, "month", 2)).toBe("2031-03-31T09:00:00.000Z");
    expect(occurrence(anchor, "month", 3)).toBe("2031-04-30T09:00:00.000Z");
    expect(occurrence(anchor, "month", 12)).toBe("2032-01-31T09:00:00.000Z");
    // A leap year keeps the 29th.
    expect(occurrence("2032-01-31T09:00:00.000Z", "month", 1)).toBe("2032-02-29T09:00:00.000Z");
  });

  it("steps days and weeks across month and year ends", () => {
    expect(occurrence("2030-12-30T18:30:15.250Z", "day", 3)).toBe("2031-01-02T18:30:15.250Z");
    expect(occurrence("2030-12-30T18:30:00.000Z", "week", 1)).toBe("2031-01-06T18:30:00.000Z");
  });

  it("keeps the clock time in the given zone when the clocks change", () => {
    // 09:00 in Paris is 08:00 UTC in winter and 07:00 UTC once summer time starts on 28 March 2027.
    expect(occurrence("2027-03-27T08:00:00.000Z", "day", 1, "Europe/Paris")).toBe("2027-03-28T07:00:00.000Z");
    expect(occurrence("2027-03-27T08:00:00.000Z", "day", 1)).toBe("2027-03-28T08:00:00.000Z");
    // The 31st at 09:00 in Paris, monthly: the last day of February, then the 31st again, now in summer time.
    expect(occurrence("2027-01-31T08:00:00.000Z", "month", 1, "Europe/Paris")).toBe("2027-02-28T08:00:00.000Z");
    expect(occurrence("2027-01-31T08:00:00.000Z", "month", 2, "Europe/Paris")).toBe("2027-03-31T07:00:00.000Z");
  });

  it("skips occurrences that were missed, and ends at the until date", () => {
    const rule = { anchor: "2030-01-01T09:00:00.000Z", every: "day" as const };
    const now = new Date("2030-01-08T12:00:00.000Z").getTime();
    expect(nextOccurrence(rule, 0, now)).toEqual({ at: "2030-01-09T09:00:00.000Z", count: 8 });
    expect(nextOccurrence({ ...rule, until: "2030-01-09T09:00:00.000Z" }, 0, now)).toEqual({ at: "2030-01-09T09:00:00.000Z", count: 8 });
    expect(nextOccurrence({ ...rule, until: "2030-01-09T08:59:59.999Z" }, 0, now)).toBeNull();
  });
});

describe("repeating posts", () => {
  const first = "2031-01-31T09:00:00.000Z";

  it("creates the next occurrence as its own scheduled post when one goes out", async () => {
    const post = await createPost({ content: "weekly note", thread: ["and a comment"], targets: [{ account_id: masto, content_override: "weekly, for mastodon" }, { account_id: sandbox }], publish_at: first, repeat: { every: "week" } }, network);
    expect(post.status).toBe("scheduled");
    expect(post.repeat).toEqual({ every: "week", until: null, timezone: null });
    expect(post.series).toEqual({ id: expect.stringMatching(/^ser_/), active: true });
    expect(await tick(network)).toBe(0);
    expect(inSeries(post.series!.id)).toHaveLength(1);

    due(post.id);
    await tick(network);
    const series = inSeries(post.series!.id);
    expect(series.map((p) => [p.status, p.publish_at])).toEqual([
      ["published", "2000-01-01T00:00:00.000Z"],
      ["scheduled", "2031-02-07T09:00:00.000Z"],
    ]);
    const next = series[1];
    expect(next.id).not.toBe(post.id);
    expect(next).toMatchObject({ content: "weekly note", thread: ["and a comment"], repeat: post.repeat, series: post.series });
    expect(next.targets.map((t) => [t.account_id, t.content_override, t.status])).toEqual([
      [masto, "weekly, for mastodon", "scheduled"],
      [sandbox, null, "scheduled"],
    ]);
    expect(sent.map((s) => s.status)).toEqual(["weekly, for mastodon", "and a comment"]);
  });

  it("creates it exactly once when several clocks and several targets race", async () => {
    const post = await createPost({ content: "race", targets: [{ account_id: sandbox }, { account_id: sandboxB }, { account_id: masto }], publish_at: first, repeat: { every: "day" } }, network);
    due(post.id);
    const ids = post.targets.map((t) => t.id);
    // Three ticks, and every target published directly as a second process would after reading the same due list.
    await Promise.all([tick(network), ...ids.map((id) => publishTarget(id, network)), tick(network), tick(network)]);
    expect(inSeries(post.series!.id).map((p) => p.status)).toEqual(["published", "scheduled"]);
    // The next one keeps the property when its own time comes.
    const second = inSeries(post.series!.id)[1];
    due(second.id);
    await Promise.all([tick(network), tick(network)]);
    expect(inSeries(post.series!.id).map((p) => p.status)).toEqual(["published", "published", "scheduled"]);
    expect(sent.map((s) => s.status)).toEqual(["race", "race"]);
  });

  it("carries on when an occurrence fails", async () => {
    const post = await createPost({ content: "doomed [fail]", targets: [{ account_id: sandbox }], publish_at: first, repeat: { every: "day" } });
    due(post.id);
    await tick();
    expect(inSeries(post.series!.id).map((p) => [p.status, p.publish_at])).toEqual([
      ["failed", "2000-01-01T00:00:00.000Z"],
      ["scheduled", "2031-02-01T09:00:00.000Z"],
    ]);
    // Retrying the failed one by hand does not create another.
    const failed = getPost(post.id)!;
    run("UPDATE posts SET content = 'fixed' WHERE id = ?", post.id);
    await retryTarget(post.id, failed.targets[0].id);
    expect(inSeries(post.series!.id)).toHaveLength(2);
  });

  it("lands on the last day of February and goes back to the 31st in March", async () => {
    const post = await createPost({ content: "monthly", targets: [{ account_id: sandbox }], publish_at: first, repeat: { every: "month" } });
    due(post.id);
    await tick();
    const february = inSeries(post.series!.id)[1];
    expect(february.publish_at).toBe("2031-02-28T09:00:00.000Z");
    due(february.id);
    await tick();
    const march = inSeries(post.series!.id).at(-1)!;
    expect(march.publish_at).toBe("2031-03-31T09:00:00.000Z");
    // Editing an occurrence without moving it does not re-date the series from the 28th.
    await updatePost(march.id, { content: "monthly, reworded" });
    due(march.id);
    await tick();
    const april = inSeries(post.series!.id).at(-1)!;
    expect([april.publish_at, april.content]).toEqual(["2031-04-30T09:00:00.000Z", "monthly, reworded"]);
  });

  it("stops by itself after the until date", async () => {
    const post = await createPost({ content: "twice", targets: [{ account_id: sandbox }], publish_at: first, repeat: { every: "day", until: "2031-02-01" } });
    expect(post.repeat!.until).toBe("2031-02-01T23:59:59.999Z");
    due(post.id);
    await tick();
    const second = inSeries(post.series!.id)[1];
    expect(second.publish_at).toBe("2031-02-01T09:00:00.000Z");
    due(second.id);
    await tick();
    const series = inSeries(post.series!.id);
    expect(series.map((p) => p.status)).toEqual(["published", "published"]);
    expect(series[0].series!.active).toBe(false);
  });

  it("sends one post, not a backlog, for a series whose times have passed", async () => {
    const weekAgo = new Date(Date.now() - 7 * 86_400_000 - 3_600_000).toISOString();
    const post = await createPost({ content: "late", targets: [{ account_id: sandbox }], publish_at: weekAgo, repeat: { every: "day" } });
    expect(post.status).toBe("published");
    const series = inSeries(post.series!.id);
    expect(series).toHaveLength(2);
    const wait = new Date(series[1].publish_at!).getTime() - Date.now();
    expect(wait).toBeGreaterThan(0);
    expect(wait).toBeLessThanOrEqual(86_400_000);
  });

  it("cancels one occurrence and leaves the series running", async () => {
    const post = await createPost({ content: "skip me", targets: [{ account_id: sandbox }], publish_at: first, repeat: { every: "week" } });
    const cancelled = cancelPost(post.id);
    expect(cancelled.status).toBe("cancelled");
    const series = inSeries(post.series!.id);
    expect(series.map((p) => [p.status, p.publish_at])).toEqual([
      ["cancelled", first],
      ["scheduled", "2031-02-07T09:00:00.000Z"],
    ]);
    expect(series[1].series!.active).toBe(true);
    due(post.id);
    expect(await tick()).toBe(0);
    // Removing a scheduled occurrence from the history does the same.
    expect(deletePost(series[1].id)).toBe(true);
    expect(inSeries(post.series!.id).map((p) => [p.status, p.publish_at])).toEqual([
      ["cancelled", "2000-01-01T00:00:00.000Z"],
      ["scheduled", "2031-02-14T09:00:00.000Z"],
    ]);
  });

  it("stops the whole series: the waiting occurrence is cancelled and no more are created", async () => {
    const post = await createPost({ content: "enough", targets: [{ account_id: sandbox }], publish_at: first, repeat: { every: "day" } });
    due(post.id);
    await tick();
    const [sentOne, waiting] = inSeries(post.series!.id);
    // Any post of the series will do, including one that already went out.
    const stopped = stopSeries(sentOne.id);
    expect(stopped.status).toBe("published");
    expect(stopped.repeat).toBeNull();
    expect(stopped.series).toEqual({ id: post.series!.id, active: false });
    expect(getPost(waiting.id)!.status).toBe("cancelled");
    due(waiting.id);
    expect(await tick()).toBe(0);
    expect(inSeries(post.series!.id)).toHaveLength(2);
    expect(() => stopSeries(sentOne.id)).toThrow("This series has already stopped.");
    const plain = await createPost({ content: "plain", targets: [{ account_id: sandbox }] });
    expect(() => stopSeries(plain.id)).toThrow("This post does not repeat, so there is no series to stop.");
  });

  it("stops an occurrence that is being sent from creating the next", async () => {
    const post = await createPost({ content: "last", targets: [{ account_id: sandbox }], publish_at: first, repeat: { every: "day" } });
    stopSeries(post.id);
    expect(getPost(post.id)!.status).toBe("cancelled");
    const again = await createPost({ content: "last", targets: [{ account_id: sandbox }], publish_at: first, repeat: { every: "day" } });
    // Published by hand after the series lost its repeat: it goes out and nothing follows.
    await updatePost(again.id, { repeat: null });
    await publishNow(again.id);
    expect(inSeries(again.series!.id).map((p) => p.status)).toEqual(["published"]);
  });

  it("publishing an occurrence early still lines up the one after it", async () => {
    const post = await createPost({ content: "early", targets: [{ account_id: sandbox }], publish_at: first, repeat: { every: "week" } });
    await publishNow(post.id);
    expect(inSeries(post.series!.id).map((p) => p.status).sort()).toEqual(["published", "scheduled"]);
    expect(inSeries(post.series!.id).find((p) => p.status === "scheduled")!.publish_at).toBe("2031-02-07T09:00:00.000Z");
  });

  it("an edit to one occurrence carries to the ones after it, and a new time re-dates them", async () => {
    const post = await createPost({ content: "v1", targets: [{ account_id: sandbox }], publish_at: first, repeat: { every: "day" } });
    const edited = await updatePost(post.id, { content: "v2", publish_at: "2031-03-10T12:00:00Z", repeat: { every: "week", timezone: "Europe/Paris" } });
    expect(edited.series!.id).toBe(post.series!.id);
    expect(edited.repeat).toEqual({ every: "week", until: null, timezone: "Europe/Paris" });
    due(post.id);
    await tick();
    const next = inSeries(post.series!.id).at(-1)!;
    expect([next.content, next.publish_at]).toEqual(["v2", "2031-03-17T12:00:00.000Z"]);
    // A post that did not repeat can be given a repeat by an edit.
    const plain = await createPost({ content: "plain", targets: [{ account_id: sandbox }], publish_at: first });
    expect(plain.series).toBeNull();
    const repeating = await updatePost(plain.id, { repeat: { every: "month" } });
    expect(repeating.series).toEqual({ id: expect.stringMatching(/^ser_/), active: true });
  });

  it("does not create an occurrence from a draft that is cancelled", async () => {
    const draft = await createPost({ content: "an agent's idea", targets: [{ account_id: sandbox }], publish_at: first, repeat: { every: "day" }, draft: true });
    expect(draft.status).toBe("draft");
    expect(draft.repeat).toEqual({ every: "day", until: null, timezone: null });
    expect(await tick()).toBe(0);
    cancelPost(draft.id);
    expect(inSeries(draft.series!.id).map((p) => p.status)).toEqual(["cancelled"]);
  });

  it("refuses a repeat it cannot keep, in plain words", async () => {
    const targets = [{ account_id: sandbox }];
    await expect(createPost({ content: "x", targets, repeat: { every: "week" } })).rejects.toThrow("A repeating post needs a first time. Set publish_at as well.");
    await expect(createPost({ content: "x", targets, publish_at: first, repeat: { every: "fortnight" as "week" } })).rejects.toThrow('repeat.every must be "day", "week" or "month".');
    await expect(createPost({ content: "x", targets, publish_at: first, repeat: { every: "week", timezone: "Mars/Olympus" } })).rejects.toThrow(/is not a time zone Broadside knows/);
    await expect(createPost({ content: "x", targets, publish_at: first, repeat: { every: "week", until: "2030-01-01" } })).rejects.toThrow("repeat.until is earlier than the first occurrence.");
    await expect(createPost({ content: "x", targets, publish_at: first, repeat: { every: "week", until: "2031-06-01T09:00:00" } })).rejects.toThrow(/has no time zone/);
  });
});

/* A database from before threads and repeats ------------------------------ */

describe("migrating an existing database", () => {
  it("adds the new columns in place, keeps the old rows, and is safe to run again", () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), "broadside-old-")), "broadside.db");
    const old = new DatabaseSync(file);
    // SCHEMA is the first release's tables; everything since arrives through migrate().
    old.exec(SCHEMA);
    const columns = (table: string) => old.prepare(`PRAGMA table_info(${table})`).all().map((c) => String(c.name));
    expect(columns("posts")).not.toContain("thread");
    expect(columns("targets")).not.toContain("parts_done");
    old.exec("INSERT INTO posts (id, content, created_at, updated_at) VALUES ('post_old', 'from before', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')");
    old.exec("INSERT INTO targets (id, post_id, account_id, platform, handle, status, external_id, external_url) VALUES ('tgt_sent', 'post_old', 'acc_1', 'mastodon', '@me', 'published', '9', 'https://m.example/@me/9')");
    old.exec("INSERT INTO targets (id, post_id, account_id, platform, handle, status) VALUES ('tgt_failed', 'post_old', 'acc_2', 'sandbox', 'One', 'failed')");

    migrate(old);
    migrate(old);

    expect(columns("posts")).toEqual(expect.arrayContaining(["thread", "series_id", "repeat_every", "repeat_until", "repeat_zone", "repeat_anchor", "repeat_count", "repeat_spawned"]));
    expect(columns("targets")).toEqual(expect.arrayContaining(["parts", "parts_done"]));
    const post = { ...old.prepare("SELECT content, thread, series_id, repeat_every, repeat_spawned FROM posts WHERE id = 'post_old'").get() };
    expect(post).toEqual({ content: "from before", thread: "[]", series_id: null, repeat_every: null, repeat_spawned: 0 });
    const targets = old.prepare("SELECT id, parts, parts_done FROM targets ORDER BY id").all().map((row) => ({ ...row }));
    // A target that had gone out counts as one part done, with the id a later reply would need.
    expect(targets).toEqual([
      { id: "tgt_failed", parts: "[]", parts_done: 0 },
      { id: "tgt_sent", parts: '[{"id":"9","url":"https://m.example/@me/9"}]', parts_done: 1 },
    ]);
    old.close();
  });

  it("opens this test's own database through the same path", () => {
    expect(all<{ name: string }>("PRAGMA table_info(targets)").map((c) => c.name)).toEqual(expect.arrayContaining(["parts", "parts_done"]));
  });
});
