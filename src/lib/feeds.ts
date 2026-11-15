import { getAccount, InputError } from "./accounts";
import { newId, sha256 } from "./crypto";
import { all, db, get, now, run } from "./db";
import { decodeFeed, FeedError, parseFeed, type FeedItem, type ParsedFeed } from "./feed-parse";
import { getGroup } from "./groups";
import { BlockedAddress, guardedFetch, readCapped } from "./net";
import { connector, fits, problems } from "./platforms";
import { createPost, getPost } from "./posts";

/**
 * RSS and Atom auto-posting. A feed is an address Broadside reads on a
 * schedule; each new item becomes a post to the accounts the feed names,
 * saved as a draft unless the operator chose to publish.
 *
 * What makes an item new: it was not in the feed when the feed was added (or
 * resumed), it says it was published after that moment when it carries a
 * date, and nothing with its id has been seen under this feed's address
 * before. Items are remembered under the address, not the feed's id, so a
 * feed deleted and added again starts with the same memory.
 *
 * Everything a feed says is someone else's text. It is fetched through
 * guardedFetch with a size cap and a timeout, parsed by the reader in
 * feed-parse.ts, reduced to plain text and put into a post as characters.
 */

/** The scheduler reads a feed at most this often. */
export const FEED_EVERY_MS = 15 * 60_000;
/** A feed larger than this is not read. */
export const FEED_MAX_BYTES = 2 * 1024 * 1024;
/** One check turns at most this many items into posts. The rest wait for the next check, so a feed that floods cannot flood your accounts. */
export const MAX_NEW_PER_CHECK = 5;
export const DEFAULT_TEMPLATE = "{title}\n\n{link}";
export const MAX_TEMPLATE = 2000;
const FETCH_TIMEOUT_MS = 15_000;
/** After failures in a row the wait doubles from half an hour, up to this. */
const BACKOFF_CAP_MS = 24 * 60 * 60_000;
/** A check claimed by a process that died is free to be claimed again after this long. */
const CLAIM_MS = 2 * 60_000;
/** How many feeds one scheduler tick checks. */
const PER_SWEEP = 2;
const MAX_FEEDS = 50;
const MAX_URL = 2000;
const PLACEHOLDER = /\{(title|link|summary)\}/g;

export type FeedAction = "draft" | "publish";
export type FeedMember = { id: string; platform: string; handle: string };

/** One item a feed has acted on. `post_status` is the post as it stands now, or null if the post was removed or never made. */
export type FeedPost = { title: string | null; link: string | null; outcome: "draft" | "publish" | "held" | "failed"; post_id: string | null; post_status: string | null; note: string | null; at: string };

export type Feed = {
  id: string;
  url: string;
  /** The feed's own title, as plain text. Null until it has been read with one. */
  title: string | null;
  template: string;
  action: FeedAction;
  /** The group whose accounts items go to, or null when the accounts are named one by one. */
  group: { id: string; name: string | null } | null;
  /** The accounts an item would go to right now. */
  accounts: FeedMember[];
  status: "active" | "paused";
  last_checked_at: string | null;
  last_error: string | null;
  next_check_at: string;
  created_at: string;
  /** The posts this feed has created: how many, and the latest few. */
  posts: { total: number; recent: FeedPost[] };
};

type FeedRow = {
  id: string;
  url: string;
  feed_key: string;
  title: string | null;
  template: string;
  action: FeedAction;
  group_id: string | null;
  status: "active" | "paused";
  since: string;
  baselined: number;
  etag: string | null;
  last_modified: string | null;
  last_checked_at: string | null;
  last_error: string | null;
  failures: number;
  next_check_at: string;
  claimed_at: string | null;
  created_at: string;
};

/* Reading ------------------------------------------------------------------ */

/** The accounts a feed posts to now: its group's, or the ones it names, without any that have been disconnected. */
function members(row: FeedRow): FeedMember[] {
  if (row.group_id) return getGroup(row.group_id)?.accounts ?? [];
  return all<FeedMember>("SELECT a.id, a.platform, a.handle FROM feed_accounts f JOIN accounts a ON a.id = f.account_id WHERE f.feed_id = ? ORDER BY a.created_at, a.rowid", row.id);
}

