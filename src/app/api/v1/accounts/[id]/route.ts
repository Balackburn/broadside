import { InputError, removeAccount } from "@/lib/accounts";
import { route } from "@/lib/http";

export const DELETE = route<RouteContext<"/api/v1/accounts/[id]">>(async (_request, { params }) => {
  const { id } = await params;
  if (!removeAccount(id)) throw new InputError(`No account with id ${id}.`);
  return { disconnected: id };
});
