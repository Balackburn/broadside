import { credentialsOf, getAccount, InputError, markAccount, saveCredentials } from "./accounts";
import { newId } from "./crypto";
import { all, db, get, now, run } from "./db";
import { groupTargets } from "./groups";
import { getMedia, toItem, type Media } from "./media";
import { guardedFetch } from "./net";
import { listening, queueEvent, type EventName } from "./outgoing";
import { connector, fits, measure, optionProblems, problems, threadProblems } from "./platforms";
import { PublishError, type PartRef } from "./platforms/types";
import { EVERY, isTimeZone, nextOccurrence, type Every } from "./repeat";
import { copyPostTags, parseTags, setPostTags, tagKey, tagsOf } from "./tags";

export type TargetStatus = "draft" | "scheduled" | "pending" | "publishing" | "retrying" | "published" | "failed" | "cancelled";
export type PostStatus = "draft" | "scheduled" | "publishing" | "published" | "partial" | "failed" | "cancelled";

/** A part behind one that is still being sent, or that failed, is "waiting": it goes out once the part before it has. */
export type PartStatus = TargetStatus | "waiting";
export type Part = { part: number; status: PartStatus; id: string | null; url: string | null };

export type Repeat = { every: Every; until: string | null; timezone: string | null };
export type RepeatInput = { every: Every; until?: string | null; timezone?: string | null };

export type Target = {
  id: string;
  account_id: string;
  platform: string;
  handle: string;
  content_override: string | null;
  options: Record<string, unknown>;
  status: TargetStatus;
  error: string | null;
  external_id: string | null;
  url: string | null;
  attempts: number;
  published_at: string | null;
  /** One entry per part, the main post first (part 1). A post with no thread has exactly one. */
  parts: Part[];
};

export type Post = {
  id: string;
  content: string;
  /** The parts that follow the main text, each published as a reply to the one before. */
  thread: string[];
  media: Media[];
  /** The names of the tags this post carries, in alphabetical order. */
  tags: string[];
  status: PostStatus;
  publish_at: string | null;
  /** Where the post came from: "ui", "api", "mcp", or "feed" for one made from a feed item. */
  origin: string;
  /** The feed that made this post. `title` is null once that feed has been deleted. */
  feed: { id: string; title: string | null } | null;
  /** Why a draft made from a feed item is being held: it does not fit a network it was meant for. Null on every other post. */
  held_reason: string | null;
  /** The team member who wrote the post. Null without a team, for a post a feed made, and for one made with a key that belongs to no one. `name` is null once that member has been removed. */
  author: { id: string; name: string | null } | null;
  created_at: string;
  updated_at: string;
  /** Set while this occurrence is due to be followed by another. */
  repeat: Repeat | null;
  /** The repeating series this post is an occurrence of. `active` is false once nothing more will come of it. */
  series: { id: string; active: boolean } | null;
  targets: Target[];
};

export type TargetInput = { account_id: string; content_override?: string | null; options?: Record<string, unknown> };

export type PostInput = {
  content: string;
  /** The accounts to post to. Leave out when `group_id` names them. */
  targets?: TargetInput[];
  /** A group of accounts, as another way to name the targets: every account in the group right now. */
  group_id?: string | null;
  thread?: string[];
  media_ids?: string[];
  /** Tag names. A tag that does not exist yet is created. */
  tags?: string[];
  publish_at?: string | null;
  repeat?: RepeatInput | null;
  draft?: boolean;
  idempotency_key?: string;
  origin?: "ui" | "api" | "mcp";
};

type PostRow = {
  id: string;
  content: string;
  media: string;
  thread: string;
  state: string;
  publish_at: string | null;
  origin: string;
  created_at: string;
  updated_at: string;
  series_id: string | null;
  repeat_every: Every | null;
  repeat_until: string | null;
  repeat_zone: string | null;
  repeat_anchor: string | null;
  repeat_count: number;
  repeat_spawned: number;
  feed_id: string | null;
  held_reason: string | null;
  created_by: string | null;
};
type TargetRow = Omit<Target, "options" | "url" | "parts"> & { options: string; external_url: string | null; post_id: string; parts: string; parts_done: number };

const MAX_ATTEMPTS = 3;

/** What only Broadside itself says about a post it makes. It is a separate argument so nothing in a request body can set it. */
type Internal = {
  /** The feed this post was made from. Its origin is then "feed". */
  feed_id?: string;
  /** Save the post as a held draft, with the reason, when it does not fit a network, instead of refusing it. */
  hold?: boolean;
  /** The team member writing the post, from the session or the key that made the request. */
  created_by?: string | null;
};

