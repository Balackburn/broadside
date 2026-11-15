import { timingSafeEqual } from "node:crypto";
import { InputError } from "./accounts";
import { newId, newToken, sha256 } from "./crypto";
import { all, get, now, run } from "./db";
import { isRole, manages, rank, type Role } from "./roles";

/**
 * `member_id` and `role` are set on a key made by a team member: the key
 * belongs to them and can do at most what `role` allows. Both are null on a
 * key made while the install was single-user ("created before the team").
 */
export type ApiKey = { id: string; name: string; prefix: string; created_at: string; last_used_at: string | null; member_id: string | null; role: Role | null };

const COLUMNS = "id, name, prefix, created_at, last_used_at, member_id, role";

/** The token is returned once and only its hash is stored. */
export function createKey(name: string, owner?: { member_id: string; role: Role }): { key: ApiKey; token: string } {
  const token = newToken();
  const id = newId("key");
  run("INSERT INTO api_keys (id, name, prefix, hash, created_at, member_id, role) VALUES (?, ?, ?, ?, ?, ?, ?)", id, name.trim() || "Unnamed key", token.slice(0, 10), sha256(token), now(), owner?.member_id ?? null, owner?.role ?? null);
  return { key: get<ApiKey>(`SELECT ${COLUMNS} FROM api_keys WHERE id = ?`, id)!, token };
}

/**
 * A key for a team member, with a role chosen now and never higher than the
 * member's own at this moment. What the key can do later is the lower of this
 * role and whatever the member's role has become (see actor.ts).
 */
export function createMemberKey(member: { id: string; role: Role }, name: string, role: unknown): { key: ApiKey; token: string } {
  const wanted = role === undefined || role === null ? member.role : role;
  if (!isRole(wanted)) throw new InputError("A key's role is one of viewer, editor, admin or owner.");
  if (rank(wanted) > rank(member.role)) throw new InputError(`A key can have a role up to your own, which is ${member.role}.`);
  return createKey(name, { member_id: member.id, role: wanted });
}

export function listKeys(): ApiKey[] {
  return all<ApiKey>(`SELECT ${COLUMNS} FROM api_keys ORDER BY created_at DESC`);
}

export function revokeKey(id: string): boolean {
  return run("DELETE FROM api_keys WHERE id = ?", id) > 0;
}

/**
 * Revoking in a team: your own keys, keys from before the team, and the keys
 * of members you could manage. An admin cannot revoke an owner's key or
 * another admin's.
 */
export function revokeKeyAs(asker: { id: string; role: Role }, id: string): boolean {
  const key = get<{ member_id: string | null }>("SELECT member_id FROM api_keys WHERE id = ?", id);
  if (!key) return false;
  if (key.member_id && key.member_id !== asker.id) {
    const owner = get<{ name: string; role: string }>("SELECT name, role FROM members WHERE id = ?", key.member_id);
    if (owner && isRole(owner.role) && !manages(asker.role, owner.role)) throw new InputError(`That key belongs to ${owner.name}. Revoking it needs an owner.`);
  }
  return revokeKey(id);
}

/** The token a request presents, as a Bearer token or an x-api-key header, or "". */
export function presentedToken(request: Request): string {
  const header = request.headers.get("authorization") ?? "";
  return header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : (request.headers.get("x-api-key") ?? "");
}

export type KeyMatch = { fixed: true } | { fixed: false; id: string; member_id: string | null; role: Role | null };

/**
 * The live key a token belongs to, or null. Says nothing yet about what the
 * key may do: actor.ts decides that. A key in the database is looked for
 * first, so a member's key is always held to that member's limits.
 */
export function matchKey(token: string): KeyMatch | null {
  if (!token) return null;
  const found = get<{ id: string; member_id: string | null; role: string | null }>("SELECT id, member_id, role FROM api_keys WHERE hash = ?", sha256(token));
  // A role this version does not know is treated as the lowest one, never as none.
  if (found) return { fixed: false, id: found.id, member_id: found.member_id, role: found.role === null ? null : isRole(found.role) ? found.role : "viewer" };
  // A key set in the environment lets a headless install be driven before anyone opens the app.
  // Compared as hashes in constant time, so response timing says nothing about the key.
  const fixed = process.env.BROADSIDE_API_KEY;
  if (fixed && timingSafeEqual(Buffer.from(sha256(token)), Buffer.from(sha256(fixed)))) return { fixed: true };
  return null;
}

export const markKeyUsed = (id: string): void => void run("UPDATE api_keys SET last_used_at = ? WHERE id = ?", now(), id);

/** True when the request carries a live key, as a Bearer token or an x-api-key header. */
export function authorized(request: Request): boolean {
  const match = matchKey(presentedToken(request));
  if (!match) return false;
  if (!match.fixed) markKeyUsed(match.id);
  return true;
}
