import type { Metadata } from "next";
import { headers } from "next/headers";
import { KeysPanel } from "@/components/keys-panel";
import { RoleNotice } from "@/components/role-notice";
import { listKeys } from "@/lib/keys";
import { publicBase } from "@/lib/media";
import { listMembers } from "@/lib/members";
import { atLeast } from "@/lib/roles";
import { viewer } from "@/lib/viewer";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Connect" };

export default async function ConnectPage() {
  const me = await viewer();
  if (!atLeast(me.role, "admin")) {
    return <RoleNotice title="Connect">API keys let an agent or a script act on this Broadside, so they are made by an admin. Ask one for a key with the role you need.</RoleNotice>;
  }
  const h = await headers();
  const base = publicBase() ?? `http://${h.get("host") ?? "localhost:3000"}`;
  const keys = listKeys();
  const members = new Map(listMembers().map((member) => [member.id, member]));
  return (
    <KeysPanel
      keys={keys.map((key) => ({ ...key, owner: key.member_id ? (members.get(key.member_id)?.name ?? null) : null, owner_role: key.member_id ? (members.get(key.member_id)?.role ?? null) : null }))}
      base={base}
      cwd={process.cwd()}
      team={me.team && me.member ? { id: me.member.id, role: me.role } : undefined}
    />
  );
}
