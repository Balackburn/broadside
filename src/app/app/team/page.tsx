import type { Metadata } from "next";
import { TeamPanel } from "@/components/team-panel";
import { publicBase } from "@/lib/media";
import { INVITE_DAYS, listInvites, listMembers, memberNames, PASSWORD_MIN } from "@/lib/members";
import { atLeast } from "@/lib/roles";
import { passwordRequired } from "@/lib/session";
import { viewer } from "@/lib/viewer";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Team" };

/**
 * Without a team: what one is, and the form that starts it. With one: the
 * members and their roles, invites for admins, and your own password. What a
 * member cannot do is left off the screen, and refused by the API either way.
 */
export default async function TeamPage() {
  const me = await viewer();
  const admin = me.team && atLeast(me.role, "admin");
  const invites = admin ? listInvites() : [];
  const names = memberNames(invites.map((invite) => invite.created_by));
  return (
    <TeamPanel
      me={me.team && me.member ? { id: me.member.id, name: me.member.name, role: me.role } : null}
      members={me.team ? listMembers() : []}
      invites={invites.map((invite) => ({ ...invite, invited_by: invite.created_by ? (names[invite.created_by] ?? null) : null }))}
      publicUrl={publicBase()}
      sharedPassword={passwordRequired()}
      passwordMin={PASSWORD_MIN}
      inviteDays={INVITE_DAYS}
    />
  );
}
