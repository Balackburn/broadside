import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

process.env.BROADSIDE_DATA_DIR = mkdtempSync(path.join(tmpdir(), "broadside-analytics-"));
process.env.BROADSIDE_SECRET = "test-secret";
// The stand-in networks in this file are not real hosts.
process.env.BROADSIDE_ALLOW_PRIVATE_FETCH = "1";

const { connectAccount, credentialsOf, InputError, listAccounts, removeAccount } = await import("@/lib/accounts");
const { analytics, BACKGROUND_DAYS, collectDue, dueReadings, parsePeriod, postAnalytics, readTarget, refreshPost } = await import("@/lib/analytics");
const { seal } = await import("@/lib/crypto");
const { all, get, run } = await import("@/lib/db");
const { createPost, getPost } = await import("@/lib/posts");
const { readNumbers, tick } = await import("@/lib/scheduler");

const MINUTE = 60_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

/**
 * Stands in for Mastodon. It publishes statuses, and answers a read of one
 * with `counts`, or the way `mode` says. Every read of a status is recorded,
 * so a test can prove a network was or was not asked.
 */
let mode: "ok" | "gone" | "limited" | "limited-no-wait" | "hang" = "ok";
let counts = { favourites_count: 3, reblogs_count: 1, replies_count: 0 };
let sent = 0;
const reads: string[] = [];
let release: (() => void) | null = null;
const mastodon = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
  const url = String(input);
  if (url.endsWith("verify_credentials")) return Response.json({ acct: "me", avatar: null });
  if (init.method === "POST") {
    sent++;
    return Response.json({ id: String(sent), url: `https://m.example/@me/${sent}` });
  }
  reads.push(url);
  if (mode === "gone") return Response.json({ error: "Record not found" }, { status: 404 });
  if (mode === "limited") return Response.json({ error: "Too many requests" }, { status: 429, headers: { "retry-after": "120" } });
  if (mode === "limited-no-wait") return Response.json({ error: "Too many requests" }, { status: 429 });
  if (mode === "hang") await new Promise<void>((resolve) => (release = resolve));
  return Response.json({ id: url.split("/").pop(), ...counts });
}) as typeof fetch;

let masto: string;
let sandbox: string;

beforeAll(async () => {
  masto = (await connectAccount("mastodon", { instance: "https://m.example", access_token: "secret-token" }, mastodon)).id;
  sandbox = (await connectAccount("sandbox", { name: "Rehearsal" })).id;
});

beforeEach(() => {
  mode = "ok";
  counts = { favourites_count: 3, reblogs_count: 1, replies_count: 0 };
  reads.length = 0;
  // Each test starts with nothing published, so what is due is only what the test made.
  run("DELETE FROM posts");
  run("DELETE FROM metric_backoff");
});

const publish = async (content: string, accounts = [masto]) => createPost({ content, targets: accounts.map((account_id) => ({ account_id })) }, mastodon);
const targetOf = (post: Awaited<ReturnType<typeof publish>>, platform = "mastodon") => post.targets.find((t) => t.platform === platform)!;
/** Moves the moment a target was last tried into the past, as if that much time had gone by. */
const age = (targetId: string, ms: number) => run("UPDATE metric_state SET attempted_at = ? WHERE target_id = ?", ago(ms), targetId);
const readingsOf = (targetId: string) => all<{ since: string; read_at: string; metrics: string }>("SELECT since, read_at, metrics FROM metric_readings WHERE target_id = ? ORDER BY read_at", targetId);

