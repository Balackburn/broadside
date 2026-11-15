import { InputError } from "@/lib/accounts";
import { deleteGroup, getGroup, updateGroup } from "@/lib/groups";
import { body, route } from "@/lib/http";

type Ctx = RouteContext<"/api/v1/groups/[id]">;

export const GET = route<Ctx>({ role: "viewer" }, async (_request, { params }) => {
  const { id } = await params;
  const group = getGroup(id);
  if (!group) throw new InputError(`No group with id ${id}.`);
  return group;
});

/** Renames a group or replaces its members with { name, account_ids }. Either may be left out. */
export const PATCH = route<Ctx>({ role: "editor" }, async (request, { params }) => {
  const { id } = await params;
  return updateGroup(id, await body<{ name?: unknown; account_ids?: unknown }>(request));
});

/** Deletes the group. Its accounts stay connected. */
export const DELETE = route<Ctx>({ role: "editor" }, async (_request, { params }) => {
  const { id } = await params;
  if (!deleteGroup(id)) throw new InputError(`No group with id ${id}.`);
  return { deleted: id };
});
