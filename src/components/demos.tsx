"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { NetworkLogo } from "./logos";
import { Icon, Stamp, Status } from "./ui";

/**
 * The demos on the front page are the app's own pieces (chips, sheets,
 * statuses, buttons) played on a clock. Each runs only while it is on
 * screen; under reduced motion it shows its finished state and stays still.
 */
const REDUCED = "(prefers-reduced-motion: reduce)";
const watchReduced = (notify: () => void) => {
  const query = matchMedia(REDUCED);
  query.addEventListener("change", notify);
  return () => query.removeEventListener("change", notify);
};

function useClock(length: number): { t: number; ref: React.RefObject<HTMLDivElement | null> } {
  const ref = useRef<HTMLDivElement>(null);
  const [t, setT] = useState(0);
  const still = useSyncExternalStore(
    watchReduced,
    () => matchMedia(REDUCED).matches,
    () => false,
  );
  useEffect(() => {
    const el = ref.current;
    if (!el || still) return;
    let timer: ReturnType<typeof setInterval> | undefined;
    const watcher = new IntersectionObserver(([entry]) => {
      clearInterval(timer);
      if (entry.isIntersecting) timer = setInterval(() => setT((now) => (now + 1) % length), 100);
    });
    watcher.observe(el);
    return () => {
      clearInterval(timer);
      watcher.disconnect();
    };
  }, [length, still]);
  return { t: still ? length - 1 : t, ref };
}

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));

/* Compose once ------------------------------------------------------------ */

const POST = "Version 2.0 is out today. Sync is faster, the editor is new, and it works offline. Release notes are on the blog.";
const ACCOUNTS = [
  { id: "x", handle: "@acme", max: 280, link: "x.com/acme" },
  { id: "bluesky", handle: "acme.bsky.social", max: 300, link: "bsky.app/profile/acme" },
  { id: "threads", handle: "@acme", max: 500, link: "threads.net/@acme" },
  { id: "mastodon", handle: "@acme@mastodon.social", max: 500, link: "mastodon.social/@acme" },
  { id: "linkedin", handle: "Acme", max: 3000, link: "linkedin.com/company/acme" },
];

