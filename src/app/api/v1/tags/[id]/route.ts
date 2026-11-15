import { InputError } from "@/lib/accounts";
import { body, route } from "@/lib/http";
import { deleteTag, renameTag } from "@/lib/tags";

type Ctx = RouteContext<"/api/v1/tags/[id]">;

/** Renames a tag with { name }. Every post that carries it shows the new name. */
export const PATCH = route<Ctx>({ role: "editor" }, async (request, { params }) => {
  const { id } = await params;
  return renameTag(id, (await body<{ name?: unknown }>(request)).name);
});

/** Deletes a tag and takes it off its posts. No post is deleted. */
export const DELETE = route<Ctx>({ role: "editor" }, async (_request, { params }) => {
  const { id } = await params;
  if (!deleteTag(id)) throw new InputError(`No tag with id ${id}.`);
  return { deleted: id };
});
