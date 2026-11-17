"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useRef, useState } from "react";
import { measure, problems, threadProblems } from "@/lib/platforms/measure";
import { noticeFor, optionProblems, optionSummary, optionsToSend, valuesOf, type OptionValues } from "@/lib/platforms/options";
import type { Limits, NoticeWhen, OptionSpec } from "@/lib/platforms/types";
import { appendSignature, endsWithSignature } from "@/lib/sign";
import { MediaPicker } from "./media-library";
import { addTag, TagPicker } from "./tags";
import { api, Icon, Stamp, Status, Tabs, useHydrated, useToast, when } from "./ui";

/**
 * `threads` says whether the network can take parts after the main post; `noThread` is its own reason when it cannot.
 * `options` are the settings its network takes for one post, `needsTitle` its word for a title it must have, and
 * `notice` what publishing there does that cannot be taken back, with what that becomes while an option holds a value.
 */
export type ComposerAccount = {
  id: string;
  platform: string;
  name: string;
  handle: string;
  limits: Limits;
  threads: boolean;
  noThread?: string;
  signature_id?: string | null;
  options: OptionSpec[];
  needsTitle?: string;
  notice?: string;
  noticeWhen?: NoticeWhen[];
};
/** A named set of accounts: picking it selects exactly these. */
export type ComposerGroup = { id: string; name: string; account_ids: string[] };
/** Saved text that Add signature puts at the end of the post. */
export type ComposerSignature = { id: string; name: string; content: string };
type Media = { id: string; type: "image" | "video"; url: string; public_url: string | null; filename: string; alt: string | null };
type Part = { part: number; status: string; url: string | null };
type Target = { id: string; account_id: string; platform: string; handle: string; status: string; error: string | null; url: string | null; parts: Part[] };
type Every = "day" | "week" | "month";
type Post = { id: string; status: string; publish_at: string | null; repeat: { every: Every } | null; targets: Target[] };
type Mode = "now" | "later" | "draft";
type Repeat = "never" | Every;

const REPEATS: { value: Repeat; label: string }[] = [
  { value: "never", label: "Never" },
  { value: "day", label: "Daily" },
  { value: "week", label: "Weekly" },
  { value: "month", label: "Monthly" },
];

/** A draft or scheduled post opened for editing. */
export type ComposerInitial = {
  id: string;
  content: string;
  publish_at: string | null;
  draft: boolean;
  targets: { account_id: string; content_override: string | null; options: OptionValues }[];
  media: Media[];
  thread: string[];
  tags: string[];
  repeat: { every: Every; until: string | null } | null;
};

const localInput = (date: Date) => new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);

