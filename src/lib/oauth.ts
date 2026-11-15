import { createHash, randomBytes } from "node:crypto";
import { InputError, saveVerified, type Account } from "./accounts";
import { open, seal } from "./crypto";
import { get, now, run } from "./db";
import { guardedFetch } from "./net";
import { connector } from "./platforms";
import { reason, tokenFields, tokenRequest } from "./platforms/oauth2";
import { PublishError, type Choice, type Connector, type Context, type Credentials, type OAuthSpec } from "./platforms/types";
import { redirectAddress } from "./redirect";
import { isRole, lower, type Role } from "./roles";

/**
 * Sign-in with a network, for connectors that describe one. You bring your own
 * developer app (its id and secret); Broadside sends you to the network to
 * approve, and stores the tokens that come back. Nothing here leaves this
 * machine except the requests to the network itself.
 *
 * Each connector says how its network does it (see OAuthSpec): the address to
 * approve at, the scopes, the style of PKCE, how the code is exchanged and
 * what is stored. This file is the part they share.
 *
 * A pending sign-in is one sealed row: single use, gone after ten minutes. The
 * state value in the callback is what proves the callback belongs to a sign-in
 * this Broadside started. A sign-in that ends in a choice (which Page, which
 * board) leaves a second row of the same kind, holding what may be chosen.
 */
type SignIn = { kind: "sign-in"; app: Credentials; verifier?: string; redirectUri: string; base: string; starter?: Starter | null };
/** The team member who began a sign-in, and the role they began it with. Null when there was no team, or the key that began it belongs to no one. */
export type Starter = { member_id: string; role: Role };
type Choosing = { kind: "choice"; choices: Choice[] };

const TEN_MINUTES = 10 * 60_000;
const UNRESERVED = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";

function verifier(): string {
  // Rejection sampling keeps every character equally likely.
  let out = "";
  while (out.length < 64) {
    for (const byte of randomBytes(64)) if (byte < 198 && out.length < 64) out += UNRESERVED[byte % UNRESERVED.length];
  }
  return out;
}

const challenge = (pkce: OAuthSpec["pkce"], value: string): string => createHash("sha256").update(value).digest(pkce === "S256-hex" ? "hex" : "base64url");

function hold(platform: string, payload: SignIn | Choosing): string {
  run("DELETE FROM oauth_pending WHERE expires_at < ?", now());
  const id = randomBytes(24).toString("base64url");
  run("INSERT INTO oauth_pending (state, platform, payload, expires_at) VALUES (?, ?, ?, ?)", id, platform, seal(payload), new Date(Date.now() + TEN_MINUTES).toISOString());
  return id;
}

/** Reads a pending row, and deletes it first when it is being used, so it works once however the rest goes. */
function pending<T extends SignIn | Choosing>(id: string, kind: T["kind"], platform?: string, use = true): T | "missing" | "expired" {
  const row = get<{ platform: string; payload: string; expires_at: string }>("SELECT platform, payload, expires_at FROM oauth_pending WHERE state = ?", id);
  if (!row || (platform && row.platform !== platform)) return "missing";
  const payload = open<SignIn | Choosing>(row.payload);
  // A sign-in's state cannot stand in for a choice, nor a choice for a state.
  if (payload.kind !== kind) return "missing";
  if (use) run("DELETE FROM oauth_pending WHERE state = ?", id);
  return row.expires_at < now() ? "expired" : (payload as T);
}

export const redirectUri = (base: string, platform: string): string => redirectAddress(base, platform, connector(platform)?.oauth?.loopback);

