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
];

/**
 * Tables added after the first release: tags and the posts that carry them,
 * named groups of accounts, and saved signatures. Each is created only if it
 * is missing, so an existing database gains them and keeps every row it had.
 * `name_key` is the name folded to one case, so "Launch" and "launch" are one tag.
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
