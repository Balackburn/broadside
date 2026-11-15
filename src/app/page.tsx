import type { Metadata } from "next";
import Link from "next/link";
import { Fan } from "@/components/fan";
import { Mark, Stamp, Wordmark } from "@/components/ui";
import { connectors } from "@/lib/platforms";

const number = new Intl.NumberFormat("en");

const how = (id: string): string =>
  ({
    bluesky: "App password",
    mastodon: "Access token",
    telegram: "Bot token",
    discord: "Webhook URL",
    slack: "Webhook URL",
    webhook: "Any URL",
    sandbox: "Nothing",
    nostr: "Your key",
    devto: "API key",
    lemmy: "Login",
    reddit: "Script app",
  })[id] ?? "Your own app keys";

const media = (images: number, videos: number, required: boolean): string => {
  const parts = [images ? `${images} image${images > 1 ? "s" : ""}` : "", videos ? "video" : ""].filter(Boolean);
  return parts.length ? `${parts.join(", ")}${required ? " (required)" : ""}` : "Text only";
};

const MCP_SNIPPET = `claude mcp add --transport http broadside \\
  http://localhost:3000/mcp \\
  --header "Authorization: Bearer bs_your_key"`;

const SELF_HOST = `npm install
npm run build
npm start        # http://localhost:3000`;

export const metadata: Metadata = { alternates: { canonical: "/" } };

