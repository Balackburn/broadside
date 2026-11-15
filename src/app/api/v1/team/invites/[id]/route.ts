import { asker, route } from "@/lib/http";
import { revokeInvite } from "@/lib/members";

/** Withdraws an invite nobody has used. Its link stops working at once. */
export const DELETE = route<RouteContext<"/api/v1/team/invites/[id]">>({ role: "admin", with: "session" }, async (_request, { params }, actor) => {
  const { id } = await params;
  revokeInvite(asker(actor), id);
  return { revoked: id };
});
