"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { Analytics, AnalyticsRow, Total } from "@/lib/analytics";
import { KIND_LABEL, type MetricKind } from "@/lib/platforms/types";
import { count, Counts, Standing } from "./numbers";
import { Icon, Stamp, Tabs, Time } from "./ui";

type Account = { id: string; platform: string; label: string; handle: string };
type SortKey = "post" | "network" | "published" | "as_of" | MetricKind;
type Sort = { key: SortKey; down: boolean };

const PERIOD_TABS = [
  { value: "7", label: "7 days" },
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
];

/** "X, Bluesky and Mastodon" */
const list = (names: string[]): string => (names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`);
const posts = (n: number): string => `${count(n)} ${n === 1 ? "post" : "posts"}`;

/** The value a row sorts by under a key. A row with nothing under that key is undefined and always goes last. */
function sortValue(row: AnalyticsRow, key: SortKey): string | number | undefined {
  if (key === "post") return row.content.toLowerCase();
  if (key === "network") return `${row.network} ${row.handle}`.toLowerCase();
  if (key === "published") return row.published_at ?? undefined;
  if (key === "as_of") return row.as_of ?? undefined;
  return row.metrics.find((m) => m.kind === key)?.value;
}

function sorted(rows: AnalyticsRow[], sort: Sort): AnalyticsRow[] {
  return [...rows].sort((a, b) => {
    const x = sortValue(a, sort.key);
    const y = sortValue(b, sort.key);
    if (x === undefined || y === undefined) return x === y ? 0 : x === undefined ? 1 : -1;
    const order = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y));
    return sort.down ? -order : order;
  });
}

export function AnalyticsView({ data, accounts, tags, everPublished }: { data: Analytics; accounts: Account[]; tags: string[]; everPublished: boolean }) {
  const router = useRouter();
  const [sort, setSort] = useState<Sort>({ key: "published", down: true });
  const [charted, setCharted] = useState<MetricKind | null>(null);
  const days = data.period.days;
  // The kinds any network reported in this period, in a fixed order. They are the table's columns and the chart's choices.
  const kinds = data.totals.map((t) => t.kind);
  const chartKind = charted && kinds.includes(charted) ? charted : (kinds[0] ?? null);
  const chart = data.totals.find((t) => t.kind === chartKind);
  const rows = sorted(data.rows, sort);
  const filtered = Boolean(data.account_id || data.tag);
  const readings = data.networks.flatMap((n) => (n.as_of_oldest && n.as_of_newest ? [n.as_of_oldest, n.as_of_newest] : [])).sort();

  const go = (next: { period?: string; account?: string; tag?: string }) => {
    const query = new URLSearchParams();
    const period = next.period ?? String(days);
    const account = next.account ?? data.account_id ?? "";
    const tag = next.tag ?? data.tag ?? "";
    if (period !== "30") query.set("period", period);
    if (account) query.set("account", account);
    if (tag) query.set("tag", tag);
    router.push(`/app/analytics${query.size ? `?${query}` : ""}`);
  };

  // Numbers open on the largest first; names and dates open in reading order, except that the newest post leads.
  const sortBy = (key: SortKey) => setSort((now) => (now.key === key ? { key, down: !now.down } : { key, down: key !== "post" && key !== "network" }));

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <h1 className="heading text-4xl">Analytics</h1>
        <div className="scroll-quiet max-w-full">
          <Tabs label="Period" value={String(days)} onChange={(period) => go({ period })} options={PERIOD_TABS} />
        </div>
      </div>

      {everPublished ? (
        <div className="mt-4 flex flex-wrap items-end gap-3">
          <p className="note min-w-0 flex-1 basis-80">
            Posts published in the last {days} days, with the latest numbers each network reported for them. Broadside reads them about once an hour for 30 days after a post goes out. After that, press Refresh on the post.
          </p>
          {accounts.length > 1 ? (
            <label className="block min-w-0">
              <span className="sr-only">Account</span>
              <select className="field text-sm" value={data.account_id ?? ""} onChange={(event) => go({ account: event.target.value })}>
                <option value="">All accounts</option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>{`${a.label}: ${a.handle}`}</option>
                ))}
              </select>
            </label>
          ) : null}
          {tags.length ? (
            <label className="block min-w-0">
              <span className="sr-only">Tag</span>
              <select className="field text-sm" value={data.tag ?? ""} onChange={(event) => go({ tag: event.target.value })}>
                <option value="">All tags</option>
                {tags.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </div>
      ) : null}

      {data.rows.length === 0 ? (
        <div className="panel mt-8 p-10 text-center">
          <p className="title text-xl">{everPublished ? (filtered ? "No published posts match." : `Nothing was published in the last ${days} days.`) : "Nothing published yet."}</p>
          <p className="note mx-auto mt-2 max-w-xl">
            {everPublished
              ? filtered
                ? "Try another account, tag or period."
                : "Try a longer period, or publish a post."
              : "Once a post goes out, the numbers each network reports for it appear here: views, likes, comments, shares and more, each with the time it was read. Networks that report no numbers are named, with the reason."}
          </p>
          <Link className="btn mt-6" href="/app">
            Write a post
          </Link>
        </div>
      ) : (
        <>
          <section className="mt-8" aria-labelledby="totals-title">
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <h2 id="totals-title" className="title text-xl">
                Totals
              </h2>
              <p className="note">
                {posts(data.posts)} on {data.networks.length} {data.networks.length === 1 ? "network" : "networks"}
                {readings.length ? (
                  <>
                    , read between{" "}
                    <span className="num">
                      <Time iso={readings[0]} />
                    </span>{" "}
                    and{" "}
                    <span className="num">
                      <Time iso={readings.at(-1)!} />
                    </span>
                  </>
                ) : null}
              </p>
            </div>
            {data.totals.length ? (
              <ul className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {data.totals.map((total) => (
                  <TotalTile key={total.kind} total={total} />
                ))}
              </ul>
            ) : (
              <p className="panel note mt-3 p-4">No numbers have been read for these posts yet. Each network below says where it stands.</p>
            )}
            {data.totals.length > 1 ? <p className="note mt-3">Each total adds up one kind of count. Views and impressions are counted apart, and so is a score, because networks mean different things by them.</p> : null}
          </section>

          {chart ? (
            <section className="mt-10" aria-labelledby="chart-title">
              <div className="flex flex-wrap items-end justify-between gap-3">
                <h2 id="chart-title" className="title text-xl">
                  {`${chart.label} by network`}
                </h2>
                {kinds.length > 1 ? (
                  <div className="scroll-quiet max-w-full">
                    <Tabs label="Count to chart" value={chart.kind} onChange={(kind) => setCharted(kind)} options={kinds.map((kind) => ({ value: kind, label: KIND_LABEL[kind] }))} />
                  </div>
                ) : null}
              </div>
              <Bars total={chart} />
            </section>
          ) : null}

          <section className="mt-10" aria-labelledby="networks-title">
            <h2 id="networks-title" className="title text-xl">
              Networks
            </h2>
            <ul className="mt-3 space-y-2">
              {data.networks.map((network) => (
                <li key={network.platform} className="panel p-4">
                  <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
                    <span className="flex min-w-0 items-center gap-2">
                      <Stamp platform={network.platform} />
                      <span className="truncate font-medium">{network.network}</span>
                    </span>
                    <span className="note num">
                      {network.available ? `${count(network.read)} of ${posts(network.targets)} read` : posts(network.targets)}
                      {network.failing ? `, the last try failed for ${count(network.failing)}` : ""}
                    </span>
                  </div>
                  {network.available ? (
                    <div className="mt-2 space-y-1">
                      {network.metrics.length ? <Counts metrics={network.metrics} /> : null}
                      <p className="note">
                        {network.as_of_oldest && network.as_of_newest ? (
                          // Readings taken within the same minute print as one time.
                          network.as_of_oldest.slice(0, 16) === network.as_of_newest.slice(0, 16) ? (
                            <>
                              As of{" "}
                              <span className="num">
                                <Time iso={network.as_of_newest} />
                              </span>
                            </>
                          ) : (
                            <>
                              Readings from{" "}
                              <span className="num">
                                <Time iso={network.as_of_oldest} />
                              </span>{" "}
                              to{" "}
                              <span className="num">
                                <Time iso={network.as_of_newest} />
                              </span>
                            </>
                          )
                        ) : (
                          "No reading yet."
                        )}
                      </p>
                    </div>
                  ) : (
                    <p className="note mt-2">{`Not available for ${network.network}. ${network.unavailable_reason}`}</p>
                  )}
                </li>
              ))}
            </ul>
          </section>

          <section className="mt-10" aria-labelledby="posts-title">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <h2 id="posts-title" className="title text-xl">
                  Posts
                </h2>
                <p className="note mt-1">
                  One row for each copy of a post on a network.<span className="hidden lg:inline"> A dash means the network was read and gave no such count.</span>
                </p>
              </div>
              <label className="flex items-center gap-2 lg:hidden">
                <span className="note">Sort by</span>
                <select className="field w-auto text-sm" value={sort.key} onChange={(event) => sortBy(event.target.value as SortKey)}>
                  <option value="published">Published</option>
                  <option value="post">Post</option>
                  <option value="network">Network</option>
                  {kinds.map((kind) => (
                    <option key={kind} value={kind}>
                      {KIND_LABEL[kind]}
                    </option>
                  ))}
                  <option value="as_of">Read</option>
                </select>
              </label>
            </div>

            {/* Wide screens: a table. The first column holds the post, its network and its dates, each with its own sorting button; every count has a column. */}
            <div className="panel scroll-quiet mt-3 hidden lg:block">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr>
                    <th scope="col" className="p-1 text-left font-medium">
                      <span className="flex flex-wrap">
                        <SortButton sort={sort} onSort={sortBy} name="post" label="Post" />
                        <SortButton sort={sort} onSort={sortBy} name="network" label="Network" />
                        <SortButton sort={sort} onSort={sortBy} name="published" label="Published" />
                        <SortButton sort={sort} onSort={sortBy} name="as_of" label="Read" />
                      </span>
                    </th>
                    {kinds.map((kind) => (
                      <th key={kind} scope="col" className="w-px p-1 text-right font-medium" aria-sort={sort.key === kind ? (sort.down ? "descending" : "ascending") : "none"}>
                        <SortButton sort={sort} onSort={sortBy} name={kind} label={KIND_LABEL[kind]} numeric />
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.target_id} className="row align-top shadow-[inset_0_1px_0_var(--line)]">
                      <td className="min-w-64 p-3">
                        <Link className="link line-clamp-2" href={`/app/posts?post=${row.post_id}`}>
                          {row.content || "No text"}
                        </Link>
                        <span className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-2">
                          <Stamp platform={row.platform} />
                          <span className="text-ink">{row.network}</span>
                          <span className="max-w-48 truncate">{row.handle}</span>
                          {row.published_at ? (
                            <span className="num whitespace-nowrap">
                              <Time iso={row.published_at} />
                            </span>
                          ) : null}
                        </span>
                        <Read row={row} />
                      </td>
                      {kinds.map((kind) => {
                        const metric = row.metrics.find((m) => m.kind === kind);
                        return (
                          <td key={kind} className="num whitespace-nowrap p-3 text-right">
                            {metric ? (
                              <>
                                {count(metric.value)}
                                {/* The network's own word, where it is not the column's. */}
                                {metric.label !== KIND_LABEL[kind] ? <span className="block text-xs text-ink-2">{metric.label.toLowerCase()}</span> : null}
                              </>
                            ) : row.as_of ? (
                              // Read, and the network gave no such count. A row that was never read stays empty.
                              <span className="text-ink-3" aria-label={`No ${KIND_LABEL[kind].toLowerCase()} reported`}>
                                -
                              </span>
                            ) : null}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Narrow screens: the same rows as cards, each count under its network's own word. */}
            <ul className="mt-3 space-y-2 lg:hidden">
              {rows.map((row) => (
                <li key={row.target_id} className="panel p-4">
                  <Link className="link line-clamp-2 text-[15px] leading-snug" href={`/app/posts?post=${row.post_id}`}>
                    {row.content || "No text"}
                  </Link>
                  <p className="note mt-2 flex flex-wrap items-center gap-x-2 gap-y-1">
                    <Stamp platform={row.platform} />
                    <span className="min-w-0 truncate">{row.handle}</span>
                    {row.published_at ? (
                      <span className="num">
                        <Time iso={row.published_at} />
                      </span>
                    ) : null}
                  </p>
                  {row.metrics.length ? (
                    <div className="mt-2">
                      <Counts metrics={row.metrics} />
                    </div>
                  ) : null}
                  <div className="mt-2">
                    <Standing numbers={row} />
                  </div>
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
    </div>
  );
}

/** One total: the sum, what it is made of, and what it leaves out. */
function TotalTile({ total }: { total: Total }) {
  return (
    <li className="panel p-4">
      <p className="note">{total.label}</p>
      <p className="num title mt-1 text-4xl">{count(total.value)}</p>
      <p className="note mt-2">
        {`From ${posts(total.targets)} on ${list(
          total.networks.map((part) =>
            // Where a network has its own word for the count, the word goes beside its share.
            total.networks.length > 1 || part.label !== total.label ? `${part.network} (${count(part.value)}${part.label !== total.label ? ` ${part.label.toLowerCase()}` : ""})` : part.network,
          ),
        )}.`}
      </p>
      {total.missing.length ? (
        <details className="mt-2 text-sm">
          <summary className="cursor-pointer py-1 text-ink-2">{`Not in this total: ${list([...new Set(total.missing.map((m) => m.network))])}`}</summary>
          <ul className="mt-1 space-y-1 text-ink-2">
            {total.missing.map((m) => (
              <li key={m.platform}>
                <span className="text-ink">{m.network}.</span> {m.reason}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </li>
  );
}

/** One kind of count, one bar per network, all on one scale from zero. Each bar carries its own figure. */
function Bars({ total }: { total: Total }) {
  const largest = Math.max(...total.networks.map((part) => part.value), 1);
  return (
    <figure className="panel mt-3 p-4">
      <ul className="space-y-3">
        {total.networks.map((part) => (
          <li key={part.platform} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 sm:grid-cols-[11rem_minmax(0,1fr)_9rem]">
            <span className="flex min-w-0 items-center gap-2">
              <Stamp platform={part.platform} />
              <span className="truncate text-sm font-medium">{part.network}</span>
            </span>
            <svg className="col-span-2 row-start-2 h-3 w-full rounded-full sm:col-span-1 sm:col-start-2 sm:row-start-1" viewBox="0 0 100 12" preserveAspectRatio="none" aria-hidden="true">
              <rect width="100" height="12" fill="var(--paper-3)" />
              <rect width={(part.value / largest) * 100} height="12" fill="var(--ink)" />
            </svg>
            <span className="num text-right text-sm sm:col-start-3 sm:row-start-1">
              {count(part.value)}
              {part.label !== total.label ? <span className="text-ink-2"> {part.label.toLowerCase()}</span> : null}
            </span>
          </li>
        ))}
      </ul>
      <figcaption className="note mt-3">
Each bar adds up the latest reading of that network&apos;s posts from the period. Networks that do not report this count have no bar.
      </figcaption>
    </figure>
  );
}

/** A button that sorts the table by one thing, and shows which way when it is the one in use. */
function SortButton({ sort, onSort, name, label, numeric }: { sort: Sort; onSort: (key: SortKey) => void; name: SortKey; label: string; numeric?: boolean }) {
  const active = sort.key === name;
  // Over a column of figures the arrow leads, so the label ends where the figures end.
  return (
    <button
      type="button"
      className={`btn btn-bare btn-sm gap-1 text-[13px] ${numeric ? "flex-row-reverse pr-3 pl-1" : "px-2"} ${active ? "text-ink" : ""}`}
      aria-pressed={active}
      aria-label={`Sort by ${label.toLowerCase()}${active ? (sort.down ? ", now descending" : ", now ascending") : ""}`}
      onClick={() => onSort(name)}
    >
      {label}
      <span className={active ? "" : "opacity-0"} aria-hidden="true">
        <Icon name={sort.down || !active ? "down" : "up"} size={12} />
      </span>
    </button>
  );
}

/** Under a row's post: when its numbers were read, or why there are none. Text from a network is shown as text. */
function Read({ row }: { row: AnalyticsRow }) {
  if (!row.available) return <span className="mt-1 block text-xs text-ink-2">{`Not available for ${row.network}. ${row.unavailable_reason}`}</span>;
  return (
    <span className="mt-1 block text-xs text-ink-2">
      {row.as_of ? (
        <span className="block">
          Read{" "}
          <span className="num whitespace-nowrap">
            <Time iso={row.as_of} />
          </span>
        </span>
      ) : row.error ? null : (
        <span className="block">No reading yet.</span>
      )}
      {row.error ? <span className="block text-bad">{`The last try failed. ${row.error.message}`}</span> : null}
      {row.note ? <span className="block">{row.note}</span> : null}
    </span>
  );
}
