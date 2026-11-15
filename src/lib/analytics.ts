import { credentialsOf, getAccount, InputError, saveCredentials } from "./accounts";
import { newId } from "./crypto";
import { all, get, now, run } from "./db";
import { guardedFetch } from "./net";
import { connector, connectors, noMetrics } from "./platforms";
import { KIND_LABEL, METRIC_KINDS, PublishError, type Metric, type MetricKind, type PartRef } from "./platforms/types";
import { tagKey } from "./tags";

/**
 * Analytics: the counts each network holds for what Broadside published.
 *
 * A reading is one answer from one network about one published target, kept
 * with the moment it was taken, so every number can be shown "as of" a time.
 * Numbers that have not changed since the reading before keep their row and
 * move its time on.
 * Nothing here is estimated or filled in. A count a network does not report
 * is absent, a network with no way to read counts says so, and a reading that
 * fails leaves the last good one in place with the reason beside it.
 *
 * Readings are taken when someone asks (refreshPost) and, for posts from the
 * last 30 days, a few at a time by the scheduler (collectDue): at most once an
 * hour per target, and not at all for an account whose network has answered
 * 429 until the wait it asked for is over.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** The scheduler reads a target at most this often. */
export const READ_EVERY_MS = HOUR;
/** The scheduler reads posts published within this window. Older ones are read only when someone asks. */
export const BACKGROUND_DAYS = 30;
/** How many targets one scheduler tick reads. */
export const PER_SWEEP = 3;
/** A Refresh pressed twice does not ask the network twice within this time. */
const MANUAL_GAP_MS = 30_000;
/** A reading that hangs is given up on, so a slow network cannot hold the sweep. */
const READ_TIMEOUT_MS = 20_000;
/** With no wait named by the network, the first 429 pauses an account this long, doubling each time up to the cap. */
const BACKOFF_FIRST_MS = 15 * MINUTE;
const BACKOFF_CAP_MS = 6 * HOUR;
const BACKOFF_ASKED_CAP_MS = DAY;

export const PERIODS = [7, 30, 90] as const;
export type Period = (typeof PERIODS)[number];

type TargetRow = {
  id: string;
  post_id: string;
  account_id: string;
  platform: string;
  handle: string;
  external_id: string | null;
  external_url: string | null;
  published_at: string | null;
  parts: string;
};

/** The numbers Broadside holds for one published target, and everything needed to say how far to trust them. */
export type TargetNumbers = {
  target_id: string;
  account_id: string;
  platform: string;
  /** The network's name, for display. */
  network: string;
  handle: string;
  url: string | null;
  published_at: string | null;
  /** False when this network has no way to read numbers. `unavailable_reason` then says why. */
  available: boolean;
  unavailable_reason: string | null;
  /** The last good reading. Empty until there is one. */
  metrics: Metric[];
  /** When the last good reading was taken. */
  as_of: string | null;
  /** What the network would not give in that reading, when it held something back. */
  note: string | null;
  /** The latest attempt, when it failed after the last good reading. The numbers above are then older than they could be. */
  error: { message: string; at: string } | null;
  /** Set while the network has asked Broadside to slow down for this account. No reading is tried before then. */
  paused_until: string | null;
};

/** Why a reading was not tried: nothing to read, read too recently, or the network asked for a pause. */
export type SkipReason = "unpublished" | "unavailable" | "disconnected" | "paused" | "recent";
export type ReadOutcome = { target_id: string; outcome: "read" | "failed" | "skipped"; message: string | null; reason?: SkipReason };

/* Reading ------------------------------------------------------------------ */

const pausedUntil = (accountId: string, at = now()): string | null => get<{ until: string }>("SELECT until FROM metric_backoff WHERE account_id = ? AND until > ?", accountId, at)?.until ?? null;

/**
 * Reads one target's numbers from its network and stores them.
 *
 * The claim on `metric_state` is a compare-and-set, so two schedulers, or a
 * Refresh racing a tick, never ask the network twice for the same target
 * inside the gap. A failure is recorded beside the last good reading, which
 * stays. A 429 also pauses the whole account, since the limit is the
 * account's and not the post's.
 */
