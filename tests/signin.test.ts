import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

process.env.BROADSIDE_DATA_DIR = mkdtempSync(path.join(tmpdir(), "broadside-signin-"));
process.env.BROADSIDE_SECRET = "test-secret";
// Every network here is a fake fetch, so nothing is resolved or reached.
process.env.BROADSIDE_ALLOW_PRIVATE_FETCH = "1";
process.env.BROADSIDE_POLL_MS = "1";

const { connectAccount, credentialsOf, getAccount, listAccounts, saveCredentials } = await import("@/lib/accounts");
const { run } = await import("@/lib/db");
const { saveMedia } = await import("@/lib/media");
const { choose, finishOAuth, pendingChoice, startOAuth } = await import("@/lib/oauth");
const { connector, connectors, describe: describeNetwork } = await import("@/lib/platforms");
const { createPost } = await import("@/lib/posts");
const { redirectAddress } = await import("@/lib/redirect");

type Call = { url: string; path: string; query: Record<string, string>; method: string; auth: string | null; body: unknown };

/** A network that answers from a function and remembers every request, so a test can state the exact wire format. */
function network(answer: (call: Call) => unknown) {
  const calls: Call[] = [];
  const fetcher = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    let body: unknown = init.body ?? null;
    if (body instanceof URLSearchParams) body = Object.fromEntries(body);
    else if (body instanceof FormData) body = Object.fromEntries([...body.entries()].map(([k, v]) => [k, typeof v === "string" ? v : "file"]));
    else if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        /* keep text */
      }
    }
    const call: Call = { url: url.toString(), path: `${url.origin}${url.pathname}`, query: Object.fromEntries(url.searchParams), method: init.method ?? "GET", auth: new Headers(init.headers).get("authorization"), body };
    calls.push(call);
    const result = answer(call);
    return result instanceof Response ? result : Response.json(result);
  }) as typeof fetch;
  return { fetcher, calls };
}

const refused = (body: unknown, status = 400) => Response.json(body, { status });
const basic = (id: string, secret: string) => `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`;
const LOCAL = "http://localhost:3000";
const PAST = "2000-01-01T00:00:00.000Z";

/** Starts a sign-in and returns the address the browser is sent to, taken apart. */
function begin(platform: string, app: Record<string, string>, base = LOCAL) {
  const started = startOAuth(platform, app, base);
  const url = new URL(started.url);
  return { address: `${url.origin}${url.pathname}`, params: Object.fromEntries(url.searchParams), state: url.searchParams.get("state")!, raw: started.url, redirect: started.redirect_uri };
}

/** The stored tokens made to look run out, as they will be when a post goes out later. */
function expire(accountId: string) {
  saveCredentials(accountId, { ...credentialsOf(accountId), expires_at: PAST });
}

const STATE = expect.stringMatching(/^[\w-]{32}$/);
const anAccount = async (signedIn: Promise<{ account?: { id: string; handle: string; platform: string } }>) => {
  const { account } = await signedIn;
  if (!account) throw new Error("expected the sign-in to connect an account");
  return account;
};

describe("the redirect address", () => {
  it("is this Broadside's own address, under the name each network accepts for this machine", () => {
    expect(redirectAddress("http://localhost:3000", "youtube")).toBe("http://localhost:3000/oauth/youtube/callback");
    expect(redirectAddress("http://localhost:3000/", "x", "127.0.0.1")).toBe("http://127.0.0.1:3000/oauth/x/callback");
    expect(redirectAddress("http://127.0.0.1:3000", "facebook", "localhost")).toBe("http://localhost:3000/oauth/facebook/callback");
    // A real host name is never rewritten.
    expect(redirectAddress("https://post.example.com", "x", "127.0.0.1")).toBe("https://post.example.com/oauth/x/callback");
  });
});

describe("every network that signs in", () => {
  const apps: Record<string, Record<string, string>> = {
    x: { client_id: "xid", client_secret: "app-secret-x" },
    linkedin: { client_id: "lid", client_secret: "app-secret-li" },
    threads: { app_id: "tid", app_secret: "app-secret-th" },
    facebook: { app_id: "fid", app_secret: "app-secret-fb" },
    instagram: { app_id: "iid", app_secret: "app-secret-ig" },
    youtube: { client_id: "yid", client_secret: "app-secret-yt" },
    pinterest: { app_id: "pid", app_secret: "app-secret-pin" },
    tiktok: { client_key: "ck", client_secret: "app-secret-tt" },
  };
  const signingIn = connectors.filter((c) => c.oauth);

  it("is the eight that have a developer app: TikTok and the seven added to it", () => {
    expect(signingIn.map((c) => c.id).sort()).toEqual(Object.keys(apps).sort());
  });

  it("never puts the app's secret in the address the browser is sent to", () => {
    for (const c of signingIn) {
      const { raw } = begin(c.id, apps[c.id], "https://post.example.com");
      expect(raw, c.id).not.toContain(apps[c.id][c.oauth!.client.secret]);
      expect(raw, c.id).toContain("state=");
    }
  });

  it("connects nothing for a state it did not issue, and uses a state once", async () => {
    for (const c of signingIn) {
      const before = listAccounts().length;
      const { fetcher, calls } = network(() => refused({ error: "invalid_grant", error_description: "nope" }));
      await expect(finishOAuth(c.id, "made-up-state", "code", fetcher), c.id).rejects.toThrow(/not started here, or it was already used/);
      expect(calls, c.id).toHaveLength(0);
      const { state } = begin(c.id, apps[c.id], "https://post.example.com");
      await expect(finishOAuth(c.id, state, "code", fetcher), c.id).rejects.toThrow(/did not complete the sign-in: nope/);
      await expect(finishOAuth(c.id, state, "code", fetcher), c.id).rejects.toThrow(/not started here, or it was already used/);
      expect(calls, c.id).toHaveLength(1);
      expect(listAccounts().length, c.id).toBe(before);
    }
  });

  it("does not accept one network's state for another, or a state past ten minutes", async () => {
    const { fetcher, calls } = network(() => ({}));
    const forX = begin("x", apps.x).state;
    await expect(finishOAuth("youtube", forX, "code", fetcher)).rejects.toThrow(/not started here/);
    const late = begin("youtube", apps.youtube).state;
    run("UPDATE oauth_pending SET expires_at = ? WHERE state = ?", PAST, late);
    await expect(finishOAuth("youtube", late, "code", fetcher)).rejects.toThrow(/took longer than ten minutes/);
    await expect(finishOAuth("youtube", late, "code", fetcher)).rejects.toThrow(/not started here/);
    expect(calls).toHaveLength(0);
  });

  it("asks for the app's id and secret before starting", () => {
    expect(() => startOAuth("x", { client_secret: "s" }, LOCAL)).toThrow("Client ID is required to connect X.");
    expect(() => startOAuth("linkedin", { client_id: "lid" }, LOCAL)).toThrow("Client Secret is required to connect LinkedIn.");
    expect(() => startOAuth("facebook", { app_id: "fid" }, LOCAL)).toThrow("App secret is required to connect Facebook Page.");
    expect(() => startOAuth("pinterest", {}, LOCAL)).toThrow("App id is required to connect Pinterest.");
  });

  it("tells the form and the API what each one needs: the app's fields to sign in, the token fields to paste", () => {
    const told = Object.fromEntries(connectors.map((c) => [c.id, describeNetwork(c)]));
    expect(told.x.fields.map((f) => [f.key, Boolean(f.optional)])).toEqual([["client_id", false], ["client_secret", true]]);
    expect(told.x.oauth).toMatchObject({ callback_path: "/oauth/x/callback", loopback: "127.0.0.1", https_only: false });
    expect(told.x.oauth!.scopes).toEqual(["tweet.read", "tweet.write", "users.read", "media.write", "offline.access"]);
    expect(told.x.oauth!.paste.map((f) => f.key)).toEqual(["api_key", "api_secret", "access_token", "access_secret"]);
    expect(told.facebook.fields.map((f) => [f.key, Boolean(f.optional)])).toEqual([["app_id", false], ["app_secret", false]]);
    expect(told.facebook.oauth!.paste.map((f) => [f.key, f.optional])).toEqual([["page_id", false], ["access_token", false]]);
    expect(told.linkedin.oauth!.paste.map((f) => [f.key, f.optional])).toEqual([["access_token", false], ["organization_id", true]]);
    expect(told.threads.oauth).toMatchObject({ https_only: true, loopback: null });
    expect(told.mastodon.oauth).toBeNull();
    for (const c of signingIn) expect(told[c.id].oauth!.paste.length, c.id).toBeGreaterThan(0);
  });
});

