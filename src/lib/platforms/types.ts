/**
 * A connector is everything Broadside knows about one network: which
 * credentials it needs, what a post may contain, and the HTTP calls that
 * publish it. Connectors never touch the database, so each one is testable
 * with a fake `fetch`.
 */

export type Credentials = Record<string, string>;

export type CredentialField = {
  key: string;
  label: string;
  kind: "text" | "secret" | "url";
  placeholder?: string;
  help?: string;
  optional?: boolean;
  /** Filled in by signing in with the network, so the connect form does not ask for it. */
  hidden?: boolean;
};

/** What a token endpoint answers. Networks add fields of their own; these are the ones Broadside reads. */
export type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  /** Seconds until the access token stops working. */
  expires_in?: number;
  [key: string]: unknown;
};

/** One thing the signed-in person can post to, when a sign-in ends in a choice (a Page, an Instagram account, a board). */
export type Choice = {
  id: string;
  name: string;
  detail?: string;
  /** Everything the account made from this choice stores. It stays on the server; the browser sees the id, name and detail. */
  credentials: Credentials;
};

/**
 * A network that connects by sending you to its own approval page, described
 * well enough that one flow serves them all. You always bring your own
 * developer app: its id and secret are two of the connector's fields.
 */
export type OAuthSpec = {
  authorizeUrl: string;
  tokenUrl: string;
  /** What Broadside asks permission for: enough to post, and to reply or comment where the network takes threads. */
  scopes: string[];
  /** How the scopes are joined in the authorize address. A space unless the network says otherwise. */
  scopeSeparator?: " " | ",";
  /** Scopes this one connection also needs, decided by what was typed into the form. */
  extraScopes?: (app: Credentials) => string[];
  /** Fixed parameters the network wants in the authorize address. */
  authorize?: Record<string, string>;
  /** Fixed parameters the network wants when the code is exchanged. */
  exchangeParams?: Record<string, string>;
  /** Which fields hold the app's id and secret, and what the network calls the id in its requests (client_id unless named). */
  client: { id: string; secret: string; param?: string; secretOptional?: boolean };
  /** S256 is RFC 7636. S256-hex is TikTok's variant, which sends the challenge as a hex digest. */
  pkce: "S256" | "S256-hex" | "none";
  /** Where the app's id and secret travel in token requests: the form body, or an HTTP Basic header. Never the address. */
  clientAuth: "body" | "basic";
  /** The one name the network accepts for a redirect to this machine. Without it, the name you browse by is used. */
  loopback?: "localhost" | "127.0.0.1";
  /** The network refuses a redirect address that is not https, so signing in needs BROADSIDE_PUBLIC_URL on https. */
  httpsOnly?: boolean;
  /**
   * Turns the answer to the code exchange into the credentials to store, making
   * any follow-up call the network needs (a short-lived token traded for a
   * long-lived one). Without it, the app's fields and the tokens are stored.
   */
  exchange?: (tokens: TokenResponse, app: Credentials, ctx: Context) => Promise<Credentials>;
  /** Present when signing in is followed by a choice. Each choice picked becomes its own account. */
  choose?: {
    prompt: string;
    multiple: boolean;
    /** What to say when the signed-in person has nothing to choose from. */
    empty: string;
    list: (credentials: Credentials, ctx: Context) => Promise<Choice[]>;
  };
  /** The fields POST /api/v1/accounts takes to connect this network with tokens made by hand, skipping the sign-in. */
  paste: { required: string[]; optional?: string[]; /** Where those tokens come from, in a sentence. */ help?: string };
};

export type MediaItem = {
  id: string;
  type: "image" | "video";
  contentType: string;
  filename: string;
  alt?: string;
  /** Raw bytes, for networks that accept an upload. */
  read: () => Promise<Uint8Array>;
  /** A URL the network can fetch, for networks that only pull media. */
  publicUrl?: string;
};

export type PublishInput = {
  text: string;
  media: MediaItem[];
  options: Record<string, unknown>;
};

export type PublishResult = {
  id: string;
  url?: string;
  /** Refreshed credentials to persist (rotated tokens). */
  credentials?: Credentials;
  /** Identifiers a later reply needs beyond the id, such as Bluesky's cid. Kept with the target. */
  ref?: Record<string, string>;
};

/** What a later part of a thread needs to know about a part already published. */
export type PartRef = { id: string; url?: string; ref?: Record<string, string> };