function view(row: FeedRow): Feed {
  const recent = all<Omit<FeedPost, "post_status" | "at"> & { seen_at: string }>(
    "SELECT title, link, outcome, post_id, note, seen_at FROM feed_items WHERE feed_key = ? AND outcome IN ('draft', 'publish', 'held', 'failed') ORDER BY seen_at DESC, rowid DESC LIMIT 5",
    row.feed_key,
  );
  const group = row.group_id ? getGroup(row.group_id) : undefined;
  return {
    id: row.id,
    url: row.url,
    title: row.title,
    template: row.template,
    action: row.action,
    group: row.group_id ? { id: row.group_id, name: group?.name ?? null } : null,
    accounts: members(row),
    status: row.status,
    last_checked_at: row.last_checked_at,
    last_error: row.last_error,
    next_check_at: row.next_check_at,
    created_at: row.created_at,
    posts: {
      total: get<{ n: number }>("SELECT COUNT(*) AS n FROM feed_items WHERE feed_key = ? AND post_id IS NOT NULL", row.feed_key)?.n ?? 0,
      recent: recent.map(({ seen_at, ...item }) => ({ ...item, post_status: item.post_id ? (getPost(item.post_id)?.status ?? null) : null, at: seen_at })),
    },
  };
}

export function listFeeds(): Feed[] {
  return all<FeedRow>("SELECT * FROM feeds ORDER BY created_at, rowid").map(view);
}

export function getFeed(id: string): Feed | undefined {
  const row = get<FeedRow>("SELECT * FROM feeds WHERE id = ?", id);
  return row && view(row);
}

/* Fetching ----------------------------------------------------------------- */

class FetchFailed extends Error {
  constructor(
    message: string,
    /** How long the server asked callers to stay away, in seconds, when it said. */
    readonly retryAfter?: number,
  ) {
    super(message);
  }
}

type Fetched = { unchanged: true } | { unchanged: false; parsed: ParsedFeed; etag: string | null; lastModified: string | null };

/** A validator header worth sending back: printable, and short. Anything else is not kept. */
const validator = (value: string | null): string | null => (value && /^[ -~]{1,300}$/.test(value) ? value : null);

/**
 * Fetches and parses one feed. Every hop is checked by guardedFetch, the
 * answer is abandoned after a timeout, and the body is read no further than
 * the size cap. With validators from the last good read, the server may
 * answer 304 and send nothing.
 */
async function fetchFeed(address: string, fetcher: typeof fetch, known: { etag?: string | null; lastModified?: string | null } = {}): Promise<Fetched> {
  const host = new URL(address).host;
  const headers: Record<string, string> = { accept: "application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.1", "user-agent": "Broadside (feed reader)" };
  if (known.etag) headers["if-none-match"] = known.etag;
  if (known.lastModified) headers["if-modified-since"] = known.lastModified;
  let bytes: Uint8Array;
  let response: Response;
  try {
    response = await guardedFetch(fetcher)(address, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (response.status === 304) return { unchanged: true };
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      const wait = Number(response.headers.get("retry-after"));
      throw new FetchFailed(`${host} answered ${response.status}.`, Number.isFinite(wait) && wait > 0 ? wait : undefined);
    }
    const tooLarge = `This feed is larger than ${FEED_MAX_BYTES / 1024 / 1024} MB, so Broadside did not read it.`;
    if (Number(response.headers.get("content-length") ?? 0) > FEED_MAX_BYTES) {
      await response.body?.cancel().catch(() => undefined);
      throw new FetchFailed(tooLarge);
    }
    bytes = await readCapped(response, FEED_MAX_BYTES).catch((cause: Error) => {
      throw cause instanceof BlockedAddress ? new FetchFailed(tooLarge) : cause;
    });
  } catch (error) {
    if (error instanceof FetchFailed) throw error;
    if (error instanceof BlockedAddress) throw new FetchFailed(error.message);
    if ((error as Error).name === "TimeoutError" || (error as Error).name === "AbortError") throw new FetchFailed(`${host} did not answer within ${FETCH_TIMEOUT_MS / 1000} seconds.`);
    const cause = (error as { cause?: { code?: string } }).cause?.code;
    throw new FetchFailed([...`Could not reach ${host}: ${cause ?? (error as Error).message}`].slice(0, 300).join(""));
  }
  try {
    const parsed = parseFeed(decodeFeed(bytes, response.headers.get("content-type") ?? ""), address);
    return { unchanged: false, parsed, etag: validator(response.headers.get("etag")), lastModified: validator(response.headers.get("last-modified")) };
  } catch (error) {
    if (error instanceof FeedError) throw new FetchFailed(error.message);
    throw error;
  }
}