/* X ------------------------------------------------------------------------ */

describe("X", () => {
  const app = { client_id: "xid", client_secret: "x-app-secret" };
  let n = 0;
  /** X as documented: two-hour access tokens, and refresh tokens that work once. */
  const xNetwork = (overrides: (call: Call) => unknown = () => undefined) =>
    network((call) => {
      const special = overrides(call);
      if (special !== undefined) return special;
      if (call.path === "https://api.x.com/2/oauth2/token") {
        n++;
        return { token_type: "bearer", expires_in: 7200, access_token: `x-access-${n}`, refresh_token: `x-refresh-${n}`, scope: "tweet.read tweet.write users.read media.write offline.access" };
      }
      if (call.path === "https://api.x.com/2/users/me") return { data: { username: "printer", profile_image_url: "https://pbs.example/p.jpg" } };
      if (call.path === "https://api.x.com/2/media/upload") return { data: { id: "m1" } };
      return { data: { id: `tweet-${calls().length}` } };
    });
  let calls: () => Call[] = () => [];
  const signIn = async (net = xNetwork()) => {
    calls = () => net.calls;
    const started = begin("x", app);
    const account = await anAccount(finishOAuth("x", started.state, "the-code", net.fetcher));
    return { account, started, net };
  };

  it("sends the browser to X with PKCE, the scopes to post with media, and 127.0.0.1 in place of localhost", () => {
    const { address, params, redirect } = begin("x", app);
    expect(address).toBe("https://x.com/i/oauth2/authorize");
    expect(params).toEqual({
      client_id: "xid",
      response_type: "code",
      scope: "tweet.read tweet.write users.read media.write offline.access",
      redirect_uri: "http://127.0.0.1:3000/oauth/x/callback",
      state: STATE,
      code_challenge: expect.stringMatching(/^[\w-]{43}$/),
      code_challenge_method: "S256",
    });
    expect(redirect).toBe("http://127.0.0.1:3000/oauth/x/callback");
  });

  it("exchanges the code with a Basic header and the verifier behind the challenge, then stores both tokens", async () => {
    const { account, started, net } = await signIn();
    const exchange = net.calls[0];
    expect(exchange).toMatchObject({ url: "https://api.x.com/2/oauth2/token", method: "POST", auth: basic("xid", "x-app-secret") });
    expect(exchange.body).toEqual({ code: "the-code", grant_type: "authorization_code", redirect_uri: "http://127.0.0.1:3000/oauth/x/callback", code_verifier: expect.stringMatching(/^[\w.~-]{64}$/) });
    expect(createHash("sha256").update((exchange.body as { code_verifier: string }).code_verifier).digest("base64url")).toBe(started.params.code_challenge);
    expect(net.calls[1]).toMatchObject({ path: "https://api.x.com/2/users/me", auth: expect.stringMatching(/^Bearer x-access-\d+$/) });
    expect(account).toMatchObject({ platform: "x", handle: "@printer" });
    const stored = credentialsOf(account.id);
    expect(stored).toMatchObject({ client_id: "xid", client_secret: "x-app-secret", username: "printer" });
    expect(stored.refresh_token).toMatch(/^x-refresh-/);
    expect(Date.parse(stored.expires_at) - Date.now()).toBeGreaterThan(7000_000);
    expect(JSON.stringify(getAccount(account.id))).not.toContain("x-refresh");
  });

  it("an app with no secret names itself in the body instead", async () => {
    const net = xNetwork();
    const started = begin("x", { client_id: "native-id" });
    const account = await anAccount(finishOAuth("x", started.state, "the-code", net.fetcher));
    expect(net.calls[0].auth).toBeNull();
    expect(net.calls[0].body).toMatchObject({ client_id: "native-id", code: "the-code", grant_type: "authorization_code" });
    expect(net.calls[0].body).not.toHaveProperty("client_secret");
    expire(account.id);
    const before = credentialsOf(account.id).refresh_token;
    await createPost({ content: "from a native app", targets: [{ account_id: account.id }] }, net.fetcher);
    const renewal = net.calls.find((c) => (c.body as { grant_type?: string } | null)?.grant_type === "refresh_token")!;
    expect(renewal.auth).toBeNull();
    expect(renewal.body).toEqual({ client_id: "native-id", grant_type: "refresh_token", refresh_token: before });
  });

  it("renews a run-out token before posting, and keeps the refresh token X rotated to, for every part of a thread", async () => {
    const { account, net } = await signIn();
    expire(account.id);
    const spent = credentialsOf(account.id).refresh_token;
    const from = net.calls.length;
    const post = await createPost({ content: "one", thread: ["two"], targets: [{ account_id: account.id }] }, net.fetcher);
    expect(post.status).toBe("published");
    const sent = net.calls.slice(from);
    expect(sent[0]).toMatchObject({ url: "https://api.x.com/2/oauth2/token", method: "POST", auth: basic("xid", "x-app-secret") });
    expect(sent[0].body).toEqual({ grant_type: "refresh_token", refresh_token: spent });
    const stored = credentialsOf(account.id);
    expect(stored.refresh_token).not.toBe(spent);
    expect(sent[1]).toMatchObject({ path: "https://api.x.com/2/tweets", auth: `Bearer ${stored.access_token}` });
    expect(sent[1].body).toEqual({ text: "one" });
    // The reply reads the tokens just stored, so the refresh token is not spent a second time.
    expect(sent[2]).toMatchObject({ path: "https://api.x.com/2/tweets", auth: `Bearer ${stored.access_token}` });
    expect(sent[2].body).toMatchObject({ text: "two", reply: { in_reply_to_tweet_id: expect.any(String) } });
    expect(sent).toHaveLength(3);
    expect(Date.parse(stored.expires_at)).toBeGreaterThan(Date.now());
  });

  it("keeps the rotated tokens even when the post is then refused", async () => {
    const { account, net: first } = await signIn();
    expire(account.id);
    const spent = credentialsOf(account.id).refresh_token;
    const net = xNetwork((call) => (call.path === "https://api.x.com/2/tweets" ? refused({ title: "Forbidden", detail: "You are not allowed to create a Tweet with duplicate content.", status: 403 }, 403) : undefined));
    const post = await createPost({ content: "again", targets: [{ account_id: account.id }] }, net.fetcher);
    expect(post.targets[0].status).toBe("failed");
    expect(post.targets[0].error).toBe("X answered 403: You are not allowed to create a Tweet with duplicate content.");
    expect(credentialsOf(account.id).refresh_token).not.toBe(spent);
    expect(credentialsOf(account.id).refresh_token).toMatch(/^x-refresh-/);
    expect(first.calls.length).toBeGreaterThan(0);
  });

  it("spends a refresh token once when two posts for the account go out together", async () => {
    const { account, net } = await signIn();
    expire(account.id);
    const from = net.calls.length;
    const posts = await Promise.all([createPost({ content: "first", targets: [{ account_id: account.id }] }, net.fetcher), createPost({ content: "second", targets: [{ account_id: account.id }] }, net.fetcher)]);
    expect(posts.map((p) => p.status)).toEqual(["published", "published"]);
    expect(net.calls.slice(from).filter((c) => c.path === "https://api.x.com/2/oauth2/token")).toHaveLength(1);
  });

  it("reports X's own reason when it will not renew, and marks the account for reconnecting", async () => {
    const { account } = await signIn();
    expire(account.id);
    const net = xNetwork((call) => (call.path === "https://api.x.com/2/oauth2/token" ? refused({ error: "invalid_request", error_description: "Value passed for the token was invalid." }) : undefined));
    const post = await createPost({ content: "too late", targets: [{ account_id: account.id }] }, net.fetcher);
    expect(post.targets[0].error).toBe("X would not renew the sign-in: Value passed for the token was invalid. Reconnect the account.");
    expect(getAccount(account.id)).toMatchObject({ status: "needs_attention" });
    expect(net.calls).toHaveLength(1);
  });

  it("reports X's own reason when the code is refused, and stores nothing", async () => {
    const before = listAccounts().length;
    const net = xNetwork((call) => (call.path.endsWith("/oauth2/token") ? refused({ error: "invalid_request", error_description: "Value passed for the authorization code was invalid." }) : undefined));
    await expect(finishOAuth("x", begin("x", app).state, "stale-code", net.fetcher)).rejects.toThrow("X did not complete the sign-in: Value passed for the authorization code was invalid.");
    expect(listAccounts().length).toBe(before);
  });

  it("still connects and posts with the four OAuth 1.0a keys", async () => {
    const net = xNetwork();
    const account = await connectAccount("x", { api_key: "k", api_secret: "s", access_token: "t", access_secret: "ts" }, net.fetcher);
    expect(account.handle).toBe("@printer");
    expect(net.calls[0].auth).toMatch(/^OAuth oauth_consumer_key="k"/);
    const post = await createPost({ content: "signed the old way", targets: [{ account_id: account.id }] }, net.fetcher);
    expect(post.status).toBe("published");
    expect(net.calls.at(-1)!.auth).toMatch(/^OAuth oauth_consumer_key="k".*oauth_token="t"/);
    expect(net.calls.some((c) => c.path.endsWith("/oauth2/token"))).toBe(false);
    await expect(connectAccount("x", { api_key: "k" }, net.fetcher)).rejects.toThrow(/either a sign-in, or all four OAuth 1.0a values/);
  });
});