export type ReplyInput = {
  text: string;
  /** Which part this is, counting the main post as 0. The first reply is 1, and its parent is the root. */
  index: number;
  /** The main post the thread hangs from. */
  root: PartRef;
  /** The part published just before this one. */
  parent: PartRef;
  options: Record<string, unknown>;
};

export type Profile = {
  handle: string;
  avatarUrl?: string;
  /** Extra values resolved at connect time and stored with the credentials. */
  credentials?: Credentials;
};

export type Context = { fetch: typeof fetch };

/**
 * The kinds of count a network may report for a post. Numbers from two
 * networks are only ever added together when they are the same kind, so views
 * and impressions are two kinds, and a score (upvotes less downvotes) is not a
 * count of likes.
 */
export const METRIC_KINDS = ["views", "impressions", "likes", "comments", "shares", "quotes", "saves", "clicks", "score"] as const;
export type MetricKind = (typeof METRIC_KINDS)[number];

/** The plain name of each kind, used where numbers from several networks stand together. */
export const KIND_LABEL: Record<MetricKind, string> = {
  views: "Views",
  impressions: "Impressions",
  likes: "Likes",
  comments: "Comments",
  shares: "Shares",
  quotes: "Quotes",
  saves: "Saves",
  clicks: "Clicks",
  score: "Score",
};

/** One count as a network reported it, under the word that network uses for it. */
export type Metric = { kind: MetricKind; label: string; value: number };

/** What a network calls each kind of count it reports. A kind left out is one the network does not report. */
export type Reports = Partial<Record<MetricKind, string>>;

/** A published post to read the counts of: what `publish` returned for it, and when it went out. */
export type MetricsInput = { id: string; url?: string; ref?: Record<string, string>; publishedAt?: string };

export type MetricsResult = {
  metrics: Metric[];
  /** Something the reader should know about these numbers, such as counts the network would not give this time. */
  note?: string;
  /** Refreshed credentials to persist (rotated tokens). */
  credentials?: Credentials;
};

/**
 * Turns a network's answer into metrics: one for each kind the connector
 * reports whose value came back as a number. A count the network left out is
 * left out here too, never shown as zero.
 */
export function counted(reports: Reports, values: Partial<Record<MetricKind, unknown>>): Metric[] {
  const metrics: Metric[] = [];
  for (const kind of METRIC_KINDS) {
    const label = reports[kind];
    const raw = values[kind];
    // YouTube sends its counts as strings of digits.
    const value = typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : raw;
    if (label && typeof value === "number" && Number.isFinite(value)) metrics.push({ kind, label, value });
  }
  return metrics;
}

export type Limits = {
  maxChars: number;
  /** How characters are counted: grapheme clusters, or X's weighted rule. */
  count: "graphemes" | "weighted";
  maxImages: number;
  maxVideos: number;
  requiresMedia: boolean;
  /** Media must be reachable at a public URL (the network pulls it). */
  pullsMedia?: boolean;
  /** The limit for a reply or comment, where the network sets one apart from the post's. */
  maxReplyChars?: number;
};

export type OptionSpec = {
  key: string;
  label: string;
  kind: "text" | "select" | "boolean";
  choices?: string[];
  help?: string;
};

export type Connector = {
  id: string;
  name: string;
  /** How a self-hoster gets credentials, in plain steps. */
  setup: string[];
  docsUrl: string;
  fields: CredentialField[];
  options?: OptionSpec[];
  oauth?: OAuthSpec;
  limits: Limits;
  verify: (credentials: Credentials, ctx: Context) => Promise<Profile>;
  publish: (input: PublishInput, credentials: Credentials, ctx: Context) => Promise<PublishResult>;
  /**
   * Publishes one later part of a thread under a post this connector published.
   * Networks with reply chains answer `parent`; networks with comments add one
   * to `root`. A connector without it is refused a post that carries a thread.
   */
  reply?: (input: ReplyInput, credentials: Credentials, ctx: Context) => Promise<PublishResult>;
  /** Why this network cannot take a thread, in its own words, when it has no `reply`. */
  noThread?: string;
  /**
   * Reads the counts the network holds for one post this connector published:
   * the main post of a target, by the id `publish` returned. It returns only
   * what the network answered. A connector without it has no numbers, and
   * says why in `noMetrics`.
   */
  metrics?: (input: MetricsInput, credentials: Credentials, ctx: Context) => Promise<MetricsResult>;
  /** The counts `metrics` reads, each under the network's own word for it. */
  reports?: Reports;
  /** Why this network has no numbers to read, in a sentence, when it has no `metrics`. */
  noMetrics?: string;
};