export async function readTarget(targetId: string, fetcher: typeof fetch = fetch, options: { manual?: boolean } = {}): Promise<ReadOutcome> {
  const skipped = (reason: SkipReason, message: string): ReadOutcome => ({ target_id: targetId, outcome: "skipped", message, reason });
  const target = get<TargetRow>("SELECT id, post_id, account_id, platform, handle, external_id, external_url, published_at, parts FROM targets WHERE id = ?", targetId);
  if (!target?.external_id) return skipped("unpublished", "This target has not been published, so there is nothing to read.");
  const c = connector(target.platform);
  if (!c?.metrics) return skipped("unavailable", `Numbers are not available for ${c?.name ?? target.platform}. ${c ? noMetrics(c) : ""}`.trim());
  if (!getAccount(target.account_id)) return skipped("disconnected", "This account was disconnected, so its numbers can no longer be read.");
  const paused = pausedUntil(target.account_id);
  if (paused) return skipped("paused", `${c.name} asked Broadside to slow down. Numbers for this account are read again after ${paused}.`);

  const stamp = now();
  const threshold = new Date(Date.now() - (options.manual ? MANUAL_GAP_MS : READ_EVERY_MS)).toISOString();
  const claimed = run(
    "INSERT INTO metric_state (target_id, attempted_at) VALUES (?, ?) ON CONFLICT(target_id) DO UPDATE SET attempted_at = excluded.attempted_at WHERE metric_state.attempted_at <= ?",
    targetId,
    stamp,
    threshold,
  );
  if (!claimed) return skipped("recent", options.manual ? "These numbers were read a moment ago." : "These numbers were read within the last hour.");

  const guarded = guardedFetch(fetcher);
  const ctx = { fetch: ((input: RequestInfo | URL, init: RequestInit = {}) => guarded(input, { ...init, signal: init.signal ?? AbortSignal.timeout(READ_TIMEOUT_MS) })) as typeof fetch };
  const main = (JSON.parse(target.parts) as PartRef[])[0];
  try {
    const result = await c.metrics({ id: target.external_id, url: target.external_url ?? undefined, ref: main?.ref, publishedAt: target.published_at ?? undefined }, credentialsOf(target.account_id), ctx);
    if (result.credentials) saveCredentials(target.account_id, result.credentials);
    // Only real, non-negative counts under a known kind are kept, whatever the connector passed on.
    const metrics = result.metrics.filter((m) => METRIC_KINDS.includes(m.kind) && Number.isFinite(m.value) && m.value >= 0);
    record(targetId, metrics, result.note ?? null);
    run("UPDATE metric_state SET error = NULL, error_at = NULL WHERE target_id = ?", targetId);
    run("DELETE FROM metric_backoff WHERE account_id = ?", target.account_id);
    return { target_id: targetId, outcome: "read", message: null };
  } catch (error) {
    const known = error instanceof PublishError;
    // A network that rotated its tokens before the failure has already retired the old ones, so the new ones are kept whatever happened next.
    if (known && error.credentials) saveCredentials(target.account_id, error.credentials);
    const message = known ? error.message : `${c.name} could not be read: ${(error as Error).message}`;
    run("UPDATE metric_state SET error = ?, error_at = ? WHERE target_id = ?", message, now(), targetId);
    if (known && error.status === 429) backOff(target.account_id, error.retryAfter, message);
    return { target_id: targetId, outcome: "failed", message };
  }
}

/**
 * Stores a reading with its time. Numbers that repeat the reading before are
 * the same row read again: its time moves on, and the moment those numbers
 * were first seen stays in `since`. A change adds a row, so the history holds
 * every value a post has had and how long it held.
 */
function record(targetId: string, metrics: Metric[], note: string | null): void {
  const stamp = now();
  const body = JSON.stringify(metrics);
  const last = get<{ id: string; metrics: string; note: string | null }>("SELECT id, metrics, note FROM metric_readings WHERE target_id = ? ORDER BY read_at DESC LIMIT 1", targetId);
  if (last && last.metrics === body && last.note === note) run("UPDATE metric_readings SET read_at = ? WHERE id = ?", stamp, last.id);
  else run("INSERT INTO metric_readings (id, target_id, since, read_at, metrics, note) VALUES (?, ?, ?, ?, ?, ?)", newId("rdg"), targetId, stamp, stamp, body, note);
}

/** Pauses an account after a 429: for as long as the network asked, or a wait that doubles with each 429 in a row. */
function backOff(accountId: string, askedSeconds: number | undefined, reason: string): void {
  const strikes = (get<{ strikes: number }>("SELECT strikes FROM metric_backoff WHERE account_id = ?", accountId)?.strikes ?? 0) + 1;
  const wait = askedSeconds !== undefined ? Math.min(Math.max(askedSeconds * 1000, MINUTE), BACKOFF_ASKED_CAP_MS) : Math.min(BACKOFF_FIRST_MS * 2 ** (strikes - 1), BACKOFF_CAP_MS);
  run(
    "INSERT INTO metric_backoff (account_id, until, strikes, reason) VALUES (?, ?, ?, ?) ON CONFLICT(account_id) DO UPDATE SET until = excluded.until, strikes = excluded.strikes, reason = excluded.reason",
    accountId,
    new Date(Date.now() + wait).toISOString(),
    strikes,
    reason,
  );
}

