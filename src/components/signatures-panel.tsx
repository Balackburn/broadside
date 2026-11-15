"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, Dialog, Icon, Stamp } from "./ui";

type Account = { id: string; platform: string; handle: string };
export type SignatureInfo = { id: string; name: string; content: string; default_for: string[] };

/** Saved pieces of text for the end of a post. The composer adds one when asked, as text you can then edit. */
export function SignaturesPanel({ accounts, signatures, show, canWrite = true }: { accounts: Account[]; signatures: SignatureInfo[]; show: (message: string) => void; canWrite?: boolean }) {
  const router = useRouter();
  const [editing, setEditing] = useState<SignatureInfo | "new" | null>(null);
  const [name, setName] = useState("");
  const [content, setContent] = useState("");
  const [offered, setOffered] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shake, setShake] = useState(0);

  const start = (signature: SignatureInfo | "new") => {
    setName(signature === "new" ? "" : signature.name);
    setContent(signature === "new" ? "" : signature.content);
    setOffered(signature === "new" ? [] : signature.default_for);
    setError(null);
    setEditing(signature);
  };

  const toggle = (id: string) => setOffered((now) => (now.includes(id) ? now.filter((x) => x !== id) : [...now, id]));
  const handleOf = (id: string) => accounts.find((a) => a.id === id)?.handle ?? null;

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!editing) return;
    setBusy(true);
    setError(null);
    try {
      const body = JSON.stringify({ name, content, default_for: offered });
      const saved = await api<SignatureInfo>(editing === "new" ? "/signatures" : `/signatures/${editing.id}`, { method: editing === "new" ? "POST" : "PATCH", body });
      setEditing(null);
      show(editing === "new" ? `Saved the signature ${saved.name}.` : `Saved ${saved.name}.`);
      router.refresh();
    } catch (cause) {
      setError((cause as Error).message);
      setShake((n) => n + 1);
    } finally {
      setBusy(false);
    }
  }

  async function remove(signature: SignatureInfo) {
    if (!window.confirm(`Delete the signature "${signature.name}"? Posts that already contain its text keep it.`)) return;
    try {
      await api(`/signatures/${signature.id}`, { method: "DELETE" });
      show(`Deleted the signature ${signature.name}.`);
      router.refresh();
    } catch (cause) {
      show((cause as Error).message);
    }
  }

  return (
    <section className="mt-12 scroll-mt-8" id="signatures" aria-label="Signatures">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="title text-2xl">Signatures</h2>
        {signatures.length && canWrite ? (
          <button type="button" className="btn btn-quiet btn-sm" onClick={() => start("new")}>
            <Icon name="plus" size={16} /> New signature
          </button>
        ) : null}
      </div>

      {signatures.length === 0 ? (
        <div className="panel mt-4 p-6">
          <p className="title text-lg">No signatures yet.</p>
          <p className="note mt-2 max-w-xl">A signature is saved text for the end of a post: a sign-off or a set of hashtags. Add signature in the composer puts it into the post, where you can edit it and it counts toward each network&rsquo;s limit.</p>
          {canWrite ? (
            <button type="button" className="btn btn-sm mt-4" onClick={() => start("new")}>
              <Icon name="plus" size={16} /> New signature
            </button>
          ) : null}
        </div>
      ) : (
        <ul className="mt-4 grid grid-cols-1 gap-2 md:grid-cols-2">
          {signatures.map((signature) => {
            const handles = signature.default_for.map(handleOf).filter((handle): handle is string => handle !== null);
            return (
              <li key={signature.id} className="panel flex flex-col gap-2 p-4">
                <div className="flex items-center gap-3">
                  <span className="min-w-0 flex-1 truncate font-medium">{signature.name}</span>
                  {canWrite ? (
                    <span className="flex flex-none items-center">
                      <button type="button" className="btn btn-bare btn-sm" onClick={() => start(signature)} aria-label={`Edit the signature ${signature.name}`}>
                        Edit
                      </button>
                      <button type="button" className="btn btn-bare btn-sm" onClick={() => remove(signature)} aria-label={`Delete the signature ${signature.name}`}>
                        Delete
                      </button>
                    </span>
                  ) : null}
                </div>
                <p className="line-clamp-3 text-[15px] leading-snug break-words whitespace-pre-wrap text-ink-2">{signature.content}</p>
                {handles.length ? <p className="note truncate">{`Offered by default for ${handles.join(", ")}`}</p> : null}
              </li>
            );
          })}
        </ul>
      )}

      <Dialog open={editing !== null} onClose={() => setEditing(null)} title={editing === "new" ? "New signature" : "Edit signature"}>
        <form onSubmit={save} key={shake} className={shake && error ? "is-shaking" : ""}>
          <label className="label" htmlFor="signature-name">
            Name
          </label>
          <input id="signature-name" className="field" value={name} onChange={(e) => setName(e.target.value)} placeholder="Team sign-off" maxLength={60} autoComplete="off" data-autofocus required />
          <label className="label mt-5" htmlFor="signature-content">
            Text
          </label>
          <textarea id="signature-content" className="field min-h-28 resize-y text-[15px] leading-snug" value={content} onChange={(e) => setContent(e.target.value)} placeholder="The Acme team" maxLength={2000} required />
          <p className="note mt-1 num">{`${[...content.trim()].length} characters, counted in the post like any other text.`}</p>
          {accounts.length ? (
            <>
              <p className="label mt-5">Offer by default for</p>
              <div className="flex flex-wrap gap-2" role="group" aria-label="Offer by default for">
                {accounts.map((account) => (
                  <button key={account.id} type="button" className="chip" aria-pressed={offered.includes(account.id)} onClick={() => toggle(account.id)}>
                    <Stamp platform={account.platform} />
                    <span className="max-w-44 truncate">{account.handle}</span>
                  </button>
                ))}
              </div>
              <p className="note mt-2">The composer offers this signature when you post to these accounts. You decide each time whether to add it. An account offers one signature, so choosing it here replaces its earlier one.</p>
            </>
          ) : null}
          {error ? (
            <p className="mt-4 text-sm font-medium text-bad" role="alert">
              {error}
            </p>
          ) : null}
          <div className="mt-6 flex justify-end gap-2">
            <button type="button" className="btn btn-quiet" onClick={() => setEditing(null)}>
              Cancel
            </button>
            <button type="submit" className="btn btn-signal" disabled={busy || !name.trim() || !content.trim()}>
              {busy ? <span className="spinner" /> : null}
              {busy ? "Saving" : "Save signature"}
            </button>
          </div>
        </form>
      </Dialog>
    </section>
  );
}