/**
 * Tells the outgoing webhooks that something happened to a post. It only
 * queues rows; the scheduler sends them. Whatever goes wrong here is logged
 * and goes no further, so a webhook can never hold up or fail a publish.
 */
function announce(event: EventName, postId: string, targetId?: string): void {
  try {
    if (!listening(event)) return;
    const post = getPost(postId);
    if (post) queueEvent(event, post, targetId ? post.targets.find((t) => t.id === targetId) : undefined);
  } catch (error) {
    console.error("[broadside] could not queue an outgoing webhook event:", (error as Error).message);
  }
}

/**
 * Announces how a post ended up once every target has settled: published,
 * partly published or failed. The mark on the post is a compare-and-set, so
 * the outcome is announced once however many targets or processes finish
 * together, and again only when a retry changes it.
 */
function announceOutcome(postId: string): void {
  try {
    const post = getPost(postId);
    if (!post || (post.status !== "published" && post.status !== "partial" && post.status !== "failed")) return;
    const mark = `${post.status}:${post.targets.reduce((sum, t) => sum + t.attempts, 0)}`;
    if (run("UPDATE posts SET announced = ? WHERE id = ? AND COALESCE(announced, '') <> ?", mark, postId, mark)) announce(`post.${post.status}`, postId);
  } catch (error) {
    console.error("[broadside] could not announce a post's outcome:", (error as Error).message);
  }
}

/** One status for the whole post, derived from its targets so the two can never disagree. */
export function aggregate(statuses: TargetStatus[]): PostStatus {
  const has = (s: TargetStatus) => statuses.includes(s);
  const every = (s: TargetStatus) => statuses.length > 0 && statuses.every((x) => x === s);
  if (every("draft")) return "draft";
  if (every("cancelled")) return "cancelled";
  if (has("pending") || has("publishing")) return "publishing";
  if (has("scheduled") || has("retrying")) return "scheduled";
  const live = statuses.filter((s) => s !== "cancelled");
  if (live.every((s) => s === "published")) return "published";
  if (live.every((s) => s === "failed")) return "failed";
  return "partial";
}

function partStatus(status: TargetStatus, index: number, done: number): PartStatus {
  if (index < done) return "published";
  if (index > done && (status === "publishing" || status === "retrying" || status === "failed")) return "waiting";
  return status;
}

/** Whether any occurrence of a series can still be followed by another. */
const seriesActive = (id: string): boolean => Boolean(get("SELECT 1 AS live FROM posts WHERE series_id = ? AND repeat_every IS NOT NULL AND repeat_spawned = 0 LIMIT 1", id));

/** The name a feed goes by: its own title, or its host until it has one. Null when the feed is gone. */
function feedTitle(id: string): string | null {
  const feed = get<{ title: string | null; url: string }>("SELECT title, url FROM feeds WHERE id = ?", id);
  if (!feed) return null;
  return feed.title || new URL(feed.url).host;
}

const memberName = (id: string): string | null => get<{ name: string }>("SELECT name FROM members WHERE id = ?", id)?.name ?? null;

function hydrate(row: PostRow): Post {
  const thread = JSON.parse(row.thread) as string[];
  const targets = all<TargetRow>("SELECT * FROM targets WHERE post_id = ? ORDER BY rowid", row.id).map((t): Target => {
    const sent = JSON.parse(t.parts) as PartRef[];
    return {
      id: t.id,
      account_id: t.account_id,
      platform: t.platform,
      handle: t.handle,
      content_override: t.content_override,
      options: JSON.parse(t.options),
      status: t.status,
      error: t.error,
      external_id: t.external_id,
      url: t.external_url,
      attempts: t.attempts,
      published_at: t.published_at,
      parts: Array.from({ length: thread.length + 1 }, (_, i) => ({ part: i + 1, status: partStatus(t.status, i, sent.length), id: sent[i]?.id ?? null, url: sent[i]?.url ?? null })),
    };
  });
  const media = (JSON.parse(row.media) as string[]).map((id) => getMedia(id)).filter((m): m is Media => Boolean(m));
  const status = aggregate(targets.map((t) => t.status));
  return {
    id: row.id,
    content: row.content,
    thread,
    media,
    tags: tagsOf(row.id),
    // A thread that stopped part of the way is out there: the post is partly published, whatever its targets say.
    status: (status === "failed" || status === "cancelled") && targets.some((t) => t.parts[0].status === "published") ? "partial" : status,
    publish_at: row.publish_at,
    origin: row.origin,
    feed: row.feed_id ? { id: row.feed_id, title: feedTitle(row.feed_id) } : null,
    held_reason: row.held_reason ?? null,
    author: row.created_by ? { id: row.created_by, name: memberName(row.created_by) } : null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    repeat: row.repeat_every ? { every: row.repeat_every, until: row.repeat_until, timezone: row.repeat_zone } : null,
    series: row.series_id ? { id: row.series_id, active: seriesActive(row.series_id) } : null,
    targets,
  };
}

