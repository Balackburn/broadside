import { createHash, randomBytes } from "node:crypto";
import { connectAccount, InputError, type Account } from "./accounts";
import { open, seal } from "./crypto";
import { get, now, run } from "./db";
import { guardedFetch } from "./net";
import { connector } from "./platforms";
import type { Credentials } from "./platforms/types";

/**
 * Sign-in with a network, for connectors that support it. You bring your own
 * developer app (its key and secret); Broadside sends you to the network to
 * approve, and stores the tokens that come back. Nothing here leaves this
 * machine except the requests to the network itself.
 *
 * A pending sign-in is one row: single use, gone after ten minutes. The state
 * value in the callback is what proves the callback belongs to a sign-in this
 * Broadside started.
 */
type Pending = { credentials: Credentials; verifier: string; redirectUri: string };

const UNRESERVED = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";

function verifier(): string {
  // Rejection sampling keeps every character equally likely.
  let out = "";
  while (out.length < 64) {
    for (const byte of randomBytes(64)) if (byte < 198 && out.length < 64) out += UNRESERVED[byte % UNRESERVED.length];
  }
  return out;
}

export const redirectUri = (base: string, platform: string): string => `${base.replace(/\/+$/, "")}/oauth/${platform}/callback`;

export function startOAuth(platform: string, input: Credentials, base: string): { url: string; redirect_uri: string } {
  const c = connector(platform);
  if (!c?.oauth) throw new InputError(`${c?.name ?? platform} is connected by pasting credentials, not by signing in.`);
  const credentials: Credentials = {};
  for (const field of c.fields.filter((f) => !f.hidden)) {
    const value = (input[field.key] ?? "").trim();
    if (!value && !field.optional) throw new InputError(`${field.label} is required to connect ${c.name}.`);
    if (value) credentials[field.key] = value;
  }
  run("DELETE FROM oauth_pending WHERE expires_at < ?", now());
  const state = randomBytes(24).toString("base64url");
  const pending: Pending = { credentials, verifier: verifier(), redirectUri: redirectUri(base, platform) };
  run("INSERT INTO oauth_pending (state, platform, payload, expires_at) VALUES (?, ?, ?, ?)", state, platform, seal(pending), new Date(Date.now() + 10 * 60_000).toISOString());

  const scopes = (credentials.scopes || c.oauth.scopes.join(",")).replace(/\s+/g, "");
  const url = new URL(c.oauth.authorizeUrl);
  url.searchParams.set("client_key", credentials.client_key);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", scopes);
  url.searchParams.set("redirect_uri", pending.redirectUri);
  url.searchParams.set("state", state);
  // TikTok wants the challenge as the hex SHA-256 of the verifier, not the usual base64url.
  url.searchParams.set("code_challenge", createHash("sha256").update(pending.verifier).digest("hex"));
  url.searchParams.set("code_challenge_method", "S256");
  return { url: url.toString(), redirect_uri: pending.redirectUri };
}

export async function finishOAuth(platform: string, state: string, code: string, fetcher: typeof fetch = fetch): Promise<Account> {
  const c = connector(platform);
  if (!c?.oauth) throw new InputError("That network does not sign in this way.");
  const row = get<{ payload: string; expires_at: string }>("SELECT payload, expires_at FROM oauth_pending WHERE state = ? AND platform = ?", state, platform);
  // Deleted before anything else, so a state value works once however the exchange goes.
  run("DELETE FROM oauth_pending WHERE state = ?", state);
  if (!row) throw new InputError("This sign-in was not started here, or it was already used. Start again from Accounts.");
  if (row.expires_at < now()) throw new InputError("This sign-in took longer than ten minutes. Start again from Accounts.");
  const pending = open<Pending>(row.payload);

  let response: Response;
  try {
    response = await guardedFetch(fetcher)(c.oauth.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_key: pending.credentials.client_key,
        client_secret: pending.credentials.client_secret,
        code,
        grant_type: "authorization_code",
        redirect_uri: pending.redirectUri,
        code_verifier: pending.verifier,
      }),
    });
  } catch (cause) {
    throw new InputError(`${c.name} could not be reached to finish signing in: ${(cause as Error).message}`);
  }
  const tokens = (await response.json().catch(() => ({}))) as { refresh_token?: string; error?: string; error_description?: string };
  if (!tokens.refresh_token) {
    throw new InputError(`${c.name} did not complete the sign-in: ${tokens.error_description ?? tokens.error ?? `it answered ${response.status}`}.`);
  }
  return connectAccount(platform, { ...pending.credentials, refresh_token: tokens.refresh_token }, fetcher);
}
