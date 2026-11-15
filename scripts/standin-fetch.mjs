/**
 * Used only by scripts/verify.mjs. The networks that sign in live at fixed
 * addresses (api.x.com, graph.facebook.com and so on), so the server under
 * test cannot be pointed at a stand-in by configuration. verify loads this
 * file into that server with `node --import`, and it sends requests for those
 * hosts to the stand-in instead, as /<host>/<path>. Broadside's own code is
 * unchanged and has no such switch.
 */
const standin = process.env.BROADSIDE_VERIFY_STANDIN;
if (standin) {
  const hosts = new Set([
    "api.x.com",
    "www.linkedin.com",
    "api.linkedin.com",
    "graph.threads.com",
    "graph.threads.net",
    "graph.facebook.com",
    "oauth2.googleapis.com",
    "www.googleapis.com",
    "api.pinterest.com",
    "api.tumblr.com",
    "id.twitch.tv",
    "api.twitch.tv",
    "id.kick.com",
    "api.kick.com",
    // Image generation. With this file loaded, no request for OpenAI leaves the machine, whatever key the server holds.
    "api.openai.com",
  ]);
  const real = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (!hosts.has(url.host)) return real(input, init);
    const target = `${standin}/${url.host}${url.pathname}${url.search}`;
    return real(input instanceof Request ? new Request(target, input) : target, init);
  };
}
