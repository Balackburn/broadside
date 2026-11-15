import { InputError } from "@/lib/accounts";
import { route } from "@/lib/http";
import { revokeKey } from "@/lib/keys";

export const DELETE = route<RouteContext<"/api/v1/keys/[id]">>(async (_request, { params }) => {
  const { id } = await params;
  if (!revokeKey(id)) throw new InputError(`No key with id ${id}.`);
  return { revoked: id };
});
