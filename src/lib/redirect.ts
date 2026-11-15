/**
 * The address a network sends the browser back to after a sign-in. It is
 * worked out the same way on the server, which sends it to the network, and
 * in the Accounts dialog, which shows it for you to register, so this file
 * has no imports and runs in both.
 */
const LOOPBACK = ["localhost", "127.0.0.1"];

/**
 * Some networks accept only one name for a redirect to this machine: X takes
 * 127.0.0.1 and refuses localhost. When Broadside is browsed by a loopback
 * name, the redirect address uses the name the network accepts. Both names
 * reach the same server, so the callback still arrives.
 */
export function redirectAddress(base: string, platform: string, loopback?: "localhost" | "127.0.0.1" | null): string {
  const url = new URL(`/oauth/${platform}/callback`, base);
  if (loopback && LOOPBACK.includes(url.hostname)) url.hostname = loopback;
  return url.toString();
}
