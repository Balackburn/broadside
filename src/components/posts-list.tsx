"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { TargetNumbers } from "@/lib/analytics";
import { tagKey } from "@/lib/tag-rules";
import { Counts, Standing } from "./numbers";
import { TagFilter, TagList, TagManager, type TagInfo } from "./tags";
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
  feed: { id: string; title: string | null } | null;
  held_reason: string | null;
  repeat: { every: "day" | "week" | "month"; until: string | null } | null;
  series: { id: string; active: boolean } | null;
  targets: Target[];
  media: { id: string }[];
  tags: string[];
};
type Filter = "all" | "scheduled" | "published" | "failed" | "draft";

const FILTERS: { value: Filter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "scheduled", label: "Scheduled" },
  { value: "published", label: "Published" },
  { value: "failed", label: "Needs attention" },
  { value: "draft", label: "Drafts" },
];

const ORIGIN: Record<string, string> = { ui: "From the app", mcp: "From an agent", api: "From the API", feed: "From a feed" };

const matches = (post: Post, filter: Filter) =>
  filter === "all" || (filter === "failed" ? post.status === "failed" || post.status === "partial" : filter === "scheduled" ? post.status === "scheduled" || post.status === "publishing" : post.status === filter);

/**
 * `numbers` holds what Broadside has read back for each published target, by target id. A target that has not gone out has no entry.
 * `feed` is set when the list was asked for one feed's posts only; its title is another site's text and is shown as text.
 */
export function PostsList({ posts, tags, numbers = {}, focus, feed }: { posts: Post[]; tags: TagInfo[]; numbers?: Record<string, TargetNumbers>; focus?: string; feed?: { id: string; title: string | null } }) {
  const router = useRouter();
  const { show, toast } = useToast();
  const [filter, setFilter] = useState<Filter>("all");
  const [open, setOpen] = useState<string | null>(focus ?? null);
  const [busy, setBusy] = useState<string | null>(null);
  const [tag, setTag] = useState<string | null>(null);
  const [managing, setManaging] = useState(false);
  // A tag that was renamed or deleted while it was the filter no longer exists, so the filter falls back to every tag.
  const filterTag = tag !== null && tags.some((t) => tagKey(t.name) === tagKey(tag)) ? tag : null;
  const shown = posts.filter((p) => matches(p, filter) && (filterTag === null || p.tags.some((name) => tagKey(name) === tagKey(filterTag))));

  /** Asks each of a post's networks for its numbers now, and says how many answered. */
  async function refresh(post: Post) {
    setBusy(post.id);
    try {
      const result = await api<{ refreshed: { outcome: "read" | "failed" | "skipped"; reason?: string }[] }>(`/posts/${post.id}/analytics/refresh`, { method: "POST" });
      const read = result.refreshed.filter((r) => r.outcome === "read").length;
      const failed = result.refreshed.filter((r) => r.outcome === "failed").length;
      const why = (reason: string) => result.refreshed.some((r) => r.reason === reason);
      show(
        failed
          ? `Read ${read} of ${read + failed}. The reason is beside each network that failed.`
          : read
            ? "Numbers updated."
            : why("paused")
              ? "A network asked Broadside to slow down. When it reads again is beside the network."
              : why("recent")
                ? "These numbers were read a moment ago."
                : "This post has no numbers to read.",
      );
      router.refresh();
    } catch (error) {
      show((error as Error).message);
    } finally {
      setBusy(null);
    }
  }

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

      {tags.length ? (
        <div className="mt-4 flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
          <TagFilter tags={tags.map((t) => t.name)} value={filterTag} onChange={setTag} />
          <button type="button" className="btn btn-bare btn-sm -mr-3 ml-auto min-h-7" onClick={() => setManaging(true)}>
            Manage tags
          </button>
        </div>
      ) : null}

      {feed ? (
        <p className="note mt-4">
          {"Posts made from the feed "}
          <span className="font-medium text-ink">{feed.title ?? "that was deleted"}</span>
          {". "}
          <Link className="link py-1" href="/app/posts">
            Show all posts
          </Link>
        </p>
      ) : null}

      {shown.length === 0 ? (
        <div className="panel mt-8 p-10 text-center">
          <p className="title text-xl">{posts.length === 0 ? (feed ? "This feed has made no posts yet." : "Nothing posted yet.") : "No posts here."}</p>
          <p className="note mt-2">{posts.length === 0 ? (feed ? "When a new item appears in the feed, the post made from it lands here." : "Posts you send from the app, an agent or the API all land in this list.") : "Try another filter."}</p>
          {posts.length === 0 && !feed ? (
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
                      {post.held_reason ? <span className="text-bad">Does not fit yet</span> : null}
                      {post.media.length ? <span>{post.media.length} media</span> : null}
                      {post.thread.length ? <span>{`Thread of ${post.thread.length + 1}`}</span> : null}
                      {post.repeat ? <span>{`Repeats every ${post.repeat.every}`}</span> : null}
                      <TagList tags={post.tags} />
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
                    {post.feed ? (
                      <p className="note mb-3">
                        {"Made from an item in the feed "}
                        <Link className="link py-1" href={`/app/posts?feed=${post.feed.id}`}>
                          {post.feed.title ?? "that was deleted"}
                        </Link>
                        {". The words are the feed's, so read them before they go out."}
                      </p>
                    ) : null}
                    {post.held_reason ? (
                      <p className="mb-3 text-sm text-bad" role="status">
                        {`Held as a draft because it does not fit. ${post.held_reason} Shorten it or change its accounts, then publish.`}
                      </p>
                    ) : null}
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
                          {numbers[t.id] ? (
                            <div className="mt-2 space-y-1">
                              {numbers[t.id].metrics.length ? <Counts metrics={numbers[t.id].metrics} /> : null}
                              <Standing numbers={numbers[t.id]} />
                            </div>
                          ) : null}
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
                      {post.targets.some((t) => numbers[t.id]?.available) ? (
                        <button type="button" className="btn btn-quiet btn-sm" disabled={busy === post.id} onClick={() => refresh(post)}>
                          <Icon name="retry" size={16} /> Refresh numbers
                        </button>
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
      <TagManager open={managing} onClose={() => setManaging(false)} tags={tags} />
      {toast}
    </div>
  );
}
