import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * Outbound requests to addresses a user typed (media to import, a Mastodon
 * instance, a webhook) must not be usable to reach this machine or its
 * private network. Local targets, such as an n8n on localhost, are an
 * explicit opt-in: BROADSIDE_ALLOW_PRIVATE_FETCH=1.
 */
export class BlockedAddress extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlockedAddress";
  }
}

/** True for loopback, private, link-local, carrier-grade NAT, multicast and unspecified addresses, in IPv4 or IPv6. */
export function isPrivateAddress(address: string): boolean {
  const a = address.toLowerCase().replace(/^\[|\]$/g, "");
  const mapped = a.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateAddress(mapped[1]);
  if (isIP(a) === 4) {
    const [p, q] = a.split(".").map(Number);
    return (
      p === 0 || p === 10 || p === 127 || p >= 224 ||
      (p === 100 && q >= 64 && q <= 127) ||
      (p === 169 && q === 254) ||
      (p === 172 && q >= 16 && q <= 31) ||
      (p === 192 && q === 168) ||
      (p === 198 && (q === 18 || q === 19))
    );
  }
  if (isIP(a) === 6) return a === "::" || a === "::1" || /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(a) || a.startsWith("::ffff:");
  return true; // not an address at all
}

export async function assertPublicUrl(url: URL): Promise<void> {
  if (!/^https?:$/.test(url.protocol)) throw new BlockedAddress("Only http:// and https:// addresses can be fetched.");
  if (process.env.BROADSIDE_ALLOW_PRIVATE_FETCH === "1") return;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host)
    ? [host]
    : (await lookup(host, { all: true }).catch(() => {
        throw new BlockedAddress(`${host} could not be resolved.`);
      })).map((entry) => entry.address);
  if (addresses.some(isPrivateAddress)) {
    throw new BlockedAddress(`${host} points inside a private network, so Broadside will not fetch it. Set BROADSIDE_ALLOW_PRIVATE_FETCH=1 to allow local targets.`);
  }
}

/**
 * fetch with every hop checked: the first address and each redirect must be
 * public, and the request is abandoned after 30 seconds. The check and the
 * connection resolve the name separately, so a hostile DNS server could still
 * answer differently the second time; this narrows that window, it does not
 * close it.
 */
export function guardedFetch(inner: typeof fetch = fetch): typeof fetch {
  return (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    let current = new URL(input instanceof Request ? input.url : String(input));
    for (let hop = 0; hop < 5; hop++) {
      await assertPublicUrl(current);
      const response = await inner(current, { ...init, redirect: "manual", signal: init.signal ?? AbortSignal.timeout(30_000) });
      const location = response.status >= 300 && response.status < 400 ? response.headers.get("location") : null;
      if (!location) return response;
      current = new URL(location, current);
      // A redirect becomes a plain GET, as browsers do, so a body is never replayed to a new host.
      init = { ...init, method: "GET", body: undefined };
    }
    throw new BlockedAddress("The address redirected too many times.");
  }) as typeof fetch;
}
