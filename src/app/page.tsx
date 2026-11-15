import type { Metadata } from "next";
import Link from "next/link";
import { AgentDemo, ComposeDemo, RetryDemo, ScheduleDemo } from "@/components/demos";
import { Fan } from "@/components/fan";
import { NetworkLogo } from "@/components/logos";
import { NetworkRules } from "@/components/network-rules";
import { Ring } from "@/components/ring";
import { Icon, Mark, Wordmark } from "@/components/ui";
import { connectors } from "@/lib/platforms";

export const metadata: Metadata = { alternates: { canonical: "/" } };

const REPO = "https://github.com/Balackburn/broadside";

const BRINGS: Record<string, string> = {
  bluesky: "An app password",
  mastodon: "An access token",
  telegram: "A bot token",
  discord: "A webhook URL",
  slack: "A webhook URL",
  webhook: "Any URL",
  nostr: "Your private key",
  devto: "An API key",
  lemmy: "Your login",
  reddit: "A script app",
};

const RING = [
  { id: "x", name: "X", handle: "@you" },
  { id: "bluesky", name: "Bluesky", handle: "you.bsky.social" },
  { id: "threads", name: "Threads", handle: "@you" },
  { id: "mastodon", name: "Mastodon", handle: "@you@mastodon.social" },
  { id: "instagram", name: "Instagram", handle: "@you" },
  { id: "tiktok", name: "TikTok", handle: "@you" },
  { id: "youtube", name: "YouTube", handle: "Your channel" },
  { id: "telegram", name: "Telegram", handle: "@yourchannel" },
];

const RING_TEXT = "We shipped it. One post, written once, sent to every network we use.";

const MCP_SNIPPET = `claude mcp add --transport http broadside \\
  http://localhost:3000/mcp \\
  --header "Authorization: Bearer bs_your_key"`;

const SELF_HOST = `git clone ${REPO}.git
cd broadside
npm install
npm run build
npm start        # http://localhost:3000`;

function SectionHead({ icon, title, children }: { icon: string; title: string; children: React.ReactNode }) {
  return (
    <div className="reveal mx-auto flex max-w-2xl flex-col items-center text-center">
      <span className="tile">
        <Icon name={icon} size={30} />
      </span>
      <h2 className="heading mt-8 text-[clamp(2.25rem,5vw,3.5rem)]">{title}</h2>
      <p className="mt-4 text-lg leading-relaxed text-ink-2">{children}</p>
    </div>
  );
}