describe("reading numbers", () => {
  it("reads a published target from its network and stores the reading with its time", async () => {
    const post = await publish("hello", [masto, sandbox]);
    const before = Date.now();
    const outcomes = await collectDue(mastodon);
    expect(outcomes).toEqual([{ target_id: targetOf(post).id, outcome: "read", message: null }]);
    expect(reads).toEqual([`https://m.example/api/v1/statuses/${targetOf(post).external_id}`]);

    const numbers = postAnalytics(post.id).targets;
    const read = numbers.find((n) => n.platform === "mastodon")!;
    expect(read.metrics).toEqual([
      { kind: "likes", label: "Favourites", value: 3 },
      { kind: "comments", label: "Replies", value: 0 },
      { kind: "shares", label: "Boosts", value: 1 },
    ]);
    expect(Date.parse(read.as_of!)).toBeGreaterThanOrEqual(before);
    expect(read.error).toBeNull();
    expect(read.network).toBe("Mastodon");
  });

  it("says a network has no numbers instead of showing zeros for it", async () => {
    const post = await publish("hello", [masto, sandbox]);
    await collectDue(mastodon);
    const rehearsal = postAnalytics(post.id).targets.find((n) => n.platform === "sandbox")!;
    expect(rehearsal).toMatchObject({ available: false, unavailable_reason: "The sandbox publishes nowhere, so there is nothing to count.", metrics: [], as_of: null });
    // Asking for it by hand reads nothing and says why.
    const asked = await readTarget(targetOf(post, "sandbox").id, mastodon, { manual: true });
    expect(asked).toMatchObject({ outcome: "skipped", message: "Numbers are not available for Sandbox. The sandbox publishes nowhere, so there is nothing to count." });
  });

  it("reads nothing for a post that has not gone out", async () => {
    const draft = await createPost({ content: "later", targets: [{ account_id: masto }], draft: true }, mastodon);
    expect(dueReadings()).toEqual([]);
    expect(postAnalytics(draft.id).targets).toEqual([]);
    await expect(refreshPost(draft.id, mastodon)).rejects.toThrow("Nothing from this post has been published yet");
    expect(() => postAnalytics("post_nothing")).toThrow(InputError);
  });
});

describe("the hourly limit", () => {
  it("reads a target at most once an hour in the background", async () => {
    const post = await publish("hourly");
    const id = targetOf(post).id;
    await collectDue(mastodon);
    expect(reads).toHaveLength(1);

    // The next ticks find nothing due and ask the network nothing.
    expect(dueReadings()).toEqual([]);
    expect(await collectDue(mastodon)).toEqual([]);
    expect(await readTarget(id, mastodon)).toMatchObject({ outcome: "skipped", message: "These numbers were read within the last hour." });
    age(id, 59 * MINUTE);
    expect(dueReadings()).toEqual([]);
    expect(reads).toHaveLength(1);

    age(id, 61 * MINUTE);
    expect(dueReadings()).toEqual([id]);
    counts = { favourites_count: 8, reblogs_count: 1, replies_count: 2 };
    await collectDue(mastodon);
    expect(reads).toHaveLength(2);
    // Both readings are kept, each with its own time; the newest is the one shown.
    expect(readingsOf(id)).toHaveLength(2);
    expect(readingsOf(id)[0].read_at < readingsOf(id)[1].since).toBe(true);
    expect(postAnalytics(post.id).targets[0].metrics[0]).toEqual({ kind: "likes", label: "Favourites", value: 8 });
  });

  it("lets a person refresh sooner, but not twice in a moment", async () => {
    const post = await publish("on demand");
    const id = targetOf(post).id;
    await collectDue(mastodon);
    const again = await refreshPost(post.id, mastodon);
    expect(again.refreshed).toEqual([{ target_id: id, outcome: "skipped", reason: "recent", message: "These numbers were read a moment ago." }]);
    expect(reads).toHaveLength(1);
    age(id, MINUTE);
    const later = await refreshPost(post.id, mastodon);
    expect(later.refreshed[0].outcome).toBe("read");
    expect(reads).toHaveLength(2);
    // The numbers had not changed, so the reading is the same row read again: its time moved on, and when it was first seen stayed.
    const [only, ...others] = readingsOf(id);
    expect(others).toEqual([]);
    expect(later.targets[0].as_of).toBe(only.read_at);
    expect(only.read_at > only.since).toBe(true);
  });

  it("reads a few targets per sweep, the ones waiting longest first", async () => {
    const posts = [];
    for (let i = 0; i < 5; i++) posts.push(await publish(`post ${i}`));
    expect(await collectDue(mastodon)).toHaveLength(3);
    expect(await collectDue(mastodon)).toHaveLength(2);
    expect(await collectDue(mastodon)).toHaveLength(0);
    expect(reads).toHaveLength(5);
    // An hour on, the one tried first comes round first.
    for (const [i, post] of posts.entries()) age(targetOf(post).id, (120 - i) * MINUTE);
    expect(dueReadings(1)).toEqual([targetOf(posts[0]).id]);
  });

  it("leaves posts older than 30 days to a person, and stops for an account that was disconnected", async () => {
    const old = await publish("old");
    run("UPDATE targets SET published_at = ? WHERE id = ?", ago((BACKGROUND_DAYS + 1) * 24 * 60 * MINUTE), targetOf(old).id);
    expect(dueReadings()).toEqual([]);
    expect((await refreshPost(old.id, mastodon)).refreshed[0].outcome).toBe("read");

    const extra = (await connectAccount("mastodon", { instance: "https://m.example", access_token: "other" }, mastodon)).id;
    const orphan = await publish("orphan", [extra]);
    removeAccount(extra);
    expect(dueReadings()).toEqual([]);
    expect((await refreshPost(orphan.id, mastodon)).refreshed[0]).toMatchObject({ outcome: "skipped", message: "This account was disconnected, so its numbers can no longer be read." });
  });
});

