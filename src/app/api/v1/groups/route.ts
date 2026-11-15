import { createGroup, listGroups } from "@/lib/groups";
import { body, route } from "@/lib/http";

/** Every group with the accounts in it. Names, networks and handles only, never credentials. */
export const GET = route(() => listGroups());

/** Creates a group from { name, account_ids }. */
export const POST = route(async (request) => createGroup(await body<{ name?: unknown; account_ids?: unknown }>(request)));
