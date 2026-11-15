import { createFeed, listFeeds } from "@/lib/feeds";
import { body, route } from "@/lib/http";

/** Every feed with when it was last checked, its last error and the posts it created. */
export const GET = route(() => listFeeds());

/** Adds a feed from { url, account_ids or group_id, template, action }. The address is read once to make sure it is a feed. */
export const POST = route(async (request) => createFeed(await body<{ url?: unknown; account_ids?: unknown; group_id?: unknown; template?: unknown; action?: unknown }>(request)));