/* Changing ----------------------------------------------------------------- */

function cleanUrl(value: unknown): URL {
  if (typeof value !== "string" || !value.trim()) throw new InputError("A feed needs an address.");
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new InputError("That is not a valid address. It should start with https:// or http://.");
  }
  if (!/^https?:$/.test(url.protocol)) throw new InputError("A feed address must start with https:// or http://.");
  if (url.username || url.password) throw new InputError("Leave the user name and password out of the feed address.");
  url.hash = "";
  if (url.href.length > MAX_URL) throw new InputError(`An address can be ${MAX_URL} characters long.`);
  return url;
}

/** What two spellings of one feed address share: the scheme and a trailing slash do not make a different feed. */
const feedKey = (url: URL): string => `${url.host}${url.pathname.replace(/\/+$/, "")}${url.search}`.toLowerCase();

function cleanTemplate(value: unknown): string {
  if (value === undefined || value === null) return DEFAULT_TEMPLATE;
  if (typeof value !== "string" || !value.trim()) throw new InputError("The template is empty. Write the text of the post, with {title}, {link} or {summary} where the item's own words go.");
  const template = value.replace(/\r\n?/g, "\n").trim();
  if ([...template].length > MAX_TEMPLATE) throw new InputError(`A template can be ${MAX_TEMPLATE} characters; this is ${[...template].length}.`);
  if (!template.match(PLACEHOLDER)) throw new InputError("The template has no placeholder, so every post would say the same thing. Use {title}, {link} or {summary}.");
  return template;
}

function cleanAction(value: unknown): FeedAction {
  if (value === undefined || value === null) return "draft";
  if (value !== "draft" && value !== "publish") throw new InputError('action must be "draft" or "publish".');
  return value;
}

/** Where items go: a group, or accounts named one by one. Exactly one of the two, each checked to exist. */
function cleanTargets(accountIds: unknown, groupId: unknown): { group_id: string | null; account_ids: string[] } {
  const hasGroup = groupId !== undefined && groupId !== null && groupId !== "";
  const hasAccounts = Array.isArray(accountIds) && accountIds.length > 0;
  if (hasGroup && hasAccounts) throw new InputError("Name the accounts with account_ids or with group_id, not both.");
  if (hasGroup) {
    if (typeof groupId !== "string" || !getGroup(groupId)) throw new InputError(`No group with id ${String(groupId)}.`);
    return { group_id: groupId, account_ids: [] };
  }
  if (!hasAccounts || (accountIds as unknown[]).some((id) => typeof id !== "string")) throw new InputError("Choose at least one account, or a group, for this feed to post to.");
  const ids = [...new Set(accountIds as string[])];
  for (const id of ids) if (!getAccount(id)) throw new InputError(`No connected account has the id ${id}.`);
  return { group_id: null, account_ids: ids };
}

function setTargets(feedId: string, targets: { group_id: string | null; account_ids: string[] }): void {
  run("UPDATE feeds SET group_id = ? WHERE id = ?", targets.group_id, feedId);
  run("DELETE FROM feed_accounts WHERE feed_id = ?", feedId);
  for (const accountId of targets.account_ids) run("INSERT INTO feed_accounts (feed_id, account_id) VALUES (?, ?)", feedId, accountId);
}

const label = (text: string | undefined, max: number): string | null => (text ? [...text].slice(0, max).join("") : null);

/** Remembers an item under the feed's address. False when it was already there, which is how two clocks never act on one item twice. */
function remember(row: Pick<FeedRow, "id" | "feed_key">, item: FeedItem, outcome: string): boolean {
  return (
    run(
      "INSERT OR IGNORE INTO feed_items (feed_key, item_key, feed_id, title, link, outcome, seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      row.feed_key,
      item.key,
      row.id,
      label(item.title, 300),
      label(item.link, MAX_URL),
      outcome,
      now(),
    ) > 0
  );
}

/**
 * Adds a feed. The address is read once here, so one that is not a feed is
 * refused with the reason and nothing is saved. Everything in the feed at
 * this moment is remembered as already seen: nothing is posted from the
 * past.
 */
