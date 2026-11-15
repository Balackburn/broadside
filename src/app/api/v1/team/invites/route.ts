import { asker, body, linkBase, route } from "@/lib/http";
import { createInvite } from "@/lib/members";

/**
 * Invites someone from { name, role }, with a role no higher than the
 * inviter's own. The reply carries the one-time link, this once: `path` always,
 * and `url` when this Broadside knows its own address. Only a hash of the
 * token is kept, so the link cannot be shown again.
 */
export const POST = route({ role: "admin", with: "session" }, async (request, _context, actor) => {
  const { invite, token } = createInvite(asker(actor), await body<{ name?: unknown; role?: unknown }>(request));
  const path = `/join/${token}`;
  const base = linkBase(request);
  return { invite, path, url: base ? `${base}${path}` : null };
});
