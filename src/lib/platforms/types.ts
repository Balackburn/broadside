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

/** A network that connects by sending you to its own approval page. */
export type OAuthSpec = { authorizeUrl: string; tokenUrl: string; scopes: string[] };

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
};

/** An error whose message is safe and useful to show next to a target. */
export class PublishError extends Error {
  constructor(
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "PublishError";
  }
}

/** Fetch JSON, turning any non-2xx into a PublishError that names the network's own message. */
export async function call<T>(
  ctx: Context,
  network: string,
  url: string,
  init: RequestInit = {},
): Promise<T> {
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
    throw new PublishError(
      `${network} answered ${response.status}: ${describe(body)}`,
      response.status === 429 || response.status >= 500,
    );
  }
  return body as T;
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