/** The targets the scheduler should read next: published in the window, on a network with numbers, not read within the hour, and not paused. Least recently tried first. */
export function dueReadings(limit = PER_SWEEP, at = Date.now()): string[] {
  const readable = connectors.filter((c) => c.metrics).map((c) => c.id);
  if (!readable.length) return [];
  return all<{ id: string }>(
    `SELECT t.id FROM targets t LEFT JOIN metric_state s ON s.target_id = t.id
     WHERE t.external_id IS NOT NULL AND t.published_at >= ?
       AND t.platform IN (${readable.map(() => "?").join(", ")})
       AND (s.attempted_at IS NULL OR s.attempted_at <= ?)
       AND t.account_id IN (SELECT id FROM accounts)
       AND t.account_id NOT IN (SELECT account_id FROM metric_backoff WHERE until > ?)
     ORDER BY s.attempted_at IS NOT NULL, s.attempted_at, t.published_at DESC LIMIT ?`,
    new Date(at - BACKGROUND_DAYS * DAY).toISOString(),
    ...readable,
    new Date(at - READ_EVERY_MS).toISOString(),
    new Date(at).toISOString(),
    limit,
  ).map((row) => row.id);
}

/**
 * One background sweep: reads a few due targets, one after another. It is
 * called beside publishing and never awaited by it, so a slow network here
 * cannot delay a post. A 429 met on the way pauses that account for the rest
 * of the sweep too.
 */
export async function collectDue(fetcher: typeof fetch = fetch, limit = PER_SWEEP): Promise<ReadOutcome[]> {
  const outcomes: ReadOutcome[] = [];
  for (const id of dueReadings(limit)) outcomes.push(await readTarget(id, fetcher));
  return outcomes;
}

/* Views -------------------------------------------------------------------- */

type ReadingRow = { target_id: string; read_at: string; metrics: string; note: string | null };
type StateRow = { target_id: string; attempted_at: string; error: string | null; error_at: string | null };

const TARGET_COLUMNS = "t.id, t.post_id, t.account_id, t.platform, t.handle, t.external_id, t.external_url, t.published_at, t.parts";

/** What Broadside holds for each of these published targets: the last good reading, and how the latest attempt went. */
function numbersFor(targets: TargetRow[]): TargetNumbers[] {
  if (!targets.length) return [];
  const ids = targets.map((t) => t.id);
  const marks = ids.map(() => "?").join(", ");
  // The newest reading of each target, and only that one: the history behind it is not loaded.
  const latest = new Map(
    all<ReadingRow>(
      `SELECT r.target_id, r.read_at, r.metrics, r.note FROM metric_readings r
       JOIN (SELECT target_id, MAX(read_at) AS read_at FROM metric_readings WHERE target_id IN (${marks}) GROUP BY target_id) newest
         ON newest.target_id = r.target_id AND newest.read_at = r.read_at`,
      ...ids,
    ).map((row) => [row.target_id, row]),
  );
  const states = new Map(all<StateRow>(`SELECT target_id, attempted_at, error, error_at FROM metric_state WHERE target_id IN (${marks})`, ...ids).map((s) => [s.target_id, s]));
  const stamp = now();
  const paused = new Map(all<{ account_id: string; until: string }>("SELECT account_id, until FROM metric_backoff WHERE until > ?", stamp).map((b) => [b.account_id, b.until]));
  return targets.map((t): TargetNumbers => {
    const c = connector(t.platform);
    const reading = latest.get(t.id);
    const state = states.get(t.id);
    const available = Boolean(c?.metrics);
    return {
      target_id: t.id,
      account_id: t.account_id,
      platform: t.platform,
      network: c?.name ?? t.platform,
      handle: t.handle,
      url: t.external_url,
      published_at: t.published_at,
      available,
      unavailable_reason: available ? null : c ? noMetrics(c) : "Broadside no longer has a connector for this network.",
      metrics: reading ? (JSON.parse(reading.metrics) as Metric[]) : [],
      as_of: reading?.read_at ?? null,
      note: reading?.note ?? null,
      error: state?.error && state.error_at ? { message: state.error, at: state.error_at } : null,
      paused_until: paused.get(t.account_id) ?? null,
    };
  });
}

export type PostNumbers = { post_id: string; targets: TargetNumbers[] };

