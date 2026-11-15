import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";

/**
 * One SQLite file, opened once per process. `node:sqlite` ships with Node, so
 * self-hosting needs no native build step and no database server.
 */

export function dataDir(): string {
  const dir = process.env.BROADSIDE_DATA_DIR || path.join(process.cwd(), "data");
  mkdirSync(dir, { recursive: true });
  return dir;
}

const SCHEMA = `
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
CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  prefix TEXT NOT NULL,
  hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_used_at TEXT
);
`;

type Global = typeof globalThis & { __broadsideDb?: { file: string; db: DatabaseSync } };

export function db(): DatabaseSync {
  const g = globalThis as Global;
  const file = path.join(dataDir(), "broadside.db");
  if (g.__broadsideDb?.file === file) return g.__broadsideDb.db;
  const handle = new DatabaseSync(file);
  handle.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  handle.exec(SCHEMA);
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
