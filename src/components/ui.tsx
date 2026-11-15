"use client";

import { NetworkLogo } from "./logos";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";

/* Brand ------------------------------------------------------------------- */

/** The mark: one post at the spine, going out three ways at once. */
export function Mark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect x="4.5" y="6" width="5.5" height="20" rx="2.75" fill="var(--signal)" />
      <g fill="currentColor">
        <rect x="13" y="13.25" width="14.5" height="5.5" rx="2.75" transform="rotate(-36 13.5 16)" />
        <rect x="13" y="13.25" width="15.5" height="5.5" rx="2.75" />
        <rect x="13" y="13.25" width="14.5" height="5.5" rx="2.75" transform="rotate(36 13.5 16)" />
      </g>
    </svg>
  );
}

export function Wordmark({ size = 22 }: { size?: number }) {
  return (
    <span className="inline-flex items-center gap-2">
      <Mark size={size + 6} />
      <span className="title" style={{ fontSize: size, letterSpacing: "-0.03em" }}>
        Broadside
      </span>
    </span>
  );
}

/** A network's badge: its real mark in a small round tile. */
export function Stamp({ platform, large }: { platform: string; large?: boolean }) {
  return (
    <span className={`stamp ${large ? "stamp-lg" : ""}`} aria-hidden="true">
      <NetworkLogo platform={platform} size={large ? 20 : 14} />
    </span>
  );
}

/* Icons: one 1.5px stroke set, coloured by the text around them. ---------- */

const paths: Record<string, ReactNode> = {
  compose: <path d="M4 20h4L19 9l-4-4L4 16v4ZM13.5 6.5l4 4" />,
  posts: <path d="M5 6h14M5 12h14M5 18h9" />,
  calendar: <path d="M5 7h14v12H5zM5 11h14M9 4v4M15 4v4" />,
  accounts: <path d="M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM3.5 19a5.5 5.5 0 0 1 11 0M16 5.5a3 3 0 0 1 0 5.5M17.5 14.5A5.5 5.5 0 0 1 20.5 19" />,
  connect: <path d="M9 4v5M15 4v5M6 9h12v3a6 6 0 0 1-12 0V9ZM12 18v3" />,
  plus: <path d="M12 5v14M5 12h14" />,
  image: <path d="M4 5h16v14H4zM4 15l4.5-4.5 4 4 2.5-2.5L20 17M15 9.5h.01" />,
  clock: <path d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 7v5l3 2" />,
  close: <path d="M6 6l12 12M18 6 6 18" />,
  copy: <path d="M9 9h10v11H9zM5 15V4h10" />,
  out: <path d="M8 16 16 8M9 8h7v7" />,
  retry: <path d="M19 12a7 7 0 1 1-2.5-5.4M19 5v4h-4" />,
  alert: <path d="M12 8v5M12 16.5h.01M12 3l9.5 17h-19L12 3Z" />,
};

export function Icon({ name, size = 18 }: { name: keyof typeof paths | string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {paths[name]}
    </svg>
  );
}

export function Check({ size = 16 }: { size?: number }) {
  return (
    <svg className="check" width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 8.5 6.5 12 13 4.5" />
    </svg>
  );
}

/* Status ------------------------------------------------------------------ */

const WORDS: Record<string, string> = {
  draft: "Draft",
  scheduled: "Scheduled",
  pending: "Sending",
  publishing: "Sending",
  retrying: "Retrying",
  waiting: "Waiting",
  published: "Published",
  partial: "Partly published",
  failed: "Failed",
  cancelled: "Cancelled",
};

export function Status({ status }: { status: string }) {
  const busy = status === "publishing" || status === "pending";
  return (
    <span className="status" data-status={status}>
      {status === "published" ? <Check /> : busy ? <span className="spinner" /> : status === "failed" || status === "partial" ? <Icon name="alert" size={16} /> : status === "scheduled" || status === "retrying" ? <Icon name="clock" size={16} /> : null}
      {WORDS[status] ?? status}
    </span>
  );
}

