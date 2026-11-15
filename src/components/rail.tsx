"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Icon, Wordmark } from "./ui";

const LINKS = [
  { href: "/app", label: "Compose", icon: "compose" },
  { href: "/app/posts", label: "Posts", icon: "posts" },
  { href: "/app/calendar", label: "Calendar", icon: "calendar" },
  { href: "/app/analytics", label: "Analytics", icon: "chart" },
  { href: "/app/media", label: "Media", icon: "image" },
  { href: "/app/automations", label: "Automations", icon: "bolt" },
  { href: "/app/accounts", label: "Accounts", icon: "accounts" },
  { href: "/app/connect", label: "Connect", icon: "connect" },
  { href: "/app/team", label: "Team", icon: "team" },
];

/** A phone's bar holds five things at most: the first four screens, then More, which opens the rest. */
const ON_BAR = 4;
const BAR_ITEM = "flex min-h-12 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 rounded-md text-[11px] font-medium text-ink-2";

/**
 * A side rail on wide screens, a bottom bar on a phone: the same places, where a pointer or a thumb expects them.
 * `member` is who is signed in, when the install has a team. Connect holds API keys, which are an admin's, so it is left out below that.
 */
export function Rail({ canSignOut = false, member, canConnect = true }: { canSignOut?: boolean; member?: { name: string; role: string }; canConnect?: boolean }) {
  const pathname = usePathname();
  const [more, setMore] = useState(false);
  const moreButton = useRef<HTMLButtonElement>(null);
  const links = canConnect ? LINKS : LINKS.filter((link) => link.href !== "/app/connect");
  const bar = links.slice(0, ON_BAR);
  const rest = links.slice(ON_BAR);
  // When the screen in view is one of those behind More, More is the item that is lit.
  const behindMore = rest.find((link) => link.href === pathname);

  useEffect(() => {
    if (!more) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setMore(false);
      moreButton.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [more]);

  const signOut = async () => {
    await fetch("/api/login", { method: "DELETE" });
    // A full reload, not a client navigation: nothing from the signed-in session should stay in memory.
    window.location.replace("/login");
  };
  return (
    <>
      <aside className="sticky top-0 hidden h-dvh w-60 flex-none flex-col gap-1 bg-paper-2 p-4 lg:flex">
        <Link href="/" className="mb-6 px-2 pt-1" aria-label="Broadside home">
          <Wordmark size={20} />
        </Link>
        <nav className="flex flex-col gap-1" aria-label="App">
          {links.map((link) => (
            <Link key={link.href} href={link.href} className="rail-link" aria-current={pathname === link.href ? "page" : undefined}>
              <Icon name={link.icon} />
              {link.label}
            </Link>
          ))}
        </nav>
        <div className="mt-auto">
          {member ? (
            <p className="note mb-1 flex gap-1 px-2">
              <span className="truncate">{member.name}</span>
              <span className="flex-none">{`(${member.role})`}</span>
            </p>
          ) : null}
          {canSignOut ? (
            <button type="button" className="rail-link w-full" onClick={signOut}>
              <Icon name="out" />
              Sign out
            </button>
          ) : null}
          <p className="note mt-2 px-2">Free and open source. Your keys stay on this machine.</p>
        </div>
      </aside>

      {more ? <button type="button" className="fixed inset-0 z-30 bg-[var(--scrim)] lg:hidden" aria-label="Close the menu" tabIndex={-1} onClick={() => setMore(false)} /> : null}
      <nav className="fixed inset-x-0 bottom-0 z-40 bg-paper-2 px-1 pt-1 pb-[max(4px,env(safe-area-inset-bottom))] lg:hidden" aria-label="App" data-phone-bar>
        <div className="flex justify-around">
          {bar.map((link) => (
            <Link key={link.href} href={link.href} aria-current={pathname === link.href ? "page" : undefined} className={`${BAR_ITEM} aria-[current=page]:text-signal`} onClick={() => setMore(false)}>
              <Icon name={link.icon} size={20} />
              {link.label}
            </Link>
          ))}
          <button
            ref={moreButton}
            type="button"
            className={`${BAR_ITEM} data-[current=true]:text-signal aria-expanded:text-ink`}
            aria-expanded={more}
            aria-controls="more-screens"
            data-current={Boolean(behindMore)}
            onClick={() => setMore((open) => !open)}
          >
            <Icon name="more" size={20} />
            More
            {behindMore ? <span className="sr-only">{`, showing ${behindMore.label}`}</span> : null}
          </button>
        </div>
        {more ? (
          <div id="more-screens" className="more-sheet absolute inset-x-2 bottom-full mb-2 flex flex-col gap-1 rounded-2xl bg-paper-2 p-2">
            {rest.map((link) => (
              <Link key={link.href} href={link.href} className="rail-link min-h-12" aria-current={pathname === link.href ? "page" : undefined} onClick={() => setMore(false)}>
                <Icon name={link.icon} />
                {link.label}
              </Link>
            ))}
            {member ? (
              <p className="note flex gap-1 px-3 pt-1">
                <span className="truncate">{member.name}</span>
                <span className="flex-none">{`(${member.role})`}</span>
              </p>
            ) : null}
            {canSignOut ? (
              <button type="button" className="rail-link min-h-12 w-full" onClick={signOut}>
                <Icon name="out" />
                Sign out
              </button>
            ) : null}
          </div>
        ) : null}
      </nav>
    </>
  );
}