/* LinkedIn ----------------------------------------------------------------- */

describe("LinkedIn", () => {
  const app = { client_id: "lid", client_secret: "li-app-secret" };
  const linkedIn = (tokens: Record<string, unknown>, overrides: (call: Call) => unknown = () => undefined) =>
    network((call) => {
      const special = overrides(call);
      if (special !== undefined) return special;
      if (call.path === "https://www.linkedin.com/oauth/v2/accessToken") return tokens;
      if (call.path === "https://api.linkedin.com/v2/userinfo") return { sub: "abc123", name: "Ada Printer" };
      if (call.path === "https://api.linkedin.com/rest/posts") return new Response(null, { status: 201, headers: { "x-restli-id": "urn:li:share:9" } });
      return {};
    });

  it("sends the browser to LinkedIn for the scopes that post and comment, with no PKCE", () => {
    const { address, params } = begin("linkedin", app);
    expect(address).toBe("https://www.linkedin.com/oauth/v2/authorization");
    expect(params).toEqual({ client_id: "lid", response_type: "code", scope: "openid profile w_member_social", redirect_uri: "http://localhost:3000/oauth/linkedin/callback", state: STATE });
    expect(begin("linkedin", { ...app, organization_id: "5515715" }).params.scope).toBe("openid profile w_member_social w_organization_social");
  });

  it("exchanges the code with the id and secret in the body, and keeps only the 60-day token when LinkedIn gives no refresh token", async () => {
    const net = linkedIn({ access_token: "li-access-plain", expires_in: 5184000, scope: "openid,profile,w_member_social" });
    const account = await anAccount(finishOAuth("linkedin", begin("linkedin", app).state, "li-code", net.fetcher));
    expect(net.calls[0]).toMatchObject({ url: "https://www.linkedin.com/oauth/v2/accessToken", method: "POST", auth: null });
    expect(net.calls[0].body).toEqual({ client_id: "lid", client_secret: "li-app-secret", code: "li-code", grant_type: "authorization_code", redirect_uri: "http://localhost:3000/oauth/linkedin/callback" });
    expect(account.handle).toBe("Ada Printer");
    const stored = credentialsOf(account.id);
    expect(stored).toMatchObject({ access_token: "li-access-plain", author: "urn:li:person:abc123" });
    expect(Math.round((Date.parse(stored.expires_at) - Date.now()) / 86_400_000)).toBe(60);
    // With nothing to refresh, the app's secret has no further use and is not kept.
    expect(stored).not.toHaveProperty("client_secret");

    expire(account.id);
    const post = await createPost({ content: "after 60 days", targets: [{ account_id: account.id }] }, net.fetcher);
    expect(post.targets[0].error).toBe("The LinkedIn sign-in has run out. LinkedIn signs you in for 60 days at a time; reconnect the account.");
    expect(getAccount(account.id)!.status).toBe("needs_attention");
  });

  it("where LinkedIn does give a refresh token, renews with it before posting and stores the new access token", async () => {
    let issued = 0;
    const net = linkedIn({}, (call) => {
      if (call.path !== "https://www.linkedin.com/oauth/v2/accessToken") return undefined;
      issued++;
      return { access_token: `li-access-${issued}`, expires_in: 5184000, refresh_token: "li-refresh-partner", refresh_token_expires_in: 31536000 };
    });
    const account = await anAccount(finishOAuth("linkedin", begin("linkedin", app).state, "li-code", net.fetcher));
    expect(credentialsOf(account.id)).toMatchObject({ client_id: "lid", client_secret: "li-app-secret", refresh_token: "li-refresh-partner", access_token: "li-access-1" });
    expire(account.id);
    const from = net.calls.length;
    const post = await createPost({ content: "renewed", targets: [{ account_id: account.id }] }, net.fetcher);
    expect(post.status).toBe("published");
    const sent = net.calls.slice(from);
    expect(sent[0]).toMatchObject({ url: "https://www.linkedin.com/oauth/v2/accessToken", method: "POST", auth: null });
    expect(sent[0].body).toEqual({ client_id: "lid", client_secret: "li-app-secret", grant_type: "refresh_token", refresh_token: "li-refresh-partner" });
    expect(sent[1]).toMatchObject({ path: "https://api.linkedin.com/rest/posts", auth: "Bearer li-access-2" });
    const stored = credentialsOf(account.id);
    expect(stored).toMatchObject({ access_token: "li-access-2", refresh_token: "li-refresh-partner" });
    expect(Date.parse(stored.expires_at)).toBeGreaterThan(Date.now());
  });

  it("reports LinkedIn's own reason when the code is refused", async () => {
    const net = linkedIn({}, (call) => (call.path.endsWith("/accessToken") ? refused({ error: "invalid_request", error_description: "Unable to retrieve access token: authorization code not found" }, 401) : undefined));
    await expect(finishOAuth("linkedin", begin("linkedin", app).state, "bad", net.fetcher)).rejects.toThrow("LinkedIn did not complete the sign-in: Unable to retrieve access token: authorization code not found.");
  });

  it("still connects with a pasted token", async () => {
    const net = linkedIn({});
    const account = await connectAccount("linkedin", { access_token: "li-pasted" }, net.fetcher);
    expect(net.calls[0]).toMatchObject({ path: "https://api.linkedin.com/v2/userinfo", auth: "Bearer li-pasted" });
    expect(credentialsOf(account.id)).toEqual({ access_token: "li-pasted", author: "urn:li:person:abc123" });
  });
});

