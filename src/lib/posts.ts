import { credentialsOf, getAccount, InputError, markAccount, saveCredentials } from "./accounts";
import { newId } from "./crypto";
import { all, db, get, now, run } from "./db";
import { getMedia, toItem, type Media } from "./media";
import { guardedFetch } from "./net";
import { connector, problems } from "./platforms";
import { PublishError } from "./platforms/types";

export type TargetStatus = "draft" | "scheduled" | "pending" | "publishing" | "retrying" | "published" | "failed" | "cancelled";
export type PostStatus = "draft" | "scheduled" | "publishing" | "published" | "partial" | "failed" | "cancelled";

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
};

export type Post = {
  id: string;
  content: string;
  media: Media[];
  status: PostStatus;
  publish_at: string | null;
  origin: string;
  created_at: string;
  updated_at: string;
  targets: Target[];
};

export type TargetInput = { account_id: string; content_override?: string | null; options?: Record<string, unknown> };

export type PostInput = {
  content: string;
  targets: TargetInput[];
  media_ids?: string[];
  publish_at?: string | null;
  draft?: boolean;
  idempotency_key?: string;
  origin?: "ui" | "api" | "mcp";
};

type PostRow = { id: string; content: string; media: string; state: string; publish_at: string | null; origin: string; created_at: string; updated_at: string };
type TargetRow = Omit<Target, "options" | "url"> & { options: string; external_url: string | null; post_id: string };

const MAX_ATTEMPTS = 3;

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

function hydrate(row: PostRow): Post {
  const targets = all<TargetRow>("SELECT * FROM targets WHERE post_id = ? ORDER BY rowid", row.id).map(
    (t): Target => ({
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
    }),
  );
  const media = (JSON.parse(row.media) as string[]).map((id) => getMedia(id)).filter((m): m is Media => Boolean(m));
  return {
    id: row.id,
    content: row.content,
    media,
    status: aggregate(targets.map((t) => t.status)),
    publish_at: row.publish_at,
    origin: row.origin,
    created_at: row.created_at,
    updated_at: row.updated_at,
    targets,
  };
}

export function getPost(id: string): Post | undefined {
  const row = get<PostRow>("SELECT * FROM posts WHERE id = ?", id);
  return row && hydrate(row);
}

