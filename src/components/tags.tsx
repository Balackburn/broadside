"use client";

import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { MAX_TAGS_PER_POST, tagKey, tagProblem, tidyTagName } from "@/lib/tag-rules";
import { api, Dialog, Icon } from "./ui";

export type TagInfo = { id: string; name: string; posts: number };

/** A post's tags, set small beside its other details. Names are text and nothing else. */
export function TagList({ tags, label = "Tags" }: { tags: string[]; label?: string }) {
  if (!tags.length) return null;
  return (
    <span className="flex flex-wrap items-center gap-1" aria-label={label}>
      {tags.map((tag) => (
        <span key={tag} className="tag">
          <span className="truncate">{tag}</span>
        </span>
      ))}
    </span>
  );
}

/** One row of tags to filter a list by. Pressing the tag that is on turns the filter off. */
export function TagFilter({ tags, value, onChange }: { tags: string[]; value: string | null; onChange: (tag: string | null) => void }) {
  if (!tags.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Filter by tag">
      <span className="note mr-1">Tag</span>
      <button type="button" className="tag" aria-pressed={value === null} onClick={() => onChange(null)}>
        All
      </button>
      {tags.map((tag) => (
        <button key={tag} type="button" className="tag" aria-pressed={value !== null && tagKey(value) === tagKey(tag)} onClick={() => onChange(value !== null && tagKey(value) === tagKey(tag) ? null : tag)}>
          <span className="max-w-40 truncate">{tag}</span>
        </button>
      ))}
    </div>
  );
}

/** Adds what is typed to a list of tags, or says why it cannot be one. A tag already on the list, in any case, is not added twice. */
export function addTag(tags: string[], typed: string): { tags: string[]; problem: string | null } {
  const name = tidyTagName(typed);
  if (!name) return { tags, problem: null };
  const problem = tagProblem(name);
  if (problem) return { tags, problem };
  if (tags.some((tag) => tagKey(tag) === tagKey(name))) return { tags, problem: null };
  if (tags.length >= MAX_TAGS_PER_POST) return { tags, problem: `A post can carry ${MAX_TAGS_PER_POST} tags.` };
  return { tags: [...tags, name], problem: null };
}

/**
 * The composer's tag field: the post's tags, a box to type a new one, and the
 * existing tags that match what is typed. `draft` is the text still in the box,
 * held by the composer so a tag typed but not yet added is saved with the post.
 */
export function TagPicker({
  value,
  onChange,
  draft,
  onDraft,
  known,
  onProblem,
}: {
  value: string[];
  onChange: (tags: string[]) => void;
  draft: string;
  onDraft: (text: string) => void;
  known: string[];
  onProblem: (message: string) => void;
}) {
  const id = useId();
  const add = (typed: string) => {
    const next = addTag(value, typed);
    if (next.problem) return onProblem(next.problem);
    onChange(next.tags);
    onDraft("");
  };
  const typed = tagKey(tidyTagName(draft));
  // Existing tags not on the post yet; typing narrows them, and the one that matches exactly is spelled as it already exists.
  const unused = known.filter((tag) => !value.some((chosen) => tagKey(chosen) === tagKey(tag)));
  const suggestions = unused.filter((tag) => !typed || tagKey(tag).includes(typed)).slice(0, 8);
  const exact = known.find((tag) => tagKey(tag) === typed);

  return (
    <div>
      <label className="label" htmlFor={`${id}-input`}>
        Tags
      </label>
      <div className="flex flex-wrap items-center gap-2">
        {value.map((tag) => (
          <button key={tag} type="button" className="tag" aria-label={`Remove the tag ${tag}`} onClick={() => onChange(value.filter((x) => x !== tag))}>
            <span className="max-w-40 truncate">{tag}</span>
            <Icon name="close" size={12} />
          </button>
        ))}
        <input
          id={`${id}-input`}
          className="field min-h-9 w-44 px-3 py-1 text-sm"
          value={draft}
          placeholder={value.length ? "Add another" : "Add a tag"}
          autoComplete="off"
          list={`${id}-known`}
          aria-describedby={`${id}-hint`}
          onChange={(e) => {
            // A comma ends a tag, as it does in a list.
            if (e.target.value.includes(",")) add(e.target.value.replace(/,/g, " "));
            else onDraft(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add(exact ?? draft);
            } else if (e.key === "Backspace" && !draft && value.length) {
              onChange(value.slice(0, -1));
            }
          }}
        />
        <datalist id={`${id}-known`}>
          {unused.map((tag) => (
            <option key={tag} value={tag} />
          ))}
        </datalist>
        <button type="button" className="btn btn-quiet btn-sm" disabled={!typed} onClick={() => add(exact ?? draft)}>
          Add tag
        </button>
      </div>
      {suggestions.length ? (
        <div className="mt-2 flex flex-wrap items-center gap-1.5" role="group" aria-label="Existing tags">
          <span className="note mr-1">{typed ? "Matching" : "Existing"}</span>
          {suggestions.map((tag) => (
            <button key={tag} type="button" className="tag" onClick={() => add(tag)}>
              <Icon name="plus" size={12} />
              <span className="max-w-40 truncate">{tag}</span>
            </button>
          ))}
        </div>
      ) : null}
      <p id={`${id}-hint`} className="note mt-2">
        Tags are for finding posts again in Posts and Calendar. They are never published.
      </p>
    </div>
  );
}