export function getPost(id: string): Post | undefined {
  const row = get<PostRow>("SELECT * FROM posts WHERE id = ?", id);
  return row && hydrate(row);
}

export function listPosts(filter: { status?: PostStatus; limit?: number; from?: string; to?: string; tag?: string; origin?: string; feed_id?: string } = {}): Post[] {
  // Where a post came from is a column, so those two filters are applied before the newest 500 are taken, not after.
  const where: string[] = [];
  const params: string[] = [];
  if (filter.origin) {
    where.push("origin = ?");
    params.push(filter.origin);
  }
  if (filter.feed_id) {
    where.push("feed_id = ?");
    params.push(filter.feed_id);
  }
  const rows = all<PostRow>(`SELECT * FROM posts ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY COALESCE(publish_at, created_at) DESC LIMIT 500`, ...params);
  // A tag is matched by name, whatever its case.
  const wanted = filter.tag ? tagKey(filter.tag.trim()) : null;
  return rows
    .map(hydrate)
    .filter((p) => !filter.status || p.status === filter.status)
    .filter((p) => !wanted || p.tags.some((name) => tagKey(name) === wanted))
    .filter((p) => {
      const when = p.publish_at ?? p.created_at;
      return (!filter.from || when >= filter.from) && (!filter.to || when <= filter.to);
    })
    .slice(0, filter.limit ?? 50);
}

function parseWhen(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new InputError(`"${value}" is not a date Broadside can read. Use ISO 8601 with an offset, such as 2026-12-01T09:00:00+01:00.`);
  if (!/(Z|[+-]\d\d:?\d\d)$/i.test(value.trim())) throw new InputError(`"${value}" has no time zone. Add an offset such as Z or +01:00 so the post goes out when you mean.`);
  return date.toISOString();
}

function parseThread(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((part) => typeof part !== "string")) throw new InputError("thread must be a list of strings, one for each part after the main post.");
  return value as string[];
}

function parseRepeat(value: unknown, publishAt: string | null): Repeat | null {
  if (value === undefined || value === null) return null;
  const input = value as Partial<RepeatInput>;
  if (typeof value !== "object" || !EVERY.includes(input.every as Every)) throw new InputError('repeat.every must be "day", "week" or "month".');
  if (!publishAt) throw new InputError("A repeating post needs a first time. Set publish_at as well.");
  const timezone = input.timezone || null;
  if (timezone && !isTimeZone(timezone)) throw new InputError(`"${timezone}" is not a time zone Broadside knows. Use an IANA name such as Europe/Paris.`);
  // A bare date means through the end of that day, counted in UTC.
  const until = input.until ? parseWhen(/^\d{4}-\d{2}-\d{2}$/.test(input.until) ? `${input.until}T23:59:59.999Z` : input.until) : null;
  if (until && until < publishAt) throw new InputError("repeat.until is earlier than the first occurrence.");
  return { every: input.every as Every, until, timezone };
}

/**
 * The targets a caller named, either one by one or as a group. A group stands
 * for the accounts in it at this moment, so one whose account was disconnected
 * simply names one fewer.
 */
function namedTargets(targets: TargetInput[] | undefined, groupId: string | null | undefined): TargetInput[] | undefined {
  if (groupId === undefined || groupId === null || groupId === "") return targets;
  if (typeof groupId !== "string") throw new InputError("group_id must be a group's id.");
  if (targets?.length) throw new InputError("Name the accounts with targets or with group_id, not both.");
  return groupTargets(groupId);
}

type Issue = { account_id: string; platform?: string; problems: string[] };