export function listPosts(filter: { status?: PostStatus; limit?: number; from?: string; to?: string } = {}): Post[] {
  const rows = all<PostRow>("SELECT * FROM posts ORDER BY COALESCE(publish_at, created_at) DESC LIMIT 500");
  return rows
    .map(hydrate)
    .filter((p) => !filter.status || p.status === filter.status)
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

/** Every reason a post cannot go to a target, found before anything is saved or sent. */
function check(content: string, mediaIds: string[], targets: TargetInput[]) {
  if (!targets.length) throw new InputError("Choose at least one account to post to.");
  const media = mediaIds.map((id) => {
    const found = getMedia(id);
    if (!found) throw new InputError(`No media with id ${id}. Upload it first, or attach it by URL.`);
    return found;
  });
  const seen = new Set<string>();
  const issues: { account_id: string; platform?: string; problems: string[] }[] = [];
  const resolved = targets.map((target) => {
    const account = getAccount(target.account_id);
    if (!account) {
      issues.push({ account_id: target.account_id, problems: ["No connected account has this id. Call list_accounts for the current ids."] });
      return null;
    }
    if (seen.has(account.id)) issues.push({ account_id: account.id, platform: account.platform, problems: ["This account is listed twice."] });
    seen.add(account.id);
    const c = connector(account.platform)!;
    const found = problems(c, target.content_override ?? content, media.map((m) => ({ type: m.type, hasPublicUrl: Boolean(m.public_url) })));
    if (found.length) issues.push({ account_id: account.id, platform: account.platform, problems: found });
    return { account, target };
  });
  if (issues.length) {
    throw new InputError(
      `This post cannot go out as written: ${issues.map((i) => `${i.platform ?? i.account_id}: ${i.problems.join(" ")}`).join(" | ")}`,
      issues,
    );
  }
  return resolved.map((r) => r!);
}

export async function createPost(input: PostInput, fetcher: typeof fetch = fetch): Promise<Post> {
  if (input.idempotency_key) {
    const existing = get<{ id: string }>("SELECT id FROM posts WHERE idempotency_key = ?", input.idempotency_key);
    if (existing) return getPost(existing.id)!;
  }
  const content = input.content ?? "";
  const mediaIds = input.media_ids ?? [];
  const resolved = check(content, mediaIds, input.targets ?? []);
  const publishAt = parseWhen(input.publish_at);
  const later = publishAt !== null && new Date(publishAt).getTime() > Date.now() + 1000;
  const status: TargetStatus = input.draft ? "draft" : later ? "scheduled" : "pending";
  const id = newId("post");
  const stamp = now();
  const database = db();
  database.exec("BEGIN");
  try {
    run(
      "INSERT INTO posts (id, content, media, publish_at, origin, idempotency_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      id,
      content,
      JSON.stringify(mediaIds),
      publishAt,
      input.origin ?? "api",
      input.idempotency_key ?? null,
      stamp,
      stamp,
    );
    for (const { account, target } of resolved) {
      run(
        "INSERT INTO targets (id, post_id, account_id, platform, handle, content_override, options, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        newId("tgt"),
        id,
        account.id,
        account.platform,
        account.handle,
        target.content_override ?? null,
        JSON.stringify(target.options ?? {}),
        status,
      );
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
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
 */
export async function publishTarget(targetId: string, fetcher: typeof fetch = fetch): Promise<void> {
  const claimed = run(
    "UPDATE targets SET status = 'publishing', attempts = attempts + 1, error = NULL WHERE id = ? AND status IN ('pending', 'scheduled', 'retrying')",
    targetId,
  );
  if (!claimed) return;
  const target = get<TargetRow>("SELECT * FROM targets WHERE id = ?", targetId)!;
  const post = getPost(target.post_id)!;
  const fail = (message: string, retryable = false) => {
    if (retryable && target.attempts < MAX_ATTEMPTS) {
      const next = new Date(Date.now() + 30_000 * 2 ** (target.attempts - 1)).toISOString();
      run("UPDATE targets SET status = 'retrying', error = ?, next_attempt_at = ? WHERE id = ?", message, next, targetId);
    } else {
      run("UPDATE targets SET status = 'failed', error = ? WHERE id = ?", message, targetId);
    }
  };
  const c = connector(target.platform);
  if (!c || !getAccount(target.account_id)) return fail("This account was disconnected before the post went out.");
  try {
    const result = await c.publish(
      { text: target.content_override ?? post.content, media: post.media.map(toItem), options: JSON.parse(target.options) },
      credentialsOf(target.account_id),
      { fetch: guardedFetch(fetcher) },
    );
    if (result.credentials) saveCredentials(target.account_id, result.credentials);
    run(
      "UPDATE targets SET status = 'published', external_id = ?, external_url = ?, published_at = ?, error = NULL WHERE id = ?",
      result.id,
      result.url ?? null,
      now(),
      targetId,
    );
    markAccount(target.account_id, null);
  } catch (error) {
    const known = error instanceof PublishError;
    const message = known ? error.message : `${c.name} failed unexpectedly: ${(error as Error).message}`;
    fail(message, known && error.retryable);
    if (known && /\b40[13]\b/.test(message)) markAccount(target.account_id, message);
  }
  run("UPDATE posts SET updated_at = ? WHERE id = ?", now(), target.post_id);
}

function editable(post: Post): void {
  if (post.status !== "draft" && post.status !== "scheduled") {
    throw new InputError(`This post is ${post.status}; only drafts and scheduled posts can be changed.`);
  }
}

export async function updatePost(
  id: string,
  patch: { content?: string; publish_at?: string | null; targets?: TargetInput[]; media_ids?: string[]; draft?: boolean },
  fetcher: typeof fetch = fetch,
): Promise<Post> {
  const post = getPost(id);
  if (!post) throw new InputError(`No post with id ${id}.`);
  editable(post);
  const content = patch.content ?? post.content;
  const mediaIds = patch.media_ids ?? post.media.map((m) => m.id);
  const targets: TargetInput[] =
    patch.targets ?? post.targets.map((t) => ({ account_id: t.account_id, content_override: t.content_override, options: t.options }));
  const resolved = check(content, mediaIds, targets);
  const publishAt = patch.publish_at === undefined ? post.publish_at : parseWhen(patch.publish_at);
  const draft = patch.draft ?? post.status === "draft";
  const later = publishAt !== null && new Date(publishAt).getTime() > Date.now() + 1000;
  const status: TargetStatus = draft ? "draft" : later ? "scheduled" : "pending";
  const database = db();
  database.exec("BEGIN");
  try {
    run("UPDATE posts SET content = ?, media = ?, publish_at = ?, updated_at = ? WHERE id = ?", content, JSON.stringify(mediaIds), publishAt, now(), id);
    run("DELETE FROM targets WHERE post_id = ?", id);
    for (const { account, target } of resolved) {
      run(
        "INSERT INTO targets (id, post_id, account_id, platform, handle, content_override, options, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        newId("tgt"),
        id,
        account.id,
        account.platform,
        account.handle,
        target.content_override ?? null,
        JSON.stringify(target.options ?? {}),
        status,
      );
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  if (status === "pending") await publishPending(id, fetcher);
  return getPost(id)!;
}

/** Publishes a draft or scheduled post now instead of waiting. */
export async function publishNow(id: string, fetcher: typeof fetch = fetch): Promise<Post> {
  const post = getPost(id);
  if (!post) throw new InputError(`No post with id ${id}.`);
  editable(post);
  run("UPDATE targets SET status = 'pending' WHERE post_id = ? AND status IN ('draft', 'scheduled')", id);
  run("UPDATE posts SET publish_at = ?, updated_at = ? WHERE id = ?", now(), now(), id);
  await publishPending(id, fetcher);
  return getPost(id)!;
}

export function cancelPost(id: string): Post {
  const post = getPost(id);
  if (!post) throw new InputError(`No post with id ${id}.`);
  const changed = run("UPDATE targets SET status = 'cancelled' WHERE post_id = ? AND status IN ('draft', 'scheduled', 'retrying')", id);
  if (!changed) throw new InputError(`This post is ${post.status}; there is nothing left to cancel. Published posts stay on their networks.`);
  run("UPDATE posts SET updated_at = ? WHERE id = ?", now(), id);
  return getPost(id)!;
}

export function deletePost(id: string): boolean {
  return run("DELETE FROM posts WHERE id = ?", id) > 0;
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
  return run(
    "UPDATE targets SET status = 'failed', error = 'Broadside stopped while this was being sent. Check the network before retrying, in case it went out.' WHERE status = 'publishing'",
  );
}