/** Rename or delete tags. Renaming changes the name on every post; deleting takes the tag off its posts and leaves the posts. */
export function TagManager({ open, onClose, tags }: { open: boolean; onClose: () => void; tags: TagInfo[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<{ id: string; text: string } | null>(null);
  // What just happened is said inside the dialog: a toast would sit behind it.
  const [done, setDone] = useState<string | null>(null);
  const close = () => {
    setDone(null);
    setError(null);
    onClose();
  };

  async function rename(tag: TagInfo, typed: string) {
    const name = tidyTagName(typed);
    if (name === tag.name) return;
    const problem = tagProblem(name);
    if (problem) return setError({ id: tag.id, text: problem });
    setBusy(tag.id);
    setError(null);
    try {
      await api(`/tags/${tag.id}`, { method: "PATCH", body: JSON.stringify({ name }) });
      setDone(`Renamed ${tag.name} to ${name}.`);
      router.refresh();
    } catch (cause) {
      setError({ id: tag.id, text: (cause as Error).message });
    } finally {
      setBusy(null);
    }
  }

  async function remove(tag: TagInfo) {
    const where = tag.posts === 0 ? "No post uses it." : `It comes off ${tag.posts} post${tag.posts === 1 ? "" : "s"}. The posts stay.`;
    if (!window.confirm(`Delete the tag "${tag.name}"? ${where}`)) return;
    setBusy(tag.id);
    setError(null);
    try {
      await api(`/tags/${tag.id}`, { method: "DELETE" });
      setDone(`Deleted the tag ${tag.name}.`);
      router.refresh();
    } catch (cause) {
      setError({ id: tag.id, text: (cause as Error).message });
    } finally {
      setBusy(null);
    }
  }

  return (
    <Dialog open={open} onClose={close} title="Tags">
      {tags.length === 0 ? (
        <p className="text-[15px] leading-snug text-ink-2">No tags yet. Add one to a post in the composer, and it shows up here to rename or delete.</p>
      ) : (
        <>
          <p className="text-[15px] leading-snug text-ink-2">Renaming a tag changes it on every post. Deleting a tag takes it off its posts and keeps the posts.</p>
          <ul className="mt-4 space-y-3">
            {tags.map((tag) => (
              <li key={tag.id}>
                <form
                  className="flex flex-wrap items-center gap-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void rename(tag, String(new FormData(event.currentTarget).get("name") ?? ""));
                  }}
                >
                  <input key={tag.name} name="name" className="field min-w-0 flex-1 basis-40" defaultValue={tag.name} aria-label={`Name of the tag ${tag.name}`} autoComplete="off" aria-invalid={error?.id === tag.id} />
                  <span className="note num w-16 flex-none">{`${tag.posts} post${tag.posts === 1 ? "" : "s"}`}</span>
                  <button type="submit" className="btn btn-quiet btn-sm" disabled={busy === tag.id}>
                    Rename
                  </button>
                  <button type="button" className="btn btn-bare btn-sm" disabled={busy === tag.id} onClick={() => remove(tag)}>
                    Delete
                  </button>
                </form>
                {error?.id === tag.id ? (
                  <p className="mt-1 text-sm font-medium text-bad" role="alert">
                    {error.text}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        </>
      )}
      <div className="mt-6 flex items-center justify-between gap-3">
        <p className="note min-w-0" role="status">
          {done}
        </p>
        <button type="button" className="btn btn-quiet flex-none" onClick={close}>
          Done
        </button>
      </div>
    </Dialog>
  );
}