describe("a failed reading", () => {
  it("keeps the last good reading and records why the new one failed", async () => {
    const post = await publish("keeps");
    const id = targetOf(post).id;
    await collectDue(mastodon);
    const good = postAnalytics(post.id).targets[0];

    mode = "gone";
    age(id, 61 * MINUTE);
    const before = Date.now();
    expect(await collectDue(mastodon)).toEqual([{ target_id: id, outcome: "failed", message: "Mastodon answered 404: Record not found" }]);
    const after = postAnalytics(post.id).targets[0];
    expect(after.metrics).toEqual(good.metrics);
    expect(after.as_of).toBe(good.as_of);
    expect(after.error!.message).toBe("Mastodon answered 404: Record not found");
    expect(Date.parse(after.error!.at)).toBeGreaterThanOrEqual(before);
    expect(readingsOf(id)).toHaveLength(1);
    // A failed reading is a fact about the numbers, not about the account: posting is untouched.
    expect(listAccounts().find((a) => a.id === masto)!.status).toBe("active");

    mode = "ok";
    counts = { favourites_count: 4, reblogs_count: 1, replies_count: 0 };
    age(id, 61 * MINUTE);
    await collectDue(mastodon);
    expect(postAnalytics(post.id).targets[0].error).toBeNull();
    expect(postAnalytics(post.id).targets[0].as_of! > good.as_of!).toBe(true);
    expect(readingsOf(id)).toHaveLength(2);
  });

  it("records the reason even when nothing was ever read", async () => {
    mode = "gone";
    const post = await publish("never read");
    await collectDue(mastodon);
    expect(postAnalytics(post.id).targets[0]).toMatchObject({ metrics: [], as_of: null, error: { message: "Mastodon answered 404: Record not found" } });
  });
});

