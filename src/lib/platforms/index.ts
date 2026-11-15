import { bluesky } from "./bluesky";
import { ghost, listmonk, wordpress } from "./blogs";
import { discord, sandbox, slack, telegram, webhook } from "./chat";
import { linkedin } from "./linkedin";
import { mastodon } from "./mastodon";
import { facebook, instagram, threads } from "./meta";
import { devto, lemmy, nostr, pinterest, reddit, tiktok, youtube } from "./more";
import { kick, twitch } from "./streams";
import { tumblr } from "./tumblr";
import { METRIC_KINDS, type Connector } from "./types";
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
  tumblr,
  reddit,
  telegram,
  discord,
  slack,
  twitch,
  kick,
  nostr,
  lemmy,
  devto,
  wordpress,
  ghost,
  listmonk,
  webhook,
  sandbox,
];

export const connector = (id: string): Connector | undefined => connectors.find((c) => c.id === id);

export { measure, problems, threadProblems, type MediaShape } from "./measure";

/** What the length and thread rules need to know about a network. */
export const fits = (c: Connector) => ({ name: c.name, limits: c.limits, threads: Boolean(c.reply), noThread: c.noThread });

/** Why a network has no numbers to read. Every connector without `metrics` gives its own reason; this is the fallback. */
export const noMetrics = (c: Connector): string => c.noMetrics ?? `${c.name} reports no numbers for a post.`;

/** The counts a network reports, in a fixed order, each under the network's own word for it. */
export const reported = (c: Connector) => (c.metrics ? METRIC_KINDS.flatMap((kind) => (c.reports?.[kind] ? [{ kind, label: c.reports[kind]! }] : [])) : []);

/** What the UI and agents need to know about a network, without its code. */
export function describe(c: Connector) {
  const spec = c.oauth;
  const named = (key: string, optional: boolean) => {
    const field = c.fields.find((f) => f.key === key)!;
    return { key, label: field.label, kind: field.kind, placeholder: field.placeholder, help: field.help, optional };
  };
  return {
    id: c.id,
    name: c.name,
    docs_url: c.docsUrl,
    setup: c.setup,
    // What the connect form asks for. Where the network signs in, that is the app's own id and secret, which are then required.
    fields: c.fields
      .filter((f) => !f.hidden)
      .map((f) => (spec && (f.key === spec.client.id || f.key === spec.client.secret) ? { ...f, optional: f.key === spec.client.secret && Boolean(spec.client.secretOptional) } : f)),
    options: c.options ?? [],
    limits: c.limits,
    // True when a post to this network may carry a thread (extra parts published as replies or comments).
    threads: Boolean(c.reply),
    // Whether Broadside can read a published post's numbers from this network, which counts it reports, or why it has none.
    metrics: c.metrics ? { available: true, reports: reported(c), reason: null } : { available: false, reports: [], reason: noMetrics(c) },
    // Present when the network connects by signing in.
    oauth: spec
      ? {
          // What you register with the network, after this Broadside's own address.
          callback_path: `/oauth/${c.id}/callback`,
          scopes: spec.scopes,
          // The one name the network accepts for a redirect to this machine, when it is particular.
          loopback: spec.loopback ?? null,
          https_only: Boolean(spec.httpsOnly),
          // The credentials POST /api/v1/accounts takes instead, for tokens made by hand.
          paste: [...spec.paste.required.map((key) => named(key, false)), ...(spec.paste.optional ?? []).map((key) => named(key, true))],
          paste_help: spec.paste.help ?? null,
        }
      : null,
  };
}

export type { Connector } from "./types";