/* Threads ------------------------------------------------------------------ */

describe("Threads", () => {
  const app = { app_id: "tid", app_secret: "th-app-secret" };
  const HOSTED = "https://post.example.com";
  const threadsNet = (overrides: (call: Call) => unknown = () => undefined) =>
    network((call) => {
      const special = overrides(call);
      if (special !== undefined) return special;
      if (call.path === "https://graph.threads.com/oauth/access_token") return { access_token: "th-short", token_type: "bearer", user_id: 17841405793187218 };
      if (call.path === "https://graph.threads.com/access_token") return { access_token: "th-long", token_type: "bearer", expires_in: 5183944 };
      if (call.path === "https://graph.threads.net/v1.0/me") return { id: "1784", username: "printer" };
      if (call.path === "https://graph.threads.net/refresh_access_token") return { access_token: "th-long-renewed", expires_in: 5183944 };
      if (call.path.endsWith("/threads")) return { id: "container-1" };
      if (call.path.endsWith("/threads_publish")) return { id: "media-1" };
      return { permalink: "https://www.threads.com/@printer/post/abc" };
    });

  it("will not start from an http address, because Threads accepts only https redirects, and says what to do", () => {
    expect(() => startOAuth("threads", app, LOCAL)).toThrow("Threads only accepts an https redirect address, and this Broadside is at http://localhost:3000. Set BROADSIDE_PUBLIC_URL to an https address to sign in, or connect by pasting a token.");
  });

  it("sends the browser to Threads for the scopes that post and reply", () => {
    const { address, params } = begin("threads", app, HOSTED);
    expect(address).toBe("https://threads.com/oauth/authorize");
    expect(params).toEqual({ client_id: "tid", response_type: "code", scope: "threads_basic,threads_content_publish,threads_manage_replies", redirect_uri: "https://post.example.com/oauth/threads/callback", state: STATE });
  });

  it("exchanges the code, trades the short token for a long-lived one with the secret in the body, and stores only that", async () => {
    const net = threadsNet();
    const account = await anAccount(finishOAuth("threads", begin("threads", app, HOSTED).state, "th-code", net.fetcher));
    expect(net.calls[0]).toMatchObject({ url: "https://graph.threads.com/oauth/access_token", method: "POST" });
    expect(net.calls[0].body).toEqual({ client_id: "tid", client_secret: "th-app-secret", code: "th-code", grant_type: "authorization_code", redirect_uri: "https://post.example.com/oauth/threads/callback" });
    expect(net.calls[1]).toMatchObject({ url: "https://graph.threads.com/access_token", method: "POST", query: {} });
    expect(net.calls[1].body).toEqual({ grant_type: "th_exchange_token", client_secret: "th-app-secret", access_token: "th-short" });
    expect(net.calls[2]).toMatchObject({ path: "https://graph.threads.net/v1.0/me", query: { access_token: "th-long" } });
    expect(account.handle).toBe("@printer");
    expect(credentialsOf(account.id)).toEqual({ access_token: "th-long", user_id: "1784" });
    expect(net.calls.every((c) => !c.url.includes("th-app-secret"))).toBe(true);

    // Posting refreshes the long-lived token, and the refreshed one is what is kept.
    const post = await createPost({ content: "hello threads", targets: [{ account_id: account.id }] }, net.fetcher);
    expect(post.status).toBe("published");
    expect(net.calls.at(-1)).toMatchObject({ path: "https://graph.threads.net/refresh_access_token", query: { grant_type: "th_refresh_token", access_token: "th-long" } });
    expect(credentialsOf(account.id).access_token).toBe("th-long-renewed");
  });

  it("reports Threads' own reason when the code or the long-lived exchange is refused, and stores nothing", async () => {
    const before = listAccounts().length;
    const badCode = threadsNet((call) => (call.path.endsWith("/oauth/access_token") ? refused({ error: { message: "Invalid client_id: 123", type: "OAuthException", code: 1 } }) : undefined));
    await expect(finishOAuth("threads", begin("threads", app, HOSTED).state, "x", badCode.fetcher)).rejects.toThrow("Threads did not complete the sign-in: Invalid client_id: 123.");
    const badTrade = threadsNet((call) => (call.path === "https://graph.threads.com/access_token" ? refused({ error: { message: "Invalid OAuth access token - Cannot parse access token", type: "OAuthException", code: 190 } }) : undefined));
    await expect(finishOAuth("threads", begin("threads", app, HOSTED).state, "x", badTrade.fetcher)).rejects.toThrow("Threads answered 400: Invalid OAuth access token - Cannot parse access token");
    expect(listAccounts().length).toBe(before);
  });

  it("still connects with a pasted token, which is the way on http://localhost", async () => {
    const net = threadsNet();
    const account = await connectAccount("threads", { access_token: "th-pasted" }, net.fetcher);
    expect(credentialsOf(account.id)).toEqual({ access_token: "th-pasted", user_id: "1784" });
  });
});

