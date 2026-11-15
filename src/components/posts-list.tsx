"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, Icon, Stamp, Status, Tabs, Time, useToast } from "./ui";

type Part = { part: number; status: string; url: string | null };
type Target = { id: string; platform: string; handle: string; status: string; error: string | null; url: string | null; content_override: string | null; parts: Part[] };
type Post = {
  id: string;
  content: string;
  thread: string[];
  status: string;
  publish_at: string | null;
  created_at: string;
  origin: string;
  repeat: { every: "day" | "week" | "month"; until: string | null } | null;
  series: { id: string; active: boolean } | null;
  targets: Target[];
  media: { id: string }[];
};
type Filter = "all" | "scheduled" | "published" | "failed" | "draft";

const FILTERS: { value: Filter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "scheduled", label: "Scheduled" },
  { value: "published", label: "Published" },
  { value: "failed", label: "Needs attention" },
  { value: "draft", label: "Drafts" },
];

const ORIGIN: Record<string, string> = { ui: "From the app", mcp: "From an agent", api: "From the API" };

const matches = (post: Post, filter: Filter) =>
  filter === "all" || (filter === "failed" ? post.status === "failed" || post.status === "partial" : filter === "scheduled" ? post.status === "scheduled" || post.status === "publishing" : post.status === filter);