/** An error whose message is safe and useful to show next to a target. */
export class PublishError extends Error {
  /** Tokens the network rotated before the failure. They must still be saved: the ones they replaced no longer work. */
  credentials?: Credentials;
  /** True when only signing in again will fix it, so the account is marked as needing attention. */
  reconnect = false;
  /** The HTTP status the network answered with, when it answered. */
  status?: number;
  /** How many seconds the network asked callers to wait, when it answered 429 and said. */
  retryAfter?: number;
  constructor(
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "PublishError";
  }
}

/**
 * How long a rate-limited response asks callers to wait, in seconds. Networks
 * say it differently: Retry-After in seconds or as a date, or a reset header
 * holding seconds from now, a Unix time, or a timestamp.
 */
export function waitAsked(headers: Headers, now = Date.now()): number | undefined {
  for (const name of ["retry-after", "x-rate-limit-reset", "ratelimit-reset", "x-ratelimit-reset"]) {
    const raw = headers.get(name)?.trim();
    if (!raw) continue;
    const number = Number(raw);
    // A number this large is a Unix time in seconds, not a count of seconds.
    const seconds = Number.isFinite(number) ? (number > 1e9 ? number - now / 1000 : number) : (Date.parse(raw) - now) / 1000;
    if (Number.isFinite(seconds)) return Math.max(0, Math.ceil(seconds));
  }
  return undefined;
}

/** One request, turning any non-2xx into a PublishError that names the network's own message. Returns the body as text and as JSON. */
async function request(ctx: Context, network: string, url: string, init: RequestInit): Promise<{ raw: string; body: unknown }> {
  let response: Response;
  try {
    response = await ctx.fetch(url, init);
  } catch (cause) {
    throw new PublishError(`${network} could not be reached: ${(cause as Error).message}`, true);
  }
  const raw = await response.text();
  let body: unknown = raw;
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    /* keep the text body */
  }
  if (!response.ok) {
    const error = new PublishError(`${network} answered ${response.status}: ${describe(body)}`, response.status === 429 || response.status >= 500);
    error.status = response.status;
    if (response.status === 429) error.retryAfter = waitAsked(response.headers);
    throw error;
  }
  return { raw, body };
}

/** Fetch JSON, turning any non-2xx into a PublishError that names the network's own message. */
export async function call<T>(ctx: Context, network: string, url: string, init: RequestInit = {}): Promise<T> {
  return (await request(ctx, network, url, init)).body as T;
}

/** The same request, returning the body as it was sent. For answers holding ids too long for a JavaScript number. */
export async function callText(ctx: Context, network: string, url: string, init: RequestInit = {}): Promise<string> {
  return (await request(ctx, network, url, init)).raw;
}

/**
 * Rethrows a network's refusal with what to do about it, when a missing
 * permission would explain it. The network's own words stay first.
 */
export function withHint(error: unknown, hint: string): never {
  if (error instanceof PublishError && (error.status === 400 || error.status === 401 || error.status === 403)) {
    const told = new PublishError(`${error.message} ${hint}`, error.retryable);
    told.status = error.status;
    told.credentials = error.credentials;
    throw told;
  }
  throw error;
}

function describe(body: unknown): string {
  if (typeof body === "string") return body.slice(0, 300) || "no details";
  const o = body as Record<string, unknown>;
  const nested = o.error && typeof o.error === "object" ? (o.error as Record<string, unknown>) : undefined;
  const text =
    nested?.message ?? o.message ?? o.error_description ?? o.description ?? o.detail ?? o.error ?? o.title;
  return typeof text === "string" ? text.slice(0, 300) : JSON.stringify(body).slice(0, 300);
}

export const json = (body: unknown, headers: Record<string, string> = {}): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify(body),
});

export const images = (input: PublishInput): MediaItem[] => input.media.filter((m) => m.type === "image");
export const videos = (input: PublishInput): MediaItem[] => input.media.filter((m) => m.type === "video");

export function blob(bytes: Uint8Array, contentType: string): Blob {
  return new Blob([bytes as BlobPart], { type: contentType });
}
