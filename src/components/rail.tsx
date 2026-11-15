"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon, Wordmark } from "./ui";

const LINKS = [
  { href: "/app", label: "Compose", icon: "compose" },
  { href: "/app/posts", label: "Posts", icon: "posts" },
  { href: "/app/calendar", label: "Calendar", icon: "calendar" },
  { href: "/app/analytics", label: "Analytics", icon: "chart" },
  { href: "/app/media", label: "Media", icon: "image" },
  { href: "/app/accounts", label: "Accounts", icon: "accounts" },
  { href: "/app/connect", label: "Connect", icon: "connect" },
];

/** A side rail on wide screens, a bottom bar on a phone: the same seven places, where a thumb or a pointer expects them. */
export function Rail({ canSignOut = false }: { canSignOut?: boolean }) {
  const pathname = usePathname();
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
          {LINKS.map((link) => (
            <Link key={link.href} href={link.href} className="rail-link" aria-current={pathname === link.href ? "page" : undefined}>
              <Icon name={link.icon} />
              {link.label}
            </Link>
          ))}
        </nav>
        <div className="mt-auto">
          {canSignOut ? (
            <button type="button" className="rail-link w-full" onClick={signOut}>
              <Icon name="out" />
              Sign out
            </button>
          ) : null}
          <p className="note mt-2 px-2">Free and open source. Your keys stay on this machine.</p>
        </div>
      </aside>
      <nav className="fixed inset-x-0 bottom-0 z-40 flex justify-around bg-paper-2 px-1 pt-1 pb-[max(4px,env(safe-area-inset-bottom))] lg:hidden" aria-label="App">
        {LINKS.map((link) => (
          <Link
            key={link.href}
            href={link.href}
            aria-current={pathname === link.href ? "page" : undefined}
            className="flex min-h-12 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 rounded-md text-[11px] font-medium text-ink-2 aria-[current=page]:text-signal"
          >
            <Icon name={link.icon} size={20} />
            {link.label}
          </Link>
        ))}
      </nav>
    </>
  );
}
