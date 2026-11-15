import { InputError } from "@/lib/accounts";
import { deleteFeed, getFeed, updateFeed } from "@/lib/feeds";
import { body, route } from "@/lib/http";
import { feedFor } from "@/lib/redact";

type Ctx = RouteContext<"/api/v1/feeds/[id]">;

export const GET = route<Ctx>({ role: "viewer" }, async (_request, { params }, actor) => {
  const { id } = await params;
  const feed = getFeed(id);
  if (!feed) throw new InputError(`No feed with id ${id}.`);
  return feedFor(actor.role, feed);
});

/** Changes { account_ids or group_id, template, action }, or pauses and resumes with { paused }. Anything left out stays as it is. */
export const PATCH = route<Ctx>({ role: "admin" }, async (request, { params }) => {
  const { id } = await params;
  return updateFeed(id, await body<{ account_ids?: unknown; group_id?: unknown; template?: unknown; action?: unknown; paused?: unknown; url?: unknown }>(request));
});

/** Deletes the feed. The posts it created stay. */
export const DELETE = route<Ctx>({ role: "admin" }, async (_request, { params }) => {
  const { id } = await params;
  if (!deleteFeed(id)) throw new InputError(`No feed with id ${id}.`);
  return { deleted: id };
});
