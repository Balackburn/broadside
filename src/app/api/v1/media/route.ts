import { InputError } from "@/lib/accounts";
import { body, route } from "@/lib/http";
import { importMedia, listLibrary, maxUploadBytes, saveMedia } from "@/lib/media";

/** The library, newest first, each file with the posts that use it. `?limit=` caps the list (default 200). */
export const GET = route({ role: "viewer" }, (request) => {
  const limit = new URL(request.url).searchParams.get("limit");
  return listLibrary(limit ? Number(limit) : undefined);
});

/** Accepts a multipart upload (field "file", optional "alt") or JSON { url, alt }. */
export const POST = route({ role: "editor" }, async (request) => {
  // Refused from the declared size, before any of the body is read into memory.
  if (Number(request.headers.get("content-length") ?? 0) > maxUploadBytes() + 1024 * 1024) {
    throw new InputError(`That upload is larger than the ${maxUploadBytes() / 1024 / 1024} MB limit.`);
  }
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
