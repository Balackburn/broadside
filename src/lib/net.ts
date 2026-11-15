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
  // IPv6: unspecified, loopback and the old IPv4-compatible block (::/96), NAT64, unique-local, link-local, site-local, multicast.
  if (isIP(a) === 6) return a.startsWith("::") || /^(64:ff9b:|fc|fd|fe[89a-f]|ff)/.test(a);
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
 * public, credentials are dropped when a redirect changes host, and a hung
 * request is abandoned. The check and the
 * connection resolve the name separately, so a hostile DNS server could still
 * answer differently the second time; this narrows that window, it does not
 * close it.
 */
/** Headers that prove who we are to one host and must not follow a redirect to another. */
const CREDENTIAL_HEADERS = ["authorization", "cookie", "api-key", "x-api-key", "proxy-authorization"];

export function guardedFetch(inner: typeof fetch = fetch): typeof fetch {
  return (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    let current = new URL(input instanceof Request ? input.url : String(input));
    // Ten minutes bounds a hung connection without cutting off a large video in mid-transfer.
    const signal = init.signal ?? AbortSignal.timeout(600_000);
    for (let hop = 0; hop < 5; hop++) {
      await assertPublicUrl(current);
      const response = await inner(current, { ...init, redirect: "manual", signal });
      const location = response.status >= 300 && response.status < 400 ? response.headers.get("location") : null;
      if (!location) return response;
      const next = new URL(location, current);
      if (next.origin !== current.origin) {
        const headers = new Headers(init.headers);
        for (const name of CREDENTIAL_HEADERS) headers.delete(name);
        init = { ...init, headers };
      }
      // 307 and 308 repeat the request as it was; the older codes become a plain GET, as browsers do.
      if (response.status !== 307 && response.status !== 308) init = { ...init, method: "GET", body: undefined };
      current = next;
    }
    throw new BlockedAddress("The address redirected too many times.");
  }) as typeof fetch;
}

/** Reads a response body, stopping with an error as soon as it passes `max` bytes, so an unbounded download cannot fill memory. */
export async function readCapped(response: Response, max: number): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array(await response.arrayBuffer());
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      await reader.cancel();
      throw new BlockedAddress(`That file is larger than the ${Math.round(max / 1024 / 1024)} MB limit.`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
