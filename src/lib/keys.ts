import { newId, newToken, sha256 } from "./crypto";
import { all, get, now, run } from "./db";

export type ApiKey = { id: string; name: string; prefix: string; created_at: string; last_used_at: string | null };

/** The token is returned once and only its hash is stored. */
export function createKey(name: string): { key: ApiKey; token: string } {
  const token = newToken();
  const id = newId("key");
  run("INSERT INTO api_keys (id, name, prefix, hash, created_at) VALUES (?, ?, ?, ?, ?)", id, name.trim() || "Unnamed key", token.slice(0, 10), sha256(token), now());
  return { key: get<ApiKey>("SELECT id, name, prefix, created_at, last_used_at FROM api_keys WHERE id = ?", id)!, token };
}

export function listKeys(): ApiKey[] {
  return all<ApiKey>("SELECT id, name, prefix, created_at, last_used_at FROM api_keys ORDER BY created_at DESC");
}

export function revokeKey(id: string): boolean {
  return run("DELETE FROM api_keys WHERE id = ?", id) > 0;
}

/** True when the request carries a live key, as a Bearer token or an x-api-key header. */
export function authorized(request: Request): boolean {
  const header = request.headers.get("authorization") ?? "";
  const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : (request.headers.get("x-api-key") ?? "");
  if (!token) return false;
  // A key set in the environment lets a headless install be driven before anyone opens the app.
  if (process.env.BROADSIDE_API_KEY && token === process.env.BROADSIDE_API_KEY) return true;
  const found = get<{ id: string }>("SELECT id FROM api_keys WHERE hash = ?", sha256(token));
  if (!found) return false;
  run("UPDATE api_keys SET last_used_at = ? WHERE id = ?", now(), found.id);
  return true;
}