/** Every reason a post cannot go to a target, found before anything is saved or sent. */
function check(content: string, mediaIds: string[], targets: TargetInput[], thread: string[]) {
  const { resolved, issues } = fit(content, mediaIds, targets, thread);
  if (issues.length) {
    throw new InputError(
      `This post cannot go out as written: ${issues.map((i) => `${i.platform ?? i.account_id}: ${i.problems.join(" ")}`).join(" | ")}`,
      issues,
    );
  }
  return resolved.map((r) => r!);
}

/** Each target with its account, and what is wrong with each. A target whose account is gone resolves to null. */
function fit(content: string, mediaIds: string[], targets: TargetInput[], thread: string[]) {
  if (!targets.length) throw new InputError("Choose at least one account to post to.");
  const media = mediaIds.map((id) => {
    const found = getMedia(id);
    if (!found) throw new InputError(`No media with id ${id}. Upload it first, or attach it by URL.`);
    return found;
  });
  const seen = new Set<string>();
  const issues: Issue[] = [];
  const resolved = targets.map((target) => {
    const account = getAccount(target.account_id);
    if (!account) {
      issues.push({ account_id: target.account_id, problems: ["No connected account has this id. Call list_accounts for the current ids."] });
      return null;
    }
    if (seen.has(account.id)) issues.push({ account_id: account.id, platform: account.platform, problems: ["This account is listed twice."] });
    seen.add(account.id);
    const c = connector(account.platform)!;
    const found = [...problems(c, target.content_override ?? content, media.map((m) => ({ type: m.type, hasPublicUrl: Boolean(m.public_url) }))), ...threadProblems(fits(c), thread)];
    if (found.length) issues.push({ account_id: account.id, platform: account.platform, problems: found });
    return { account, target };
  });
  return { resolved, issues };
}

function addTarget(postId: string, account: { id: string; platform: string; handle: string }, target: { content_override?: string | null; options?: Record<string, unknown> }, status: TargetStatus): void {
  run(
    "INSERT INTO targets (id, post_id, account_id, platform, handle, content_override, options, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    newId("tgt"),
    postId,
    account.id,
    account.platform,
    account.handle,
    target.content_override ?? null,
    JSON.stringify(target.options ?? {}),
    status,
  );
}