/* Tabs with a sliding pill ------------------------------------------------- */

export function Tabs<T extends string>({ value, onChange, options, label }: { value: T; onChange: (value: T) => void; options: { value: T; label: string }[]; label: string }) {
  const list = useRef<HTMLDivElement>(null);
  const pill = useRef<HTMLSpanElement>(null);
  const placed = useRef(false);

  useLayoutEffect(() => {
    const active = list.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!active || !pill.current) return;
    const el = pill.current;
    // The first placement must not animate, or the pill slides in from the corner.
    if (!placed.current) el.style.transition = "none";
    // Width is tweened as a horizontal scale of a 100px pill, so only transform animates.
    el.style.transform = `translateX(${active.offsetLeft}px) scaleX(${active.offsetWidth / 100})`;
    if (!placed.current) {
      void el.offsetWidth;
      el.style.transition = "";
      placed.current = true;
    }
  }, [value, options.length]);

  return (
    <div className="tabs" role="tablist" aria-label={label} ref={list}>
      <span className="tabs-pill" ref={pill} aria-hidden="true" />
      {options.map((option) => (
        <button key={option.value} type="button" role="tab" className="tab" aria-selected={option.value === value} onClick={() => onChange(option.value)}>
          {option.label}
        </button>
      ))}
    </div>
  );
}

/* Dialog ------------------------------------------------------------------ */

export function Dialog({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className="dialog"
      aria-label={title}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === ref.current) onClose();
      }}
    >
      <div className="mb-4 flex items-start justify-between gap-4">
        <h2 className="title text-2xl">{title}</h2>
        <button type="button" className="btn btn-bare btn-sm" onClick={onClose} aria-label="Close">
          <Icon name="close" />
        </button>
      </div>
      {open ? children : null}
    </dialog>
  );
}

/* Toast ------------------------------------------------------------------- */

export function useToast() {
  const [message, setMessage] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const show = useCallback((text: string) => {
    timers.current.forEach(clearTimeout);
    setLeaving(false);
    setMessage(text);
    timers.current = [setTimeout(() => setLeaving(true), 3600), setTimeout(() => setMessage(null), 3800)];
  }, []);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  const toast = message ? (
    <div className="toast" role="status" data-leaving={leaving}>
      {message}
    </div>
  ) : null;
  return { show, toast };
}

/* Copy -------------------------------------------------------------------- */

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="btn btn-quiet btn-sm"
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1600);
      }}
    >
      {copied ? <Check /> : <Icon name="copy" size={16} />}
      <span className="swap" key={String(copied)}>
        {copied ? "Copied" : label}
      </span>
    </button>
  );
}

/* Talking to the API ------------------------------------------------------- */

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const isForm = init.body instanceof FormData;
  const response = await fetch(`/api/v1${path}`, { ...init, headers: isForm ? init.headers : { "content-type": "application/json", ...init.headers } });
  const payload = (await response.json().catch(() => ({}))) as { data?: T; error?: { message: string; details?: unknown } };
  if (!response.ok || payload.error) {
    const error = new Error(payload.error?.message ?? `The server answered ${response.status}.`) as Error & { details?: unknown };
    error.details = payload.error?.details;
    throw error;
  }
  return payload.data as T;
}

export function when(iso: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));
}

const noop = () => () => {};

/** False on the server and during hydration, true afterwards. */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    noop,
    () => true,
    () => false,
  );
}

/**
 * A date in the reader's own locale and time zone. The server cannot know
 * either, so it sends a neutral UTC form and the browser swaps in the local
 * one once it has taken over; the two never disagree during hydration.
 */
export function Time({ iso }: { iso: string }) {
  const hydrated = useHydrated();
  return <time dateTime={iso}>{hydrated ? when(iso) : `${iso.slice(0, 16).replace("T", " ")} UTC`}</time>;
}