describe("backing off", () => {
  it("pauses the whole account for as long as the network asks after a 429", async () => {
    const first = await publish("one");
    const second = await publish("two");
    mode = "limited";
    const outcomes = await collectDue(mastodon);
    // The first 429 pauses the account, so the second target is not asked in the same sweep.
    expect(outcomes.map((o) => o.outcome)).toEqual(["failed", "skipped"]);
    expect(reads).toHaveLength(1);
    // The newest post is read first, so it is the one that met the 429.
    expect(outcomes[0].target_id).toBe(targetOf(second).id);
    const pause = get<{ until: string; strikes: number }>("SELECT until, strikes FROM metric_backoff WHERE account_id = ?", masto)!;
    expect(Date.parse(pause.until) - Date.now()).toBeGreaterThan(110_000);
    expect(Date.parse(pause.until) - Date.now()).toBeLessThanOrEqual(120_000);

    // While paused nothing is due, and a person's refresh is told to wait without the network being asked.
    mode = "ok";
    expect(dueReadings()).toEqual([]);
    const asked = await refreshPost(first.id, mastodon);
    expect(asked.refreshed[0]).toMatchObject({ outcome: "skipped", reason: "paused" });
    expect(asked.refreshed[0].message).toContain("Mastodon asked Broadside to slow down");
    expect(asked.targets[0].paused_until).toBe(pause.until);
    expect(reads).toHaveLength(1);
    expect(postAnalytics(second.id).targets[0].error!.message).toBe("Mastodon answered 429: Too many requests");

    // Once the wait is over the account is read again, and a good reading clears the pause.
    run("UPDATE metric_backoff SET until = ? WHERE account_id = ?", ago(1000), masto);
    expect(dueReadings()).toEqual([targetOf(first).id]);
    await collectDue(mastodon);
    expect(get("SELECT 1 AS paused FROM metric_backoff WHERE account_id = ?", masto)).toBeUndefined();
  });

  it("waits longer each time when the network names no wait", async () => {
    const post = await publish("doubling");
    const id = targetOf(post).id;
    mode = "limited-no-wait";
    const waits: number[] = [];
    for (let strike = 0; strike < 3; strike++) {
      run("UPDATE metric_backoff SET until = ? WHERE account_id = ?", ago(1000), masto);
      age(id, 61 * MINUTE);
      await collectDue(mastodon);
      waits.push(Math.round((Date.parse(get<{ until: string }>("SELECT until FROM metric_backoff WHERE account_id = ?", masto)!.until) - Date.now()) / MINUTE));
    }
    expect(waits).toEqual([15, 30, 60]);
  });
});

describe("beside publishing", () => {
  it("never holds up a post that is due while a network is slow to report numbers", async () => {
    const earlier = await publish("already out");
    mode = "hang";
    // The clock starts a sweep and does not wait for it.
    const reading = readNumbers(mastodon);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(reads).toHaveLength(1);

    const due = await createPost({ content: "due now", targets: [{ account_id: masto }, { account_id: sandbox }], publish_at: new Date(Date.now() + 1500).toISOString() }, mastodon);
    expect(due.status).toBe("scheduled");
    run("UPDATE posts SET publish_at = ? WHERE id = ?", ago(1000), due.id);
    const sentBefore = sent;
    expect(await tick(mastodon)).toBe(2);
    expect(getPost(due.id)!.status).toBe("published");
    expect(sent).toBe(sentBefore + 1);

    // The reading is still waiting on its network, and a second sweep does not pile up behind it.
    expect(await Promise.race([reading, new Promise((resolve) => setTimeout(() => resolve("still reading"), 20))])).toBe("still reading");
    expect(await readNumbers(mastodon)).toBe(0);
    release!();
    expect(await reading).toBeGreaterThanOrEqual(1);
    expect(postAnalytics(earlier.id).targets[0].as_of).not.toBeNull();
  });

  it("saves tokens a network renewed while its numbers were read", async () => {
    // A YouTube channel whose hour-long access token has run out, with a published video.
    const id = "acc_youtube_test";
    run("INSERT INTO accounts (id, platform, label, handle, credentials, created_at) VALUES (?, 'youtube', 'YouTube', 'Channel', ?, ?)", id, seal({ client_id: "cid", client_secret: "sec", refresh_token: "yt-refresh", access_token: "yt-old", expires_at: ago(1000) }), ago(0));
    run("INSERT INTO posts (id, content, created_at, updated_at) VALUES ('post_yt', 'a video', ?, ?)", ago(0), ago(0));
    run("INSERT INTO targets (id, post_id, account_id, platform, handle, status, external_id, published_at) VALUES ('tgt_yt', 'post_yt', ?, 'youtube', 'Channel', 'published', 'vid1', ?)", id, ago(0));
    const google = (async (input: RequestInfo | URL) =>
      String(input).includes("oauth2.googleapis.com") ? Response.json({ access_token: "yt-new", expires_in: 3599 }) : Response.json({ items: [{ statistics: { viewCount: "12", likeCount: "3", commentCount: "1" } }] })) as typeof fetch;
    expect((await readTarget("tgt_yt", google)).outcome).toBe("read");
    expect(credentialsOf(id).access_token).toBe("yt-new");
    expect(postAnalytics("post_yt").targets[0].metrics.map((m) => [m.label, m.value])).toEqual([["Views", 12], ["Likes", 3], ["Comments", 1]]);
    removeAccount(id);
  });
});

