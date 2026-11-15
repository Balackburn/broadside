import { InputError, removeAccount } from "@/lib/accounts";
import { body, route } from "@/lib/http";
import { setAccountSignature } from "@/lib/signatures";

type Ctx = RouteContext<"/api/v1/accounts/[id]">;

/** Sets the signature this account offers by default with { signature_id }, or clears it with null. */
export const PATCH = route<Ctx>({ role: "editor" }, async (request, { params }) => {
  const { id } = await params;
  const input = await body<{ signature_id?: unknown }>(request);
  if (input.signature_id === undefined) throw new InputError("Send signature_id: a signature's id, or null to offer none.");
  return setAccountSignature(id, input.signature_id);
});

export const DELETE = route<Ctx>({ role: "admin" }, async (_request, { params }) => {
  const { id } = await params;
  if (!removeAccount(id)) throw new InputError(`No account with id ${id}.`);
  return { disconnected: id };
});
