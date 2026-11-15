/**
 * Optional password for the web app. With BROADSIDE_PASSWORD unset the app
 * answers on localhost only (see hosts.ts). A session is a signed expiry
 * time: it stops working after 30 days, when the password changes, or when
 * BROADSIDE_SECRET changes. Web Crypto only, so the proxy can run it too.
 */
export const SESSION_COOKIE = "broadside_session";
export const SESSION_SECONDS = 30 * 24 * 3600;

export const passwordRequired = (): boolean => Boolean(process.env.BROADSIDE_PASSWORD);

const encoder = new TextEncoder();
const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");

async function sign(message: string): Promise<string> {
  // Keyed by the password and the server secret together, so a leaked cookie is no shortcut to the password.
  const material = encoder.encode(`${process.env.BROADSIDE_PASSWORD}\u0000${process.env.BROADSIDE_SECRET ?? ""}`);
  const key = await crypto.subtle.importKey("raw", await crypto.subtle.digest("SHA-256", material), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
}

function same(a: string, b: string): boolean {
  let difference = a.length ^ b.length;
  for (let i = 0; i < a.length && i < b.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}

/** A fresh cookie value: when it expires, and proof this server issued it. */
export async function sessionValue(now = Date.now()): Promise<string> {
  const expires = Math.floor(now / 1000) + SESSION_SECONDS;
  return `${expires}.${await sign(`session:${expires}`)}`;
}

export async function passwordMatches(candidate: string): Promise<boolean> {
  const digest = async (value: string) => hex(await crypto.subtle.digest("SHA-256", encoder.encode(`check:${value}`)));
  return same(await digest(candidate), await digest(process.env.BROADSIDE_PASSWORD ?? ""));
}

export async function signedIn(request: Request, now = Date.now()): Promise<boolean> {
  if (!passwordRequired()) return true;
  const cookies = request.headers.get("cookie") ?? "";
  const value = cookies.split(/;\s*/).find((c) => c.startsWith(`${SESSION_COOKIE}=`))?.slice(SESSION_COOKIE.length + 1) ?? "";
  const [expires, signature] = value.split(".");
  if (!expires || !signature || !/^\d+$/.test(expires) || Number(expires) * 1000 < now) return false;
  return same(signature, await sign(`session:${expires}`));
}