export function Composer({
  accounts,
  initial,
  groups = [],
  signatures = [],
  knownTags = [],
}: {
  accounts: ComposerAccount[];
  initial?: ComposerInitial;
  groups?: ComposerGroup[];
  signatures?: ComposerSignature[];
  knownTags?: string[];
}) {
  const router = useRouter();
  const hydrated = useHydrated();
  const { show, toast } = useToast();
  const [text, setText] = useState(initial?.content ?? "");
  const [selected, setSelected] = useState<string[]>(() =>
    initial ? initial.targets.map((t) => t.account_id).filter((id) => accounts.some((a) => a.id === id)) : accounts.map((a) => a.id),
  );
  const [overrides, setOverrides] = useState<Record<string, string>>(() =>
    Object.fromEntries((initial?.targets ?? []).flatMap((t) => (t.content_override === null ? [] : [[t.account_id, t.content_override]]))),
  );
  // What each account's network was told for this post, by account. An account with nothing here goes out with its network's defaults.
  const [options, setOptions] = useState<Record<string, OptionValues>>(() => Object.fromEntries((initial?.targets ?? []).flatMap((t) => (Object.keys(valuesOf(t.options)).length ? [[t.account_id, valuesOf(t.options)]] : []))));
  const [openOptions, setOpenOptions] = useState<string[]>([]);
  const [media, setMedia] = useState<Media[]>(initial?.media ?? []);
  const [mode, setMode] = useState<Mode>(initial ? (initial.draft ? "draft" : initial.publish_at ? "later" : "now") : "now");
  const [at, setAt] = useState(() => localInput(initial?.publish_at ? new Date(initial.publish_at) : new Date(Date.now() + 3600_000)));
  // Thread parts carry their own key so removing one keeps the others' text fields in place.
  const [thread, setThread] = useState<{ key: number; text: string }[]>(() => (initial?.thread ?? []).map((part, key) => ({ key, text: part })));
  const [repeat, setRepeat] = useState<Repeat>(initial?.repeat?.every ?? "never");
  const [until, setUntil] = useState(() => (initial?.repeat?.until ? localInput(new Date(initial.repeat.until)).slice(0, 10) : ""));
  const [tags, setTags] = useState<string[]>(initial?.tags ?? []);
  // What is typed in the tag box and not yet added. It is saved with the post, so a last tag is never lost to a missed Enter.
  const [tagDraft, setTagDraft] = useState("");
  const [signing, setSigning] = useState(false);
  const [library, setLibrary] = useState(false);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [result, setResult] = useState<Post | null>(null);
  const [shake, setShake] = useState(0);
  const file = useRef<HTMLInputElement>(null);

  const chosen = accounts.filter((a) => selected.includes(a.id));
  const shapes = useMemo(() => media.map((m) => ({ type: m.type, hasPublicUrl: Boolean(m.public_url) })), [media]);
  // An untouched composer is not an error: problems appear once there is something to measure.
  const [freshPart, setFreshPart] = useState<number | null>(null);
  const parts = useMemo(() => thread.map((part) => part.text), [thread]);
  const pristine = !text.trim() && media.length === 0 && Object.keys(overrides).length === 0 && parts.every((part) => !part.trim());
  const issues = useMemo(
    () =>
      Object.fromEntries(
        chosen.map((a) => [a.id, mode === "draft" || pristine ? [] : [...problems(a, overrides[a.id] ?? text, shapes), ...threadProblems(a, parts, true), ...optionProblems(a, overrides[a.id] ?? text, options[a.id])]]),
      ),
    [chosen, overrides, text, shapes, mode, pristine, parts, options],
  );
  const blocked = chosen.filter((a) => issues[a.id].length > 0);

  /** Changes which accounts the post goes to. An account taken off the post loses its options, so adding it back starts from the defaults. */
  const choose = (next: string[]) => {
    setSelected(next);
    setOptions((held) => Object.fromEntries(Object.entries(held).filter(([id]) => next.includes(id))));
    setOpenOptions((open) => open.filter((id) => next.includes(id)));
  };
  const toggle = (id: string) => choose(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  /** Sets one option for one account. Emptying it removes it, which leaves the network's default in charge. */
  const setOption = (id: string, key: string, value: string | boolean) =>
    setOptions((held) => {
      const next = { ...held[id] };
      if (value === "" || value === false) delete next[key];
      else next[key] = value;
      return { ...held, [id]: next };
    });
  // The accounts with something to set, or with something to say before a post goes to them.
  const configurable = chosen.filter((a) => a.options.length > 0 || a.notice);

  // A group names accounts that may since have been disconnected; only the ones still here count.
  const membersOf = (group: ComposerGroup) => group.account_ids.filter((id) => accounts.some((a) => a.id === id));
  const isPicked = (group: ComposerGroup) => {
    const members = membersOf(group);
    return members.length > 0 && members.length === selected.length && members.every((id) => selected.includes(id));
  };

  const signatureOf = (account: ComposerAccount) => signatures.find((s) => s.id === account.signature_id);
  /** Puts a signature at the end of the shared post, as text to edit like the rest. */
  function sign(signature: ComposerSignature) {
    setText((now) => appendSignature(now, signature.content));
    setSigning(false);
    show(`Added ${signature.name} to the post. Edit it like any other text.`);
  }
  /** Puts an account's default signature at the end of that account's own version, starting one from the shared post if need be. */
  const signFor = (account: ComposerAccount, signature: ComposerSignature) => setOverrides((o) => ({ ...o, [account.id]: appendSignature(o[account.id] ?? text, signature.content) }));

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

  const keepsSchedule = mode === "draft" && Boolean(initial?.draft);
  // An untouched time goes back exactly as it was stored, so a repeating post is not re-dated by opening it.
  const publishAt = () => (initial?.publish_at && at === localInput(new Date(initial.publish_at)) ? initial.publish_at : new Date(at).toISOString());
  const repeatRule = () =>
    repeat === "never" ? null : { every: repeat, until: until ? new Date(`${until}T23:59:59.999`).toISOString() : null, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone };

  async function submit() {
    if (!chosen.length) return show("Choose at least one account to post to.");
    if (pristine) return show("Write something first.");
    const blank = parts.findIndex((part) => !part.trim());
    if (blank >= 0) return show(`Part ${blank + 2} of the thread is empty. Write it or remove it.`);
    if (blocked.length) {
      setShake((n) => n + 1);
      return show(`${blocked.map((a) => a.name).join(", ")} can’t take this as written. Fix the marked sheets.`);
    }
    const tagged = addTag(tags, tagDraft);
    if (tagged.problem) return show(tagged.problem);
    setBusy(true);
    try {
      // Editing replaces the saved post in place; a new post is created otherwise.
      const post = await api<Post>(initial ? `/posts/${initial.id}` : "/posts", {
        method: initial ? "PATCH" : "POST",
        body: JSON.stringify({
          content: text,
          targets: chosen.map((a) => ({ account_id: a.id, content_override: overrides[a.id] ?? undefined, options: optionsToSend(a.options, options[a.id]) })),
          thread: parts,
          media_ids: media.map((m) => m.id),
          tags: tagged.tags,
          // A draft that came with a time keeps it when it is saved as a draft again.
          publish_at: mode === "later" ? publishAt() : keepsSchedule ? undefined : initial ? null : undefined,
          // Repeat is chosen beside the time. Sending a repeating post now, or parking it as a draft, leaves its series as it was.
          repeat: mode === "later" ? repeatRule() : undefined,
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
    if (initial) return router.replace("/app");
    setResult(null);
    setText("");
    setOverrides({});
    setOptions({});
    setOpenOptions([]);
    setMedia([]);
    setThread([]);
    setTags([]);
    setTagDraft("");
    setRepeat("never");
    setUntil("");
    setMode("now");
  }

  if (!accounts.length) return <NoAccounts onDone={() => router.refresh()} />;

  if (result) {
    const heading = result.status === "published" ? "Published everywhere." : result.status === "scheduled" ? `Scheduled for ${when(result.publish_at!)}.` : result.status === "draft" ? "Draft saved." : result.status === "partial" ? "Published, with one problem." : "Nothing went out.";
    return (
      <div className="mx-auto max-w-2xl">
        <h1 className="heading rise text-5xl">{heading}</h1>
        {result.repeat && result.status !== "draft" ? <p className="note rise mt-3">{`It repeats every ${result.repeat.every}. Each occurrence shows up under Posts as its own post.`}</p> : null}
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
              {t.parts.length > 1 && t.status !== "scheduled" && t.status !== "draft" ? (
                <ol className="mt-3 space-y-1">
                  {t.parts.map((part) => (
                    <li key={part.part} className="flex flex-wrap items-center justify-between gap-3 text-sm">
                      <span className="text-ink-2">{`Part ${part.part}`}</span>
                      <span className="flex items-center gap-4">
                        <Status status={part.status} />
                        {part.url ? (
                          <a className="link inline-flex items-center gap-1" href={part.url} target="_blank" rel="noreferrer">
                            Open <Icon name="out" size={14} />
                          </a>
                        ) : null}
                      </span>
                    </li>
                  ))}
                </ol>
              ) : null}
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
  const action = busy ? (mode === "now" ? "Sending" : "Saving") : mode === "draft" ? "Save draft" : mode === "later" ? `Schedule for ${count} account${count === 1 ? "" : "s"}` : `Publish to ${count} account${count === 1 ? "" : "s"}`;

  return (
    <div className="grid grid-cols-1 gap-8 xl:grid-cols-[minmax(0,6fr)_minmax(0,5fr)]">
      <section aria-label="Write the post">
        <h1 className="heading text-4xl">{initial ? "Edit post" : "Compose"}</h1>
        <div className="mt-6">
          <p className="label">Post to</p>
          {groups.length ? (
            <div className="mb-3 flex flex-wrap items-center gap-1.5" role="group" aria-label="Groups">
              <span className="note mr-1">Groups</span>
              {groups.map((group) => {
                const members = membersOf(group);
                return (
                  <button
                    key={group.id}
                    type="button"
                    className="tag"
                    aria-pressed={isPicked(group)}
                    disabled={members.length === 0}
                    title={members.length === 0 ? "This group has no accounts left." : `Select exactly ${members.length === 1 ? "its 1 account" : `its ${members.length} accounts`}`}
                    onClick={() => choose(members)}
                  >
                    <span className="max-w-44 truncate">{group.name}</span>
                    <span className="num opacity-70">{members.length}</span>
                  </button>
                );
              })}
            </div>
          ) : null}
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
          <div className="mt-2">
            <button type="button" className="btn btn-quiet btn-sm" aria-expanded={signing} aria-controls="post-signatures" onClick={() => setSigning((on) => !on)}>
              <Icon name="plus" size={16} /> Add signature
            </button>
            {signing ? (
              <div id="post-signatures" className="panel mt-2 p-2">
                {signatures.length === 0 ? (
                  <p className="note p-2">
                    No signatures saved yet. A signature is a sign-off or a set of hashtags you keep for the end of a post.{" "}
                    <Link className="link" href="/app/accounts#signatures">
                      Create one under Accounts
                    </Link>
                  </p>
                ) : (
                  <ul>
                    {signatures.map((signature) => {
                      const offering = chosen.filter((a) => a.signature_id === signature.id);
                      return (
                        <li key={signature.id}>
                          <button type="button" className="row block w-full rounded-md p-2 text-left" onClick={() => sign(signature)}>
                            <span className="flex flex-wrap items-baseline gap-x-2">
                              <span className="font-medium">{signature.name}</span>
                              {offering.length ? <span className="note">{`Default for ${offering.map((a) => a.handle).join(", ")}`}</span> : null}
                            </span>
                            <span className="note line-clamp-2 break-words whitespace-pre-wrap">{signature.content}</span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
                {signatures.length ? (
                  <p className="note px-2 pt-1 pb-1">
                    It goes at the end of the post as text you can edit, and counts toward every limit.{" "}
                    <Link className="link" href="/app/accounts#signatures">
                      Manage signatures
                    </Link>
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>
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
            <button type="button" className="btn btn-quiet h-24 w-32 flex-col gap-1 text-sm whitespace-normal" onClick={() => setLibrary(true)}>
              <Icon name="library" size={20} />
              Choose from library
            </button>
            <input ref={file} type="file" hidden multiple accept="image/jpeg,image/png,image/webp,image/gif,video/mp4,video/quicktime,video/webm" onChange={(e) => upload(e.target.files)} />
          </div>
        </div>

        <div className="mt-6">
          {thread.map((part, i) => (
            <div key={part.key} className="mb-4">
              <div className="flex items-center justify-between gap-3">
                <label className="label" htmlFor={`post-part-${part.key}`}>
                  {`Part ${i + 2}`}
                </label>
                <button type="button" className="btn btn-bare btn-sm mb-1" onClick={() => setThread((all) => all.filter((x) => x.key !== part.key))}>
                  Remove
                </button>
              </div>
              <textarea
                id={`post-part-${part.key}`}
                className="field min-h-24 resize-y text-[15px] leading-snug"
                value={part.text}
                onChange={(e) => setThread((all) => all.map((x) => (x.key === part.key ? { ...x, text: e.target.value } : x)))}
                placeholder="Goes out as a reply to the part above."
                autoFocus={part.key === freshPart}
              />
            </div>
          ))}
          <button
            type="button"
            className="btn btn-quiet btn-sm"
            onClick={() => {
              // The new part takes the cursor, so typing continues in it rather than in the part above.
              const key = (thread.at(-1)?.key ?? -1) + 1;
              setFreshPart(key);
              setThread((all) => [...all, { key, text: "" }]);
            }}
          >
            <Icon name="plus" size={16} /> Add to thread
          </button>
          {thread.length === 0 ? <span className="note ml-3">Add a first comment or a full thread.</span> : null}
        </div>

        {configurable.length ? (
          <div className="mt-8">
            <p className="label">Options</p>
            <p className="note -mt-1 mb-3">What each account&rsquo;s network lets you set for this post. Anything left as it is uses that network&rsquo;s default.</p>
            <ul className="space-y-2">
              {configurable.map((a) => (
                <AccountOptions
                  key={a.id}
                  account={a}
                  values={options[a.id] ?? {}}
                  open={openOptions.includes(a.id)}
                  onToggle={() => setOpenOptions((open) => (open.includes(a.id) ? open.filter((id) => id !== a.id) : [...open, a.id]))}
                  onChange={(key, value) => setOption(a.id, key, value)}
                />
              ))}
            </ul>
          </div>
        ) : null}

        <div className="mt-8">
          <TagPicker value={tags} onChange={setTags} draft={tagDraft} onDraft={setTagDraft} known={knownTags} onProblem={show} />
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
          {/* The time field is in the reader's zone, which only the browser knows, so it appears after hydration. */}
          {mode === "later" && hydrated ? (
            <div>
              <label className="label" htmlFor="post-at">
                Date and time
              </label>
              <input id="post-at" type="datetime-local" className="field w-auto" value={at} min={localInput(new Date())} onChange={(e) => setAt(e.target.value)} />
            </div>
          ) : null}
          {mode === "later" && hydrated ? (
            <div>
              <p className="label">Repeat</p>
              <Tabs label="How often to repeat" value={repeat} onChange={setRepeat} options={REPEATS} />
            </div>
          ) : null}
          {mode === "later" && hydrated && repeat !== "never" ? (
            <div>
              <label className="label" htmlFor="post-until">
                Until (optional)
              </label>
              <input id="post-until" type="date" className="field w-auto" value={until} min={at.slice(0, 10)} onChange={(e) => setUntil(e.target.value)} />
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
            // An account's default signature is offered here and added only when asked.
            const offered = signatureOf(a);
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
                {a.threads
                  ? thread.map((part, i) => {
                      const size = measure(part.text, a.limits.count);
                      const max = a.limits.maxReplyChars ?? a.limits.maxChars;
                      return (
                        <div key={part.key} className="mt-3 pt-3" style={{ borderTop: "1px solid var(--line)" }}>
                          <div className="flex items-center justify-between gap-3">
                            <span className="note">{`Part ${i + 2}`}</span>
                            <span className="num flex-none text-sm font-medium" style={{ color: size > max ? "var(--bad)" : "var(--ink-3)" }}>
                              {size} / {max}
                            </span>
                          </div>
                          <p className="mt-1 line-clamp-3 whitespace-pre-wrap text-[15px] leading-snug">{part.text || <span className="text-ink-3">Nothing written yet.</span>}</p>
                        </div>
                      );
                    })
                  : null}
                {found.map((problem) => (
                  <p key={problem} className="mt-2 text-sm font-medium text-bad">
                    {problem}
                  </p>
                ))}
                {offered && !endsWithSignature(copy, offered.content) ? (
                  <p className="note mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 pt-3" style={{ borderTop: "1px solid var(--line)" }}>
                    <span className="min-w-0 break-words">{`This account offers the signature ${offered.name}.`}</span>
                    <button type="button" className="btn btn-quiet btn-sm" onClick={() => signFor(a, offered)}>
                      Add it to this account
                    </button>
                  </p>
                ) : null}
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
      <MediaPicker
        open={library}
        onClose={() => setLibrary(false)}
        attached={media.map((m) => m.id)}
        onToggle={(item) => setMedia((all) => (all.some((m) => m.id === item.id) ? all.filter((m) => m.id !== item.id) : [...all, { id: item.id, type: item.type, url: item.url, public_url: item.public_url, filename: item.filename, alt: item.alt }]))}
      />
      {toast}
    </div>
  );
}

/**
 * One account's options for this post: a line saying what is set, which opens
 * in place to the controls. The controls stay in the page while it is closed,
 * hidden, so what was typed is kept. The network's notice sits under them
 * whether the section is open or not, and follows the values as they change.
 */
function AccountOptions({
  account,
  values,
  open,
  onToggle,
  onChange,
}: {
  account: ComposerAccount;
  values: OptionValues;
  open: boolean;
  onToggle: () => void;
  onChange: (key: string, value: string | boolean) => void;
}) {
  const summary = optionSummary(account.options, values);
  const notice = noticeFor(account, values);
  const panel = `options-${account.id}`;
  return (
    <li className="panel">
      {account.options.length ? (
        <button type="button" className="row flex w-full items-center gap-3 rounded-[inherit] p-3 text-left" aria-expanded={open} aria-controls={panel} onClick={onToggle}>
          <Stamp platform={account.platform} />
          <span className="min-w-0 flex-1">
            <span className="block truncate font-medium">{account.handle}</span>
            <span className="note block break-words">{summary || "Defaults"}</span>
          </span>
          <span className="note flex-none">{open ? "Close" : "Change"}</span>
        </button>
      ) : (
        <div className="flex items-center gap-3 p-3">
          <Stamp platform={account.platform} />
          <span className="min-w-0 truncate font-medium">{account.handle}</span>
        </div>
      )}
      {account.options.length ? (
        <div id={panel} hidden={!open} className="grid gap-x-3 gap-y-4 px-3 pt-1 pb-3 sm:grid-cols-2">
          {account.options.map((option) => {
            const id = `${panel}-${option.key}`;
            const help = option.help ? (
              <p id={`${id}-help`} className="note mt-1.5">
                {option.help}
              </p>
            ) : null;
            const described = option.help ? `${id}-help` : undefined;
            const held = values[option.key];
            if (option.kind === "boolean") {
              return (
                <div key={option.key}>
                  <label className="flex min-h-10 cursor-pointer items-center gap-2.5 text-sm font-[550]" htmlFor={id}>
                    <input id={id} type="checkbox" className="size-[18px] flex-none accent-signal" checked={held === true} aria-describedby={described} onChange={(e) => onChange(option.key, e.target.checked)} />
                    {option.label}
                  </label>
                  {help}
                </div>
              );
            }
            if (option.kind === "select") {
              const [first, ...rest] = option.choices ?? [];
              const current = typeof held === "string" && held !== first ? held : "";
              return (
                <div key={option.key}>
                  <label className="label" htmlFor={id}>
                    {option.label}
                  </label>
                  <select id={id} className="field" value={current} aria-describedby={described} onChange={(e) => onChange(option.key, e.target.value)}>
                    <option value="">{`${first} (default)`}</option>
                    {rest.map((choice) => (
                      <option key={choice} value={choice}>
                        {choice}
                      </option>
                    ))}
                    {/* A value set through the API that the list does not offer is kept until it is changed here. */}
                    {current && !rest.includes(current) ? <option value={current}>{current}</option> : null}
                  </select>
                  {help}
                </div>
              );
            }
            return (
              <div key={option.key}>
                <label className="label" htmlFor={id}>
                  {option.label}
                </label>
                <input id={id} type="text" className="field" value={typeof held === "string" ? held : ""} aria-describedby={described} autoComplete="off" onChange={(e) => onChange(option.key, e.target.value)} />
                {help}
              </div>
            );
          })}
        </div>
      ) : null}
      {notice ? (
        <p className="note flex gap-2 px-3 pb-3" role="status">
          <span className="mt-0.5 flex-none">
            <Icon name="alert" size={16} />
          </span>
          <span className="min-w-0">{notice}</span>
        </p>
      ) : null}
    </li>
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
