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

export { measure, problems, type MediaShape } from "./measure";

/** What the UI and agents need to know about a network, without its code. */
export function describe(c: Connector) {
  return { id: c.id, name: c.name, docs_url: c.docsUrl, setup: c.setup, fields: c.fields, options: c.options ?? [], limits: c.limits };
}

export type { Connector } from "./types";
