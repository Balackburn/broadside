import { InputError } from "@/lib/accounts";
import { body, route } from "@/lib/http";
import { createKey, createMemberKey, listKeys } from "@/lib/keys";
import { memberNames } from "@/lib/members";

/** Every key by name and prefix, never the token. In a team each key shows who it belongs to and the role it was given. */
export const GET = route({ role: "admin" }, () => {
  const keys = listKeys();
  const names = memberNames(keys.map((key) => key.member_id));
  return keys.map((key) => ({ ...key, owner: key.member_id ? (names[key.member_id] ?? null) : null }));
});

/**
 * Creates a key from { name } and, in a team, { role }. A key made by a member
 * belongs to that member and its role can be at most their own right now; left
 * out, it is their own. A key that belongs to no one cannot make another in a team.
 */
export const POST = route({ role: "admin" }, async (request, _context, actor) => {
  const { name, role } = await body<{ name?: string; role?: unknown }>(request);
  if (!actor.team) return createKey(name ?? "");
  // actor.role is already the lower of the member's role and, when a key is asking, that key's own.
  if (!actor.member) throw new InputError("A key that belongs to no one cannot create keys. Sign in to the app as an admin.");
  return createMemberKey({ id: actor.member.id, role: actor.role }, name ?? "", role);
});
