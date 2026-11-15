import { body, route } from "@/lib/http";
import { createTag, listTags } from "@/lib/tags";

/** Every tag, in alphabetical order, with how many posts carry it. */
export const GET = route(() => listTags());

/** Creates a tag from { name }. A name that already exists, in any capitalisation, returns that tag. */
export const POST = route(async (request) => createTag((await body<{ name?: unknown }>(request)).name));
