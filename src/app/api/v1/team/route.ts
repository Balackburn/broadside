import { InputError } from "@/lib/accounts";
import { memberSecret } from "@/lib/actor";
import { body, route } from "@/lib/http";
import { listInvites, listMembers, memberNames, startTeam } from "@/lib/members";
import { atLeast } from "@/lib/roles";
import { memberSessionValue, sessionHeader } from "@/lib/session";

/**
 * The team as the person asking may see it: whether there is one, who they
 * are, every member with their role, and for admins the invites still waiting.
 * A person in the app only; no API key reads or changes the team.
 */
export const GET = route({ role: "viewer", with: "session" }, (_request, _context, actor) => {
  const invites = actor.team && atLeast(actor.role, "admin") ? listInvites() : [];
  const names = memberNames(invites.map((invite) => invite.created_by));
  return {
    team: actor.team,
    me: actor.member ? { ...actor.member, role: actor.role } : null,
    members: actor.team ? listMembers() : [],
    invites: invites.map((invite) => ({ ...invite, invited_by: invite.created_by ? (names[invite.created_by] ?? null) : null })),
  };
});

/**
 * Sets up a team from { name, password }: whoever runs this install becomes
 * its first member and its owner, and is signed in as that member at once.
 * It is allowed exactly as any request was before there was a team, and only
 * while there is none.
 */
export const POST = route({ role: "owner", with: "session" }, async (request, _context, actor) => {
  if (actor.team) throw new InputError("This Broadside already has a team. Invite people from the Team screen.");
  const owner = await startTeam(await body<{ name?: unknown; password?: unknown }>(request));
  const secret = memberSecret(owner.id);
  const headers = secret ? { "set-cookie": sessionHeader(await memberSessionValue(owner.id, secret), request) } : undefined;
  return Response.json({ data: { team: true, me: { id: owner.id, name: owner.name, role: owner.role } } }, { headers });
});