export function startOAuth(platform: string, input: Credentials, base: string, starter: Starter | null = null): { url: string; redirect_uri: string } {
  const c = connector(platform);
  const spec = c?.oauth;
  if (!c || !spec) throw new InputError(`${c?.name ?? platform} is connected by pasting credentials, not by signing in.`);
  const app: Credentials = {};
  for (const field of c.fields.filter((f) => !f.hidden)) {
    const value = (input[field.key] ?? "").trim();
    const required = field.key === spec.client.id || (field.key === spec.client.secret ? !spec.client.secretOptional : !field.optional);
    if (!value && required) throw new InputError(`${field.label} is required to connect ${c.name}.`);
    if (value) app[field.key] = value;
  }
  const redirect = redirectUri(base, platform);
  if (spec.httpsOnly && !redirect.startsWith("https://")) {
    throw new InputError(`${c.name} only accepts an https redirect address, and this Broadside is at ${new URL(redirect).origin}. Set BROADSIDE_PUBLIC_URL to an https address to sign in, or connect by pasting a token.`);
  }
  const signIn: SignIn = { kind: "sign-in", app, redirectUri: redirect, base: base.replace(/\/+$/, ""), starter };
  if (spec.pkce !== "none") signIn.verifier = verifier();
  const state = hold(platform, signIn);

  const separator = spec.scopeSeparator ?? " ";
  // A scopes field in the form replaces the list, for an app that was granted fewer.
  const scopes = app.scopes ? app.scopes.split(/[\s,]+/).filter(Boolean) : [...spec.scopes, ...(spec.extraScopes?.(app) ?? [])];
  const url = new URL(spec.authorizeUrl);
  url.searchParams.set(spec.client.param ?? "client_id", app[spec.client.id]);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", scopes.join(separator));
  url.searchParams.set("redirect_uri", redirect);
  url.searchParams.set("state", state);
  if (signIn.verifier) {
    url.searchParams.set("code_challenge", challenge(spec.pkce, signIn.verifier));
    url.searchParams.set("code_challenge_method", "S256");
  }
  for (const [key, value] of Object.entries(spec.authorize ?? {})) url.searchParams.set(key, value);
  return { url: url.toString(), redirect_uri: redirect };
}

/**
 * Who a callback speaks for. The browser comes back from the network without
 * a session to show (another site sent it, and sometimes to another name for
 * this machine), so the state value stands for whoever began the sign-in.
 * Their role is read again here: a member demoted or disabled in the ten
 * minutes a sign-in may take does not finish it as an admin.
 *
 * Undefined when the state is not a sign-in waiting here. Null when it is,
 * and the one who began it may no longer act at all.
 */
export function oauthStarter(state: string): { role: Role; member: { id: string; name: string } | null; via: "session"; team: boolean } | null | undefined {
  if (!state) return undefined;
  const signIn = pending<SignIn>(state, "sign-in", undefined, false);
  if (typeof signIn === "string") return undefined;
  const team = Boolean(get("SELECT 1 AS team FROM members LIMIT 1"));
  if (!team) return { role: "owner", member: null, via: "session", team };
  if (!signIn.starter) return null;
  const member = get<{ id: string; name: string; role: string; disabled_at: string | null }>("SELECT id, name, role, disabled_at FROM members WHERE id = ?", signIn.starter.member_id);
  if (!member || member.disabled_at || !isRole(member.role)) return null;
  return { role: lower(signIn.starter.role, member.role), member: { id: member.id, name: member.name }, via: "session", team };
}

/** Network errors met while signing in are shown as they are; they were written to be read. */
async function asInput<T>(c: Connector, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof InputError) throw error;
    if (error instanceof PublishError) throw new InputError(error.message);
    throw new InputError(`${c.name} could not be reached to finish signing in: ${(error as Error).message}`);
  }
}

export type SignedIn = {
  /** The account that was connected, when the sign-in needed no choice. */
  account?: Account;
  /** The id of the choice waiting in the Accounts dialog, when it did. */
  choice?: string;
  /** Where this sign-in was started from, which is where the browser goes back to. */
  base: string;
};