export function ComposeDemo() {
  const typed = Math.ceil(POST.length / 4);
  const picked = 6 + typed + 4;
  const press = picked + ACCOUNTS.length * 3 + 5;
  const sent = press + 12;
  const { t, ref } = useClock(sent + ACCOUNTS.length * 3 + 34);
  const text = POST.slice(0, clamp((t - 6) * 4, 0, POST.length));
  const chosen = clamp(Math.floor((t - picked) / 3) + 1, 0, ACCOUNTS.length);
  const sending = t >= press + 3;
  const published = clamp(Math.floor((t - sent) / 3) + 1, 0, ACCOUNTS.length);

  return (
    <div ref={ref} className="grid gap-6 p-5 sm:p-8 lg:grid-cols-2" aria-label="A demonstration of writing one post and publishing it to five accounts">
      <div aria-hidden="true">
        <p className="label">Post to</p>
        <div className="flex flex-wrap gap-2">
          {ACCOUNTS.map((account, i) => (
            <span key={account.id} className="chip" aria-pressed={i < chosen}>
              <Stamp platform={account.id} />
              <span className="max-w-36 truncate">{account.handle}</span>
            </span>
          ))}
        </div>
        <p className="label mt-5">Post</p>
        <div className="field min-h-32 text-[15px] leading-snug">
          <span className={text.length < POST.length && t > 5 ? "caret" : ""}>{text}</span>
          {text ? null : <span className="text-ink-3">What do you want to say everywhere?</span>}
        </div>
        <div className="mt-5 flex justify-end">
          <span className="btn btn-signal" style={{ transform: t >= press && t < press + 3 ? "scale(0.96)" : undefined }}>
            {sending && published < ACCOUNTS.length ? <span className="spinner" /> : null}
            {sending ? (published < ACCOUNTS.length ? "Sending" : "Published") : `Publish to ${chosen} account${chosen === 1 ? "" : "s"}`}
          </span>
        </div>
      </div>

      <ul className="space-y-2" aria-hidden="true">
        {ACCOUNTS.map((account, i) => {
          const live = i < chosen;
          const done = sending && i < published;
          return (
            <li key={account.id} className="sheet flex items-center justify-between gap-3" style={{ opacity: live ? 1 : 0.35, padding: 12 }}>
              <span className="flex min-w-0 items-center gap-3">
                <Stamp platform={account.id} />
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium">{account.handle}</span>
                  <span className="num block truncate text-xs text-ink-3">{done ? `${account.link}/…` : `${text.length} / ${account.max}`}</span>
                </span>
              </span>
              {sending && live ? <Status status={done ? "published" : "publishing"} /> : <span className="text-sm text-ink-3">{live ? "Ready" : "Not chosen"}</span>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/* Hand it to an agent ----------------------------------------------------- */

const ASK = "Announce the 2.0 release on every account tomorrow at nine.";

/** One tool call and what it returned. */
function Call({ name, children, bad }: { name: string; children: React.ReactNode; bad?: boolean }) {
  return (
    <div className="swap mt-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <code className="rounded-md bg-paper-3 px-2 py-0.5 font-mono text-[13px]">{name}</code>
      <span className={bad ? "text-bad" : "text-ink-2"}>{children}</span>
    </div>
  );
}

export function AgentDemo() {
  const asked = 4 + Math.ceil(ASK.length / 3);
  const { t, ref } = useClock(asked + 110);
  const ask = ASK.slice(0, clamp((t - 4) * 3, 0, ASK.length));
  const at = (offset: number) => t >= asked + offset;

  return (
    <div ref={ref} className="min-h-80 p-5 text-[15px] leading-snug sm:p-8" aria-label="A demonstration of an AI agent scheduling a post through Broadside">
      <div aria-hidden="true">
        <p className="text-ink-3">You</p>
        <p className={`mt-1 ${ask.length < ASK.length ? "caret" : ""}`}>{ask || " "}</p>
        {at(6) ? <p className="swap mt-5 text-ink-3">Agent</p> : null}
        {at(6) && !at(14) ? <p className="shimmer mt-1 inline-block">Checking the post against each network</p> : null}
        {at(14) ? (
          <Call name="check_post" bad>
            X allows 280 characters; this is 312.
          </Call>
        ) : null}
        {at(26) ? <p className="swap mt-3">I wrote a shorter version for X and kept the full text everywhere else.</p> : null}
        {at(38) ? <Call name="create_post">Scheduled for tomorrow at 09:00 on 6 accounts.</Call> : null}
        {at(54) ? <p className="swap mt-5 text-ink-3">Tomorrow, 09:00</p> : null}
        {at(60) ? (
          <Call name="get_post">
            <span className="text-good">6 of 6 published</span>
          </Call>
        ) : null}
        {at(68) ? (
          <p className="swap mt-3 flex flex-wrap gap-2">
            {["x", "bluesky", "threads", "mastodon", "linkedin", "telegram"].map((id) => (
              <span key={id} className="stamp">
                <NetworkLogo platform={id} size={14} />
              </span>
            ))}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/* Schedule it ------------------------------------------------------------- */

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function ScheduleDemo() {
  const { t, ref } = useClock(90);
  const placed = t >= 14;
  const due = t >= 44;
  const minutes = clamp(57 + Math.floor((t - 26) / 6), 57, 60);
  const clock = t < 26 ? "08:57" : minutes >= 60 ? "09:00" : `08:${minutes}`;

  return (
    <div ref={ref} className="p-5 sm:p-6" aria-label="A demonstration of a post being scheduled for Thursday at nine and published on time">
      <div aria-hidden="true">
        <div className="flex items-center justify-between text-sm">
          <span className="text-ink-3">This week</span>
          <span className="num flex items-center gap-2 text-ink-2">
            <Icon name="clock" size={16} /> Thu {clock}
          </span>
        </div>
        <div className="mt-3 grid grid-cols-7 gap-1.5">
          {DAYS.map((day, i) => (
            <div key={day} className="flex min-h-28 flex-col rounded-lg p-1.5 text-xs" style={{ background: "var(--paper-2)" }}>
              <span className="text-ink-3">{day}</span>
              {i === 3 && placed ? (
                <span className="sheet mt-1.5 block" style={{ padding: 6, borderRadius: 8 }}>
                  <span className="num block font-medium">09:00</span>
                  <span className="mt-1 flex gap-0.5">
                    <NetworkLogo platform="x" size={11} />
                    <NetworkLogo platform="bluesky" size={11} />
                    <NetworkLogo platform="mastodon" size={11} />
                  </span>
                </span>
              ) : null}
            </div>
          ))}
        </div>
        <div className="mt-4 flex items-center justify-between gap-3 rounded-lg p-3 text-sm" style={{ background: "var(--paper-2)" }}>
          <span className="truncate">Office hours this Thursday. Bring your questions.</span>
          <Status status={due ? "published" : placed ? "scheduled" : "draft"} />
        </div>
      </div>
    </div>
  );
}

/* One failure does not stop the rest -------------------------------------- */

export function RetryDemo() {
  const [state, setState] = useState<"failed" | "publishing" | "published">("failed");
  const rows = [
    { id: "x", handle: "@acme", status: "published" },
    { id: "mastodon", handle: "@acme@mastodon.social", status: state },
    { id: "bluesky", handle: "acme.bsky.social", status: "published" },
  ];
  return (
    <div className="space-y-2 p-5 sm:p-6">
      {rows.map((row) => (
        <div key={row.id} className="sheet" style={{ padding: 12 }}>
          <div className="flex items-center justify-between gap-3">
            <span className="flex min-w-0 items-center gap-3">
              <Stamp platform={row.id} />
              <span className="truncate text-sm font-medium">{row.handle}</span>
            </span>
            <span className="flex items-center gap-3">
              <Status status={row.status} />
              {row.status === "failed" ? (
                <button
                  type="button"
                  className="btn btn-quiet btn-sm"
                  onClick={() => {
                    setState("publishing");
                    setTimeout(() => setState("published"), 1100);
                  }}
                >
                  <Icon name="retry" size={16} /> Retry
                </button>
              ) : null}
            </span>
          </div>
          {row.status === "failed" ? <p className="mt-2 text-sm text-bad">Mastodon answered 503: Service unavailable</p> : null}
        </div>
      ))}
      {state === "published" ? (
        <button type="button" className="btn btn-bare btn-sm" onClick={() => setState("failed")}>
          Play it again
        </button>
      ) : (
        <p className="note px-1">Press Retry. Only Mastodon is sent again.</p>
      )}
    </div>
  );
}