/* Facebook Pages and Instagram --------------------------------------------- */

describe("Facebook Pages", () => {
  const app = { app_id: "fid", app_secret: "fb-app-secret" };
  const TOKEN_URL = "https://graph.facebook.com/v27.0/oauth/access_token";
  const facebookNet = (pages: unknown[], overrides: (call: Call) => unknown = () => undefined) =>
    network((call) => {
      const special = overrides(call);
      if (special !== undefined) return special;
      if (call.path === TOKEN_URL) return (call.body as { grant_type: string }).grant_type === "fb_exchange_token" ? { access_token: "fb-user-long", token_type: "bearer", expires_in: 5183944 } : { access_token: "fb-user-short", token_type: "bearer", expires_in: 5400 };
      if (call.path === "https://graph.facebook.com/v27.0/me/accounts") return { data: pages, paging: { cursors: { before: "a", after: "b" } } };
      if (call.path.endsWith("/feed")) return { id: "111_222", permalink_url: "https://www.facebook.com/111/posts/222" };
      const page = (pages as { id: string; name: string }[]).find((p) => call.path.endsWith(`/${p.id}`));
      return page ? { name: page.name } : {};
    });
  const twoPages = [
    { id: "111", name: "Press Room", access_token: "page-token-111", tasks: ["CREATE_CONTENT"] },
    { id: "222", name: "Bindery", access_token: "page-token-222", tasks: ["CREATE_CONTENT"] },
  ];

  it("sends the browser to Facebook for the Page scopes, using localhost as the name of this machine", () => {
    const { address, params } = begin("facebook", app, "http://127.0.0.1:3000");
    expect(address).toBe("https://www.facebook.com/v27.0/dialog/oauth");
    expect(params).toEqual({ client_id: "fid", response_type: "code", scope: "pages_show_list,pages_manage_posts,pages_read_engagement,pages_manage_engagement", redirect_uri: "http://localhost:3000/oauth/facebook/callback", state: STATE });
  });

  it("exchanges the code, trades for a long-lived user token, and offers the Pages without connecting any", async () => {
    const before = listAccounts().length;
    const net = facebookNet(twoPages);
    const signedIn = await finishOAuth("facebook", begin("facebook", app).state, "fb-code", net.fetcher);
    expect(net.calls[0]).toMatchObject({ url: TOKEN_URL, method: "POST" });
    expect(net.calls[0].body).toEqual({ client_id: "fid", client_secret: "fb-app-secret", code: "fb-code", grant_type: "authorization_code", redirect_uri: "http://localhost:3000/oauth/facebook/callback" });
    expect(net.calls[1]).toMatchObject({ url: TOKEN_URL, method: "POST" });
    expect(net.calls[1].body).toEqual({ grant_type: "fb_exchange_token", client_id: "fid", client_secret: "fb-app-secret", fb_exchange_token: "fb-user-short" });
    expect(net.calls[2]).toMatchObject({ path: "https://graph.facebook.com/v27.0/me/accounts", query: { fields: "id,name,access_token", limit: "100", access_token: "fb-user-long" } });
    expect(net.calls.every((c) => !c.url.includes("fb-app-secret"))).toBe(true);
    expect(signedIn.account).toBeUndefined();
    expect(signedIn.base).toBe(LOCAL);
    expect(listAccounts().length).toBe(before);

    const waiting = pendingChoice(signedIn.choice!)!;
    expect(waiting).toEqual({
      id: signedIn.choice,
      platform: "facebook",
      name: "Facebook Page",
      prompt: "Pick the Pages to connect. Each becomes its own account.",
      multiple: true,
      choices: [
        { id: "111", name: "Press Room" },
        { id: "222", name: "Bindery" },
      ],
    });
    // What the dialog is given names the Pages and nothing else.
    expect(JSON.stringify(waiting)).not.toMatch(/page-token|fb-user/);
  });

  it("connects each Page picked as its own account, holding that Page's token and nothing of the sign-in", async () => {
    const net = facebookNet(twoPages);
    const { choice } = await finishOAuth("facebook", begin("facebook", app).state, "fb-code", net.fetcher);
    await expect(choose(choice!, [], net.fetcher)).rejects.toThrow("Pick at least one.");
    await expect(choose(choice!, ["999"], net.fetcher)).rejects.toThrow("That was not one of the choices offered.");
    const { connected, failed } = await choose(choice!, ["111", "222"], net.fetcher);
    expect(failed).toEqual([]);
    expect(connected.map((a) => [a.platform, a.handle])).toEqual([["facebook", "Press Room"], ["facebook", "Bindery"]]);
    expect(credentialsOf(connected[0].id)).toEqual({ page_id: "111", access_token: "page-token-111" });
    expect(credentialsOf(connected[1].id)).toEqual({ page_id: "222", access_token: "page-token-222" });
    // The choice is used up, and it never doubles as a sign-in state.
    await expect(choose(choice!, ["111"], net.fetcher)).rejects.toThrow(/run out or was already made/);
    expect(pendingChoice(choice!)).toBeUndefined();

    const post = await createPost({ content: "to the press room", targets: [{ account_id: connected[0].id }] }, net.fetcher);
    expect(post.status).toBe("published");
    expect(net.calls.at(-1)).toMatchObject({ path: "https://graph.facebook.com/111/feed" });
    expect(net.calls.at(-1)!.body).toEqual({ message: "to the press room", access_token: "page-token-111" });
  });

  it("keeps a state and a choice apart, and a choice lasts ten minutes", async () => {
    const net = facebookNet(twoPages);
    const { state } = begin("facebook", app);
    expect(pendingChoice(state)).toBeUndefined();
    await expect(choose(state, ["111"], net.fetcher)).rejects.toThrow(/run out or was already made/);
    const { choice } = await finishOAuth("facebook", state, "fb-code", net.fetcher);
    await expect(finishOAuth("facebook", choice!, "fb-code", net.fetcher)).rejects.toThrow(/not started here/);
    run("UPDATE oauth_pending SET expires_at = ? WHERE state = ?", PAST, choice!);
    expect(pendingChoice(choice!)).toBeUndefined();
    await expect(choose(choice!, ["111"], net.fetcher)).rejects.toThrow(/run out or was already made/);
  });

  it("follows Facebook's paging, and says so when there is no Page to connect", async () => {
    const paged = facebookNet([], (call) => {
      if (call.path !== "https://graph.facebook.com/v27.0/me/accounts") return undefined;
      return call.query.after === "next" ? { data: [twoPages[1]] } : { data: [twoPages[0]], paging: { next: "https://graph.facebook.com/v27.0/me/accounts?access_token=fb-user-long&after=next" } };
    });
    const { choice } = await finishOAuth("facebook", begin("facebook", app).state, "fb-code", paged.fetcher);
    expect(pendingChoice(choice!)!.choices.map((c) => c.name)).toEqual(["Press Room", "Bindery"]);
    const none = facebookNet([]);
    await expect(finishOAuth("facebook", begin("facebook", app).state, "fb-code", none.fetcher)).rejects.toThrow(/Facebook listed no Pages for this sign-in/);
  });

  it("reports Facebook's own reason when the code is refused", async () => {
    const net = facebookNet([], (call) => (call.path === TOKEN_URL ? refused({ error: { message: "Error validating verification code. Please make sure your redirect_uri is identical to the one you used in the OAuth dialog request", type: "OAuthException", code: 100 } }) : undefined));
    await expect(finishOAuth("facebook", begin("facebook", app).state, "bad", net.fetcher)).rejects.toThrow(/Facebook Page did not complete the sign-in: Error validating verification code/);
  });

  it("still connects with a pasted Page id and Page token", async () => {
    const net = facebookNet(twoPages);
    const account = await connectAccount("facebook", { page_id: "222", access_token: "page-token-pasted" }, net.fetcher);
    expect(account.handle).toBe("Bindery");
    expect(credentialsOf(account.id)).toEqual({ page_id: "222", access_token: "page-token-pasted" });
  });
});

