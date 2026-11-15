import { InputError } from "@/lib/accounts";
import { asker, body, route } from "@/lib/http";
import { removeMember, setDisabled, setRole } from "@/lib/members";

type Ctx = RouteContext<"/api/v1/team/members/[id]">;

/**
 * Changes a member with { role } or { disabled: true | false }. The route asks
 * for an admin; the engine then holds an admin to editors and viewers, lets
 * nobody change themselves, and keeps the last owner an owner.
 */
export const PATCH = route<Ctx>({ role: "admin", with: "session" }, async (request, { params }, actor) => {
  const { id } = await params;
  const input = await body<{ role?: unknown; disabled?: unknown }>(request);
  if (input.role === undefined && typeof input.disabled !== "boolean") throw new InputError("Send role, or disabled as true or false.");
  let member = input.role !== undefined ? setRole(asker(actor), id, input.role) : undefined;
  if (typeof input.disabled === "boolean") member = setDisabled(asker(actor), id, input.disabled);
  return member;
});

/** Removes a member and their API keys. The posts they wrote stay. */
export const DELETE = route<Ctx>({ role: "admin", with: "session" }, async (_request, { params }, actor) => {
  const { id } = await params;
  removeMember(asker(actor), id);
  return { removed: id };
});
