import { body, route } from "@/lib/http";
import { createOutgoingWebhook, listOutgoingWebhooks } from "@/lib/outgoing";
import { webhookFor } from "@/lib/redact";

/** Every outgoing webhook with its latest deliveries. A signing secret is never in this list. Below admin, the address is the receiver's site only. */
export const GET = route({ role: "viewer" }, (_request, _context, actor) => listOutgoingWebhooks().map((webhook) => webhookFor(actor.role, webhook)));

/** Creates one from { name, url, events }. The reply carries `secret`, the signing secret, this once and never again. */
export const POST = route({ role: "admin" }, async (request) => {
  const { webhook, secret } = await createOutgoingWebhook(await body<{ name?: unknown; url?: unknown; events?: unknown }>(request));
  return { ...webhook, secret };
});
