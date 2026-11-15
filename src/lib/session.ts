/**
 * Optional password for the web app. With BROADSIDE_PASSWORD unset the app is
 * open to whoever can reach it, which is right for localhost; set it before
 * exposing Broadside to a network. Uses Web Crypto only, so the same code runs
 * in the proxy and in route handlers.
 */
export const SESSION_COOKIE = "broadside_session";

export const passwordRequired = (): boolean => Boolean(process.env.BROADSIDE_PASSWORD);

async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The cookie value that proves someone knew the password. It changes when the password does. */
export const sessionValue = (): Promise<string> => digest(`broadside-session:${process.env.BROADSIDE_PASSWORD}`);

export async function passwordMatches(candidate: string): Promise<boolean> {
  const [a, b] = await Promise.all([digest(`check:${candidate}`), digest(`check:${process.env.BROADSIDE_PASSWORD}`)]);
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}

export async function signedIn(request: Request): Promise<boolean> {
  if (!passwordRequired()) return true;
  const cookies = request.headers.get("cookie") ?? "";
  const match = cookies.split(/;\s*/).find((c) => c.startsWith(`${SESSION_COOKIE}=`));
  return match?.slice(SESSION_COOKIE.length + 1) === (await sessionValue());
}
