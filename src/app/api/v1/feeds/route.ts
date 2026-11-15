import { createFeed, listFeeds } from "@/lib/feeds";
import { body, route } from "@/lib/http";
import { feedFor } from "@/lib/redact";

/** Every feed with when it was last checked, its last error and the posts it created. Below admin, a feed's address comes without its query. */
export const GET = route({ role: "viewer" }, (_request, _context, actor) => listFeeds().map((feed) => feedFor(actor.role, feed)));

/** Adds a feed from { url, account_ids or group_id, template, action }. The address is read once to make sure it is a feed. */
export const POST = route({ role: "admin" }, async (request) => createFeed(await body<{ url?: unknown; account_ids?: unknown; group_id?: unknown; template?: unknown; action?: unknown }>(request)));
