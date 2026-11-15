import { body, route } from "@/lib/http";
import { createOutgoingWebhook, listOutgoingWebhooks } from "@/lib/outgoing";

/** Every outgoing webhook with its latest deliveries. A signing secret is never in this list. */
export const GET = route(() => listOutgoingWebhooks());

/** Creates one from { name, url, events }. The reply carries `secret`, the signing secret, this once and never again. */
export const POST = route(async (request) => {
  const { webhook, secret } = await createOutgoingWebhook(await body<{ name?: unknown; url?: unknown; events?: unknown }>(request));
  return { ...webhook, secret };
});
