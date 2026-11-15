import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import path from "node:path";
import { InputError } from "./accounts";
import { newId } from "./crypto";
import { all, dataDir, get, now, run } from "./db";
import type { MediaItem } from "./platforms/types";

export type Media = {
  id: string;
  filename: string;
  content_type: string;
  size: number;
  alt: string | null;
  source_url: string | null;
  created_at: string;
  type: "image" | "video";
  url: string;
  public_url: string | null;
};

type MediaRow = Omit<Media, "type" | "url" | "public_url">;

const ALLOWED = ["image/jpeg", "image/png", "image/webp", "image/gif", "video/mp4", "video/quicktime", "video/webm"];
const MAX_BYTES = Number(process.env.BROADSIDE_MAX_UPLOAD_MB ?? 512) * 1024 * 1024;

const folder = () => {
  const dir = path.join(dataDir(), "media");
  mkdirSync(dir, { recursive: true });
  return dir;
};

const safeName = (name: string) => name.replace(/[^\w.\-]+/g, "_").slice(-80) || "file";

export function publicBase(): string | null {
  const base = process.env.BROADSIDE_PUBLIC_URL?.replace(/\/+$/, "");
  return base || null;
}

function view(row: MediaRow): Media {
  const local = `/media/${row.id}/${encodeURIComponent(row.filename)}`;
  const base = publicBase();
  return {
    ...row,
    type: row.content_type.startsWith("video/") ? "video" : "image",
    url: local,
    public_url: row.source_url ?? (base ? `${base}${local}` : null),
  };
}

export function saveMedia(bytes: Uint8Array, filename: string, contentType: string, extra: { alt?: string; sourceUrl?: string } = {}): Media {
  const type = contentType.split(";")[0].trim().toLowerCase();
  if (!ALLOWED.includes(type)) throw new InputError(`Broadside accepts JPEG, PNG, WebP, GIF, MP4, MOV and WebM; this file is ${type || "of an unknown type"}.`);
  if (bytes.length === 0) throw new InputError("That file is empty.");
  if (bytes.length > MAX_BYTES) throw new InputError(`That file is larger than the ${MAX_BYTES / 1024 / 1024} MB limit.`);
  const id = newId("med");
  writeFileSync(path.join(folder(), id), bytes);
  run(
    "INSERT INTO media (id, filename, content_type, size, alt, source_url, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    id,
    safeName(filename),
    type,
    bytes.length,
    extra.alt ?? null,
    extra.sourceUrl ?? null,
    now(),
  );
  return getMedia(id)!;
}

/** Refuses addresses inside the host's own network, so a pasted URL cannot be used to read internal services. */
async function assertPublicHost(url: URL): Promise<void> {
  if (process.env.BROADSIDE_ALLOW_PRIVATE_FETCH === "1") return;
  const addresses = isIP(url.hostname) ? [url.hostname] : (await lookup(url.hostname, { all: true })).map((a) => a.address);
  const internal = addresses.some((a) => /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.|::1$|f[cd]|fe80)/i.test(a));
  if (internal) throw new InputError("That address points inside a private network, so Broadside will not fetch it.");
}

export async function importMedia(sourceUrl: string, alt?: string, fetcher: typeof fetch = fetch): Promise<Media> {
  let url: URL;
  try {
    url = new URL(sourceUrl);
  } catch {
    throw new InputError("That media URL is not a valid address.");
  }
  if (!/^https?:$/.test(url.protocol)) throw new InputError("Media URLs must start with http:// or https://.");
  await assertPublicHost(url);
  const response = await fetcher(url, { redirect: "follow" }).catch((cause: Error) => {
    throw new InputError(`Could not download ${url.host}: ${cause.message}`);
  });
  if (!response.ok) throw new InputError(`Could not download the media: ${url.host} answered ${response.status}.`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const name = path.basename(url.pathname) || "media";
  return saveMedia(bytes, name, response.headers.get("content-type") ?? "", { alt, sourceUrl });
}

export function getMedia(id: string): Media | undefined {
  const row = get<MediaRow>("SELECT * FROM media WHERE id = ?", id);
  return row && view(row);
}

export function listMedia(limit = 60): Media[] {
  return all<MediaRow>("SELECT * FROM media ORDER BY created_at DESC LIMIT ?", limit).map(view);
}

export function setAlt(id: string, alt: string): Media {
  if (!run("UPDATE media SET alt = ? WHERE id = ?", alt.trim() || null, id)) throw new InputError(`No media with id ${id}.`);
  return getMedia(id)!;
}

export function readMedia(id: string): Uint8Array {
  return new Uint8Array(readFileSync(path.join(folder(), id)));
}

export function deleteMedia(id: string): boolean {
  rmSync(path.join(folder(), id), { force: true });
  return run("DELETE FROM media WHERE id = ?", id) > 0;
}

export function toItem(media: Media): MediaItem {
  return {
    id: media.id,
    type: media.type,
    contentType: media.content_type,
    filename: media.filename,
    alt: media.alt ?? undefined,
    read: async () => readMedia(media.id),
    publicUrl: media.public_url ?? undefined,
  };
}
