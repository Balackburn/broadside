"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { CheckResult, Feed, FeedAction, FeedPreview } from "@/lib/feeds";
import { api, Dialog, Icon, Stamp, Status, Time } from "./ui";

type Account = { id: string; platform: string; handle: string };
type Group = { id: string; name: string; account_ids: string[] };

const DEFAULT_TEMPLATE = "{title}\n\n{link}";

const host = (address: string): string => {
  try {
    return new URL(address).host;
  } catch {
    return address;
  }
};

/** What to call a feed: its own title, or its host until it has one. Both are text from another site and are shown as text. */
const nameOf = (feed: Feed): string => feed.title || host(feed.url);

/**
 * RSS and Atom feeds. Each new item becomes a post to the accounts the feed
 * names: a draft to read first, or published at once if the operator chose
 * that. Everything a feed says is another site's text, set here as plain text.
 */
export function FeedsPanel({ feeds, accounts, groups, show, canManage = true }: { feeds: Feed[]; accounts: Account[]; groups: Group[]; show: (message: string) => void; canManage?: boolean }) {
  const router = useRouter();
  // `editing` is the feed being changed, "new" for one being added, null when the dialog is shut.
  const [editing, setEditing] = useState<Feed | "new" | null>(null);
  const [url, setUrl] = useState("");
  const [where, setWhere] = useState("accounts");
  const [members, setMembers] = useState<string[]>([]);
  const [template, setTemplate] = useState(DEFAULT_TEMPLATE);
  const [action, setAction] = useState<FeedAction>("draft");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [shake, setShake] = useState(0);
  const [preview, setPreview] = useState<{ feed: Feed; result: FeedPreview } | null>(null);

  const start = (feed: Feed | "new") => {
    setUrl(feed === "new" ? "" : feed.url);
    setWhere(feed === "new" || !feed.group ? "accounts" : feed.group.id);
    setMembers(feed === "new" || feed.group ? [] : feed.accounts.map((a) => a.id));
    setTemplate(feed === "new" ? DEFAULT_TEMPLATE : feed.template);
    setAction(feed === "new" ? "draft" : feed.action);
    setError(null);
    setEditing(feed);
  };

  const toggle = (id: string) => setMembers((now) => (now.includes(id) ? now.filter((x) => x !== id) : [...now, id]));
  const ready = url.trim() !== "" && template.trim() !== "" && (where !== "accounts" || members.length > 0);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!editing) return;
    setBusy("save");
    setError(null);
    try {
      const targets = where === "accounts" ? { account_ids: members } : { group_id: where };
      const saved =
        editing === "new"
          ? await api<Feed>("/feeds", { method: "POST", body: JSON.stringify({ url, template, action, ...targets }) })
          : await api<Feed>(`/feeds/${editing.id}`, { method: "PATCH", body: JSON.stringify({ template, action, ...targets }) });
      setEditing(null);
      show(editing === "new" ? `Added ${nameOf(saved)}. It posts what appears from now on.` : `Saved ${nameOf(saved)}.`);
      router.refresh();
    } catch (cause) {
      setError((cause as Error).message);
      setShake((n) => n + 1);
    } finally {
      setBusy(null);
    }
  }

  async function act(feed: Feed, key: string, run: () => Promise<string | void>) {
    setBusy(`${key}:${feed.id}`);
    try {
      const said = await run();
      if (said) show(said);
      router.refresh();
    } catch (cause) {
      show((cause as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const checkNow = (feed: Feed) =>
    act(feed, "check", async () => {
      const result = await api<CheckResult>(`/feeds/${feed.id}/check`, { method: "POST" });
      if (result.outcome === "failed" || result.outcome === "skipped") return result.message ?? "This feed could not be checked.";
      if (!result.post_ids.length) return result.message ?? "Nothing new in this feed.";
      const made = result.post_ids.length === 1 ? "1 post" : `${result.post_ids.length} posts`;
      return result.message ? `Made ${made}. ${result.message}` : `Made ${made} from this feed.`;
    });

  const remove = (feed: Feed) => {
    if (!window.confirm(`Delete the feed "${nameOf(feed)}"? The posts it made stay.`)) return;
    void act(feed, "delete", async () => {
      await api(`/feeds/${feed.id}`, { method: "DELETE" });
      return `Deleted the feed ${nameOf(feed)}.`;
    });
  };

  return (
    <section className="mt-10" aria-label="Feeds">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="title text-2xl">Feeds</h2>
        {feeds.length && canManage ? (
          <button type="button" className="btn btn-quiet btn-sm" onClick={() => start("new")}>
            <Icon name="plus" size={16} /> Add feed
          </button>
        ) : null}
      </div>

      {feeds.length === 0 ? (
        <div className="panel mt-4 p-6">
          <p className="title text-lg">No feeds yet.</p>
          <p className="note mt-2 max-w-xl">Add the RSS or Atom address of a blog, a newsletter or a release page. Each new item becomes a post to the accounts you choose, saved as a draft for you to read first.</p>
          {!canManage ? (
            <p className="note mt-4">Feeds are added and changed by an admin of this Broadside.</p>
          ) : accounts.length ? (
            <button type="button" className="btn btn-sm mt-4" onClick={() => start("new")}>
              <Icon name="plus" size={16} /> Add feed
            </button>
          ) : (
            <Link className="btn btn-sm mt-4" href="/app/accounts">
              Connect an account first
            </Link>
          )}
        </div>
      ) : (
        <ul className="mt-4 space-y-2">
          {feeds.map((feed) => {
            const failing = feed.status === "active" && feed.last_error !== null;
            return (
              <li key={feed.id} className="panel p-4">
                <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
                  <div className="min-w-0 flex-1 basis-56">
                    <p className="truncate font-medium">{nameOf(feed)}</p>
                    <p className="note truncate font-mono text-[13px]">{feed.url}</p>
                  </div>
                  <span className="status" data-status={feed.status === "paused" ? "draft" : failing ? "failed" : "published"}>
                    {failing ? <Icon name="alert" size={16} /> : null}
                    {feed.status === "paused" ? "Paused" : failing ? "Failing" : "Active"}
                  </span>
                </div>

                <dl className="mt-3 grid gap-x-8 gap-y-2 text-sm sm:grid-cols-2">
                  <div className="min-w-0">
                    <dt className="note">Each new item</dt>
                    <dd>{feed.action === "publish" ? "Is published straight away" : "Is saved as a draft"}</dd>
                  </div>
                  <div className="min-w-0">
                    <dt className="note">{feed.group ? `Posts to the group ${feed.group.name ?? "that was deleted"}` : "Posts to"}</dt>
                    <dd className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                      {feed.accounts.length === 0 ? (
                        <span className="text-bad">{canManage ? "No accounts left. Edit this feed to choose some." : "No accounts left."}</span>
                      ) : (
                        feed.accounts.map((account) => (
                          <span key={account.id} className="flex min-w-0 items-center gap-1.5">
                            <Stamp platform={account.platform} />
                            <span className="truncate">{account.handle}</span>
                          </span>
                        ))
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt className="note">Last checked</dt>
                    <dd className="num">{feed.last_checked_at ? <Time iso={feed.last_checked_at} /> : "Not yet"}</dd>
                  </div>
                  <div>
                    <dt className="note">Next check</dt>
                    <dd className="num">{feed.status === "paused" ? "When you resume it" : <Time iso={feed.next_check_at} />}</dd>
                  </div>
                </dl>

                {feed.last_error ? (
                  <p className="mt-3 text-sm text-bad" role="status">
                    {feed.last_error}
                  </p>
                ) : null}

                <div className="mt-3 rounded-md bg-paper-2 p-3">
                  <p className="text-sm">
                    {feed.posts.total === 0 ? (
                      <span className="note">No posts made yet. Items that were in the feed when you added it are left alone.</span>
                    ) : (
                      <>
                        <span className="font-medium">{feed.posts.total === 1 ? "1 post made" : `${feed.posts.total} posts made`}</span>{" "}
                        <Link className="link py-1" href={`/app/posts?feed=${feed.id}`}>
                          See them in Posts
                        </Link>
                      </>
                    )}
                  </p>
                  {feed.posts.recent.length ? (
                    <ul className="mt-2 space-y-1.5">
                      {feed.posts.recent.map((item, i) => (
                        <li key={`${item.at}-${i}`} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 text-sm">
                          <span className="min-w-0 flex-1 basis-48">
                            {item.post_id && item.post_status ? (
                              <Link className="link line-clamp-1 py-0.5" href={`/app/posts?post=${item.post_id}`}>
                                {item.title || "Untitled item"}
                              </Link>
                            ) : (
                              <span className="line-clamp-1">{item.title || "Untitled item"}</span>
                            )}
                            {item.note ? <span className="block text-bad">{item.outcome === "held" ? `Held as a draft. ${item.note}` : item.note}</span> : null}
                          </span>
                          <span className="flex flex-none items-center gap-3">
                            <span className="note num">
                              <Time iso={item.at} />
                            </span>
                            {item.post_status ? <Status status={item.post_status} /> : <span className="note">{item.outcome === "failed" ? "No post made" : "Post removed"}</span>}
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>

                {canManage ? (
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button type="button" className="btn btn-quiet btn-sm" disabled={busy !== null || feed.status === "paused"} onClick={() => checkNow(feed)}>
                      {busy === `check:${feed.id}` ? <span className="spinner" /> : <Icon name="retry" size={16} />} Check now
                    </button>
                    <button
                      type="button"
                      className="btn btn-quiet btn-sm"
                      disabled={busy !== null}
                      onClick={() =>
                        act(feed, "preview", async () => {
                          setPreview({ feed, result: await api<FeedPreview>(`/feeds/${feed.id}/test`, { method: "POST" }) });
                        })
                      }
                    >
                      {busy === `preview:${feed.id}` ? <span className="spinner" /> : null} Preview
                    </button>
                    <button type="button" className="btn btn-bare btn-sm" onClick={() => start(feed)} aria-label={`Edit the feed ${nameOf(feed)}`}>
                      Edit
                    </button>
                    <button
                      type="button"
                      className="btn btn-bare btn-sm"
                      disabled={busy !== null}
                      onClick={() =>
                        act(feed, "pause", async () => {
                          await api(`/feeds/${feed.id}`, { method: "PATCH", body: JSON.stringify({ paused: feed.status === "active" }) });
                          return feed.status === "active" ? "Paused. This feed is not read until you resume it." : "Resumed. It posts what appears from now on.";
                        })
                      }
                    >
                      {feed.status === "active" ? "Pause" : "Resume"}
                    </button>
                    <button type="button" className="btn btn-bare btn-sm" disabled={busy !== null} onClick={() => remove(feed)} aria-label={`Delete the feed ${nameOf(feed)}`}>
                      Delete
                    </button>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      <Dialog open={editing !== null} onClose={() => setEditing(null)} title={editing === "new" ? "Add a feed" : "Edit feed"}>
        <form onSubmit={save} key={shake} className={shake && error ? "is-shaking" : ""}>
          {editing === "new" ? (
            <>
              <label className="label" htmlFor="feed-url">
                Feed address
              </label>
              <input id="feed-url" className="field" type="url" inputMode="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/feed.xml" autoComplete="off" data-autofocus required />
            </>
          ) : (
            <>
              <p className="label">Feed address</p>
              <p className="note break-all font-mono text-[13px]">{url}</p>
            </>
          )}

          <p className="label mt-5" id="feed-where">
            Post to
          </p>
          {groups.length ? (
            <select className="field mb-3" aria-labelledby="feed-where" value={where} onChange={(e) => setWhere(e.target.value)}>
              <option value="accounts">Accounts I choose here</option>
              {groups.map((group) => (
                <option key={group.id} value={group.id}>{`The group ${group.name}`}</option>
              ))}
            </select>
          ) : null}
          {where === "accounts" ? (
            <div className="flex flex-wrap gap-2" role="group" aria-label="Accounts this feed posts to">
              {accounts.map((account) => (
                <button key={account.id} type="button" className="chip" aria-pressed={members.includes(account.id)} onClick={() => toggle(account.id)}>
                  <Stamp platform={account.platform} />
                  <span className="max-w-44 truncate">{account.handle}</span>
                </button>
              ))}
            </div>
          ) : (
            <p className="note">Every account in the group at the time an item arrives.</p>
          )}

          <p className="label mt-5" id="feed-action">
            Each new item
          </p>
          <div className="flex flex-wrap gap-2" role="group" aria-labelledby="feed-action">
            <button type="button" className="chip pl-3" aria-pressed={action === "draft"} onClick={() => setAction("draft")}>
              Save as a draft
            </button>
            <button type="button" className="chip pl-3" aria-pressed={action === "publish"} onClick={() => setAction("publish")}>
              Publish
            </button>
          </div>
          <p className="note mt-2">
            {action === "publish"
              ? "Items go out as soon as Broadside sees them, with nobody reading them first. Choose this only for a feed you write yourself."
              : "Each item waits in Posts as a draft until you publish it."}
          </p>

          <label className="label mt-5" htmlFor="feed-template">
            Post text
          </label>
          <textarea id="feed-template" className="field font-mono text-sm" rows={4} value={template} onChange={(e) => setTemplate(e.target.value)} maxLength={2000} required />
          <p className="note mt-2">
            <code className="font-mono text-[13px]">{"{title}"}</code>, <code className="font-mono text-[13px]">{"{link}"}</code> and <code className="font-mono text-[13px]">{"{summary}"}</code>
            {" are replaced with the words of each item. An item too long for one of the accounts is saved as a draft with the reason, and nothing is cut."}
          </p>

          {error ? (
            <p className="mt-4 text-sm font-medium text-bad" role="alert">
              {error}
            </p>
          ) : null}
          <div className="mt-6 flex justify-end gap-2">
            <button type="button" className="btn btn-quiet" onClick={() => setEditing(null)}>
              Cancel
            </button>
            <button type="submit" className="btn btn-signal" disabled={busy === "save" || !ready}>
              {busy === "save" ? <span className="spinner" /> : null}
              {busy === "save" ? (editing === "new" ? "Reading the feed" : "Saving") : editing === "new" ? "Add feed" : "Save feed"}
            </button>
          </div>
        </form>
      </Dialog>

      <Dialog open={preview !== null} onClose={() => setPreview(null)} title="Preview">
        {preview ? (
          preview.result.newest ? (
            <div>
              <p className="note">{`${nameOf(preview.feed)} lists ${preview.result.items === 1 ? "1 item" : `${preview.result.items} items`}. The newest would be posted like this. Nothing has been saved or sent.`}</p>
              <pre className="code mt-3 max-h-72 overflow-auto whitespace-pre-wrap break-words">{preview.result.newest.text || "(empty)"}</pre>
              {preview.result.newest.problems.length ? (
                <ul className="mt-3 space-y-1 text-sm text-bad">
                  {preview.result.newest.problems.map((problem) => (
                    <li key={problem}>{problem}</li>
                  ))}
                  <li className="text-ink-2">It would be saved as a draft with this reason.</li>
                </ul>
              ) : (
                <p className="note mt-3">It fits every account this feed posts to.</p>
              )}
            </div>
          ) : (
            <p className="note">This feed has no items yet.</p>
          )
        ) : null}
      </Dialog>
    </section>
  );
}