describe("Instagram", () => {
  const app = { app_id: "iid", app_secret: "ig-app-secret" };
  const TOKEN_URL = "https://graph.facebook.com/v27.0/oauth/access_token";
  const linked: Record<string, { id: string; username: string } | undefined> = { "111": { id: "17841400000000001", username: "pressroom" }, "222": undefined, "333": { id: "17841400000000003", username: "bindery" } };
  const instagramNet = () =>
    network((call) => {
      if (call.path === TOKEN_URL) return (call.body as { grant_type: string }).grant_type === "fb_exchange_token" ? { access_token: "ig-user-long" } : { access_token: "ig-user-short" };
      if (call.path.endsWith("/me/accounts")) return { data: Object.keys(linked).map((id) => ({ id, name: `Page ${id}`, access_token: `page-token-${id}` })) };
      const page = Object.keys(linked).find((id) => call.path === `https://graph.facebook.com/v27.0/${id}`);
      if (page) return linked[page] ? { instagram_business_account: linked[page], id: page } : { id: page };
      const account = Object.values(linked).find((a) => a && call.path.endsWith(`/${a.id}`));
      return account ? { username: account.username } : {};
    });

  it("sends the browser to Facebook for the Instagram scopes", () => {
    const { address, params } = begin("instagram", app);
    expect(address).toBe("https://www.facebook.com/v27.0/dialog/oauth");
    expect(params).toEqual({ client_id: "iid", response_type: "code", scope: "instagram_basic,instagram_content_publish,instagram_manage_comments,pages_show_list,pages_read_engagement", redirect_uri: "http://localhost:3000/oauth/instagram/callback", state: STATE });
  });

  it("finds the Instagram account behind each Page, offers those, and connects the ones picked with their Page's token", async () => {
    const net = instagramNet();
    const { choice } = await finishOAuth("instagram", begin("instagram", app).state, "ig-code", net.fetcher);
    expect(net.calls[0].body).toEqual({ client_id: "iid", client_secret: "ig-app-secret", code: "ig-code", grant_type: "authorization_code", redirect_uri: "http://localhost:3000/oauth/instagram/callback" });
    expect(net.calls[1].body).toEqual({ grant_type: "fb_exchange_token", client_id: "iid", client_secret: "ig-app-secret", fb_exchange_token: "ig-user-short" });
    expect(net.calls[3]).toMatchObject({ path: "https://graph.facebook.com/v27.0/111", query: { fields: "instagram_business_account{id,username}", access_token: "page-token-111" } });
    expect(pendingChoice(choice!)!.choices).toEqual([
      { id: "17841400000000001", name: "@pressroom", detail: "Linked to the Page Page 111" },
      { id: "17841400000000003", name: "@bindery", detail: "Linked to the Page Page 333" },
    ]);
    const { connected } = await choose(choice!, ["17841400000000003"], net.fetcher);
    expect(connected.map((a) => a.handle)).toEqual(["@bindery"]);
    expect(credentialsOf(connected[0].id)).toEqual({ ig_user_id: "17841400000000003", access_token: "page-token-333" });
    expect(net.calls.every((c) => !c.url.includes("ig-app-secret"))).toBe(true);
  });

  it("says so when no Page has an Instagram account behind it, and still connects with pasted values", async () => {
    const none = network((call) => {
      if (call.path === TOKEN_URL) return { access_token: "ig-user" };
      if (call.path.endsWith("/me/accounts")) return { data: [{ id: "222", name: "Bindery", access_token: "page-token-222" }] };
      return { id: "222" };
    });
    await expect(finishOAuth("instagram", begin("instagram", app).state, "ig-code", none.fetcher)).rejects.toThrow(/Facebook listed no Instagram professional account/);
    const net = instagramNet();
    const account = await connectAccount("instagram", { ig_user_id: "17841400000000001", access_token: "ig-pasted" }, net.fetcher);
    expect(account.handle).toBe("@pressroom");
  });
});

