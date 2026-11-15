import { serverSecret } from "./crypto";
import { get } from "./db";
import { markKeyUsed, matchKey } from "./keys";
import { sessionMember, teamMode, touchMember } from "./members";
import { isRole, lower, type Role } from "./roles";
import { claimedMember, memberSessionValid, sessionCookie, signedIn } from "./session";

/**
 * Who is behind a request, and what they may do. Everything that checks a
 * role asks here, and the answer is worked out from the database each time:
 * a role is never read from a cookie, and a key never outranks its owner.
 *
 * Single-user (no members): any request that was allowed before teams
 * existed is the owner. That is the whole rule, and it is why an install
 * that never adds a member behaves as it always has.
 *
 * Team (at least one member):
 *   a browser session  the member it was signed for, with their role now
 *   a member's key     the lower of the key's role and its owner's role now;
 *                      nothing at all once the owner is disabled or removed
 *   a key from before the team, or BROADSIDE_API_KEY
 *                      editor, and no member: it can still post, which is
 *                      what it was made for, and can change nothing about
 *                      accounts, keys, automations or the team
 */
export type Actor = {
  role: Role;
  /** The member acting, or null in single-user mode and for a key that belongs to no one. */
  member: { id: string; name: string } | null;
  /** How they proved it. "open" is a single-user install with no password. */
  via: "open" | "password" | "session" | "key";
  /** True when the install has members. */
  team: boolean;
};

/** What a key with no owner may do once there is a team. */
export const UNOWNED_KEY_ROLE: Role = "editor";

const SOLO: Omit<Actor, "via"> = { role: "owner", member: null, team: false };

/** The actor for an API token, or null when the token opens nothing. */
export function tokenActor(token: string): Actor | null {
  const match = matchKey(token);
  if (!match) return null;
  const team = teamMode();
  if (match.fixed) return team ? { role: UNOWNED_KEY_ROLE, member: null, via: "key", team } : { ...SOLO, via: "key" };
  let actor: Actor | null;
  if (match.member_id) {
    // A key made by a member lives and dies with that member, in either mode.
    const owner = get<{ id: string; name: string; role: string; disabled_at: string | null }>("SELECT id, name, role, disabled_at FROM members WHERE id = ?", match.member_id);
    actor = owner && !owner.disabled_at && isRole(owner.role) ? { role: lower(match.role ?? "viewer", owner.role), member: { id: owner.id, name: owner.name }, via: "key", team } : null;
  } else if (match.role) {
    // A role with no owner should not exist. If it does, the role is still a ceiling.
    actor = { role: team ? lower(match.role, UNOWNED_KEY_ROLE) : match.role, member: null, via: "key", team };
  } else {
    actor = team ? { role: UNOWNED_KEY_ROLE, member: null, via: "key", team } : { ...SOLO, via: "key" };
  }
  if (actor) markKeyUsed(match.id);
  return actor;
}

/**
 * The actor for a browser, from its cookie. Does not look at where the
 * request came from: callers that change things check Sec-Fetch-Site first
 * (see http.ts), and pages are only ever read.
 */
export async function sessionActor(request: Request, now = Date.now()): Promise<Actor | null> {
  if (!teamMode()) {
    if (!(await signedIn(request, now))) return null;
    return { ...SOLO, via: process.env.BROADSIDE_PASSWORD ? "password" : "open" };
  }
  // With a team, the shared password signs no one in: a cookie must name a member and be signed with that member's own secret.
  const value = sessionCookie(request);
  const claimed = claimedMember(value);
  const found = claimed ? sessionMember(claimed) : null;
  if (!found || !isRole(found.member.role)) return null;
  if (!(await memberSessionValid(value, `${serverSecret()}\u0000${found.secret}`, now))) return null;
  touchMember(found.member.id);
  return { role: found.member.role, member: { id: found.member.id, name: found.member.name }, via: "session", team: true };
}

/** What signs a member's cookie: the server secret with that member's password hash and session nonce. */
export function memberSecret(memberId: string): string | null {
  const found = sessionMember(memberId);
  return found && `${serverSecret()}\u0000${found.secret}`;
}

/**
 * The actor for something running on the server itself with the data folder
 * open: the stdio MCP server. Whoever starts it can already read and change
 * everything in that folder, so no role can bind them. The role here limits
 * the agent they hand it to. Single-user: owner, as before. In a team: when
 * BROADSIDE_API_KEY holds a member's key, that member under the same rule as
 * the key over HTTP (and nothing at all if they are disabled); otherwise the
 * same as a key that belongs to no one.
 */
export function localActor(): Actor | null {
  const team = teamMode();
  if (!team) return { ...SOLO, via: "open" };
  const token = process.env.BROADSIDE_API_KEY ?? "";
  const match = token ? matchKey(token) : null;
  if (match && !match.fixed) return tokenActor(token);
  return { role: UNOWNED_KEY_ROLE, member: null, via: "key", team };
}
