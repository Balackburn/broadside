import { body, route } from "@/lib/http";
import { createSignature, listSignatures } from "@/lib/signatures";

/** Every saved signature, with the accounts that offer it by default. */
export const GET = route({ role: "viewer" }, () => listSignatures());

/** Creates a signature from { name, content } and, optionally, default_for: the accounts that offer it by default. */
export const POST = route({ role: "editor" }, async (request) => createSignature(await body<{ name?: unknown; content?: unknown; default_for?: unknown }>(request)));