/** True once anything at all has been published, whatever the period. */
export const hasPublished = (): boolean => Boolean(get("SELECT 1 AS found FROM targets WHERE external_id IS NOT NULL LIMIT 1"));

const publishedTargets = (postId: string): TargetRow[] => all<TargetRow>(`SELECT ${TARGET_COLUMNS} FROM targets t WHERE t.post_id = ? AND t.external_id IS NOT NULL ORDER BY t.rowid`, postId);

/** The numbers of one post, per published target. A target that has not gone out has none and is left out. */
export function postAnalytics(postId: string): PostNumbers {
  if (!get("SELECT 1 AS found FROM posts WHERE id = ?", postId)) throw new InputError(`No post with id ${postId}.`);
  return { post_id: postId, targets: numbersFor(publishedTargets(postId)) };
}

/** The numbers of every published target of these posts, keyed by target id. One query for a whole list of posts. */
export function numbersByTarget(postIds: string[]): Record<string, TargetNumbers> {
  if (!postIds.length) return {};
  const targets = all<TargetRow>(`SELECT ${TARGET_COLUMNS} FROM targets t WHERE t.external_id IS NOT NULL AND t.post_id IN (${postIds.map(() => "?").join(", ")})`, ...postIds);
  return Object.fromEntries(numbersFor(targets).map((n) => [n.target_id, n]));
}

/** Reads every published target of one post now, each network at once, and returns the post's numbers with how each reading went. */
export async function refreshPost(postId: string, fetcher: typeof fetch = fetch): Promise<PostNumbers & { refreshed: ReadOutcome[] }> {
  if (!get("SELECT 1 AS found FROM posts WHERE id = ?", postId)) throw new InputError(`No post with id ${postId}.`);
  const targets = publishedTargets(postId);
  if (!targets.length) throw new InputError("Nothing from this post has been published yet, so there are no numbers to read.");
  const refreshed = await Promise.all(targets.map((t) => readTarget(t.id, fetcher, { manual: true })));
  return { ...postAnalytics(postId), refreshed };
}

/* The overview ------------------------------------------------------------- */

/** One network's share of a total, under the word that network uses for the count. */
export type TotalPart = { platform: string; network: string; label: string; value: number; targets: number };
/** A network with posts in the period that adds nothing to a total, and why. */
export type Missing = { platform: string; network: string; reason: string };

export type Total = {
  kind: MetricKind;
  label: string;
  /** The sum of the last good reading of every target that reports this kind. */
  value: number;
  /** How many published targets the sum is made of. */
  targets: number;
  networks: TotalPart[];
  missing: Missing[];
};

export type NetworkNumbers = {
  platform: string;
  network: string;
  /** Published targets on this network in the period. */
  targets: number;
  /** How many of them have a reading. */
  read: number;
  /** How many have a failed attempt newer than their last reading. */
  failing: number;
  available: boolean;
  unavailable_reason: string | null;
  /** The sum of each kind this network reported, under its own word for it. */
  metrics: Metric[];
  /** The oldest and newest of the readings the sums are made of. */
  as_of_oldest: string | null;
  as_of_newest: string | null;
};

export type AnalyticsRow = TargetNumbers & { post_id: string; content: string };

export type Analytics = {
  period: { days: Period; from: string; to: string };
  account_id: string | null;
  tag: string | null;
  /** Posts with at least one published target in the period, and the count of those targets. */
  posts: number;
  targets: number;
  totals: Total[];
  networks: NetworkNumbers[];
  /** One row for each published target: a post as it stands on one network. */
  rows: AnalyticsRow[];
};

const EXCERPT = 160;

export function parsePeriod(value: unknown): Period {
  const days = value === undefined || value === null || value === "" ? 30 : Number(value);
  if (!PERIODS.includes(days as Period)) throw new InputError(`period must be ${PERIODS.join(", ").replace(/, (\d+)$/, " or $1")} (days).`);
  return days as Period;
}

/**
 * Everything published in the last `days` days with the numbers held for it.
 *
 * A total adds up the last good reading of each target, one kind at a time.
 * Kinds are never mixed: views and impressions are separate totals, and so is
 * a score. Each total lists the networks it is made of, and the networks with
 * posts in the period that it leaves out, with the reason.
 */
