import { InputError } from "@/lib/accounts";
import { body, route } from "@/lib/http";
import { deleteMedia, setAlt } from "@/lib/media";

/** Deletes a file. Refused, with the number of posts, while a post that has not gone out yet still uses it. */
export const DELETE = route<RouteContext<"/api/v1/media/[id]">>(async (_request, { params }) => {
  const { id } = await params;
  if (!deleteMedia(id)) throw new InputError(`No media with id ${id}.`);
  return { deleted: id };
});

export const PATCH = route<RouteContext<"/api/v1/media/[id]">>(async (request, { params }) => {
  const { id } = await params;
  const { alt } = await body<{ alt?: string }>(request);
  return setAlt(id, alt ?? "");
});
