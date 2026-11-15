"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { tagKey } from "@/lib/tag-rules";
import { TagFilter, TagList } from "./tags";
import { Stamp, Status, useHydrated } from "./ui";

type Entry = { id: string; content: string; status: string; at: string; platforms: string[]; tags: string[] };

const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** The calendar is laid out in the reader's time zone, which only the browser knows, so it draws after hydration. */
export function Calendar({ posts }: { posts: Entry[] }) {
  const hydrated = useHydrated();
  if (!hydrated) {
    return (
      <div>
        <h1 className="heading text-4xl">Calendar</h1>
        <div className="panel mt-6 h-96" aria-busy="true" aria-label="Loading the calendar" />
      </div>
    );
  }
  return <Month posts={posts} />;
}

function Month({ posts: every }: { posts: Entry[] }) {
  const [cursor, setCursor] = useState(() => new Date(new Date().getFullYear(), new Date().getMonth(), 1));
  const [picked, setPicked] = useState(() => dayKey(new Date()));
  const [tag, setTag] = useState<string | null>(null);
  // The tags on the posts in hand, each once, in alphabetical order.
  const tags = useMemo(() => {
    const seen = new Map<string, string>();
    for (const post of every) for (const name of post.tags) if (!seen.has(tagKey(name))) seen.set(tagKey(name), name);
    return [...seen.values()].sort((a, b) => tagKey(a).localeCompare(tagKey(b)));
  }, [every]);
  const filterTag = tag !== null && tags.some((name) => tagKey(name) === tagKey(tag)) ? tag : null;
  const posts = useMemo(() => (filterTag === null ? every : every.filter((post) => post.tags.some((name) => tagKey(name) === tagKey(filterTag)))), [every, filterTag]);

  const byDay = useMemo(() => {
    const map = new Map<string, Entry[]>();
    for (const post of posts) {
      const key = dayKey(new Date(post.at));
      map.set(key, [...(map.get(key) ?? []), post]);
    }
    for (const list of map.values()) list.sort((a, b) => a.at.localeCompare(b.at));
    return map;
  }, [posts]);

  const days = useMemo(() => {
    const first = new Date(cursor);
    const offset = (first.getDay() + 6) % 7;
    return Array.from({ length: 42 }, (_, i) => new Date(cursor.getFullYear(), cursor.getMonth(), i - offset + 1));
  }, [cursor]);

  const today = dayKey(new Date());
  const month = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" }).format(cursor);
  const time = new Intl.DateTimeFormat(undefined, { timeStyle: "short" });
  const move = (by: number) => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + by, 1));
  const list = byDay.get(picked) ?? [];
  const [y, m, d] = picked.split("-").map(Number);
  const pickedLabel = new Intl.DateTimeFormat(undefined, { weekday: "long", day: "numeric", month: "long" }).format(new Date(y, m, d));

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <h1 className="heading text-4xl">Calendar</h1>
        <div className="flex items-center gap-2">
          <button type="button" className="btn btn-quiet btn-sm" onClick={() => move(-1)} aria-label="Previous month">
            Earlier
          </button>
          <span className="title num w-44 text-center text-lg" aria-live="polite">
            {month}
          </span>
          <button type="button" className="btn btn-quiet btn-sm" onClick={() => move(1)} aria-label="Next month">
            Later
          </button>
        </div>
      </div>

      {tags.length ? (
        <div className="mt-4">
          <TagFilter tags={tags} value={filterTag} onChange={setTag} />
        </div>
      ) : null}

      <div className="mt-6 grid gap-6 xl:grid-cols-[minmax(0,7fr)_minmax(0,4fr)]">
        <div className="panel overflow-hidden p-2">
          <div className="grid grid-cols-7 pb-1 text-center text-sm text-ink-3">
            {WEEKDAYS.map((w) => (
              <span key={w}>{w}</span>
            ))}
          </div>
          <div className="grid grid-cols-7 gap-1">
            {days.map((day) => {
              const key = dayKey(day);
              const entries = byDay.get(key) ?? [];
              const inMonth = day.getMonth() === cursor.getMonth();
              const attention = entries.some((e) => e.status === "failed" || e.status === "partial");
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => setPicked(key)}
                  aria-pressed={picked === key}
                  aria-label={`${day.toDateString()}, ${entries.length} post${entries.length === 1 ? "" : "s"}`}
                  className="row flex min-h-16 flex-col items-start gap-1 rounded-md p-1.5 text-left aria-pressed:bg-ink aria-pressed:text-paper sm:min-h-24 sm:p-2"
                  style={{ opacity: inMonth ? 1 : 0.4 }}
                >
                  <span className={`num text-sm ${key === today ? "font-bold text-signal" : ""}`}>{day.getDate()}</span>
                  {entries.length ? (
                    <span className="flex flex-wrap items-center gap-1 text-xs font-medium">
                      <span className="rounded-sm px-1.5 py-0.5" style={{ background: attention ? "var(--bad)" : "var(--signal)", color: "var(--on-signal)" }}>
                        {entries.length}
                      </span>
                      <span className="hidden truncate sm:inline">{entries.length === 1 ? "post" : "posts"}</span>
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        </div>

        <section aria-label={`Posts on ${pickedLabel}`}>
          <h2 className="title text-xl">{pickedLabel}</h2>
          {list.length === 0 ? (
            <div className="panel mt-3 p-6">
              <p className="note">{filterTag === null ? "Nothing on this day." : `Nothing tagged ${filterTag} on this day.`}</p>
              <Link className="btn btn-sm mt-4" href="/app">
                Write a post
              </Link>
            </div>
          ) : (
            <ul className="mt-3 space-y-2">
              {list.map((post) => (
                <li key={post.id}>
                  <Link href={`/app/posts?post=${post.id}`} className="sheet row block">
                    <span className="flex items-center justify-between gap-3">
                      <span className="num text-sm font-medium">{time.format(new Date(post.at))}</span>
                      <Status status={post.status} />
                    </span>
                    <span className="mt-2 line-clamp-3 text-[15px] leading-snug">{post.content || "No text"}</span>
                    {post.tags.length ? (
                      <span className="mt-2 block">
                        <TagList tags={post.tags} />
                      </span>
                    ) : null}
                    <span className="mt-3 flex gap-1" aria-hidden="true">
                      {post.platforms.map((p, i) => (
                        <Stamp key={`${p}-${i}`} platform={p} />
                      ))}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
