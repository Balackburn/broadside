import { createReadStream, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { Readable } from "node:stream";
import path from "node:path";
import { InputError } from "./accounts";
import { newId } from "./crypto";
import { all, dataDir, get, now, run } from "./db";
import { BlockedAddress, guardedFetch, readCapped } from "./net";
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
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
};

/** The largest upload accepted, in bytes. */
export const maxUploadBytes = (): number => MAX_BYTES;

/** Media ids are generated here and never contain a path separator; anything else is not an id. */
const isId = (id: string): boolean => /^med_[A-Za-z0-9_-]{6,40}$/.test(id);

/** What the bytes say they are, whatever the caller declared. */
export function sniff(bytes: Uint8Array): string | null {
  const head = Buffer.from(bytes.subarray(0, 16));
  if (head.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return "image/jpeg";
  if (head.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) return "image/png";
  if (head.subarray(0, 4).toString("latin1") === "GIF8") return "image/gif";
  if (head.subarray(0, 4).toString("latin1") === "RIFF" && head.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  if (head.subarray(4, 8).toString("latin1") === "ftyp") return head.subarray(8, 10).toString("latin1") === "qt" ? "video/quicktime" : "video/mp4";
  if (head.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return "video/webm";
  return null;
}

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
  // The stored type comes from the bytes. A text file called a PNG is refused, so nothing but real media is ever kept or served.
  const actual = sniff(bytes);
  if (!actual) throw new InputError("That file is not a JPEG, PNG, WebP, GIF, MP4, MOV or WebM, whatever its name says.");
  if (bytes.length > MAX_BYTES) throw new InputError(`That file is larger than the ${MAX_BYTES / 1024 / 1024} MB limit.`);
  const id = newId("med");
  writeFileSync(path.join(folder(), id), bytes);
  run(
    "INSERT INTO media (id, filename, content_type, size, alt, source_url, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    id,
    safeName(filename),
    actual,
    bytes.length,
    extra.alt ?? null,
    extra.sourceUrl ?? null,
    now(),
  );
  return getMedia(id)!;
}

export async function importMedia(sourceUrl: string, alt?: string, fetcher: typeof fetch = fetch): Promise<Media> {
  let url: URL;
  try {
    url = new URL(sourceUrl);
  } catch {
    throw new InputError("That media URL is not a valid address.");
  }
  if (!/^https?:$/.test(url.protocol)) throw new InputError("Media URLs must start with http:// or https://.");
  // guardedFetch checks the first address and every redirect, so a public URL cannot bounce the download into the private network.
  const response = await guardedFetch(fetcher)(url).catch((cause: Error) => {
    throw new InputError(cause instanceof BlockedAddress ? cause.message : `Could not download ${url.host}: ${cause.message}`);
  });
  if (!response.ok) throw new InputError(`Could not download the media: ${url.host} answered ${response.status}.`);
  if (Number(response.headers.get("content-length") ?? 0) > MAX_BYTES) throw new InputError(`That file is larger than the ${MAX_BYTES / 1024 / 1024} MB limit.`);
  const bytes = await readCapped(response, MAX_BYTES).catch((cause: Error) => {
    throw new InputError(cause.message);
  });
  const name = path.basename(url.pathname) || "media";
  return saveMedia(bytes, name, response.headers.get("content-type") ?? "", { alt, sourceUrl });
}

export function getMedia(id: string): Media | undefined {
  if (!isId(id)) return undefined;
  const row = get<MediaRow>("SELECT * FROM media WHERE id = ?", id);
  return row && view(row);
}

export function listMedia(limit = 60): Media[] {
  return all<MediaRow>("SELECT * FROM media ORDER BY created_at DESC, rowid DESC LIMIT ?", limit).map(view);
}

/** One post that carries a file. `waiting` is true while any part of that post has yet to go out. */
export type MediaUse = { post_id: string; excerpt: string; waiting: boolean };
export type LibraryItem = Media & { used_by: MediaUse[] };

/** A target in one of these states may still send the post's media: it is a draft, is scheduled, is on its way out, or failed and can be retried. */
const WAITING = "('draft', 'scheduled', 'pending', 'publishing', 'retrying', 'failed')";

const USES = `
  SELECT DISTINCT j.value AS media_id, p.id AS post_id, COALESCE(p.publish_at, p.created_at) AS at, substr(p.content, 1, 80) AS excerpt,
    EXISTS (SELECT 1 FROM targets t WHERE t.post_id = p.id AND t.status IN ${WAITING}) AS waiting
  FROM posts p, json_each(p.media) j`;

type UseRow = { media_id: string; post_id: string; excerpt: string; waiting: number };

const asUse = (row: UseRow): MediaUse => ({ post_id: row.post_id, excerpt: row.excerpt, waiting: row.waiting === 1 });

/** The posts that carry this file, newest first. */
export function mediaUses(id: string): MediaUse[] {
  if (!isId(id)) return [];
  return all<UseRow>(`${USES} WHERE j.value = ? ORDER BY at DESC`, id).map(asUse);
}

/** Everything in the library, newest first, each with the posts that use it. */
export function listLibrary(limit = 200): LibraryItem[] {
  const uses = new Map<string, MediaUse[]>();
  for (const row of all<UseRow>(`${USES} ORDER BY at DESC`)) uses.set(row.media_id, [...(uses.get(row.media_id) ?? []), asUse(row)]);
  const capped = Math.min(Math.max(1, Math.floor(limit) || 200), 1000);
  return listMedia(capped).map((media) => ({ ...media, used_by: uses.get(media.id) ?? [] }));
}

export function setAlt(id: string, alt: string): Media {
  if (!run("UPDATE media SET alt = ? WHERE id = ?", alt.trim() || null, id)) throw new InputError(`No media with id ${id}.`);
  return getMedia(id)!;
}

export function readMedia(id: string): Uint8Array {
  if (!isId(id)) throw new InputError(`No media with id ${id}.`);
  return new Uint8Array(readFileSync(path.join(folder(), id)));
}

/** The file as a stream, so serving a large video never loads it into memory. */
export function streamMedia(id: string): ReadableStream<Uint8Array> {
  if (!isId(id)) throw new InputError(`No media with id ${id}.`);
  return Readable.toWeb(createReadStream(path.join(folder(), id))) as ReadableStream<Uint8Array>;
}

/**
 * The record goes first, and a file is only removed when a record for exactly that id existed.
 * A file that a post has yet to send is kept (a draft, a scheduled post, or one that failed and
 * can be retried): deleting it would send that post out without its picture. Once every post
 * that used it has gone out, it may be deleted.
 */
export function deleteMedia(id: string): boolean {
  if (!isId(id)) return false;
  const waiting = mediaUses(id).filter((use) => use.waiting);
  if (waiting.length) {
    const one = waiting.length === 1;
    throw new InputError(
      `${waiting.length} ${one ? "post that has not gone out yet still uses" : "posts that have not gone out yet still use"} this file. Edit or remove ${one ? "that post" : "those posts"} first, or delete the file once ${one ? "it is" : "they are"} published.`,
      { post_ids: waiting.map((use) => use.post_id) },
    );
  }
  if (!run("DELETE FROM media WHERE id = ?", id)) return false;
  rmSync(path.join(folder(), id), { force: true });
  return true;
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