describe("the overview", () => {
  /** A published target with a stored reading, placed straight in the database: the overview reads only what is stored. */
  let n = 0;
  function stored(platform: string, metrics: [string, string, number][] | null, options: { daysAgo?: number; account?: string; tag?: string; error?: string; note?: string; content?: string } = {}) {
    n++;
    const at = ago((options.daysAgo ?? 1) * 24 * 60 * MINUTE);
    const post = `post_o${n}`;
    const target = `tgt_o${n}`;
    run("INSERT INTO posts (id, content, created_at, updated_at) VALUES (?, ?, ?, ?)", post, options.content ?? `post ${n}`, at, at);
    run("INSERT INTO targets (id, post_id, account_id, platform, handle, status, external_id, external_url, published_at) VALUES (?, ?, ?, ?, ?, 'published', ?, ?, ?)", target, post, options.account ?? `acc_${platform}`, platform, `@${platform}`, `ext${n}`, `https://example.com/${n}`, at);
    if (metrics) run("INSERT INTO metric_readings (id, target_id, since, read_at, metrics, note) VALUES (?, ?, ?, ?, ?, ?)", `rdg_o${n}`, target, ago(n * MINUTE), ago(n * MINUTE), JSON.stringify(metrics.map(([kind, label, value]) => ({ kind, label, value }))), options.note ?? null);
    if (options.error) run("INSERT INTO metric_state (target_id, attempted_at, error, error_at) VALUES (?, ?, ?, ?)", target, ago(0), options.error, ago(0));
    if (options.tag) {
      run("INSERT OR IGNORE INTO tags (id, name, name_key, created_at) VALUES (?, ?, ?, ?)", `tag_${options.tag}`, options.tag, options.tag.toLowerCase(), at);
      run("INSERT INTO post_tags (post_id, tag_id) VALUES (?, ?)", post, `tag_${options.tag}`);
    }
    return { post, target };
  }
  const total = (data: ReturnType<typeof analytics>, kind: string) => data.totals.find((t) => t.kind === kind);

  it("adds up one kind at a time, and never views with impressions or a score with likes", () => {
    stored("x", [["impressions", "Impressions", 5000], ["likes", "Likes", 40], ["comments", "Replies", 4]]);
    stored("youtube", [["views", "Views", 900], ["likes", "Likes", 25], ["comments", "Comments", 6]]);
    stored("mastodon", [["likes", "Favourites", 10], ["comments", "Replies", 1], ["shares", "Boosts", 2]]);
    stored("reddit", [["comments", "Comments", 3], ["score", "Score", 17]]);
    const data = analytics({ days: 7 });
    expect(data.posts).toBe(4);
    expect(data.totals.map((t) => [t.kind, t.value])).toEqual([["views", 900], ["impressions", 5000], ["likes", 75], ["comments", 14], ["shares", 2], ["score", 17]]);
    // Each share of a total carries the word its network uses.
    expect(total(data, "likes")!.networks.map((p) => [p.network, p.label, p.value])).toEqual([["X", "Likes", 40], ["Mastodon", "Favourites", 10], ["YouTube", "Likes", 25]]);
    expect(total(data, "likes")!.targets).toBe(3);
    // No figure on the screen is a mix: there is no total of everything.
    expect(data.totals.some((t) => t.value === 900 + 5000)).toBe(false);
  });

  it("names the networks missing from each total, and why", () => {
    stored("x", [["impressions", "Impressions", 5000], ["likes", "Likes", 40]]);
    stored("youtube", [["views", "Views", 900]]);
    stored("telegram", null);
    stored("linkedin", null);
    stored("reddit", [["score", "Score", 17]]);
    stored("bluesky", null);
    stored("threads", null, { error: "Threads answered 400: (#10) Application does not have permission for this action" });
    stored("facebook", [["likes", "Reactions", 2]], { note: "Views and clicks were not read. They need the permission read_insights." });
    const data = analytics({ days: 30 });
    const why = (kind: string) => Object.fromEntries(total(data, kind)!.missing.map((x) => [x.platform, x.reason]));
    expect(why("views")).toEqual({
      x: "X does not report views.",
      bluesky: "Bluesky does not report views.",
      threads: "No reading yet. The last try failed: Threads answered 400: (#10) Application does not have permission for this action",
      linkedin: "Not available for LinkedIn. LinkedIn gives post statistics only to apps it has approved for its Community Management API. An app with Share on LinkedIn alone cannot read them.",
      facebook: "Views and clicks were not read. They need the permission read_insights.",
      reddit: "Reddit does not report views.",
      telegram: "Not available for Telegram. Telegram's Bot API has no way to ask for a message's views or reactions.",
    });
    expect(why("likes").youtube).toBe("YouTube gave no likes in its last reading.");
    expect(why("likes").bluesky).toBe("No reading yet.");
    expect(why("likes").reddit).toBe("Reddit does not report likes.");
    expect(why("score").x).toBe("X does not report a score.");

    // The breakdown lists every network with posts in the period, readable or not.
    const networks = Object.fromEntries(data.networks.map((x) => [x.platform, x]));
    expect(networks.telegram).toMatchObject({ available: false, targets: 1, read: 0, metrics: [] });
    expect(networks.threads).toMatchObject({ available: true, read: 0, failing: 1, as_of_newest: null });
    expect(networks.x.metrics).toEqual([{ kind: "impressions", label: "Impressions", value: 5000 }, { kind: "likes", label: "Likes", value: 40 }]);
  });

  it("says when only some of a network's posts are in a total", () => {
    stored("mastodon", [["likes", "Favourites", 10]]);
    stored("mastodon", null);
    const likes = total(analytics({ days: 7 }), "likes")!;
    expect(likes.value).toBe(10);
    expect(likes.targets).toBe(1);
    expect(likes.missing).toEqual([{ platform: "mastodon", network: "Mastodon", reason: "1 of 2 Mastodon posts has no reading with this count yet." }]);
  });

  it("covers the chosen period, and filters by account and by tag", () => {
    const recent = stored("mastodon", [["likes", "Favourites", 1]], { daysAgo: 2, account: "acc_a", tag: "Launch" });
    stored("mastodon", [["likes", "Favourites", 10]], { daysAgo: 20, account: "acc_b" });
    stored("mastodon", [["likes", "Favourites", 100]], { daysAgo: 60, account: "acc_a" });
    stored("mastodon", [["likes", "Favourites", 1000]], { daysAgo: 120, account: "acc_a" });
    const likes = (filter: Parameters<typeof analytics>[0]) => total(analytics(filter), "likes")?.value;
    expect(likes({ days: 7 })).toBe(1);
    expect(likes({ days: 30 })).toBe(11);
    expect(likes({ days: 90 })).toBe(111);
    expect(likes({ days: 90, account_id: "acc_a" })).toBe(101);
    expect(likes({ days: 90, tag: "launch" })).toBe(1);
    expect(analytics({ days: 90, tag: "nothing" })).toMatchObject({ posts: 0, totals: [], networks: [], rows: [] });
    const row = analytics({ days: 7 }).rows[0];
    expect(row).toMatchObject({ post_id: recent.post, target_id: recent.target, platform: "mastodon", handle: "@mastodon", url: expect.stringContaining("https://example.com/") });
    expect(parsePeriod("90")).toBe(90);
    expect(parsePeriod(null)).toBe(30);
    expect(() => parsePeriod("14")).toThrow("period must be 7, 30 or 90 (days).");
  });

  it("shows nothing at all when nothing is published: no sample rows, no zeros", () => {
    expect(analytics({ days: 30 })).toMatchObject({ posts: 0, targets: 0, totals: [], networks: [], rows: [] });
  });
});
