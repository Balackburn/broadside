import { body, route } from "@/lib/http";
import { inspectPost, type TargetInput } from "@/lib/posts";

/** A dry run: how this text, media and thread fit each chosen account. Sends nothing. */
export const POST = route(async (request) => inspectPost(await body<{ content: string; targets?: TargetInput[]; group_id?: string | null; media_ids?: string[]; thread?: string[] }>(request)));