export async function finishOAuth(platform: string, state: string, code: string, fetcher: typeof fetch = fetch): Promise<SignedIn> {
  const c = connector(platform);
  const spec = c?.oauth;
  if (!c || !spec) throw new InputError("That network does not sign in this way.");
  const signIn = pending<SignIn>(state, "sign-in", platform);
  if (signIn === "missing") throw new InputError("This sign-in was not started here, or it was already used. Start again from Accounts.");
  if (signIn === "expired") throw new InputError("This sign-in took longer than ten minutes. Start again from Accounts.");
  const ctx: Context = { fetch: guardedFetch(fetcher) };

  const credentials = await asInput(c, async () => {
    const params: Record<string, string> = { ...spec.exchangeParams, code, grant_type: "authorization_code", redirect_uri: signIn.redirectUri };
    if (signIn.verifier) params.code_verifier = signIn.verifier;
    const { status, tokens } = await tokenRequest(ctx, c.name, spec, signIn.app, params);
    if (!tokens.access_token) throw new InputError(`${c.name} did not complete the sign-in: ${reason(tokens) ?? `it answered ${status}`}.`);
    return spec.exchange ? spec.exchange(tokens, signIn.app, ctx) : { ...signIn.app, ...tokenFields(tokens) };
  });

  if (spec.choose) {
    const choose = spec.choose;
    const choices = await asInput(c, () => choose.list(credentials, ctx));
    if (!choices.length) throw new InputError(choose.empty);
    return { choice: hold(platform, { kind: "choice", choices }), base: signIn.base };
  }
  return { account: await saveVerified(c, credentials, fetcher), base: signIn.base };
}

export type PendingChoice = { id: string; platform: string; name: string; prompt: string; multiple: boolean; choices: { id: string; name: string; detail?: string }[] };

/** What the Accounts dialog shows after a sign-in that ends in a choice. The tokens behind each choice stay here. */
export function pendingChoice(id: string): PendingChoice | undefined {
  const row = get<{ platform: string }>("SELECT platform FROM oauth_pending WHERE state = ?", id);
  const c = row && connector(row.platform);
  const choosing = pending<Choosing>(id, "choice", undefined, false);
  if (!c?.oauth?.choose || typeof choosing === "string") return undefined;
  return {
    id,
    platform: c.id,
    name: c.name,
    prompt: c.oauth.choose.prompt,
    multiple: c.oauth.choose.multiple,
    choices: choosing.choices.map(({ id: choice, name, detail }) => ({ id: choice, name, detail })),
  };
}

/** Connects what was picked, each as its own account. The choice is used up whether or not every account connects. */
export async function choose(id: string, picked: string[], fetcher: typeof fetch = fetch): Promise<{ connected: Account[]; failed: { name: string; error: string }[] }> {
  const waiting = pendingChoice(id);
  const c = waiting && connector(waiting.platform);
  if (!waiting || !c) throw new InputError("That choice has run out or was already made. Sign in again from Accounts.");
  const wanted = [...new Set(picked)];
  if (!wanted.length) throw new InputError("Pick at least one.");
  if (wanted.length > 1 && !waiting.multiple) throw new InputError(`${c.name} connects one at a time. Pick one.`);
  const unknown = wanted.find((choice) => !waiting.choices.some((offered) => offered.id === choice));
  if (unknown) throw new InputError("That was not one of the choices offered.");
  const choosing = pending<Choosing>(id, "choice");
  if (typeof choosing === "string") throw new InputError("That choice has run out or was already made. Sign in again from Accounts.");

  const connected: Account[] = [];
  const failed: { name: string; error: string }[] = [];
  for (const choice of choosing.choices.filter((offered) => wanted.includes(offered.id))) {
    try {
      connected.push(await saveVerified(c, choice.credentials, fetcher));
    } catch (error) {
      if (!(error instanceof InputError)) throw error;
      failed.push({ name: choice.name, error: error.message });
    }
  }
  if (!connected.length) throw new InputError(failed.map((f) => `${f.name}: ${f.error}`).join(" "));
  return { connected, failed };
}
