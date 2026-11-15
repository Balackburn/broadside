"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { api, Check, Dialog, Icon, Time, useToast } from "./ui";

export type MediaUse = { post_id: string; excerpt: string; waiting: boolean };
export type LibraryItem = {
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
  used_by: MediaUse[];
};

const ACCEPT = "image/jpeg,image/png,image/webp,image/gif,video/mp4,video/quicktime,video/webm";
const KINDS: Record<string, string> = {
  "image/jpeg": "JPEG image",
  "image/png": "PNG image",
  "image/webp": "WebP image",
  "image/gif": "GIF image",
  "video/mp4": "MP4 video",
  "video/quicktime": "MOV video",
  "video/webm": "WebM video",
};

export const kindOf = (item: { content_type: string; type: string }): string => KINDS[item.content_type] ?? (item.type === "video" ? "Video" : "Image");

/** A file size in the largest unit that keeps it readable. */
export function sizeOf(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

/** The file itself, shown and never run: an image, or a video's first frame. */
function Picture({ item }: { item: Pick<LibraryItem, "type" | "url" | "alt"> }) {
  return item.type === "image" ? (
    // eslint-disable-next-line @next/next/no-img-element -- user uploads are served from the data directory, not a build-time asset
    <img src={item.url} alt={item.alt ?? ""} loading="lazy" />
  ) : (
    <video src={item.url} muted preload="metadata" aria-label={item.alt ?? undefined} />
  );
}

/** Everything uploaded or imported, newest first: add to it, describe a file, see where it is used, delete what is finished with. */
export function MediaLibrary({ items }: { items: LibraryItem[] }) {
  const router = useRouter();
  const { show, toast } = useToast();
  const file = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  // Why a file could not be deleted stays beside it until the next try, long enough to read and act on.
  const [refused, setRefused] = useState<{ id: string; text: string } | null>(null);

  async function upload(files: FileList | null) {
    if (!files?.length) return;
    setUploading(true);
    let added = 0;
    try {
      for (const item of Array.from(files)) {
        const form = new FormData();
        form.set("file", item);
        await api("/media", { method: "POST", body: form });
        added++;
      }
      show(added === 1 ? "Added 1 file." : `Added ${added} files.`);
    } catch (error) {
      show((error as Error).message);
    } finally {
      setUploading(false);
      if (file.current) file.current.value = "";
      if (added) router.refresh();
    }
  }

  async function importLink(event: React.FormEvent) {
    event.preventDefault();
    if (!link.trim()) return;
    setImporting(true);
    try {
      await api("/media", { method: "POST", body: JSON.stringify({ url: link.trim() }) });
      setLink("");
      show("Imported.");
      router.refresh();
    } catch (error) {
      show((error as Error).message);
    } finally {
      setImporting(false);
    }
  }

  async function saveAlt(item: LibraryItem, alt: string) {
    if (alt.trim() === (item.alt ?? "")) return;
    try {
      await api(`/media/${item.id}`, { method: "PATCH", body: JSON.stringify({ alt }) });
      show(alt.trim() ? "Description saved." : "Description removed.");
      router.refresh();
    } catch (error) {
      show((error as Error).message);
    }
  }

  async function remove(item: LibraryItem) {
    // Only posts that have gone out can lose a file; while one is still waiting the server refuses and says how many.
    const sent = item.used_by.some((use) => use.waiting) ? 0 : item.used_by.length;
    const note = sent ? ` ${sent === 1 ? "The post that used it keeps its" : `The ${sent} posts that used it keep their`} text and no longer ${sent === 1 ? "shows" : "show"} this file.` : "";
    if (!window.confirm(`Delete ${item.filename} from the library?${note} This cannot be undone.`)) return;
    setBusy(item.id);
    setRefused(null);
    try {
      await api(`/media/${item.id}`, { method: "DELETE" });
      show(`Deleted ${item.filename}.`);
      router.refresh();
    } catch (error) {
      setRefused({ id: item.id, text: (error as Error).message });
    } finally {
      setBusy(null);
    }
  }

  const picker = <input ref={file} type="file" hidden multiple accept={ACCEPT} onChange={(e) => upload(e.target.files)} />;
  const uploadButton = (className: string) => (
    <button type="button" className={className} onClick={() => file.current?.click()} disabled={uploading}>
      {uploading ? <span className="spinner" /> : <Icon name="plus" size={16} />}
      {uploading ? "Uploading" : "Upload"}
    </button>
  );
  const importForm = (
    <form onSubmit={importLink} className="flex min-w-0 flex-1 basis-full gap-2 sm:max-w-md sm:basis-0">
      <label className="sr-only" htmlFor="media-link">
        Link to an image or video
      </label>
      <input id="media-link" className="field min-w-0" type="url" inputMode="url" placeholder="Link to an image or video" value={link} onChange={(e) => setLink(e.target.value)} autoComplete="off" spellCheck={false} />
      <button type="submit" className="btn btn-quiet flex-none" disabled={importing || !link.trim()}>
        {importing ? <span className="spinner" /> : null}
        {importing ? "Importing" : "Import"}
      </button>
    </form>
  );

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <h1 className="heading text-4xl">Media</h1>
        {items.length ? <p className="note num">{items.length === 1 ? "1 file" : `${items.length} files`}</p> : null}
      </div>
      {picker}

      {items.length === 0 ? (
        <div className="panel mt-8 p-8 sm:p-10">
          <p className="title text-xl">No media yet.</p>
          <p className="note mt-2 max-w-xl">Every image and video you upload or import by link is kept here. Attach one to as many posts as you like without uploading it again.</p>
          <div className="mt-6 flex flex-wrap items-center gap-3">
            {uploadButton("btn")}
            {importForm}
          </div>
        </div>
      ) : (
        <>
          <div className="mt-6 flex flex-wrap items-center gap-3">
            {uploadButton("btn")}
            {importForm}
          </div>
          <ul className="mt-6 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4" aria-label="Media library">
            {items.map((item) => {
              const waiting = item.used_by.filter((use) => use.waiting).length;
              return (
                <li key={item.id} className="panel flex min-w-0 flex-col p-3">
                  <a className="thumb" href={item.url} target="_blank" rel="noreferrer" aria-label={`Open ${item.filename}`}>
                    <Picture item={item} />
                  </a>
                  <p className="mt-3 truncate text-sm font-medium" title={item.filename}>
                    {item.filename}
                  </p>
                  <p className="note num mt-0.5 text-[13px]">
                    {kindOf(item)}, {sizeOf(item.size)}
                  </p>
                  <p className="note num text-[13px]">
                    {item.source_url ? "Imported" : "Uploaded"} <Time iso={item.created_at} />
                  </p>
                  <div className="mt-2 text-[13px]">
                    {item.used_by.length === 0 ? (
                      <p className="text-ink-3">Not used in a post yet.</p>
                    ) : (
                      <>
                        <p className="font-medium">
                          {item.used_by.length === 1 ? "Used in 1 post" : `Used in ${item.used_by.length} posts`}
                          {waiting ? <span className="font-normal text-ink-2">{`, ${waiting} not out yet`}</span> : null}
                        </p>
                        <ul className="mt-1 space-y-0.5">
                          {item.used_by.slice(0, 3).map((use) => (
                            <li key={use.post_id} className="flex min-w-0">
                              <Link className="link min-h-6 truncate" href={`/app/posts?post=${use.post_id}`}>
                                {use.excerpt.trim() || "Post with no text"}
                              </Link>
                            </li>
                          ))}
                          {item.used_by.length > 3 ? <li className="text-ink-3">{`and ${item.used_by.length - 3} more`}</li> : null}
                        </ul>
                      </>
                    )}
                  </div>
                  {/* The description and Delete sit at the foot of every card, whatever is above them. */}
                  <div className="mt-auto pt-3">
                    <label className="sr-only" htmlFor={`alt-${item.id}`}>
                      {`Description of ${item.filename} for screen readers`}
                    </label>
                    <input id={`alt-${item.id}`} key={item.alt ?? ""} className="field min-h-9 px-2.5 py-1 text-sm" placeholder="Describe it" defaultValue={item.alt ?? ""} onBlur={(e) => void saveAlt(item, e.target.value)} />
                    {refused?.id === item.id ? (
                      <p className="mt-2 text-[13px] font-medium text-bad" role="alert">
                        {refused.text}
                      </p>
                    ) : null}
                    <div className="flex justify-end pt-2">
                      <button type="button" className="btn btn-bare btn-sm" disabled={busy === item.id} onClick={() => remove(item)} aria-label={`Delete ${item.filename}`}>
                        Delete
                      </button>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}
      {toast}
    </div>
  );
}

type Picked = Pick<LibraryItem, "id" | "type" | "url" | "public_url" | "filename" | "alt">;

/** The composer's way into the library: press a file to attach it, press again to take it off. Nothing is uploaded twice. */
export function MediaPicker({ open, onClose, attached, onToggle }: { open: boolean; onClose: () => void; attached: string[]; onToggle: (item: Picked) => void }) {
  const [items, setItems] = useState<LibraryItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The library is read each time the dialog opens, so a file added a moment ago in another tab is there.
  useEffect(() => {
    if (!open) return;
    let live = true;
    api<LibraryItem[]>("/media")
      .then((found) => {
        if (!live) return;
        setItems(found);
        setError(null);
      })
      .catch((cause: Error) => {
        if (live) setError(cause.message);
      });
    return () => {
      live = false;
    };
  }, [open]);

  const count = items?.filter((item) => attached.includes(item.id)).length ?? 0;

  return (
    <Dialog open={open} onClose={onClose} title="Choose from library">
      {error ? (
        <p className="text-sm font-medium text-bad" role="alert">
          {error}
        </p>
      ) : items === null ? (
        <p className="note flex items-center gap-2" aria-busy="true">
          <span className="spinner" /> Opening the library
        </p>
      ) : items.length === 0 ? (
        <p className="text-[15px] leading-snug text-ink-2">The library is empty. Files you add with Add media are kept there, ready to attach to other posts.</p>
      ) : (
        <>
          <p className="text-[15px] leading-snug text-ink-2">Press a file to attach it to this post. Press it again to take it off.</p>
          <ul className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3" aria-label="Media library">
            {items.map((item) => {
              const on = attached.includes(item.id);
              return (
                <li key={item.id} className="min-w-0">
                  <button type="button" className="thumb" aria-pressed={on} aria-label={`${on ? "Take off" : "Attach"} ${item.filename}`} onClick={() => onToggle(item)}>
                    <Picture item={item} />
                    {on ? (
                      <span className="absolute top-1.5 right-1.5 grid h-6 w-6 place-items-center rounded-full bg-signal" style={{ color: "var(--on-signal)" }}>
                        <Check size={14} />
                      </span>
                    ) : null}
                  </button>
                  <p className="mt-1 truncate text-[13px] font-medium">{item.filename}</p>
                  <p className="note num text-[13px]">
                    {kindOf(item)}, {sizeOf(item.size)}
                  </p>
                </li>
              );
            })}
          </ul>
        </>
      )}
      <div className="mt-6 flex items-center justify-between gap-3">
        <span className="note num">{count === 0 ? "Nothing attached from the library" : count === 1 ? "1 file attached" : `${count} files attached`}</span>
        <button type="button" className="btn" onClick={onClose}>
          Done
        </button>
      </div>
    </Dialog>
  );
}
