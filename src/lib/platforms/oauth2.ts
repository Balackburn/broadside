import { PublishError, type Context, type Credentials, type OAuthSpec, type TokenResponse } from "./types";

/**
 * The token half of OAuth 2.0, shared by the sign-in flow and by connectors
 * that refresh before they post. Like the connectors, nothing here touches
 * the database: tokens go in, tokens come out, and the caller stores them.
 */

/** The network's own words for why a token request failed, whichever of the usual shapes it used. */
export function reason(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const o = body as Record<string, unknown>;
  const nested = o.error && typeof o.error === "object" ? (o.error as Record<string, unknown>) : undefined;
  const text = o.error_description ?? nested?.message ?? o.error_message ?? o.message ?? o.error;
  // The closing full stop is dropped because the reason is quoted inside a sentence of Broadside's own.
  return typeof text === "string" && text ? text.slice(0, 300).replace(/\.$/, "") : undefined;
}

/**
 * One POST to a token endpoint. The app's id and secret go in the form body or
 * in a Basic header, as the network asks, and never in the address. An app
 * with no secret (a public client) names itself in the body instead.
 */
export async function tokenRequest(ctx: Context, name: string, spec: OAuthSpec, app: Credentials, params: Record<string, string>): Promise<{ status: number; tokens: TokenResponse }> {
  const id = app[spec.client.id];
  const secret = app[spec.client.secret];
  const body = new URLSearchParams();
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
  if (spec.clientAuth === "basic" && secret) headers.authorization = `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`;
  else {
    body.set(spec.client.param ?? "client_id", id);
    if (secret) body.set("client_secret", secret);
  }
  for (const [key, value] of Object.entries(params)) body.set(key, value);
  let response: Response;
  try {
    response = await ctx.fetch(spec.tokenUrl, { method: "POST", headers, body });
  } catch (cause) {
    throw new PublishError(`${name} could not be reached: ${(cause as Error).message}`, true);
  }
  return { status: response.status, tokens: (await response.json().catch(() => ({}))) as TokenResponse };
}

/** The tokens to keep from a token response, with the expiry as a moment instead of a count of seconds. */
export function tokenFields(tokens: TokenResponse, now = Date.now()): Credentials {
  const kept: Credentials = {};
  if (tokens.access_token) kept.access_token = tokens.access_token;
  if (tokens.refresh_token) kept.refresh_token = tokens.refresh_token;
  if (typeof tokens.expires_in === "number" && tokens.expires_in > 0) kept.expires_at = new Date(now + tokens.expires_in * 1000).toISOString();
  return kept;
}

/** Refresh this long before the token runs out, so a slow upload does not outlive it. */
const EARLY_MS = 5 * 60_000;

/** True when there is no access token, or the one there is has run out or is about to. A pasted token with no known expiry is used as it is. */
export function stale(c: Credentials, now = Date.now()): boolean {
  if (!c.access_token) return true;
  return c.expires_at ? Date.parse(c.expires_at) - now < EARLY_MS : false;
}

/**
 * Refreshes that are under way or just finished, by the refresh token they
 * spent. X's refresh tokens work once, and two posts for one account can go
 * out together, each holding the same stored token. The second finds the
 * first's answer here instead of spending a token that is already used up.
 *
 * The map is kept on globalThis, as the database handle is: the built server
 * holds this module more than once (the scheduler is its own bundle, apart
 * from the API routes), and a renewal the scheduler starts while reading a
 * post's numbers must be found by a post going out through a route.
 */
type Renewals = Map<string, { at: number; tokens: Promise<Credentials> }>;
const recent: Renewals = ((globalThis as typeof globalThis & { __broadsideRenewals?: Renewals }).__broadsideRenewals ??= new Map());
const REMEMBER_MS = 10 * 60_000;

/** Trades the refresh token for a new access token, and for a new refresh token where the network rotates them. */
export async function refresh(name: string, spec: OAuthSpec, c: Credentials, ctx: Context): Promise<Credentials> {
  const expired = new PublishError(`The ${name} sign-in has run out and cannot be renewed. Reconnect the account.`);
  expired.reconnect = true;
  if (!c.refresh_token || !c[spec.client.id]) throw expired;
  const now = Date.now();
  for (const [key, entry] of recent) if (now - entry.at > REMEMBER_MS) recent.delete(key);
  const key = `${spec.tokenUrl} ${c.refresh_token}`;
  let entry = recent.get(key);
  if (!entry) {
    const tokens = (async () => {
      const { status, tokens: fresh } = await tokenRequest(ctx, name, spec, c, { grant_type: "refresh_token", refresh_token: c.refresh_token });
      if (!fresh.access_token) {
        const refused = new PublishError(`${name} would not renew the sign-in: ${reason(fresh) ?? `it answered ${status}`}. Reconnect the account.`, status === 429 || status >= 500);
        refused.reconnect = !refused.retryable;
        throw refused;
      }
      return tokenFields(fresh);
    })();
    entry = { at: now, tokens };
    recent.set(key, entry);
    tokens.catch(() => recent.delete(key));
  }
  return { ...c, ...(await entry.tokens) };
}

/**
 * Runs one call to the network with a working access token, refreshing first
 * when the stored one has run out. Renewed tokens ride back on the result, or
 * on the error if the call then fails, so the caller saves them either way.
 */
export async function withSession<T extends object>(name: string, spec: OAuthSpec, c: Credentials, ctx: Context, run: (session: Credentials) => Promise<T>): Promise<T> {
  const renewed = stale(c);
  const session = renewed ? await refresh(name, spec, c, ctx) : c;
  try {
    const result = await run(session);
    return renewed ? { ...result, credentials: { ...session, ...(result as { credentials?: Credentials }).credentials } } : result;
  } catch (error) {
    if (renewed && error instanceof PublishError) error.credentials = session;
    throw error;
  }
}