export default function Home() {
  const networks = connectors.filter((c) => c.id !== "sandbox");
  const fan = ["x", "bluesky", "mastodon", "threads", "linkedin"].map((id) => {
    const c = connectors.find((x) => x.id === id)!;
    return { id: c.id, name: c.name, limits: c.limits };
  });

  return (
    <>
      <header className="page flex h-16 items-center justify-between">
        <Link href="/" aria-label="Broadside home">
          <Wordmark />
        </Link>
        <nav className="flex items-center gap-1 text-[15px]" aria-label="Main">
          <a className="btn btn-bare max-sm:hidden" href="#networks">
            Networks
          </a>
          <a className="btn btn-bare max-sm:hidden" href="#agents">
            Agents
          </a>
          <a className="btn btn-bare max-sm:hidden" href="#self-host">
            Self-host
          </a>
          <Link className="btn btn-sm ml-2" href="/app">
            Open the app
          </Link>
        </nav>
      </header>

      <main id="content">
        <section className="page pt-10 pb-24 lg:pt-14">
          <h1 className="display rise text-[clamp(3.25rem,9.4vw,8.5rem)]">One post. Every network.</h1>
          <div className="mt-8">
            <Fan networks={fan}>
              <p className="rise max-w-xl text-xl leading-snug text-ink-2" style={{ "--i": 1 } as React.CSSProperties}>
                Broadside is a free, open-source app that publishes one post to {networks.length} networks at once, from your browser or from your AI agent.
              </p>
              <div className="rise mt-6 flex flex-wrap gap-3" style={{ "--i": 2 } as React.CSSProperties}>
                <Link className="btn btn-signal btn-lg" href="/app">
                  Open the app
                </Link>
                <a className="btn btn-quiet btn-lg" href="#self-host">
                  Run it yourself
                </a>
              </div>
            </Fan>
          </div>
        </section>

        <section className="bg-ink py-24 text-paper" id="refuse">
          <div className="page grid gap-10 lg:grid-cols-2 lg:items-end">
            <h2 className="heading reveal text-[clamp(2.5rem,6vw,5rem)]">It refuses. It never trims.</h2>
            <div className="reveal max-w-xl space-y-4 text-lg leading-snug">
              <p>
                Some cross-posters cut your text at a network&rsquo;s limit and drop the media it won&rsquo;t take, without telling you. Broadside checks every account before anything is sent.
              </p>
              <p>
                If one copy would be mangled, nothing goes out, and you are told which network and by how many characters. Write that account its own version and send again.
              </p>
            </div>
          </div>
        </section>

        <section className="page py-24" id="networks">
          <div className="grid gap-10 lg:grid-cols-[minmax(0,4fr)_minmax(0,8fr)]">
            <div className="reveal lg:sticky lg:top-10 lg:self-start">
              <h2 className="heading text-[clamp(2.25rem,5vw,4rem)]">{networks.length} networks, your own keys.</h2>
              <p className="mt-5 max-w-sm text-lg leading-snug text-ink-2">
                You connect each account with credentials you create yourself. They are encrypted on your machine and go nowhere else. No middleman holds your accounts, so nobody can take them away or charge for them.
              </p>
            </div>
            <table className="reveal w-full text-left text-[15px]">
              <thead className="text-ink-3">
                <tr>
                  <th className="pb-3 font-medium">Network</th>
                  <th className="pb-3 text-right font-medium">Characters</th>
                  <th className="pb-3 pl-6 font-medium max-sm:hidden">Media</th>
                  <th className="pb-3 pl-6 font-medium">You bring</th>
                </tr>
              </thead>
              <tbody>
                {networks.map((c, i) => (
                  <tr key={c.id} className={i % 2 ? "" : "bg-paper-2"}>
                    <td className="rounded-l-md px-3 py-2.5">
                      <span className="flex items-center gap-3 font-medium">
                        <Stamp platform={c.id} />
                        {c.name}
                      </span>
                    </td>
                    <td className="num py-2.5 text-right">{number.format(c.limits.maxChars)}</td>
                    <td className="py-2.5 pl-6 text-ink-2 max-sm:hidden">{media(c.limits.maxImages, c.limits.maxVideos, c.limits.requiresMedia)}</td>
                    <td className="rounded-r-md py-2.5 pr-3 pl-6 text-ink-2">{how(c.id)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="bg-paper-2 py-24" id="agents">
          <div className="page grid gap-12 lg:grid-cols-2">
            <div className="reveal">
              <h2 className="heading text-[clamp(2.25rem,5vw,4rem)]">Your agent can post too.</h2>
              <p className="mt-5 max-w-lg text-lg leading-snug text-ink-2">
                Broadside is an MCP server. Connect Claude, Cursor, Codex or any MCP client, and it can check a post against every network, publish, schedule, and confirm what went out. Tokens and passwords never pass through the chat.
              </p>
              <ul className="mt-8 grid max-w-lg grid-cols-2 gap-x-6 gap-y-2 text-[15px]">
                {["list_accounts", "check_post", "create_post", "upload_media", "update_post", "publish_post", "cancel_post", "retry_target"].map((tool) => (
                  <li key={tool}>
                    <code className="font-mono text-[13.5px]">{tool}</code>
                  </li>
                ))}
              </ul>
            </div>
            <div className="reveal space-y-4">
              <pre className="code">{MCP_SNIPPET}</pre>
              <div className="sheet text-[15px] leading-snug">
                <p className="text-ink-3">You</p>
                <p className="mt-1">Announce the 2.0 release on everything, tomorrow at nine.</p>
                <p className="mt-4 text-ink-3">Agent</p>
                <p className="mt-1">
                  The announcement is 312 characters, so X and Bluesky each got a shorter version. Scheduled for 09:00 on six accounts. I&rsquo;ll confirm each link once it&rsquo;s out.
                </p>
              </div>
            </div>
          </div>
        </section>

        <section className="page py-24" id="self-host">
          <div className="grid gap-12 lg:grid-cols-2 lg:items-start">
            <div className="reveal">
              <h2 className="heading text-[clamp(2.25rem,5vw,4rem)]">One process. One file.</h2>
              <p className="mt-5 max-w-lg text-lg leading-snug text-ink-2">
                No queue, no database server, no second service. Broadside is a single Node process with one SQLite file beside it. The scheduler runs inside it, and a post interrupted mid-send is never sent twice.
              </p>
            </div>
            <div className="reveal space-y-4">
              <pre className="code">{SELF_HOST}</pre>
              <p className="note">Needs Node 22.5 or newer. Set BROADSIDE_PASSWORD before putting it on a network other people can reach.</p>
            </div>
          </div>
        </section>

        <section className="bg-signal py-24" style={{ color: "var(--on-signal)" }}>
          <div className="page grid gap-8 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] lg:items-end">
            <h2 className="display reveal text-[clamp(3rem,8vw,7rem)]">Free. Not free for now.</h2>
            <div className="reveal space-y-5 text-lg leading-snug">
              <p>MIT licensed. No plans, no seats, no post quota, no account with us, because there is no us in the loop. It runs on your machine with your keys.</p>
              <Link className="btn btn-lg" href="/app" style={{ background: "var(--on-signal)", color: "var(--signal-press)" }}>
                Open the app
              </Link>
            </div>
          </div>
        </section>
      </main>

      <footer className="page pt-16 pb-10">
        <div className="flex flex-wrap items-center justify-between gap-4 text-[15px] text-ink-2">
          <span className="flex items-center gap-2">
            <Mark size={24} /> Broadside, MIT licensed
          </span>
          <nav className="flex gap-5" aria-label="Footer">
            <Link className="link inline-block py-2" href="/app">
              App
            </Link>
            <Link className="link inline-block py-2" href="/app/connect">
              MCP and API
            </Link>
            <a className="link inline-block py-2" href="#networks">
              Networks
            </a>
          </nav>
        </div>
        <p className="display mt-10 select-none text-[clamp(4rem,21vw,19rem)] leading-[0.8]" aria-hidden="true">
          Broadside
        </p>
      </footer>
    </>
  );
}
