import type { Feed } from "./feeds";
import type { OutgoingWebhook } from "./outgoing";
import { atLeast, type Role } from "./roles";

/**
 * Feed and receiver addresses often carry a token. Admins set them, so admins
 * see them whole. Everyone else sees enough to recognise the address and none
 * of the part that could be a secret: a feed without its query, a receiver as
 * its site alone. `redacted` says when that has been done.
 */
export function feedFor<T extends Pick<Feed, "url">>(role: Role, feed: T): T & { redacted?: true } {
  if (atLeast(role, "admin")) return feed;
  const address = new URL(feed.url);
  return { ...feed, url: `${address.origin}${address.pathname}`, redacted: true };
}

export function webhookFor<T extends Pick<OutgoingWebhook, "url">>(role: Role, webhook: T): T & { redacted?: true } {
  if (atLeast(role, "admin")) return webhook;
  return { ...webhook, url: new URL(webhook.url).origin, redacted: true };
}
