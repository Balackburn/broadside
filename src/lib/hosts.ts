/**
 * Without a password, the only thing between a web page and this app is the
 * address the browser thinks it is talking to. A hostile page can point its
 * own domain at 127.0.0.1 (DNS rebinding) and would then be "same origin".
 * So a passwordless Broadside answers only when the Host header is a name it
 * expects. With a password set, the session cookie already ties a request to
 * the right host, and this check stands down.
 */
const LOOPBACK = ["localhost", "127.0.0.1", "[::1]"];

export function hostAllowed(request: Request): boolean {
  if (process.env.BROADSIDE_PASSWORD) return true;
  return hostListed(request);
}

/** Whether the Host header is a name this Broadside knows as its own: a loopback name, an allowed host, or the public URL's. */
export function hostListed(request: Request): boolean {
  const host = (request.headers.get("host") ?? "").toLowerCase();
  const name = host.replace(/:\d+$/, "");
  if (LOOPBACK.includes(name)) return true;
  const extra = (process.env.BROADSIDE_ALLOWED_HOSTS ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
  try {
    if (process.env.BROADSIDE_PUBLIC_URL) extra.push(new URL(process.env.BROADSIDE_PUBLIC_URL).host.toLowerCase());
  } catch {
    /* an unparsable public URL allows nothing extra */
  }
  return extra.includes(host) || extra.includes(name);
}

export const HOST_REFUSED =
  "This Broadside has no password, so it only answers on localhost. Open it at http://localhost, or set BROADSIDE_PASSWORD (and BROADSIDE_PUBLIC_URL) to reach it by another name.";
