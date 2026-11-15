"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useRef, useState } from "react";
import { measure, problems } from "@/lib/platforms/measure";
import type { Limits } from "@/lib/platforms/types";
import { api, Icon, Stamp, Status, Tabs, useToast, when } from "./ui";

export type ComposerAccount = { id: string; platform: string; name: string; handle: string; limits: Limits };
type Media = { id: string; type: "image" | "video"; url: string; public_url: string | null; filename: string; alt: string | null };
type Target = { id: string; account_id: string; platform: string; handle: string; status: string; error: string | null; url: string | null };
type Post = { id: string; status: string; publish_at: string | null; targets: Target[] };
type Mode = "now" | "later" | "draft";

const localInput = (date: Date) => new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);

export function Composer({ accounts }: { accounts: ComposerAccount[] }) {
  const router = useRouter();
  const { show, toast } = useToast();
  const [text, setText] = useState("");
  const [selected, setSelected] = useState<string[]>(() => accounts.map((a) => a.id));
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [media, setMedia] = useState<Media[]>([]);
  const [mode, setMode] = useState<Mode>("now");
  const [at, setAt] = useState(() => localInput(new Date(Date.now() + 3600_000)));
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [result, setResult] = useState<Post | null>(null);
  const [shake, setShake] = useState(0);
  const file = useRef<HTMLInputElement>(null);

  const chosen = accounts.filter((a) => selected.includes(a.id));
  const shapes = useMemo(() => media.map((m) => ({ type: m.type, hasPublicUrl: Boolean(m.public_url) })), [media]);
  // An untouched composer is not an error: problems appear once there is something to measure.
  const pristine = !text.trim() && media.length === 0 && Object.keys(overrides).length === 0;
  const issues = useMemo(
    () => Object.fromEntries(chosen.map((a) => [a.id, mode === "draft" || pristine ? [] : problems(a, overrides[a.id] ?? text, shapes)])),
    [chosen, overrides, text, shapes, mode, pristine],
  );
  const blocked = chosen.filter((a) => issues[a.id].length > 0);

  const toggle = (id: string) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  async function upload(files: FileList | null) {
    if (!files?.length) return;
    setUploading(true);
    try {
      for (const item of Array.from(files)) {
        const form = new FormData();
        form.set("file", item);
        const saved = await api<Media>("/media", { method: "POST", body: form });
        setMedia((m) => [...m, saved]);
      }
    } catch (error) {
      show((error as Error).message);
    } finally {
      setUploading(false);
      if (file.current) file.current.value = "";
    }
  }

  async function submit() {
    if (!chosen.length) return show("Choose at least one account to post to.");
    if (pristine) return show("Write something first.");
    if (blocked.length) {
      setShake((n) => n + 1);
      return show(`${blocked.map((a) => a.name).join(", ")} can’t take this as written. Fix the marked sheets.`);
    }
    setBusy(true);
    try {
      const post = await api<Post>("/posts", {
        method: "POST",
        body: JSON.stringify({
          content: text,
          targets: chosen.map((a) => ({ account_id: a.id, content_override: overrides[a.id] ?? undefined })),
          media_ids: media.map((m) => m.id),
          publish_at: mode === "later" ? new Date(at).toISOString() : undefined,
          draft: mode === "draft",
        }),
      });
      setResult(post);
      router.refresh();
    } catch (error) {
      show((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    setResult(null);
    setText("");
    setOverrides({});
    setMedia([]);
    setMode("now");
  }

  if (!accounts.length) return <NoAccounts onDone={() => router.refresh()} />;

  if (result) {
    const heading = result.status === "published" ? "Published everywhere." : result.status === "scheduled" ? `Scheduled for ${when(result.publish_at!)}.` : result.status === "draft" ? "Draft saved." : result.status === "partial" ? "Published, with one problem." : "Nothing went out.";
    return (
      <div className="mx-auto max-w-2xl">
        <h1 className="heading rise text-5xl">{heading}</h1>
        <ul className="mt-8 space-y-2">
          {result.targets.map((t, i) => (
            <li key={t.id} className="sheet rise" style={{ "--i": i + 1 } as React.CSSProperties}>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <span className="flex min-w-0 items-center gap-3">
                  <Stamp platform={t.platform} />
                  <span className="truncate font-medium">{t.handle}</span>
                </span>
                <span className="flex items-center gap-4">
                  <Status status={t.status} />
                  {t.url ? (
                    <a className="link inline-flex items-center gap-1 text-sm" href={t.url} target="_blank" rel="noreferrer">
                      Open <Icon name="out" size={14} />
                    </a>
                  ) : null}
                </span>
              </div>
              {t.error ? <p className="mt-2 text-sm text-bad">{t.error}</p> : null}
            </li>
          ))}
        </ul>
        <div className="mt-8 flex gap-3">
          <button type="button" className="btn" onClick={reset}>
            Write another
          </button>
          <Link className="btn btn-quiet" href="/app/posts">
            See all posts
          </Link>
        </div>
        {toast}
      </div>
    );
  }

  const count = chosen.length;
  const action = busy ? "Sending" : mode === "draft" ? "Save draft" : mode === "later" ? `Schedule for ${count} account${count === 1 ? "" : "s"}` : `Publish to ${count} account${count === 1 ? "" : "s"}`;

  return (
    <div className="grid gap-8 xl:grid-cols-[minmax(0,6fr)_minmax(0,5fr)]">
      <section aria-label="Write the post">
        <h1 className="heading text-4xl">Compose</h1>
        <div className="mt-6">
          <p className="label">Post to</p>
          <div className="flex flex-wrap gap-2">
            {accounts.map((a) => (
              <button key={a.id} type="button" className="chip" aria-pressed={selected.includes(a.id)} onClick={() => toggle(a.id)}>
                <Stamp platform={a.platform} />
                <span className="max-w-44 truncate">{a.handle}</span>
              </button>
            ))}
            <Link className="chip" href="/app/accounts" style={{ paddingLeft: 12 }}>
              <Icon name="plus" size={16} /> Add account
            </Link>
          </div>
        </div>

        <div className="mt-6">
          <label className="label" htmlFor="post-text">
            Post
          </label>
          <textarea id="post-text" className="field min-h-52 resize-y text-[17px] leading-snug" value={text} onChange={(e) => setText(e.target.value)} placeholder="What do you want to say everywhere?" autoFocus />
        </div>

        <div className="mt-4">
          <div className="flex flex-wrap items-start gap-3">
            {media.map((m) => (
              <figure key={m.id} className="w-32">
                <div className="relative h-24 overflow-hidden rounded-md bg-paper-2" style={{ outline: "1px solid var(--line)", outlineOffset: -1 }}>
                  {m.type === "image" ? (
                    // eslint-disable-next-line @next/next/no-img-element -- user uploads are served from the data directory, not a build-time asset
                    <img src={m.url} alt={m.alt ?? ""} className="h-full w-full object-cover" />
                  ) : (
                    <video src={m.url} className="h-full w-full object-cover" muted />
                  )}
                  <button type="button" className="btn btn-sm absolute top-1 right-1 min-h-7 px-1.5" aria-label={`Remove ${m.filename}`} onClick={() => setMedia((all) => all.filter((x) => x.id !== m.id))}>
                    <Icon name="close" size={14} />
                  </button>
                </div>
                <input
                  className="field mt-1 min-h-8 px-2 py-1 text-sm"
                  placeholder="Describe it"
                  aria-label={`Alt text for ${m.filename}`}
                  defaultValue={m.alt ?? ""}
                  onBlur={(e) => {
                    const alt = e.target.value;
                    if (alt !== (m.alt ?? "")) void api(`/media/${m.id}`, { method: "PATCH", body: JSON.stringify({ alt }) }).catch((error: Error) => show(error.message));
                  }}
                />
              </figure>
            ))}
            <button type="button" className="btn btn-quiet h-24 w-32 flex-col gap-1 text-sm" onClick={() => file.current?.click()} disabled={uploading}>
              {uploading ? <span className="spinner" /> : <Icon name="image" size={20} />}
              {uploading ? "Uploading" : "Add media"}
            </button>
            <input ref={file} type="file" hidden multiple accept="image/jpeg,image/png,image/webp,image/gif,video/mp4,video/quicktime,video/webm" onChange={(e) => upload(e.target.files)} />
          </div>
        </div>

        <div className="mt-8 flex flex-wrap items-end gap-4">
          <div>
            <p className="label">When</p>
            <Tabs
              label="When to publish"
              value={mode}
              onChange={setMode}
              options={[
                { value: "now", label: "Now" },
                { value: "later", label: "Later" },
                { value: "draft", label: "Draft" },
              ]}
            />
          </div>
          {mode === "later" ? (
            <div>
              <label className="label" htmlFor="post-at">
                Date and time
              </label>
              <input id="post-at" type="datetime-local" className="field w-auto" value={at} min={localInput(new Date())} onChange={(e) => setAt(e.target.value)} />
            </div>
          ) : null}
          <button type="button" className="btn btn-signal btn-lg ml-auto" onClick={submit} disabled={busy || uploading}>
            {busy ? <span className="spinner" /> : null}
            <span className="swap" key={action}>
              {action}
            </span>
          </button>
        </div>
      </section>

      <section aria-label="How each account will receive it">
        <h2 className="title text-xl">Proofs</h2>
        <p className="note mt-1">Each account&rsquo;s copy, measured the way its network counts.</p>
        <div className="mt-4 space-y-3">
          {chosen.length === 0 ? <p className="note panel p-6">Choose an account to see its proof.</p> : null}
          {chosen.map((a) => {
            const own = overrides[a.id];
            const copy = own ?? text;
            const length = measure(copy, a.limits.count);
            const found = issues[a.id];
            return (
              <article key={`${a.id}-${found.length ? shake : 0}`} className={`sheet ${found.length && shake ? "is-shaking" : ""}`} data-over={found.length > 0}>
                <header className="flex items-center justify-between gap-3">
                  <span className="flex min-w-0 items-center gap-2">
                    <Stamp platform={a.platform} />
                    <span className="truncate font-medium">{a.handle}</span>
                    <span className="note flex-none">{a.name}</span>
                  </span>
                  <span className="num flex-none text-sm font-medium" style={{ color: length > a.limits.maxChars ? "var(--bad)" : "var(--ink-3)" }}>
                    {length} / {a.limits.maxChars}
                  </span>
                </header>
                {own === undefined ? (
                  <p className="mt-3 line-clamp-5 whitespace-pre-wrap text-[15px] leading-snug">{copy || <span className="text-ink-3">Nothing written yet.</span>}</p>
                ) : (
                  <textarea className="field mt-3 min-h-24 text-[15px] leading-snug" aria-label={`Version for ${a.handle}`} value={own} onChange={(e) => setOverrides((o) => ({ ...o, [a.id]: e.target.value }))} />
                )}
                {found.map((problem) => (
                  <p key={problem} className="mt-2 text-sm font-medium text-bad">
                    {problem}
                  </p>
                ))}
                <button
                  type="button"
                  className="btn btn-bare btn-sm mt-2 -ml-2.5"
                  onClick={() =>
                    setOverrides((o) => {
                      if (own === undefined) return { ...o, [a.id]: text };
                      return Object.fromEntries(Object.entries(o).filter(([id]) => id !== a.id));
                    })
                  }
                >
                  {own === undefined ? "Write a separate version" : "Use the shared post"}
                </button>
              </article>
            );
          })}
        </div>
      </section>
      {toast}
    </div>
  );
}

function NoAccounts({ onDone }: { onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const { show, toast } = useToast();
  return (
    <div className="mx-auto max-w-xl py-10">
      <h1 className="heading rise text-5xl">Connect an account to start.</h1>
      <p className="rise mt-5 text-lg leading-snug text-ink-2" style={{ "--i": 1 } as React.CSSProperties}>
        Broadside posts to the accounts you connect. Add a real network, or add a sandbox first: it accepts posts and sends them nowhere, so you can rehearse the whole flow.
      </p>
      <div className="rise mt-8 flex flex-wrap gap-3" style={{ "--i": 2 } as React.CSSProperties}>
        <Link className="btn btn-signal btn-lg" href="/app/accounts">
          Connect a network
        </Link>
        <button
          type="button"
          className="btn btn-quiet btn-lg"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await api("/accounts", { method: "POST", body: JSON.stringify({ platform: "sandbox", credentials: { name: "Rehearsal" } }) });
              onDone();
            } catch (error) {
              show((error as Error).message);
              setBusy(false);
            }
          }}
        >
          {busy ? <span className="spinner" /> : null} Add a sandbox
        </button>
      </div>
      {toast}
    </div>
  );
}
