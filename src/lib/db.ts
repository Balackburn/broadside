import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";

/**
 * One SQLite file, opened once per process. `node:sqlite` ships with Node, so
 * self-hosting needs no native build step and no database server.
 */

export function dataDir(): string {
  const dir = process.env.BROADSIDE_DATA_DIR || path.join(process.cwd(), "data");
  // Owner only: the folder holds credentials (encrypted), the key that opens them, and every post.
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    /* a folder we do not own keeps its mode */
  }
  return dir;
}

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  label TEXT NOT NULL,
  handle TEXT NOT NULL,
  avatar_url TEXT,
  credentials TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  last_error TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS posts (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  media TEXT NOT NULL DEFAULT '[]',
  state TEXT NOT NULL DEFAULT 'active',
  publish_at TEXT,
  origin TEXT NOT NULL DEFAULT 'ui',
  idempotency_key TEXT UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS targets (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  handle TEXT NOT NULL,
  content_override TEXT,
  options TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL,
  error TEXT,
  external_id TEXT,
  external_url TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  published_at TEXT
);
CREATE INDEX IF NOT EXISTS targets_post ON targets(post_id);
CREATE INDEX IF NOT EXISTS targets_status ON targets(status);
CREATE TABLE IF NOT EXISTS media (
  id TEXT PRIMARY KEY,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  alt TEXT,
  source_url TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS oauth_pending (
  state TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  payload TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  prefix TEXT NOT NULL,
  hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_used_at TEXT
);
`;

/**
 * Columns added after the first release. Each is added with ALTER TABLE only
 * when PRAGMA table_info says it is missing, so a new database and one created
 * by an older Broadside end up with the same shape and no data is touched.
 */
const ADDED: [table: string, column: string, definition: string][] = [
  // Threads: the parts after the main text, and per target how far the thread has gone and the ids needed to continue it.
  ["posts", "thread", "TEXT NOT NULL DEFAULT '[]'"],
  ["targets", "parts", "TEXT NOT NULL DEFAULT '[]'"],
  ["targets", "parts_done", "INTEGER NOT NULL DEFAULT 0"],
  // Repeating posts: the rule, where its dates are counted from, and whether this occurrence has lined up the next one.
  ["posts", "series_id", "TEXT"],
  ["posts", "repeat_every", "TEXT"],
  ["posts", "repeat_until", "TEXT"],
  ["posts", "repeat_zone", "TEXT"],
  ["posts", "repeat_anchor", "TEXT"],
  ["posts", "repeat_count", "INTEGER NOT NULL DEFAULT 0"],
  ["posts", "repeat_spawned", "INTEGER NOT NULL DEFAULT 0"],
  // Signatures: the one an account offers by default in the composer.
  ["accounts", "signature_id", "TEXT"],
  // Feeds: the feed that made a post, and why a draft is being held back when its text does not fit a chosen network.
  ["posts", "feed_id", "TEXT"],
  ["posts", "held_reason", "TEXT"],
  // Outgoing webhooks: the outcome last announced for a post, so one outcome is announced once however many clocks see it.
  ["posts", "announced", "TEXT"],
  // Teams: the member who wrote a post (null for a feed's, and for any post made before there was a team),
  // and the member an API key belongs to with the role it was given. Both null on a key made before the team.
  ["posts", "created_by", "TEXT"],
  ["api_keys", "member_id", "TEXT"],
  ["api_keys", "role", "TEXT"],
];

/**
 * Tables added after the first release: tags and the posts that carry them,
 * named groups of accounts, saved signatures, and the numbers read back from
 * the networks. Each is created only if it is missing, so an existing database
 * gains them and keeps every row it had.
 * `name_key` is the name folded to one case, so "Launch" and "launch" are one tag.
 *
 * Analytics keeps three things. `metric_readings` holds what a network
 * answered about a published target: the counts, when they were first read
 * (`since`) and when they were last read (`read_at`). A reading that repeats
 * the one before moves `read_at` on instead of adding a row, so the table
 * grows with the numbers and not with the clock. `metric_state` holds, per
 * target, when a reading was last tried and why the last try failed, if it
 * did. `metric_backoff` holds the accounts a network has asked
 * Broadside to slow down for, and until when.
 */
const ADDED_TABLES = `
CREATE TABLE IF NOT EXISTS tags (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS post_tags (
  post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (post_id, tag_id)
);
CREATE INDEX IF NOT EXISTS post_tags_tag ON post_tags(tag_id);
CREATE TABLE IF NOT EXISTS account_groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS group_members (
  group_id TEXT NOT NULL REFERENCES account_groups(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  PRIMARY KEY (group_id, account_id)
);
CREATE TABLE IF NOT EXISTS signatures (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS metric_readings (
  id TEXT PRIMARY KEY,
  target_id TEXT NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
  since TEXT NOT NULL,
  read_at TEXT NOT NULL,
  metrics TEXT NOT NULL,
  note TEXT
);
CREATE INDEX IF NOT EXISTS metric_readings_target ON metric_readings(target_id, read_at);
CREATE TABLE IF NOT EXISTS metric_state (
  target_id TEXT PRIMARY KEY REFERENCES targets(id) ON DELETE CASCADE,
  attempted_at TEXT NOT NULL,
  error TEXT,
  error_at TEXT
);
CREATE TABLE IF NOT EXISTS metric_backoff (
  account_id TEXT PRIMARY KEY,
  until TEXT NOT NULL,
  strikes INTEGER NOT NULL DEFAULT 1,
  reason TEXT
);
CREATE TABLE IF NOT EXISTS outgoing_webhooks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  secret TEXT NOT NULL,
  events TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  paused_reason TEXT,
  failures INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS outgoing_deliveries (
  id TEXT PRIMARY KEY,
  webhook_id TEXT NOT NULL REFERENCES outgoing_webhooks(id) ON DELETE CASCADE,
  event TEXT NOT NULL,
  post_id TEXT,
  payload TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  response_code INTEGER,
  error TEXT,
  created_at TEXT NOT NULL,
  attempted_at TEXT,
  next_attempt_at TEXT
);
CREATE INDEX IF NOT EXISTS outgoing_deliveries_webhook ON outgoing_deliveries(webhook_id, created_at);
CREATE INDEX IF NOT EXISTS outgoing_deliveries_status ON outgoing_deliveries(status);
CREATE TABLE IF NOT EXISTS feeds (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  feed_key TEXT NOT NULL UNIQUE,
  title TEXT,
  template TEXT NOT NULL,
  action TEXT NOT NULL DEFAULT 'draft',
  group_id TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  since TEXT NOT NULL,
  baselined INTEGER NOT NULL DEFAULT 0,
  etag TEXT,
  last_modified TEXT,
  last_checked_at TEXT,
  last_error TEXT,
  failures INTEGER NOT NULL DEFAULT 0,
  next_check_at TEXT NOT NULL,
  claimed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS feed_accounts (
  feed_id TEXT NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  PRIMARY KEY (feed_id, account_id)
);
CREATE TABLE IF NOT EXISTS feed_items (
  feed_key TEXT NOT NULL,
  item_key TEXT NOT NULL,
  feed_id TEXT NOT NULL,
  title TEXT,
  link TEXT,
  outcome TEXT NOT NULL,
  post_id TEXT,
  note TEXT,
  seen_at TEXT NOT NULL,
  PRIMARY KEY (feed_key, item_key)
);
CREATE INDEX IF NOT EXISTS feed_items_post ON feed_items(post_id);
CREATE TABLE IF NOT EXISTS members (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  session_nonce TEXT NOT NULL,
  created_at TEXT NOT NULL,
  disabled_at TEXT,
  last_seen_at TEXT
);
CREATE TABLE IF NOT EXISTS invites (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL,
  member_id TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);
`;

export function migrate(handle: DatabaseSync): void {
  // One writer at a time: a second process starting at the same moment waits here, then finds the columns present.
  handle.exec("BEGIN IMMEDIATE");
  try {
    for (const [table, column, definition] of ADDED) {
      const present = handle.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
      if (present) continue;
      handle.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
      // Targets published before threads existed have one part done: the post itself.
      if (column === "parts_done") {
        handle.exec("UPDATE targets SET parts_done = 1, parts = json_array(json_object('id', external_id, 'url', external_url)) WHERE status = 'published' AND external_id IS NOT NULL");
      }
    }
    handle.exec("CREATE INDEX IF NOT EXISTS posts_series ON posts(series_id)");
    handle.exec("CREATE INDEX IF NOT EXISTS posts_feed ON posts(feed_id)");
    handle.exec(ADDED_TABLES);
    handle.exec("COMMIT");
  } catch (error) {
    handle.exec("ROLLBACK");
    throw error;
  }
}

type Global = typeof globalThis & { __broadsideDb?: { file: string; db: DatabaseSync } };

export function db(): DatabaseSync {
  const g = globalThis as Global;
  const file = path.join(dataDir(), "broadside.db");
  if (g.__broadsideDb?.file === file) return g.__broadsideDb.db;
  const handle = new DatabaseSync(file);
  handle.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  handle.exec(SCHEMA);
  migrate(handle);
  g.__broadsideDb = { file, db: handle };
  return handle;
}

export type Row = Record<string, string | number | null>;

/** node:sqlite rows have no prototype; copying them makes plain objects that React can send to the browser. */
export function all<T = Row>(sql: string, ...params: (string | number | null)[]): T[] {
  return db().prepare(sql).all(...params).map((row) => ({ ...row })) as T[];
}

export function get<T = Row>(sql: string, ...params: (string | number | null)[]): T | undefined {
  const row = db().prepare(sql).get(...params);
  return row ? ({ ...row } as T) : undefined;
}

export function run(sql: string, ...params: (string | number | null)[]): number {
  return Number(db().prepare(sql).run(...params).changes);
}

export const now = (): string => new Date().toISOString();