export async function createFeed(input: { url?: unknown; account_ids?: unknown; group_id?: unknown; template?: unknown; action?: unknown }, fetcher: typeof fetch = fetch): Promise<Feed> {
  const url = cleanUrl(input.url);
  const template = cleanTemplate(input.template);
  const action = cleanAction(input.action);
  const targets = cleanTargets(input.account_ids, input.group_id);
  const key = feedKey(url);
  if (get("SELECT 1 AS found FROM feeds WHERE feed_key = ?", key)) throw new InputError("This feed is already added.");
  if ((get<{ n: number }>("SELECT COUNT(*) AS n FROM feeds")?.n ?? 0) >= MAX_FEEDS) throw new InputError(`Broadside keeps up to ${MAX_FEEDS} feeds. Delete one first.`);
  const fetched = await fetchFeed(url.href, fetcher).catch((error: Error) => {
    throw error instanceof FetchFailed ? new InputError(error.message) : error;
  });
  if (fetched.unchanged) throw new InputError(`${url.host} sent no feed.`);
  const id = newId("feed");
  const stamp = now();
  const database = db();
  database.exec("BEGIN");
  try {
    run(
      "INSERT INTO feeds (id, url, feed_key, title, template, action, since, baselined, etag, last_modified, last_checked_at, next_check_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)",
      id,
      url.href,
      key,
      label(fetched.parsed.title, 200),
      template,
      action,
      stamp,
      fetched.etag,
      fetched.lastModified,
      stamp,
      new Date(Date.now() + FEED_EVERY_MS).toISOString(),
      stamp,
      stamp,
    );
    setTargets(id, targets);
    for (const item of fetched.parsed.items) remember({ id, feed_key: key }, item, "baseline");
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    // Two requests adding one address at the same moment: the second finds the first's row.
    if (/UNIQUE/.test((error as Error).message)) throw new InputError("This feed is already added.");
    throw error;
  }
  return getFeed(id)!;
}

/**
 * Changes where a feed posts, its template or what it does with an item, or
 * pauses and resumes it. Its address cannot change: a different address is a
 * different feed. Resuming starts from now, so what appeared while the feed
 * was paused is not posted.
 */
