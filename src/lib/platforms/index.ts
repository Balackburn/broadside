import { bluesky } from "./bluesky";
import { discord, sandbox, slack, telegram, webhook } from "./chat";
import { linkedin } from "./linkedin";
import { mastodon } from "./mastodon";
import { facebook, instagram, threads } from "./meta";
import { devto, lemmy, nostr, pinterest, reddit, tiktok, youtube } from "./more";
import type { Connector } from "./types";
import { x } from "./x";

/** Every network Broadside can post to, in the order the UI lists them. */
export const connectors: Connector[] = [
  x,
  bluesky,
  threads,
  mastodon,
  linkedin,
  instagram,
  facebook,
  tiktok,
  youtube,
  pinterest,
  reddit,
  telegram,
  discord,
  slack,
  nostr,
  lemmy,
  devto,
  webhook,
  sandbox,
];

export const connector = (id: string): Connector | undefined => connectors.find((c) => c.id === id);

export { measure, problems, threadProblems, type MediaShape } from "./measure";

/** What the length and thread rules need to know about a network. */
export const fits = (c: Connector) => ({ name: c.name, limits: c.limits, threads: Boolean(c.reply), noThread: c.noThread });

/** What the UI and agents need to know about a network, without its code. */
export function describe(c: Connector) {
  return {
    id: c.id,
    name: c.name,
    docs_url: c.docsUrl,
    setup: c.setup,
    fields: c.fields.filter((f) => !f.hidden),
    options: c.options ?? [],
    limits: c.limits,
    // True when a post to this network may carry a thread (extra parts published as replies or comments).
    threads: Boolean(c.reply),
    // Present when the network connects by signing in; the callback path is what you register with the network.
    oauth: c.oauth ? { callback_path: `/oauth/${c.id}/callback`, scopes: c.oauth.scopes } : null,
  };
}

export type { Connector } from "./types";