export async function createPost(input: PostInput, fetcher: typeof fetch = fetch, internal: Internal = {}): Promise<Post> {
  if (input.idempotency_key) {
    const existing = get<{ id: string }>("SELECT id FROM posts WHERE idempotency_key = ?", input.idempotency_key);
    if (existing) return getPost(existing.id)!;
  }
  const content = input.content ?? "";
  const mediaIds = input.media_ids ?? [];
  const thread = parseThread(input.thread);
  const tags = parseTags(input.tags);
  const named = namedTargets(input.targets, input.group_id) ?? [];
  // A post that does not fit is refused. One made from a feed item is kept instead, as a draft that says why,
  // so nothing is trimmed and nothing is lost; it cannot go out until it has been changed to fit.
  let held: string | null = null;
  let resolved: ReturnType<typeof check>;
  if (internal.hold) {
    const found = fit(content, mediaIds, named, thread);
    resolved = found.resolved.filter((r): r is NonNullable<typeof r> => r !== null).filter((r, i, list) => list.findIndex((other) => other.account.id === r.account.id) === i);
    if (!resolved.length) throw new InputError("None of the chosen accounts is connected any more.");
    const unfit = found.issues.filter((issue) => issue.platform);
    if (unfit.length) held = [...new Set(unfit.flatMap((issue) => issue.problems))].join(" ");
  } else {
    resolved = check(content, mediaIds, named, thread);
  }
  const publishAt = parseWhen(input.publish_at);
  const repeat = parseRepeat(input.repeat, publishAt);
  const later = publishAt !== null && new Date(publishAt).getTime() > Date.now() + 1000;
  const status: TargetStatus = input.draft || held ? "draft" : later ? "scheduled" : "pending";
  const id = newId("post");
  const stamp = now();
  const database = db();
  database.exec("BEGIN");
  try {
    run(
      "INSERT INTO posts (id, content, media, thread, publish_at, origin, feed_id, held_reason, created_by, idempotency_key, series_id, repeat_every, repeat_until, repeat_zone, repeat_anchor, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      id,
      content,
      JSON.stringify(mediaIds),
      JSON.stringify(thread),
      publishAt,
      internal.feed_id ? "feed" : (input.origin ?? "api"),
      internal.feed_id ?? null,
      held,
      // A feed's post has no author, whoever set the feed up.
      internal.feed_id ? null : (internal.created_by ?? null),
      input.idempotency_key ?? null,
      repeat ? newId("ser") : null,
      repeat?.every ?? null,
      repeat?.until ?? null,
      repeat?.timezone ?? null,
      repeat ? publishAt : null,
      stamp,
      stamp,
    );
    for (const { account, target } of resolved) addTarget(id, account, target, status);
    setPostTags(id, tags);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  if (status === "scheduled") announce("post.scheduled", id);
  if (status === "pending") await publishPending(id, fetcher);
  return getPost(id)!;
}

/** Sends every pending target of a post at once; one network failing never holds up another. */
async function publishPending(postId: string, fetcher: typeof fetch): Promise<void> {
  const ids = all<{ id: string }>("SELECT id FROM targets WHERE post_id = ? AND status = 'pending'", postId);
  await Promise.all(ids.map(({ id }) => publishTarget(id, fetcher)));
}

/**
 * Publishes one target. The claim is a compare-and-set, so two schedulers or
 * a retry racing a tick can never send the same post twice.
 *
 * A thread goes out one part at a time, each a reply to the one before. Every
 * part is recorded as soon as its network accepts it, so a target that stops
 * at part 3 keeps parts 1 and 2 and a retry starts again at part 3.
 */
export async function publishTarget(targetId: string, fetcher: typeof fetch = fetch): Promise<void> {
  const claimed = run(
    "UPDATE targets SET status = 'publishing', attempts = attempts + 1, error = NULL WHERE id = ? AND status IN ('pending', 'scheduled', 'retrying')",
    targetId,
  );
  if (!claimed) return;
  const target = get<TargetRow>("SELECT * FROM targets WHERE id = ?", targetId)!;
  const post = getPost(target.post_id)!;
  if (post.repeat) lineUpNext(post.id);
  const texts = [target.content_override ?? post.content, ...post.thread];
  const sent = JSON.parse(target.parts) as PartRef[];
  let settled = false;
  /** This try's last word: the post's time moves on, then the outgoing webhooks hear what happened, with the post as it now stands. */
  const settle = (failed: boolean) => {
    if (settled) return;
    settled = true;
    run("UPDATE posts SET updated_at = ? WHERE id = ?", now(), target.post_id);
    if (failed) announce("target.failed", target.post_id, targetId);
    announceOutcome(target.post_id);
  };
  const fail = (message: string, retryable = false) => {
    if (retryable && target.attempts < MAX_ATTEMPTS) {
      const next = new Date(Date.now() + 30_000 * 2 ** (target.attempts - 1)).toISOString();
      run("UPDATE targets SET status = 'retrying', error = ?, next_attempt_at = ? WHERE id = ?", message, next, targetId);
    } else {
      run("UPDATE targets SET status = 'failed', error = ? WHERE id = ?", message, targetId);
      settle(true);
    }
  };
  const c = connector(target.platform);
  if (!c || !getAccount(target.account_id)) return fail("This account was disconnected before the post went out.");
  const reply = c.reply;
  if (texts.length > 1 && !reply) return fail(threadProblems(fits(c), post.thread)[0]);
  const ctx = { fetch: guardedFetch(fetcher) };
  const options = JSON.parse(target.options) as Record<string, unknown>;
  try {
    for (let i = sent.length; i < texts.length; i++) {
      // A second Broadside process starting up fails targets it finds mid-send. If that happened between parts, stop here and leave the rest to a retry.
      if (i > 0 && !get("SELECT 1 AS ours FROM targets WHERE id = ? AND status = 'publishing'", targetId)) return;
      // Read each time round: a network may rotate its token while the post goes out.
      const credentials = credentialsOf(target.account_id);
      const result =
        i === 0
          ? await c.publish({ text: texts[0], media: post.media.map(toItem), options }, credentials, ctx)
          : await reply!({ text: texts[i], index: i, root: sent[0], parent: sent[i - 1], options }, credentials, ctx);
      if (result.credentials) saveCredentials(target.account_id, result.credentials);
      sent.push({ id: result.id, url: result.url, ref: result.ref });
      // Written before the next part is sent. This row is what stops a retry from sending a part twice.
      run("UPDATE targets SET parts = ?, parts_done = ? WHERE id = ?", JSON.stringify(sent), sent.length, targetId);
      if (i === 0) run("UPDATE targets SET external_id = ?, external_url = ?, published_at = ? WHERE id = ?", result.id, result.url ?? null, now(), targetId);
    }
    run("UPDATE targets SET status = 'published', error = NULL WHERE id = ?", targetId);
    markAccount(target.account_id, null);
  } catch (error) {
    const known = error instanceof PublishError;
    // A network that rotated its tokens before the failure has already retired the old ones, so the new ones are kept whatever happened next.
    if (known && error.credentials) saveCredentials(target.account_id, error.credentials);
    const reason = known ? error.message : `${c.name} failed unexpectedly: ${(error as Error).message}`;
    // In a thread the error says which part stopped, so it is clear what is already out.
    const message = texts.length > 1 ? `Part ${sent.length + 1} of ${texts.length}: ${reason}` : reason;
    fail(message, known && error.retryable);
    if (known && (error.reconnect || /\b40[13]\b/.test(reason))) markAccount(target.account_id, reason);
  }
  settle(false);
}

/**
 * Creates the next occurrence of a repeating post as its own scheduled post.
 * The flag on the parent is flipped in the same transaction as the insert, so
 * however many clocks, targets or processes get here, exactly one of them
 * creates it. The copy carries the text, thread, media, tags and accounts as
 * they are now, so an edit to one occurrence carries forward.
 */
function lineUpNext(postId: string): void {
  const database = db();
  let created: string | null = null;
  database.exec("BEGIN IMMEDIATE");
  try {
    const claimed = run("UPDATE posts SET repeat_spawned = 1 WHERE id = ? AND repeat_spawned = 0 AND repeat_every IS NOT NULL AND repeat_anchor IS NOT NULL", postId);
    const row = claimed ? get<PostRow>("SELECT * FROM posts WHERE id = ?", postId) : undefined;
    const next = row && nextOccurrence({ anchor: row.repeat_anchor!, every: row.repeat_every!, zone: row.repeat_zone, until: row.repeat_until }, row.repeat_count, Date.now());
    // An account disconnected since the last occurrence is left out of the next one.
    const targets = next ? all<TargetRow>("SELECT * FROM targets WHERE post_id = ? ORDER BY rowid", postId).filter((t) => getAccount(t.account_id)) : [];
    if (row && next && targets.length) {
      const id = newId("post");
      const stamp = now();
      run(
        "INSERT INTO posts (id, content, media, thread, publish_at, origin, created_by, series_id, repeat_every, repeat_until, repeat_zone, repeat_anchor, repeat_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        id,
        row.content,
        row.media,
        row.thread,
        next.at,
        row.origin,
        // The next occurrence is still the work of whoever set the series going.
        row.created_by ?? null,
        row.series_id,
        row.repeat_every,
        row.repeat_until,
        row.repeat_zone,
        row.repeat_anchor,
        next.count,
        stamp,
        stamp,
      );
      for (const t of targets) addTarget(id, { id: t.account_id, platform: t.platform, handle: t.handle }, { content_override: t.content_override, options: JSON.parse(t.options) }, "scheduled");
      copyPostTags(postId, id);
      created = id;
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    // The flag is rolled back with the rest, so the next target or tick tries again; the post in hand still goes out.
    console.error("[broadside] could not line up the next occurrence:", error);
    created = null;
  }
  if (created) announce("post.scheduled", created);
}

function editable(post: Post): void {
  if (post.status !== "draft" && post.status !== "scheduled") {
    throw new InputError(`This post is ${post.status}; only drafts and scheduled posts can be changed.`);
  }
  // A target waiting to retry counts as scheduled, but some of it may be out already. Changing it would send those parts again.
  if (post.targets.some((t) => t.status !== "draft" && t.status !== "scheduled")) {
    throw new InputError("This post has started going out; only drafts and scheduled posts can be changed. Cancel it or wait for it to finish.");
  }
}

export async function updatePost(
  id: string,
  patch: { content?: string; publish_at?: string | null; targets?: TargetInput[]; group_id?: string | null; thread?: string[]; media_ids?: string[]; tags?: string[]; repeat?: RepeatInput | null; draft?: boolean },
  fetcher: typeof fetch = fetch,
): Promise<Post> {
  const post = getPost(id);
  if (!post) throw new InputError(`No post with id ${id}.`);
  editable(post);
  const content = patch.content ?? post.content;
  const mediaIds = patch.media_ids ?? post.media.map((m) => m.id);
  const targets: TargetInput[] =
    namedTargets(patch.targets, patch.group_id) ?? post.targets.map((t) => ({ account_id: t.account_id, content_override: t.content_override, options: t.options }));
  const thread = patch.thread === undefined ? post.thread : parseThread(patch.thread);
  // Tags left out stay as they are; an empty list removes them all.
  const tags = patch.tags === undefined ? null : parseTags(patch.tags);
  const resolved = check(content, mediaIds, targets, thread);
  const publishAt = patch.publish_at === undefined ? post.publish_at : parseWhen(patch.publish_at);
  const repeat = patch.repeat === undefined ? post.repeat : parseRepeat(patch.repeat, publishAt);
  const row = get<PostRow>("SELECT * FROM posts WHERE id = ?", id)!;
  // Later occurrences are counted from the anchor. It moves only when this occurrence is given a new time or a new rule.
  const moved = publishAt !== null && (publishAt !== post.publish_at || repeat?.every !== post.repeat?.every || repeat?.timezone !== post.repeat?.timezone || !row.repeat_anchor);
  const anchor = repeat && moved ? publishAt : row.repeat_anchor;
  const draft = patch.draft ?? post.status === "draft";
  const later = publishAt !== null && new Date(publishAt).getTime() > Date.now() + 1000;
  const status: TargetStatus = draft ? "draft" : later ? "scheduled" : "pending";
  const database = db();
  database.exec("BEGIN");
  try {
    run(
      // The edit passed every network's rules above, so a draft that was held for not fitting is held no longer.
      "UPDATE posts SET content = ?, media = ?, thread = ?, publish_at = ?, series_id = ?, repeat_every = ?, repeat_until = ?, repeat_zone = ?, repeat_anchor = ?, repeat_count = ?, held_reason = NULL, updated_at = ? WHERE id = ?",
      content,
      JSON.stringify(mediaIds),
      JSON.stringify(thread),
      publishAt,
      repeat ? (row.series_id ?? newId("ser")) : row.series_id,
      repeat?.every ?? null,
      repeat?.until ?? null,
      repeat?.timezone ?? null,
      anchor,
      repeat && moved ? 0 : row.repeat_count,
      now(),
      id,
    );
    run("DELETE FROM targets WHERE post_id = ?", id);
    for (const { account, target } of resolved) addTarget(id, account, target, status);
    if (tags) setPostTags(id, tags);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  if (status === "scheduled") announce("post.scheduled", id);
  if (status === "pending") await publishPending(id, fetcher);
  return getPost(id)!;
}

/** Publishes a draft or scheduled post now instead of waiting. */
export async function publishNow(id: string, fetcher: typeof fetch = fetch): Promise<Post> {
  const post = getPost(id);
  if (!post) throw new InputError(`No post with id ${id}.`);
  editable(post);
  // A draft held because it did not fit was saved without passing the rules, so it meets them here before anything is sent.
  if (post.held_reason) {
    check(post.content, post.media.map((m) => m.id), post.targets.map((t) => ({ account_id: t.account_id, content_override: t.content_override, options: t.options })), post.thread);
    run("UPDATE posts SET held_reason = NULL WHERE id = ?", id);
  }
  run("UPDATE targets SET status = 'pending' WHERE post_id = ? AND status IN ('draft', 'scheduled')", id);
  run("UPDATE posts SET publish_at = ?, updated_at = ? WHERE id = ?", now(), now(), id);
  await publishPending(id, fetcher);
  return getPost(id)!;
}

export function cancelPost(id: string): Post {
  const post = getPost(id);
  if (!post) throw new InputError(`No post with id ${id}.`);
  // Cancelling one occurrence leaves its series running, so the next one is lined up before this one is dropped.
  if (post.repeat && post.status === "scheduled") lineUpNext(id);
  const changed = run("UPDATE targets SET status = 'cancelled' WHERE post_id = ? AND status IN ('draft', 'scheduled', 'retrying')", id);
  if (!changed) throw new InputError(`This post is ${post.status}; there is nothing left to cancel. Published posts stay on their networks.`);
  run("UPDATE posts SET updated_at = ? WHERE id = ?", now(), id);
  return getPost(id)!;
}

export function deletePost(id: string): boolean {
  const post = getPost(id);
  // Removing a scheduled occurrence is like cancelling it: the series carries on. stopSeries is what ends one.
  if (post?.repeat && post.status === "scheduled") lineUpNext(id);
  return run("DELETE FROM posts WHERE id = ?", id) > 0;
}

/**
 * Ends the repeating series a post belongs to: no occurrence will create
 * another, and the ones still waiting for their time are cancelled. What has
 * been published stays where it is.
 */
export function stopSeries(id: string): Post {
  const post = getPost(id);
  if (!post) throw new InputError(`No post with id ${id}.`);
  if (!post.series) throw new InputError("This post does not repeat, so there is no series to stop.");
  const ended = run("UPDATE posts SET repeat_every = NULL WHERE series_id = ? AND repeat_every IS NOT NULL", post.series.id);
  const cancelled = run("UPDATE targets SET status = 'cancelled' WHERE status = 'scheduled' AND post_id IN (SELECT id FROM posts WHERE series_id = ?)", post.series.id);
  if (!ended && !cancelled) throw new InputError("This series has already stopped.");
  run("UPDATE posts SET updated_at = ? WHERE series_id = ?", now(), post.series.id);
  return getPost(id)!;
}


export async function retryTarget(postId: string, targetId: string, fetcher: typeof fetch = fetch): Promise<Post> {
  const changed = run("UPDATE targets SET status = 'pending', attempts = 0 WHERE id = ? AND post_id = ? AND status = 'failed'", targetId, postId);
  if (!changed) throw new InputError("Only a failed target can be retried.");
  await publishTarget(targetId, fetcher);
  return getPost(postId)!;
}

/** Target ids whose time has come: scheduled posts that are due, and retries whose wait is over. */
export function dueTargets(at = now()): string[] {
  return all<{ id: string }>(
    `SELECT t.id FROM targets t JOIN posts p ON p.id = t.post_id
     WHERE (t.status = 'scheduled' AND p.publish_at <= ?) OR (t.status = 'retrying' AND t.next_attempt_at <= ?)`,
    at,
    at,
  ).map((r) => r.id);
}

/**
 * A target left "publishing" by a process that died may or may not have gone
 * out. Sending it again could post twice, so it is failed with the reason and
 * left for a person to retry.
 */
export function recoverInterrupted(): number {
  const stuck = all<{ id: string; post_id: string; parts_done: number; thread: string }>("SELECT t.id, t.post_id, t.parts_done, p.thread FROM targets t JOIN posts p ON p.id = t.post_id WHERE t.status = 'publishing'");
  let failed = 0;
  for (const target of stuck) {
    const total = (JSON.parse(target.thread) as string[]).length + 1;
    const what = total > 1 ? `part ${target.parts_done + 1} of ${total}` : "this";
    const changed = run("UPDATE targets SET status = 'failed', error = ? WHERE id = ? AND status = 'publishing'", `Broadside stopped while ${what} was being sent. Check the network before retrying, in case it went out.`, target.id);
    failed += changed;
    if (changed) {
      announce("target.failed", target.post_id, target.id);
      announceOutcome(target.post_id);
    }
  }
  return failed;
}

/**
 * A dry run: how the text, media, thread and options fit each chosen account.
 * Sends and saves nothing. It also names what a connector would only find when
 * the post goes out, such as an article with no title.
 */
export function inspectPost(input: { content?: string; targets?: TargetInput[]; group_id?: string | null; media_ids?: string[]; thread?: string[] }) {
  const media = (input.media_ids ?? []).map((id) => {
    const found = getMedia(id);
    if (!found) throw new InputError(`No media with id ${id}.`);
    return { type: found.type, hasPublicUrl: Boolean(found.public_url) };
  });
  const thread = parseThread(input.thread);
  return (namedTargets(input.targets, input.group_id) ?? []).map((target) => {
    const account = getAccount(target.account_id);
    const c = account && connector(account.platform);
    if (!account || !c) return { account_id: target.account_id, ok: false, problems: ["No connected account has this id."] };
    const text = target.content_override ?? input.content ?? "";
    const found = [...problems(c, text, media), ...threadProblems(fits(c), thread), ...optionProblems(c, text, target.options)];
    const replyMax = c.limits.maxReplyChars ?? c.limits.maxChars;
    return {
      account_id: account.id,
      platform: account.platform,
      handle: account.handle,
      ok: found.length === 0,
      problems: found,
      length: measure(text, c.limits.count),
      max_chars: c.limits.maxChars,
      // Part 1 is the main post; these are the parts after it, each against the network's limit for a reply.
      thread: thread.map((part, i) => ({ part: i + 2, length: measure(part, c.limits.count), max_chars: replyMax })),
    };
  });
}