export function analytics(filter: { days?: Period; account_id?: string | null; tag?: string | null } = {}, at = Date.now()): Analytics {
  const days = filter.days ?? 30;
  const from = new Date(at - days * DAY).toISOString();
  const tag = filter.tag?.trim() || null;
  const accountId = filter.account_id || null;
  const where = ["t.external_id IS NOT NULL", "t.published_at >= ?"];
  const params: (string | number)[] = [from];
  if (accountId) {
    where.push("t.account_id = ?");
    params.push(accountId);
  }
  if (tag) {
    where.push("t.post_id IN (SELECT pt.post_id FROM post_tags pt JOIN tags g ON g.id = pt.tag_id WHERE g.name_key = ?)");
    params.push(tagKey(tag));
  }
  const targets = all<TargetRow & { content: string }>(
    `SELECT ${TARGET_COLUMNS}, COALESCE(t.content_override, p.content) AS content FROM targets t JOIN posts p ON p.id = t.post_id WHERE ${where.join(" AND ")} ORDER BY t.published_at DESC, t.rowid`,
    ...params,
  );
  const numbers = numbersFor(targets);
  const rows = numbers.map((n, i): AnalyticsRow => ({ ...n, post_id: targets[i].post_id, content: [...targets[i].content].slice(0, EXCERPT).join("") }));

  // Per network, in the order the app lists networks.
  const order = new Map(connectors.map((c, i) => [c.id, i]));
  const byPlatform = new Map<string, AnalyticsRow[]>();
  for (const row of rows) byPlatform.set(row.platform, [...(byPlatform.get(row.platform) ?? []), row]);
  const platforms = [...byPlatform.keys()].sort((a, b) => (order.get(a) ?? 99) - (order.get(b) ?? 99));

  const networks = platforms.map((platform): NetworkNumbers => {
    const mine = byPlatform.get(platform)!;
    const read = mine.filter((r) => r.as_of);
    const sums = new Map<MetricKind, Metric>();
    for (const row of read) for (const m of row.metrics) sums.set(m.kind, { kind: m.kind, label: m.label, value: (sums.get(m.kind)?.value ?? 0) + m.value });
    const times = read.map((r) => r.as_of!).sort();
    return {
      platform,
      network: mine[0].network,
      targets: mine.length,
      read: read.length,
      failing: mine.filter((r) => r.error).length,
      available: mine[0].available,
      unavailable_reason: mine[0].unavailable_reason,
      metrics: METRIC_KINDS.flatMap((kind) => (sums.has(kind) ? [sums.get(kind)!] : [])),
      as_of_oldest: times[0] ?? null,
      as_of_newest: times.at(-1) ?? null,
    };
  });

  const totals = METRIC_KINDS.flatMap((kind): Total[] => {
    const parts: TotalPart[] = [];
    const missing: Missing[] = [];
    for (const network of networks) {
      const mine = byPlatform.get(network.platform)!;
      const counted = mine.filter((r) => r.metrics.some((m) => m.kind === kind));
      const sum = network.metrics.find((m) => m.kind === kind);
      if (sum) parts.push({ platform: network.platform, network: network.network, label: sum.label, value: sum.value, targets: counted.length });
      const reason = sum ? partly(network, counted.length) : absent(network, kind, mine);
      if (reason) missing.push({ platform: network.platform, network: network.network, reason });
    }
    if (!parts.length) return [];
    return [{ kind, label: KIND_LABEL[kind], value: parts.reduce((sum, p) => sum + p.value, 0), targets: parts.reduce((sum, p) => sum + p.targets, 0), networks: parts, missing }];
  });

  return { period: { days, from, to: new Date(at).toISOString() }, account_id: accountId, tag, posts: new Set(rows.map((r) => r.post_id)).size, targets: rows.length, totals, networks, rows };
}

/** Why a network that does add to a total still leaves some of its posts out of it. */
function partly(network: NetworkNumbers, counted: number): string | null {
  const left = network.targets - counted;
  if (left <= 0) return null;
  return `${left} of ${network.targets} ${network.network} posts ${left === 1 ? "has" : "have"} no reading with this count yet.`;
}

/** Why a network with posts in the period adds nothing at all to a total. */
function absent(network: NetworkNumbers, kind: MetricKind, rows: AnalyticsRow[]): string {
  const word = KIND_LABEL[kind].toLowerCase();
  const c = connector(network.platform);
  if (!network.available) return `Not available for ${network.network}. ${network.unavailable_reason ?? ""}`.trim();
  if (!c?.reports?.[kind]) return `${network.network} does not report ${word === "score" ? "a score" : word}.`;
  const failed = rows.find((r) => r.error);
  if (network.read === 0) return failed ? `No reading yet. The last try failed: ${failed.error!.message}` : "No reading yet.";
  // The network reports this kind, and was read, and still gave no such count: it held that one back.
  const noted = rows.find((r) => r.note)?.note;
  return noted ?? `${network.network} gave no ${word} in its last reading.`;
}