export default function Home() {
  const networks = connectors.filter((c) => c.id !== "sandbox");
  const fan = ["x", "bluesky", "mastodon", "threads", "linkedin"].map((id) => {
    const c = connectors.find((x) => x.id === id)!;
    return { id: c.id, name: c.name, limits: c.limits };
  });
  const rules = networks.map((c) => ({ id: c.id, name: c.name, setup: c.setup, limits: c.limits, brings: BRINGS[c.id] ?? "Your own app keys" }));

  return (
    <>
      <header className="drop page flex h-16 items-center justify-between">
        <Link href="/" aria-label="Broadside home">
          <Wordmark />
        </Link>
        <nav className="flex items-center gap-1 text-sm" aria-label="Main">
          <a className="btn btn-ghost btn-sm max-sm:hidden" href="#networks">
            Networks
          </a>
          <a className="btn btn-ghost btn-sm max-sm:hidden" href="#agents">
            Agents
          </a>
          <a className="btn btn-ghost btn-sm max-sm:hidden" href="#self-host">
            Self-host
          </a>
          <Link className="btn btn-glass ml-2" href="/app">
            Open the app
          </Link>
        </nav>
      </header>

      <main id="content">
        <section className="relative overflow-hidden">
          <div className="ray" />
          <div className="page relative grid gap-6 pt-14 pb-24 lg:grid-cols-[minmax(0,6fr)_minmax(0,6fr)] lg:items-center lg:pt-20">
            <div>
              <a className="pill rise" href={REPO}>
                Open source under the MIT licence
                <Icon name="out" size={14} />
              </a>
              <h1 className="display rise mt-8 text-[clamp(3.25rem,7.4vw,6rem)]" style={{ "--i": 1 } as React.CSSProperties}>
                One post for every network
              </h1>
              <p className="rise mt-5 max-w-lg text-lg leading-relaxed text-ink-2" style={{ "--i": 2 } as React.CSSProperties}>
                Write a post once. Broadside sends it to X, Bluesky, Threads, Mastodon, LinkedIn and {networks.length - 5} more, from your browser or from your AI agent.
              </p>
              <div className="rise mt-8 flex flex-wrap gap-2" style={{ "--i": 3 } as React.CSSProperties}>
                <Link className="btn btn-glass btn-lg" href="/app">
                  Open the app
                </Link>
                <a className="btn btn-ghost btn-lg" href={REPO}>
                  Source on GitHub
                </a>
              </div>
            </div>
            <Ring cards={RING} text={RING_TEXT} />
          </div>
        </section>

        <section className="page pb-24" aria-label="Networks Broadside posts to">
          <p className="reveal text-center text-sm text-ink-3">Broadside posts to all of these</p>
          <ul className="reveal mx-auto mt-6 grid max-w-4xl grid-cols-3 gap-x-2 gap-y-1 sm:grid-cols-6">
            {networks.map((c) => (
              <li key={c.id} className="logo-cell">
                <NetworkLogo platform={c.id} size={24} />
                <span>{c.name}</span>
              </li>
            ))}
          </ul>
        </section>

        <section className="page py-24">
          <SectionHead icon="compose" title="Write it once">
            Pick your accounts, write the post and press publish. Each account reports back with its own status and a link to the live post.
          </SectionHead>
          <div className="glass reveal mt-14">
            <ComposeDemo />
          </div>
        </section>

        <section className="page py-24" id="check">
          <div className="reveal max-w-2xl">
            <h2 className="heading text-[clamp(2.25rem,5vw,3.5rem)]">It checks before it posts</h2>
            <p className="mt-4 text-lg leading-relaxed text-ink-2">
              Each network counts characters its own way and accepts different media. Broadside measures your post against every account first. If one copy is too long, nothing goes out until you give that account a shorter version.
            </p>
          </div>
          <div className="glass reveal mt-12 p-5 sm:p-8">
            <Fan networks={fan} />
          </div>
        </section>

        <section className="page grid gap-6 py-24 lg:grid-cols-2">
          <article className="glass reveal flex flex-col">
            <div className="flex-1">
              <ScheduleDemo />
            </div>
            <div className="p-6 pt-0 sm:p-8 sm:pt-0">
              <h2 className="title text-xl">Schedule it and close the tab</h2>
              <p className="mt-2 leading-relaxed text-ink-2">The scheduler runs inside Broadside. A post set for Thursday at nine goes out on Thursday at nine, with no other service to keep running.</p>
            </div>
          </article>
          <article className="glass reveal flex flex-col">
            <div className="flex-1">
              <RetryDemo />
            </div>
            <div className="p-6 pt-0 sm:p-8 sm:pt-0">
              <h2 className="title text-xl">One failure does not stop the rest</h2>
              <p className="mt-2 leading-relaxed text-ink-2">If Mastodon is down, your other accounts still publish. The failed one tells you why, and you can send it again on its own.</p>
            </div>
          </article>
        </section>

        <section className="page py-24" id="agents">
          <SectionHead icon="connect" title="Hand it to your agent">
            Broadside is an MCP server. Claude, Cursor and Codex can check a post, publish it and confirm each link. You enter passwords and tokens in Broadside, so they stay out of the chat.
          </SectionHead>
          <div className="mt-14 grid gap-6 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]">
            <div className="glass reveal">
              <AgentDemo />
            </div>
            <div className="reveal space-y-4">
              <p className="text-sm text-ink-3">Connect Claude Code with one command</p>
              <pre className="code">{MCP_SNIPPET}</pre>
              <p className="leading-relaxed text-ink-2">
                Any client that speaks Streamable HTTP works with the same address and key. A local stdio server is included too; it needs no key and can read media from your disk.
              </p>
              <Link className="btn btn-glass" href="/app/connect">
                Create a key
              </Link>
            </div>
          </div>
        </section>

        <section className="page py-24" id="networks">
          <div className="reveal max-w-2xl">
            <h2 className="heading text-[clamp(2.25rem,5vw,3.5rem)]">{networks.length} networks, your own keys</h2>
            <p className="mt-4 text-lg leading-relaxed text-ink-2">
              You connect each account with credentials you create yourself. Broadside encrypts them on your machine and sends them to that network only. Pick a network to see what it accepts.
            </p>
          </div>
          <div className="reveal mt-12">
            <NetworkRules networks={rules} />
          </div>
        </section>

        <section className="page grid gap-10 py-24 lg:grid-cols-2 lg:items-center" id="self-host">
          <div className="reveal">
            <h2 className="heading text-[clamp(2.25rem,5vw,3.5rem)]">Runs on one machine</h2>
            <p className="mt-4 max-w-lg text-lg leading-relaxed text-ink-2">
              Broadside is one Node process and one SQLite file. There is no queue and no database server to look after. Back up the data folder and you have backed up everything.
            </p>
          </div>
          <div className="reveal space-y-3">
            <pre className="code">{SELF_HOST}</pre>
            <p className="note">Needs Node 22.5 or newer. Set BROADSIDE_PASSWORD before you put it on a network other people can reach.</p>
          </div>
        </section>

        <section className="relative overflow-hidden py-32">
          <div className="ray" />
          <div className="page reveal relative flex flex-col items-center text-center">
            <span className="tile">
              <Mark size={36} />
            </span>
            <h2 className="display mt-10 text-[clamp(3rem,7vw,5.5rem)]">Free to use, free to change</h2>
            <p className="mt-5 max-w-xl text-lg leading-relaxed text-ink-2">The licence is MIT and there are no paid plans. Your posts go from your machine to the networks, with no server of ours in between.</p>
            <div className="mt-8 flex flex-wrap justify-center gap-2">
              <Link className="btn btn-glass btn-lg" href="/app">
                Open the app
              </Link>
              <a className="btn btn-ghost btn-lg" href={REPO}>
                Source on GitHub
              </a>
            </div>
          </div>
        </section>
      </main>

      <footer className="page pt-10 pb-12">
        <div className="flex flex-wrap items-center justify-between gap-4 text-sm text-ink-2">
          <span className="flex items-center gap-2">
            <Mark size={22} /> Broadside
          </span>
          <nav className="flex gap-5" aria-label="Footer">
            <Link className="link inline-block py-2" href="/app">
              App
            </Link>
            <Link className="link inline-block py-2" href="/app/connect">
              MCP and API
            </Link>
            <a className="link inline-block py-2" href={REPO}>
              GitHub
            </a>
          </nav>
        </div>
        <p className="note mt-6 max-w-2xl text-ink-3">Network names and logos belong to their owners. They appear here only to show which networks Broadside can post to.</p>
      </footer>
    </>
  );
}
