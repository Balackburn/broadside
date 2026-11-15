import { InputError } from "@/lib/accounts";
import { body, route } from "@/lib/http";
import { deleteOutgoingWebhook, getOutgoingWebhook, updateOutgoingWebhook } from "@/lib/outgoing";

type Ctx = RouteContext<"/api/v1/outgoing-webhooks/[id]">;

export const GET = route<Ctx>(async (_request, { params }) => {
  const { id } = await params;
  const webhook = getOutgoingWebhook(id);
  if (!webhook) throw new InputError(`No outgoing webhook with id ${id}.`);
  return webhook;
});

/** Changes { name, url, events }, or pauses and resumes with { paused }. Anything left out stays as it is. */
export const PATCH = route<Ctx>(async (request, { params }) => {
  const { id } = await params;
  return updateOutgoingWebhook(id, await body<{ name?: unknown; url?: unknown; events?: unknown; paused?: unknown }>(request));
});

export const DELETE = route<Ctx>(async (_request, { params }) => {
  const { id } = await params;
  if (!deleteOutgoingWebhook(id)) throw new InputError(`No outgoing webhook with id ${id}.`);
  return { deleted: id };
});