/* YouTube ------------------------------------------------------------------ */

describe("YouTube", () => {
  const app = { client_id: "yid", client_secret: "yt-app-secret" };
  let issued = 0;
  const google = (overrides: (call: Call) => unknown = () => undefined) =>
    network((call) => {
      const special = overrides(call);
      if (special !== undefined) return special;
      if (call.path === "https://oauth2.googleapis.com/token") {
        issued++;
        const first = (call.body as { grant_type: string }).grant_type === "authorization_code";
        return { access_token: `yt-access-${issued}`, expires_in: 3599, scope: "https://www.googleapis.com/auth/youtube.upload", token_type: "Bearer", ...(first ? { refresh_token: `yt-refresh-${issued}` } : {}) };
      }
      if (call.path === "https://www.googleapis.com/youtube/v3/channels") return { items: [{ snippet: { title: "The Print Shop" } }] };
      if (call.path === "https://www.googleapis.com/upload/youtube/v3/videos") return new Response(null, { status: 200, headers: { location: "https://upload.youtube.example/session" } });
      return { id: "vid9" };
    });

  it("sends the browser to Google asking for offline access, so a refresh token comes back", () => {
    const { address, params } = begin("youtube", app);
    expect(address).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(params).toEqual({
      client_id: "yid",
      response_type: "code",
      scope: "https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly",
      redirect_uri: "http://localhost:3000/oauth/youtube/callback",
      state: STATE,
      access_type: "offline",
      prompt: "consent",
    });
  });

  it("exchanges the code, connects the signed-in account's channel, and renews the hour-long token before uploading", async () => {
    const net = google();
    const account = await anAccount(finishOAuth("youtube", begin("youtube", app).state, "yt-code", net.fetcher));
    expect(net.calls[0]).toMatchObject({ url: "https://oauth2.googleapis.com/token", method: "POST", auth: null });
    expect(net.calls[0].body).toEqual({ client_id: "yid", client_secret: "yt-app-secret", code: "yt-code", grant_type: "authorization_code", redirect_uri: "http://localhost:3000/oauth/youtube/callback" });
    expect(net.calls[1]).toMatchObject({ path: "https://www.googleapis.com/youtube/v3/channels", query: { part: "snippet", mine: "true" }, auth: expect.stringMatching(/^Bearer yt-access-/) });
    expect(account.handle).toBe("The Print Shop");
    const first = credentialsOf(account.id);
    expect(first).toMatchObject({ client_id: "yid", client_secret: "yt-app-secret" });
    expect(first.refresh_token).toMatch(/^yt-refresh-/);

    expire(account.id);
    const clip = saveMedia(new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]), "clip.mp4", "video/mp4");
    const from = net.calls.length;
    const post = await createPost({ content: "A film\nAbout printing", targets: [{ account_id: account.id }], media_ids: [clip.id] }, net.fetcher);
    expect(post.status).toBe("published");
    const sent = net.calls.slice(from);
    expect(sent[0]).toMatchObject({ url: "https://oauth2.googleapis.com/token", method: "POST" });
    expect(sent[0].body).toEqual({ client_id: "yid", client_secret: "yt-app-secret", grant_type: "refresh_token", refresh_token: first.refresh_token });
    const stored = credentialsOf(account.id);
    expect(sent[1]).toMatchObject({ path: "https://www.googleapis.com/upload/youtube/v3/videos", auth: `Bearer ${stored.access_token}` });
    // Google does not rotate refresh tokens: the same one stays, beside the new access token and its expiry.
    expect(stored.refresh_token).toBe(first.refresh_token);
    expect(stored.access_token).not.toBe(first.access_token);
    expect(Date.parse(stored.expires_at)).toBeGreaterThan(Date.now());
  });

  it("refuses to connect a channel it could not keep, and reports Google's own reasons", async () => {
    const before = listAccounts().length;
    const noRefresh = google((call) => (call.path.endsWith("/token") ? { access_token: "yt-once", expires_in: 3599 } : undefined));
    await expect(finishOAuth("youtube", begin("youtube", app).state, "yt-code", noRefresh.fetcher)).rejects.toThrow(/Google returned no refresh token/);
    const badCode = google((call) => (call.path.endsWith("/token") ? refused({ error: "invalid_grant", error_description: "Malformed auth code." }) : undefined));
    await expect(finishOAuth("youtube", begin("youtube", app).state, "bad", badCode.fetcher)).rejects.toThrow("YouTube did not complete the sign-in: Malformed auth code.");
    expect(listAccounts().length).toBe(before);
  });

  it("reports Google's reason when a refresh token has stopped working, as one from an app in Testing does after 7 days", async () => {
    const net = google();
    const account = await anAccount(finishOAuth("youtube", begin("youtube", app).state, "yt-code", net.fetcher));
    expire(account.id);
    const clip = saveMedia(new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]), "clip.mp4", "video/mp4");
    const dead = google((call) => (call.path.endsWith("/token") ? refused({ error: "invalid_grant", error_description: "Token has been expired or revoked." }) : undefined));
    const post = await createPost({ content: "A film", targets: [{ account_id: account.id }], media_ids: [clip.id] }, dead.fetcher);
    expect(post.targets[0].error).toBe("YouTube would not renew the sign-in: Token has been expired or revoked. Reconnect the account.");
    expect(getAccount(account.id)!.status).toBe("needs_attention");
  });

  it("still connects with a pasted client id, secret and refresh token", async () => {
    const net = google();
    const account = await connectAccount("youtube", { client_id: "yid", client_secret: "yt-app-secret", refresh_token: "yt-pasted-refresh" }, net.fetcher);
    expect(net.calls[0].body).toEqual({ client_id: "yid", client_secret: "yt-app-secret", grant_type: "refresh_token", refresh_token: "yt-pasted-refresh" });
    expect(account.handle).toBe("The Print Shop");
    expect(credentialsOf(account.id).refresh_token).toBe("yt-pasted-refresh");
  });
});

