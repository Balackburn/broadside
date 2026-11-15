import { InputError } from "@/lib/accounts";
import { route } from "@/lib/http";
import { revokeKey, revokeKeyAs } from "@/lib/keys";

/** Revokes a key. In a team an admin revokes their own keys, keys from before the team, and those of editors and viewers; an owner revokes any. */
export const DELETE = route<RouteContext<"/api/v1/keys/[id]">>({ role: "admin" }, async (_request, { params }, actor) => {
  const { id } = await params;
  const done = actor.team ? revokeKeyAs({ id: actor.member?.id ?? "", role: actor.role }, id) : revokeKey(id);
  if (!done) throw new InputError(`No key with id ${id}.`);
  return { revoked: id };
});