export function updateFeed(id: string, patch: { account_ids?: unknown; group_id?: unknown; template?: unknown; action?: unknown; paused?: unknown; url?: unknown }): Feed {
  const row = get<FeedRow>("SELECT * FROM feeds WHERE id = ?", id);
  if (!row) throw new InputError(`No feed with id ${id}.`);
  if (patch.url !== undefined && patch.url !== row.url) throw new InputError("A feed's address cannot be changed. Add the new address as its own feed and delete this one.");
  if (patch.paused !== undefined && typeof patch.paused !== "boolean") throw new InputError("paused must be true or false.");
  const template = patch.template === undefined ? row.template : cleanTemplate(patch.template);
  const action = patch.action === undefined ? row.action : cleanAction(patch.action);
  const targets = patch.account_ids === undefined && patch.group_id === undefined ? null : cleanTargets(patch.account_ids, patch.group_id);
  const database = db();
  database.exec("BEGIN");
  try {
    run("UPDATE feeds SET template = ?, action = ?, updated_at = ? WHERE id = ?", template, action, now(), id);
    if (targets) setTargets(id, targets);
    if (patch.paused === true) run("UPDATE feeds SET status = 'paused' WHERE id = ?", id);
    if (patch.paused === false && row.status === "paused") {
      // The next check finds the feed as it is now and takes that as its starting point, with no validators so the server sends it in full.
      run("UPDATE feeds SET status = 'active', since = ?, baselined = 0, etag = NULL, last_modified = NULL, failures = 0, last_error = NULL, next_check_at = ? WHERE id = ?", now(), now(), id);
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  return getFeed(id)!;
}

/** Deletes the feed. The posts it made stay, and so does its memory of the items it has seen. */
export function deleteFeed(id: string): boolean {
  return run("DELETE FROM feeds WHERE id = ?", id) > 0;
}

/* Checking ----------------------------------------------------------------- */

/** The text of a post made from an item. Each placeholder is replaced once, by the item's own plain text; what the item says is never read for placeholders. */
export function renderTemplate(template: string, item: Pick<FeedItem, "title" | "link" | "summary">): string {
  return template
    .replace(PLACEHOLDER, (_, name: "title" | "link" | "summary") => item[name])
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export type CheckResult = {
  feed: Feed;
  /** "checked": read and acted on. "unchanged": the server said nothing is new. "failed": see `message`. "skipped": not due, paused, or being checked elsewhere. */
  outcome: "checked" | "unchanged" | "failed" | "skipped";
  message: string | null;
  /** The posts this check created. */
  post_ids: string[];
};

/** Feeds the scheduler should read now, the longest-waiting first. */
export function dueFeeds(limit = PER_SWEEP, at = Date.now()): string[] {
  return all<{ id: string }>(
    "SELECT id FROM feeds WHERE status = 'active' AND next_check_at <= ? AND (claimed_at IS NULL OR claimed_at <= ?) ORDER BY next_check_at LIMIT ?",
    new Date(at).toISOString(),
    new Date(at - CLAIM_MS).toISOString(),
    limit,
  ).map((row) => row.id);
}

/**
 * Reads one feed and turns its new items into posts.
 *
 * The claim is a compare-and-set, so two clocks, or the scheduler and a
 * person pressing Check now, never read one feed at the same time. The
 * scheduler's claim also requires the feed to be due, which is what keeps it
 * to one read every fifteen minutes; `manual` is a person asking now.
 * A failure records why and pushes the next read back, further each time.
 */
export async function checkFeed(id: string, fetcher: typeof fetch = fetch, options: { manual?: boolean } = {}): Promise<CheckResult> {
  const before = get<FeedRow>("SELECT * FROM feeds WHERE id = ?", id);
  if (!before) throw new InputError(`No feed with id ${id}.`);
  const skipped = (message: string): CheckResult => ({ feed: getFeed(id)!, outcome: "skipped", message, post_ids: [] });
  if (before.status !== "active") return skipped("This feed is paused. Resume it to check it.");
  const stamp = now();
  const claimed = run(
    `UPDATE feeds SET claimed_at = ? WHERE id = ? AND status = 'active' AND (claimed_at IS NULL OR claimed_at <= ?)${options.manual ? "" : " AND next_check_at <= ?"}`,
    ...[stamp, id, new Date(Date.now() - CLAIM_MS).toISOString(), ...(options.manual ? [] : [stamp])],
  );
  if (!claimed) return skipped(options.manual ? "This feed is being checked right now." : "This feed is not due yet.");
  const row = get<FeedRow>("SELECT * FROM feeds WHERE id = ?", id)!;

  const fail = (message: string, retryAfter?: number): CheckResult => {
    const failures = row.failures + 1;
    const wait = Math.min(Math.max(FEED_EVERY_MS * 2 ** failures, (retryAfter ?? 0) * 1000), BACKOFF_CAP_MS);
    run("UPDATE feeds SET last_checked_at = ?, last_error = ?, failures = ?, next_check_at = ?, claimed_at = NULL WHERE id = ?", now(), message, failures, new Date(Date.now() + wait).toISOString(), id);
    return { feed: getFeed(id)!, outcome: "failed", message, post_ids: [] };
  };
  const done = (changes: { title?: string | null; etag?: string | null; lastModified?: string | null; error?: string | null } | null): void => {
    const next = new Date(Date.now() + FEED_EVERY_MS).toISOString();
    if (!changes) run("UPDATE feeds SET last_checked_at = ?, last_error = NULL, failures = 0, next_check_at = ?, claimed_at = NULL WHERE id = ?", now(), next, id);
    else
      run(
        "UPDATE feeds SET title = COALESCE(?, title), etag = ?, last_modified = ?, baselined = 1, last_checked_at = ?, last_error = ?, failures = 0, next_check_at = ?, claimed_at = NULL WHERE id = ?",
        changes.title ?? null,
        changes.etag ?? null,
        changes.lastModified ?? null,
        now(),
        changes.error ?? null,
        next,
        id,
      );
  };

  try {
    const targets = members(row).map((account) => ({ account_id: account.id }));
    if (!targets.length) return fail(row.group_id && !getGroup(row.group_id) ? "The group this feed posts to was deleted. Edit the feed and choose where it posts." : "This feed has no accounts left to post to. Edit the feed and choose some.");

    let fetched: Fetched;
    try {
      fetched = await fetchFeed(row.url, fetcher, { etag: row.etag, lastModified: row.last_modified });
    } catch (error) {
      if (error instanceof FetchFailed) return fail(error.message, error.retryAfter);
      throw error;
    }
    if (fetched.unchanged) {
      done(null);
      return { feed: getFeed(id)!, outcome: "unchanged", message: null, post_ids: [] };
    }

    // Sort what the feed holds into what has been seen, what is too old to count, and what is new.
    const fresh: FeedItem[] = [];
    for (const item of fetched.parsed.items) {
      if (get("SELECT 1 AS seen FROM feed_items WHERE feed_key = ? AND item_key = ?", row.feed_key, item.key)) continue;
      if (!row.baselined) remember(row, item, "baseline");
      else if (item.date && item.date <= row.since) remember(row, item, "old");
      else fresh.push(item);
    }
    // Feeds list the newest first; posts are made oldest first, so they land in the order they were written.
    fresh.reverse();
    fresh.sort((a, b) => (a.date && b.date ? a.date.localeCompare(b.date) : 0));

    const created: string[] = [];
    let problem: string | null = null;
    for (const item of fresh.slice(0, MAX_NEW_PER_CHECK)) {
      // The row goes in before the post is made. If Broadside stops between the two the item is skipped, never posted twice.
      if (!remember(row, item, row.action)) continue;
      const record = (outcome: string, postId: string | null, note: string | null) =>
        run("UPDATE feed_items SET outcome = ?, post_id = ?, note = ? WHERE feed_key = ? AND item_key = ?", outcome, postId, note, row.feed_key, item.key);
      try {
        const post = await createPost(
          { content: renderTemplate(row.template, item), targets, draft: row.action === "draft", idempotency_key: `feed:${sha256(`${row.feed_key}\n${item.key}`).slice(0, 40)}` },
          fetcher,
          { feed_id: row.id, hold: true },
        );
        record(post.held_reason ? "held" : row.action, post.id, post.held_reason);
        created.push(post.id);
      } catch (error) {
        const known = error instanceof InputError;
        if (!known) console.error("[broadside] a feed item could not be made into a post:", (error as Error).message);
        problem = known ? error.message : "Broadside hit an unexpected error making a post from an item. The server log has the details.";
        record("failed", null, problem);
      }
    }
    // With items still waiting, the validators are not kept: the next read must get the feed in full to reach them.
    const waiting = fresh.length > MAX_NEW_PER_CHECK;
    done({ title: label(fetched.parsed.title, 200), etag: waiting ? null : fetched.etag, lastModified: waiting ? null : fetched.lastModified, error: problem });
    return { feed: getFeed(id)!, outcome: "checked", message: problem, post_ids: created };
  } catch (error) {
    console.error("[broadside] checking a feed failed:", (error as Error).message);
    return fail("Broadside hit an unexpected error reading this feed. The server log has the details.");
  }
}

/** One background sweep: reads the feeds that are due, one after another. The scheduler starts it beside publishing and never waits for it. */
export async function checkDueFeeds(fetcher: typeof fetch = fetch, limit = PER_SWEEP): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const id of dueFeeds(limit)) results.push(await checkFeed(id, fetcher));
  return results;
}

export type FeedPreview = {
  title: string;
  items: number;
  /** The newest item as it would be posted, with every reason it would not fit a chosen account. Null when the feed is empty. */
  newest: { title: string; link: string; date: string | null; text: string; problems: string[] } | null;
};

/** A dry run: reads the feed now and shows the post its newest item would make. Saves and sends nothing, and leaves the feed's memory alone. */
export async function previewFeed(id: string, fetcher: typeof fetch = fetch): Promise<FeedPreview> {
  const row = get<FeedRow>("SELECT * FROM feeds WHERE id = ?", id);
  if (!row) throw new InputError(`No feed with id ${id}.`);
  const fetched = await fetchFeed(row.url, fetcher).catch((error: Error) => {
    throw error instanceof FetchFailed ? new InputError(error.message) : error;
  });
  if (fetched.unchanged) throw new InputError(`${new URL(row.url).host} sent no feed.`);
  const item = fetched.parsed.items[0];
  if (!item) return { title: fetched.parsed.title, items: 0, newest: null };
  const text = renderTemplate(row.template, item);
  const found = members(row).flatMap((account) => {
    const c = connector(account.platform);
    return c ? problems(fits(c), text, []) : [];
  });
  return { title: fetched.parsed.title, items: fetched.parsed.items.length, newest: { title: item.title, link: item.link, date: item.date, text, problems: [...new Set(found)] } };
}