/* Pinterest ---------------------------------------------------------------- */

describe("Pinterest", () => {
  const app = { app_id: "pid", app_secret: "pin-app-secret" };
  let issued = 0;
  const boards = [
    { id: "b-1", name: "Type specimens", privacy: "PUBLIC" },
    { id: "b-2", name: "Drafts", privacy: "SECRET" },
  ];
  const pinterestNet = (overrides: (call: Call) => unknown = () => undefined) =>
    network((call) => {
      const special = overrides(call);
      if (special !== undefined) return special;
      if (call.path === "https://api.pinterest.com/v5/oauth/token") {
        issued++;
        return { access_token: `pina-${issued}`, refresh_token: `pinr-${issued}`, token_type: "bearer", expires_in: 2592000, refresh_token_expires_in: 5184000, scope: "boards:read pins:write user_accounts:read" };
      }
      if (call.path === "https://api.pinterest.com/v5/boards") return call.query.bookmark ? { items: [boards[1]], bookmark: null } : { items: [boards[0]], bookmark: "page-2" };
      if (call.path === "https://api.pinterest.com/v5/user_account") return { username: "printer" };
      return { id: "pin-77" };
    });

  it("sends the browser to Pinterest for the scopes that read boards and write pins", () => {
    const { address, params } = begin("pinterest", app);
    expect(address).toBe("https://www.pinterest.com/oauth/");
    expect(params).toEqual({ client_id: "pid", response_type: "code", scope: "boards:read,pins:write,user_accounts:read", redirect_uri: "http://localhost:3000/oauth/pinterest/callback", state: STATE });
  });

  it("exchanges the code with a Basic header, lists every board, and connects the one picked", async () => {
    const net = pinterestNet();
    const { choice, account } = await finishOAuth("pinterest", begin("pinterest", app).state, "pin-code", net.fetcher);
    expect(account).toBeUndefined();
    expect(net.calls[0]).toMatchObject({ url: "https://api.pinterest.com/v5/oauth/token", method: "POST", auth: basic("pid", "pin-app-secret") });
    expect(net.calls[0].body).toEqual({ continuous_refresh: "true", code: "pin-code", grant_type: "authorization_code", redirect_uri: "http://localhost:3000/oauth/pinterest/callback" });
    expect(net.calls[1]).toMatchObject({ path: "https://api.pinterest.com/v5/boards", query: { page_size: "100" }, auth: expect.stringMatching(/^Bearer pina-/) });
    expect(net.calls[2]).toMatchObject({ path: "https://api.pinterest.com/v5/boards", query: { page_size: "100", bookmark: "page-2" } });
    const waiting = pendingChoice(choice!)!;
    expect(waiting).toMatchObject({ platform: "pinterest", multiple: false, prompt: "Pick the board to pin to." });
    expect(waiting.choices).toEqual([
      { id: "b-1", name: "Type specimens" },
      { id: "b-2", name: "Drafts", detail: "Not public" },
    ]);
    expect(JSON.stringify(waiting)).not.toMatch(/pina-|pinr-|pin-app-secret/);
    await expect(choose(choice!, ["b-1", "b-2"], net.fetcher)).rejects.toThrow("Pinterest connects one at a time. Pick one.");
    const { connected } = await choose(choice!, ["b-1"], net.fetcher);
    expect(connected[0].handle).toBe("@printer, Type specimens");
    expect(credentialsOf(connected[0].id)).toMatchObject({ app_id: "pid", app_secret: "pin-app-secret", board_id: "b-1", board_name: "Type specimens", username: "printer" });
  });

  it("renews a run-out token before pinning, and keeps the refresh token Pinterest rotated to", async () => {
    const net = pinterestNet();
    const { choice } = await finishOAuth("pinterest", begin("pinterest", app).state, "pin-code", net.fetcher);
    const account = (await choose(choice!, ["b-2"], net.fetcher)).connected[0];
    expire(account.id);
    const spent = credentialsOf(account.id).refresh_token;
    const image = saveMedia(new Uint8Array([137, 80, 78, 71]), "specimen.png", "image/png");
    const from = net.calls.length;
    const post = await createPost({ content: "A specimen", targets: [{ account_id: account.id }], media_ids: [image.id] }, net.fetcher);
    expect(post.status).toBe("published");
    const sent = net.calls.slice(from);
    expect(sent[0]).toMatchObject({ url: "https://api.pinterest.com/v5/oauth/token", method: "POST", auth: basic("pid", "pin-app-secret") });
    expect(sent[0].body).toEqual({ grant_type: "refresh_token", refresh_token: spent });
    const stored = credentialsOf(account.id);
    expect(sent[1]).toMatchObject({ path: "https://api.pinterest.com/v5/pins", auth: `Bearer ${stored.access_token}` });
    expect(sent[1].body).toMatchObject({ board_id: "b-2", description: "A specimen" });
    expect(stored.refresh_token).toMatch(/^pinr-/);
    expect(stored.refresh_token).not.toBe(spent);
    expect(Math.round((Date.parse(stored.expires_at) - Date.now()) / 86_400_000)).toBe(30);
  });

  it("reports Pinterest's own reason when the code is refused, and says so when there is no board", async () => {
    const badCode = pinterestNet((call) => (call.path.endsWith("/oauth/token") ? refused({ code: 283, message: "Authorization code invalid or expired." }) : undefined));
    await expect(finishOAuth("pinterest", begin("pinterest", app).state, "bad", badCode.fetcher)).rejects.toThrow("Pinterest did not complete the sign-in: Authorization code invalid or expired.");
    const noBoards = pinterestNet((call) => (call.path.endsWith("/boards") ? { items: [], bookmark: null } : undefined));
    await expect(finishOAuth("pinterest", begin("pinterest", app).state, "pin-code", noBoards.fetcher)).rejects.toThrow(/has no boards/);
  });

  it("still connects with a pasted token and board id", async () => {
    const net = pinterestNet();
    const account = await connectAccount("pinterest", { access_token: "pin-pasted", board_id: "b-1" }, net.fetcher);
    expect(net.calls[0]).toMatchObject({ path: "https://api.pinterest.com/v5/user_account", auth: "Bearer pin-pasted" });
    expect(account.handle).toBe("@printer");
    expect(connector("pinterest")!.oauth!.paste.required).toEqual(["access_token", "board_id"]);
  });
});
