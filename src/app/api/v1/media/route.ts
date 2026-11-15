import { InputError } from "@/lib/accounts";
import { body, route } from "@/lib/http";
import { importMedia, listMedia, saveMedia } from "@/lib/media";

export const GET = route(() => listMedia());

/** Accepts a multipart upload (field "file", optional "alt") or JSON { url, alt }. */
export const POST = route(async (request) => {
  if ((request.headers.get("content-type") ?? "").includes("multipart/form-data")) {
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) throw new InputError('Send the file in a form field named "file".');
    const alt = form.get("alt");
    return saveMedia(new Uint8Array(await file.arrayBuffer()), file.name, file.type, { alt: typeof alt === "string" && alt ? alt : undefined });
  }
  const input = await body<{ url?: string; alt?: string }>(request);
  if (!input.url) throw new InputError("Send a multipart file, or JSON with a url to import.");
  return importMedia(input.url, input.alt);
});