export function PostsList({ posts, focus }: { posts: Post[]; focus?: string }) {
  const router = useRouter();
  const { show, toast } = useToast();
  const [filter, setFilter] = useState<Filter>("all");
  const [open, setOpen] = useState<string | null>(focus ?? null);
  const [busy, setBusy] = useState<string | null>(null);
  const shown = posts.filter((p) => matches(p, filter));

  async function act(key: string, path: string, method: string, done: string, body?: unknown) {
    setBusy(key);
    try {
      await api(path, { method, body: body === undefined ? undefined : JSON.stringify(body) });
      show(done);
      router.refresh();
    } catch (error) {
      show((error as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <h1 className="heading text-4xl">Posts</h1>
        <div className="scroll-quiet max-w-full">
          <Tabs label="Filter posts" value={filter} onChange={setFilter} options={FILTERS} />
        </div>
      </div>

      {shown.length === 0 ? (
        <div className="panel mt-8 p-10 text-center">
          <p className="title text-xl">{posts.length === 0 ? "Nothing posted yet." : "No posts here."}</p>
          <p className="note mt-2">{posts.length === 0 ? "Posts you send from the app, an agent or the API all land in this list." : "Try another filter."}</p>
          {posts.length === 0 ? (
            <Link className="btn mt-6" href="/app">
              Write a post
            </Link>
          ) : null}
        </div>
      ) : (
        <ul className="mt-6 space-y-2">
          {shown.map((post) => {
            const expanded = open === post.id;
            const editable = post.status === "scheduled" || post.status === "draft";
            const series = post.series ? posts.filter((p) => p.series?.id === post.series?.id).sort((a, b) => (a.publish_at ?? a.created_at).localeCompare(b.publish_at ?? b.created_at)) : [];
            return (
              <li key={post.id} className="panel overflow-hidden">
                <button type="button" className="row flex w-full items-center gap-4 p-4 text-left" aria-expanded={expanded} onClick={() => setOpen(expanded ? null : post.id)}>
                  <span className="min-w-0 flex-1">
                    <span className="line-clamp-2 text-[15px] leading-snug">{post.content || <span className="text-ink-3">No text</span>}</span>
                    <span className="note mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
                      <span className="num">
                        <Time iso={post.publish_at ?? post.created_at} />
                      </span>
                      <span>{ORIGIN[post.origin] ?? post.origin}</span>
                      {post.media.length ? <span>{post.media.length} media</span> : null}
                      {post.thread.length ? <span>{`Thread of ${post.thread.length + 1}`}</span> : null}
                      {post.repeat ? <span>{`Repeats every ${post.repeat.every}`}</span> : null}
                    </span>
                  </span>
                  <span className="hidden flex-none items-center sm:flex" aria-hidden="true">
                    {post.targets.slice(0, 6).map((t, i) => (
                      <span key={t.id} style={{ marginLeft: i ? -6 : 0, outline: "2px solid var(--paper)", borderRadius: "50%" }}>
                        <Stamp platform={t.platform} />
                      </span>
                    ))}
                  </span>
                  <span className="flex-none text-right sm:w-36">
                    <Status status={post.status} />
                  </span>
                </button>
                {expanded ? (
                  <div className="bg-paper-2 p-4">
                    {post.thread.length ? (
                      <ol className="mb-3 space-y-2">
                        {post.thread.map((text, i) => (
                          <li key={i} className="rounded-md bg-paper p-3">
                            <span className="note">{`Part ${i + 2}`}</span>
                            <p className="mt-1 whitespace-pre-wrap text-[15px] leading-snug">{text}</p>
                          </li>
                        ))}
                      </ol>
                    ) : null}
                    <ul className="space-y-2">
                      {post.targets.map((t) => (
                        <li key={t.id} className="rounded-md bg-paper p-3">
                          <div className="flex flex-wrap items-center justify-between gap-3">
                            <span className="flex min-w-0 items-center gap-2">
                              <Stamp platform={t.platform} />
                              <span className="truncate font-medium">{t.handle}</span>
                              {t.content_override !== null ? <span className="note">own version</span> : null}
                            </span>
                            <span className="flex items-center gap-3">
                              <Status status={t.status} />
                              {t.url ? (
                                <a className="link inline-flex items-center gap-1 text-sm" href={t.url} target="_blank" rel="noreferrer">
                                  Open <Icon name="out" size={14} />
                                </a>
                              ) : null}
                              {t.status === "failed" ? (
                                <button type="button" className="btn btn-quiet btn-sm" disabled={busy === t.id} onClick={() => act(t.id, `/posts/${post.id}/targets/${t.id}/retry`, "POST", "Sent again.")}>
                                  <Icon name="retry" size={16} /> Retry
                                </button>
                              ) : null}
                            </span>
                          </div>
                          {/* Until a thread starts going out, every part has its target's status and the list would only repeat it. */}
                          {t.parts.length > 1 && t.status !== "scheduled" && t.status !== "draft" ? (
                            <ol className="mt-2 space-y-1">
                              {t.parts.map((part) => (
                                <li key={part.part} className="flex flex-wrap items-center justify-between gap-3 text-sm">
                                  <span className="text-ink-2">{`Part ${part.part}`}</span>
                                  <span className="flex items-center gap-3">
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
                    {post.series ? (
                      <div className="mt-3 rounded-md bg-paper p-3">
                        <div className="flex flex-wrap items-center justify-between gap-3">
                          <span className="font-medium">
                            {post.repeat ? `Repeats every ${post.repeat.every}` : "Repeating series"}
                            {post.repeat?.until ? (
                              <span className="note">
                                {" "}
                                until <Time iso={post.repeat.until} />
                              </span>
                            ) : null}
                          </span>
                          {post.series.active ? (
                            <button
                              type="button"
                              className="btn btn-quiet btn-sm"
                              disabled={busy === post.id}
                              onClick={() => act(post.id, `/posts/${post.id}/cancel`, "POST", "Stopped. Nothing more will go out from this series.", { series: true })}
                            >
                              Stop repeating
                            </button>
                          ) : (
                            <span className="note">Ended</span>
                          )}
                        </div>
                        <ol className="mt-2 space-y-1">
                          {series.map((p) => (
                            <li key={p.id} className="flex flex-wrap items-center justify-between gap-3 text-sm">
                              <span className={p.id === post.id ? "num font-medium" : "num text-ink-2"}>
                                <Time iso={p.publish_at ?? p.created_at} />
                                {p.id === post.id ? " (this post)" : ""}
                              </span>
                              <Status status={p.status} />
                            </li>
                          ))}
                        </ol>
                      </div>
                    ) : null}
                    <div className="mt-3 flex flex-wrap gap-2">
                      {editable ? (
                        <Link className="btn btn-sm" href={`/app?edit=${post.id}`}>
                          Edit
                        </Link>
                      ) : null}
                      {editable ? (
                        <button type="button" className="btn btn-quiet btn-sm" disabled={busy === post.id} onClick={() => act(post.id, `/posts/${post.id}/publish`, "POST", "Published.")}>
                          Publish now
                        </button>
                      ) : null}
                      {editable ? (
                        <button
                          type="button"
                          className="btn btn-quiet btn-sm"
                          disabled={busy === post.id}
                          onClick={() => act(post.id, `/posts/${post.id}/cancel`, "POST", post.repeat && post.status === "scheduled" ? "Cancelled this one. The series carries on." : "Cancelled. It will not go out.")}
                        >
                          {post.repeat && post.status === "scheduled" ? "Cancel this one" : "Cancel"}
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className="btn btn-bare btn-sm"
                        disabled={busy === post.id}
                        onClick={() => {
                          if (window.confirm("Remove this post from Broadside's history? Anything already published stays on its network.")) void act(post.id, `/posts/${post.id}`, "DELETE", "Removed from history.");
                        }}
                      >
                        Remove from history
                      </button>
                    </div>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {toast}
    </div>
  );
}
