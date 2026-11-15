import { InputError } from "@/lib/accounts";
import { body, route } from "@/lib/http";
import { deleteSignature, updateSignature } from "@/lib/signatures";

type Ctx = RouteContext<"/api/v1/signatures/[id]">;

/** Changes a signature's name, content or default_for. Posts already written keep the text they were given. */
export const PATCH = route<Ctx>({ role: "editor" }, async (request, { params }) => {
  const { id } = await params;
  return updateSignature(id, await body<{ name?: unknown; content?: unknown; default_for?: unknown }>(request));
});

/** Deletes the saved text. Accounts that offered it by default offer nothing. */
export const DELETE = route<Ctx>({ role: "editor" }, async (_request, { params }) => {
  const { id } = await params;
  if (!deleteSignature(id)) throw new InputError(`No signature with id ${id}.`);
  return { deleted: id };
});
