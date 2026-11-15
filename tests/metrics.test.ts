import { afterEach, describe, expect, it, vi } from "vitest";
import { connector, connectors, describe as describeConnector } from "@/lib/platforms";
import { counted, PublishError, waitAsked, type Metric } from "@/lib/platforms/types";

/**
 * One test group per network that reports numbers: the exact request its
 * `metrics` makes, a response shaped as the network documents it turned into
 * counts, and the network's own error passed on. Then the networks that
 * report nothing, which must say so and never return a number.
 */

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };

/** A fetch that answers from a function and remembers every request, so a test can assert the exact wire format. */
function fake(answers: (call: Call, index: number) => unknown | Response) {
  const calls: Call[] = [];
  const fetcher = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => (headers[k] = v));
    let body: unknown = init.body;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        /* keep text */
      }
    } else if (body instanceof URLSearchParams) body = Object.fromEntries(body);
    const call = { url: String(input), method: init.method ?? "GET", headers, body };
    calls.push(call);
    const answer = answers(call, calls.length - 1);
    return answer instanceof Response ? answer : Response.json(answer);
  }) as typeof fetch;
  return { fetcher, calls };
}

const refuse = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const metricsOf = (id: string) => connector(id)!.metrics!;
const m = (kind: Metric["kind"], label: string, value: number): Metric => ({ kind, label, value });
const failure = async (work: Promise<unknown>): Promise<PublishError> => {
  const error = await work.catch((e) => e);
  expect(error).toBeInstanceOf(PublishError);
  return error as PublishError;
};

afterEach(() => vi.useRealTimers());

describe("the metrics capability", () => {
  it("is declared by every connector one way or the other: numbers to read, or the reason there are none", () => {
    for (const c of connectors) {
      if (c.metrics) {
        expect(Object.keys(c.reports ?? {}).length, c.id).toBeGreaterThan(0);
        expect(c.noMetrics, c.id).toBeUndefined();
      } else {
        expect(c.noMetrics, c.id).toMatch(/\.$/);
        expect(c.reports, c.id).toBeUndefined();
      }
    }
    expect(connectors.filter((c) => c.metrics).map((c) => c.id)).toEqual(["x", "bluesky", "threads", "mastodon", "instagram", "facebook", "tiktok", "youtube", "pinterest", "reddit", "discord", "lemmy", "devto", "listmonk"]);
  });

  it("tells the UI and agents which counts a network reports, under the network's own words", () => {
    expect(describeConnector(connector("mastodon")!).metrics).toEqual({
      available: true,
      reports: [
        { kind: "likes", label: "Favourites" },
        { kind: "comments", label: "Replies" },
        { kind: "shares", label: "Boosts" },
        { kind: "quotes", label: "Quotes" },
      ],
      reason: null,
    });
    expect(describeConnector(connector("telegram")!).metrics).toEqual({ available: false, reports: [], reason: "Telegram's Bot API has no way to ask for a message's views or reactions." });
  });

  it("keeps only the counts a network sent as numbers, and never fills one in", () => {
    expect(counted({ views: "Views", likes: "Likes", comments: "Comments" }, { views: "1024", likes: undefined, comments: null, shares: 9 })).toEqual([m("views", "Views", 1024)]);
    expect(counted({ likes: "Likes" }, { likes: 0 })).toEqual([m("likes", "Likes", 0)]);
    expect(counted({ likes: "Likes" }, { likes: "many" })).toEqual([]);
  });

  it("reads how long a rate-limited answer asks callers to wait, however the network says it", () => {
    const now = Date.parse("2026-11-15T12:00:00Z");
    expect(waitAsked(new Headers({ "retry-after": "120" }), now)).toBe(120);
    expect(waitAsked(new Headers({ "retry-after": "Sun, 15 Nov 2026 12:05:00 GMT" }), now)).toBe(300);
    // X and Bluesky send the Unix time the limit resets; Mastodon sends a timestamp; Reddit sends seconds from now.
    expect(waitAsked(new Headers({ "x-rate-limit-reset": String(now / 1000 + 900) }), now)).toBe(900);
    expect(waitAsked(new Headers({ "ratelimit-reset": String(now / 1000 + 30) }), now)).toBe(30);
    expect(waitAsked(new Headers({ "x-ratelimit-reset": "2026-11-15T12:02:00.000Z" }), now)).toBe(120);
    expect(waitAsked(new Headers({ "x-ratelimit-reset": "45" }), now)).toBe(45);
    expect(waitAsked(new Headers({}), now)).toBeUndefined();
  });
});

describe("Mastodon metrics", () => {
  const c = { instance: "https://example.social/", access_token: "tok" };
  const status = { id: "109", created_at: "2026-11-01T10:00:00.000Z", visibility: "public", replies_count: 2, reblogs_count: 5, favourites_count: 11, quotes_count: 1, content: "<p>hi</p>" };

  it("reads the status and its counts", async () => {
    const { fetcher, calls } = fake(() => status);
    const result = await metricsOf("mastodon")({ id: "109" }, c, { fetch: fetcher });
    expect(calls).toEqual([{ url: "https://example.social/api/v1/statuses/109", method: "GET", headers: { authorization: "Bearer tok" }, body: undefined }]);
    expect(result.metrics).toEqual([m("likes", "Favourites", 11), m("comments", "Replies", 2), m("shares", "Boosts", 5), m("quotes", "Quotes", 1)]);
  });

  it("reports no quotes for an instance older than 4.5, which does not count them", async () => {
    const { fetcher } = fake(() => ({ id: "109", replies_count: 0, reblogs_count: 0, favourites_count: 0 }));
    expect((await metricsOf("mastodon")({ id: "109" }, c, { fetch: fetcher })).metrics.map((x) => x.kind)).toEqual(["likes", "comments", "shares"]);
  });

  it("reads a public status without the token when the token lacks read:statuses", async () => {
    const { fetcher, calls } = fake((call) => (call.headers.authorization ? refuse(403, { error: "This action is outside the authorized scopes" }) : status));
    const result = await metricsOf("mastodon")({ id: "109" }, c, { fetch: fetcher });
    expect(calls.map((call) => call.headers)).toEqual([{ authorization: "Bearer tok" }, {}]);
    expect(result.metrics[0]).toEqual(m("likes", "Favourites", 11));
  });

  it("passes on Mastodon's own error, and says which scope a private post needs", async () => {
    const gone = fake(() => refuse(404, { error: "Record not found" }));
    expect((await failure(metricsOf("mastodon")({ id: "1" }, c, { fetch: gone.fetcher }))).message).toBe("Mastodon answered 404: Record not found");
    const refused = fake((call) => (call.headers.authorization ? refuse(403, { error: "This action is outside the authorized scopes" }) : refuse(404, { error: "Record not found" })));
    const error = await failure(metricsOf("mastodon")({ id: "1" }, c, { fetch: refused.fetcher }));
    expect(error.message).toMatch(/^Mastodon answered 403: This action is outside the authorized scopes Add the scope read:statuses/);
    expect(error.status).toBe(403);
  });
});

describe("Bluesky metrics", () => {
  const c = { identifier: "me.bsky.social", app_password: "pw" };
  const uri = "at://did:plc:abc/app.bsky.feed.post/3kxyz";

  it("signs in, asks for the post by its at:// address and reads the counts on the post view", async () => {
    const { fetcher, calls } = fake(({ url }) =>
      url.endsWith("createSession")
        ? { accessJwt: "jwt", did: "did:plc:abc", handle: "me.bsky.social" }
        : { posts: [{ uri, cid: "bafyrei", author: { did: "did:plc:abc", handle: "me.bsky.social" }, record: { text: "hi" }, replyCount: 1, repostCount: 2, likeCount: 7, quoteCount: 0, indexedAt: "2026-11-01T10:00:00.000Z" }] },
    );
    const result = await metricsOf("bluesky")({ id: uri }, c, { fetch: fetcher });
    expect(calls[0].body).toEqual({ identifier: "me.bsky.social", password: "pw" });
    expect(calls[1]).toEqual({ url: "https://bsky.social/xrpc/app.bsky.feed.getPosts?uris=at%3A%2F%2Fdid%3Aplc%3Aabc%2Fapp.bsky.feed.post%2F3kxyz", method: "GET", headers: { authorization: "Bearer jwt" }, body: undefined });
    expect(result.metrics).toEqual([m("likes", "Likes", 7), m("comments", "Replies", 1), m("shares", "Reposts", 2), m("quotes", "Quotes", 0)]);
  });

  it("says so when the post is gone, and passes on a rate limit with the wait Bluesky names", async () => {
    const gone = fake(({ url }) => (url.endsWith("createSession") ? { accessJwt: "jwt", did: "did:plc:abc", handle: "h" } : { posts: [] }));
    expect((await failure(metricsOf("bluesky")({ id: uri }, c, { fetch: gone.fetcher }))).message).toBe("Bluesky returned no post for this address. It may have been deleted.");
    const reset = Math.floor(Date.now() / 1000) + 600;
    const limited = fake(() => refuse(429, { error: "RateLimitExceeded", message: "Rate Limit Exceeded" }, { "ratelimit-reset": String(reset) }));
    const error = await failure(metricsOf("bluesky")({ id: uri }, c, { fetch: limited.fetcher }));
    expect(error.message).toBe("Bluesky answered 429: Rate Limit Exceeded");
    expect(error.status).toBe(429);
    expect(error.retryAfter).toBeGreaterThan(590);
    expect(error.retryAfter).toBeLessThanOrEqual(600);
  });
});

describe("X metrics", () => {
  const keys = { api_key: "k", api_secret: "s", access_token: "t", access_secret: "ts", username: "me" };
  // The example from X's metrics guide.
  const tweet = { data: { id: "1234567890", text: "Hello world!", edit_history_tweet_ids: ["1234567890"], public_metrics: { retweet_count: 50, reply_count: 12, like_count: 234, quote_count: 8, bookmark_count: 15, impression_count: 5432 } } };

  it("asks for the post's public_metrics, signed as the account", async () => {
    const { fetcher, calls } = fake(() => tweet);
    const result = await metricsOf("x")({ id: "1234567890" }, keys, { fetch: fetcher });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.x.com/2/tweets/1234567890?tweet.fields=public_metrics");
    expect(calls[0].method).toBe("GET");
    expect(calls[0].headers.authorization).toMatch(/^OAuth oauth_consumer_key="k".*oauth_signature="/);
    expect(result.metrics).toEqual([m("impressions", "Impressions", 5432), m("likes", "Likes", 234), m("comments", "Replies", 12), m("shares", "Reposts", 50), m("quotes", "Quotes", 8), m("saves", "Bookmarks", 15)]);
    expect(result.credentials).toBeUndefined();
  });

  it("renews a signed-in account's token first and hands the rotated one back to be saved", async () => {
    const { fetcher, calls } = fake(({ url }) => (url.endsWith("/oauth2/token") ? { token_type: "bearer", expires_in: 7200, access_token: "x-access-2", refresh_token: "x-refresh-2" } : tweet));
    const result = await metricsOf("x")({ id: "1234567890" }, { client_id: "cid", client_secret: "sec", refresh_token: "x-refresh-1", username: "me" }, { fetch: fetcher });
    expect(calls[0].body).toEqual({ grant_type: "refresh_token", refresh_token: "x-refresh-1" });
    expect(calls[1].headers.authorization).toBe("Bearer x-access-2");
    expect(result.credentials?.refresh_token).toBe("x-refresh-2");
    expect(result.metrics[0]).toEqual(m("impressions", "Impressions", 5432));
  });

  it("reports X's own reason: a post it will not show, a refusal, and a rate limit with its reset time", async () => {
    const hidden = fake(() => ({ errors: [{ title: "Not Found Error", detail: "Could not find tweet with id: [1].", resource_type: "tweet" }] }));
    expect((await failure(metricsOf("x")({ id: "1" }, keys, { fetch: hidden.fetcher }))).message).toBe("X returned no counts for this post: Could not find tweet with id: [1].");
    const refused = fake(() => refuse(403, { title: "Forbidden", detail: "You are not permitted to perform this action.", status: 403 }));
    expect((await failure(metricsOf("x")({ id: "1" }, keys, { fetch: refused.fetcher }))).message).toBe("X answered 403: You are not permitted to perform this action.");
    const limited = fake(() => refuse(429, { title: "Too Many Requests", detail: "Too Many Requests", status: 429 }, { "x-rate-limit-reset": String(Math.floor(Date.now() / 1000) + 900) }));
    const error = await failure(metricsOf("x")({ id: "1" }, keys, { fetch: limited.fetcher }));
    expect(error.status).toBe(429);
    expect(error.retryAfter).toBeGreaterThan(880);
  });
});

/** One entry of a Meta insights answer, as Threads, Instagram and Facebook all shape it. */
const entry = (name: string, value: number, id = "1") => ({ name, period: "lifetime", values: [{ value }], title: name, description: "", id: `${id}/insights/${name}/lifetime` });
const noPermission = () => refuse(400, { error: { message: "(#10) Application does not have permission for this action", type: "OAuthException", code: 10, fbtrace_id: "A1" } });

describe("Threads metrics", () => {
  it("asks for the post's insights and reads each lifetime value", async () => {
    const { fetcher, calls } = fake(() => ({ data: [entry("views", 900), entry("likes", 100), entry("replies", 10), entry("reposts", 4), entry("quotes", 1)] }));
    const result = await metricsOf("threads")({ id: "18028" }, { access_token: "th token", user_id: "1" }, { fetch: fetcher });
    expect(calls).toEqual([{ url: "https://graph.threads.net/v1.0/18028/insights?metric=views,likes,replies,reposts,quotes&access_token=th%20token", method: "GET", headers: {}, body: undefined }]);
    expect(result.metrics).toEqual([m("views", "Views", 900), m("likes", "Likes", 100), m("comments", "Replies", 10), m("shares", "Reposts", 4), m("quotes", "Quotes", 1)]);
  });

  it("leaves out a metric Threads did not send, and names the permission when Threads refuses", async () => {
    const some = fake(() => ({ data: [entry("likes", 3)] }));
    expect((await metricsOf("threads")({ id: "1" }, { access_token: "t" }, { fetch: some.fetcher })).metrics).toEqual([m("likes", "Likes", 3)]);
    const refused = fake(noPermission);
    const error = await failure(metricsOf("threads")({ id: "1" }, { access_token: "t" }, { fetch: refused.fetcher }));
    expect(error.message).toBe("Threads answered 400: (#10) Application does not have permission for this action Reading numbers needs the permission threads_manage_insights. If this account was connected without it, reconnect it.");
  });
});

describe("Instagram metrics", () => {
  it("asks for the media's insights and reads views, likes, comments, shares and saves", async () => {
    const { fetcher, calls } = fake(() => ({ data: [entry("views", 1500), entry("likes", 210), entry("comments", 14), entry("shares", 9), entry("saved", 31)] }));
    const result = await metricsOf("instagram")({ id: "17932174733377207" }, { ig_user_id: "178", access_token: "ig-token" }, { fetch: fetcher });
    expect(calls).toEqual([{ url: "https://graph.facebook.com/17932174733377207/insights?metric=views,likes,comments,shares,saved&access_token=ig-token", method: "GET", headers: {}, body: undefined }]);
    expect(result.metrics).toEqual([m("views", "Views", 1500), m("likes", "Likes", 210), m("comments", "Comments", 14), m("shares", "Shares", 9), m("saves", "Saves", 31)]);
  });

  it("reports nothing for an empty answer, and names the permission when Instagram refuses", async () => {
    // Instagram answers with an empty set, not zeros, while it has no data for a post.
    const empty = fake(() => ({ data: [] }));
    expect((await metricsOf("instagram")({ id: "1" }, { access_token: "t" }, { fetch: empty.fetcher })).metrics).toEqual([]);
    const error = await failure(metricsOf("instagram")({ id: "1" }, { access_token: "t" }, { fetch: fake(noPermission).fetcher }));
    expect(error.message).toMatch(/^Instagram answered 400: \(#10\) Application does not have permission for this action Reading numbers needs the permission instagram_manage_insights\./);
  });
});

describe("Facebook Page metrics", () => {
  const c = { page_id: "111", access_token: "page-token" };
  const post = { id: "111_222", shares: { count: 4 }, reactions: { data: [], summary: { total_count: 31 } }, comments: { data: [], summary: { order: "chronological", total_count: 6, can_comment: true } } };

  it("reads the post's reaction, comment and share totals, then its views and clicks from insights", async () => {
    const { fetcher, calls } = fake(({ url }) => (url.includes("/insights") ? { data: [entry("post_media_view", 880), entry("post_clicks", 17)] } : post));
    const result = await metricsOf("facebook")({ id: "111_222" }, c, { fetch: fetcher });
    expect(calls.map((call) => [call.method, call.url])).toEqual([
      ["GET", "https://graph.facebook.com/111_222?fields=shares,reactions.summary(total_count).limit(0),comments.summary(true).limit(0)&access_token=page-token"],
      ["GET", "https://graph.facebook.com/111_222/insights?metric=post_media_view,post_clicks&access_token=page-token"],
    ]);
    expect(result.metrics).toEqual([m("views", "Views", 880), m("likes", "Reactions", 31), m("comments", "Comments", 6), m("shares", "Shares", 4), m("clicks", "Clicks", 17)]);
    expect(result.note).toBeUndefined();
  });

  it("keeps the engagement counts and says what is missing when a Page was connected without read_insights", async () => {
    const { fetcher } = fake(({ url }) => (url.includes("/insights") ? refuse(403, { error: { message: "(#200) Requires read_insights permission", type: "OAuthException", code: 200 } }) : { id: "111_222", reactions: { summary: { total_count: 2 } }, comments: { summary: { total_count: 0 } } }));
    const result = await metricsOf("facebook")({ id: "111_222" }, c, { fetch: fetcher });
    // A post nobody shared comes back without `shares`.
    expect(result.metrics).toEqual([m("likes", "Reactions", 2), m("comments", "Comments", 0), m("shares", "Shares", 0)]);
    expect(result.note).toBe("Views and clicks were not read. Facebook answered 403: (#200) Requires read_insights permission They need the permission read_insights. If this Page was connected without it, reconnect it.");
  });

  it("passes on Facebook's own error when the post itself cannot be read", async () => {
    const { fetcher } = fake(() => refuse(400, { error: { message: "Unsupported get request. Object with ID '111_9' does not exist", type: "GraphMethodException", code: 100 } }));
    expect((await failure(metricsOf("facebook")({ id: "111_9" }, c, { fetch: fetcher }))).message).toBe("Facebook answered 400: Unsupported get request. Object with ID '111_9' does not exist");
  });
});

describe("YouTube metrics", () => {
  const c = { client_id: "cid", client_secret: "sec", refresh_token: "yt-refresh", access_token: "yt-access", expires_at: new Date(Date.now() + 3_000_000).toISOString() };

  it("lists the video's statistics, which arrive as strings of digits", async () => {
    const { fetcher, calls } = fake(() => ({ kind: "youtube#videoListResponse", items: [{ kind: "youtube#video", id: "dQw4w9WgXcQ", statistics: { viewCount: "1024", likeCount: "77", favoriteCount: "0", commentCount: "9" } }] }));
    const result = await metricsOf("youtube")({ id: "dQw4w9WgXcQ" }, c, { fetch: fetcher });
    expect(calls).toEqual([{ url: "https://www.googleapis.com/youtube/v3/videos?part=statistics&id=dQw4w9WgXcQ", method: "GET", headers: { authorization: "Bearer yt-access" }, body: undefined }]);
    expect(result.metrics).toEqual([m("views", "Views", 1024), m("likes", "Likes", 77), m("comments", "Comments", 9)]);
  });

  it("renews an hour-old token first and hands the new one back", async () => {
    const { fetcher, calls } = fake(({ url }) => (url.includes("oauth2.googleapis.com") ? { access_token: "yt-access-2", expires_in: 3599, token_type: "Bearer" } : { items: [{ statistics: { viewCount: "5" } }] }));
    const result = await metricsOf("youtube")({ id: "v" }, { ...c, expires_at: new Date(Date.now() - 1000).toISOString() }, { fetch: fetcher });
    expect(calls[1].headers.authorization).toBe("Bearer yt-access-2");
    expect(result.credentials?.access_token).toBe("yt-access-2");
    expect(result.metrics).toEqual([m("views", "Views", 5)]);
  });

  it("says so when the video is gone, and passes on Google's own refusal with the scope it needs", async () => {
    expect((await failure(metricsOf("youtube")({ id: "v" }, c, { fetch: fake(() => ({ items: [] })).fetcher }))).message).toBe("YouTube returned no video for this id. It may have been deleted.");
    const refused = fake(() => refuse(403, { error: { code: 403, message: "Request had insufficient authentication scopes.", status: "PERMISSION_DENIED" } }));
    expect((await failure(metricsOf("youtube")({ id: "v" }, c, { fetch: refused.fetcher }))).message).toMatch(/^YouTube answered 403: Request had insufficient authentication scopes\. Reading numbers needs the scope youtube\.readonly\./);
  });
});

describe("TikTok metrics", () => {
  const c = { client_key: "ck", client_secret: "cs", refresh_token: "tt-refresh-1" };
  const token = { access_token: "act.1", refresh_token: "tt-refresh-2", expires_in: 86400, open_id: "o", scope: "user.info.basic,video.publish,video.list", token_type: "Bearer" };
  // A post id is 19 digits, more than a JavaScript number holds, so the stand-in sends it as raw text the way TikTok does.
  const status = (state: string, ids: string) => new Response(`{"data":{"status":"${state}","publicaly_available_post_id":[${ids}],"uploaded_bytes":10000},"error":{"code":"ok","message":"","log_id":"2026"}}`, { headers: { "content-type": "application/json" } });

  it("finds the public post behind the upload, then asks for that video's counts", async () => {
    const { fetcher, calls } = fake(({ url }) => {
      if (url.endsWith("/oauth/token/")) return token;
      if (url.endsWith("/status/fetch/")) return status("PUBLISH_COMPLETE", "7325786486870552578");
      return { data: { videos: [{ id: "7325786486870552578", like_count: 120, comment_count: 8, share_count: 3, view_count: 4500 }] }, error: { code: "ok", message: "", log_id: "2026" } };
    });
    const result = await metricsOf("tiktok")({ id: "v_pub_url~v2.123456789" }, c, { fetch: fetcher });
    expect(calls[0].body).toEqual({ client_key: "ck", client_secret: "cs", grant_type: "refresh_token", refresh_token: "tt-refresh-1" });
    expect(calls[1]).toEqual({ url: "https://open.tiktokapis.com/v2/post/publish/status/fetch/", method: "POST", headers: { authorization: "Bearer act.1", "content-type": "application/json; charset=UTF-8" }, body: { publish_id: "v_pub_url~v2.123456789" } });
    expect(calls[2].url).toBe("https://open.tiktokapis.com/v2/video/query/?fields=id,like_count,comment_count,share_count,view_count");
    expect(calls[2].method).toBe("POST");
    // The id reaches TikTok digit for digit.
    expect(calls[2].body).toEqual({ filters: { video_ids: ["7325786486870552578"] } });
    expect(result.metrics).toEqual([m("views", "Views", 4500), m("likes", "Likes", 120), m("comments", "Comments", 8), m("shares", "Shares", 3)]);
    expect(result.credentials?.refresh_token).toBe("tt-refresh-2");
  });

  it("says a draft in the inbox has no numbers yet, and still hands back the rotated token", async () => {
    const { fetcher, calls } = fake(({ url }) => (url.endsWith("/oauth/token/") ? token : status("SEND_TO_USER_INBOX", "")));
    const error = await failure(metricsOf("tiktok")({ id: "p1" }, c, { fetch: fetcher }));
    expect(error.message).toBe("This post is a draft in your TikTok inbox. TikTok reports numbers once you publish it there and it is public.");
    expect(error.credentials?.refresh_token).toBe("tt-refresh-2");
    expect(calls).toHaveLength(2);
  });

  it("passes on TikTok's own refusal and names the scope when the app lacks video.list", async () => {
    const { fetcher } = fake(({ url }) => {
      if (url.endsWith("/oauth/token/")) return token;
      if (url.endsWith("/status/fetch/")) return status("PUBLISH_COMPLETE", "7325786486870552578");
      return refuse(401, { data: {}, error: { code: "scope_not_authorized", message: "The user did not authorize the scope required for completing this request.", log_id: "2026" } });
    });
    const error = await failure(metricsOf("tiktok")({ id: "p1" }, c, { fetch: fetcher }));
    expect(error.message).toMatch(/^TikTok answered 401: The user did not authorize the scope required for completing this request\. Reading numbers needs the scope video\.list\./);
  });
});

describe("Pinterest metrics", () => {
  const c = { access_token: "pin-token", board_id: "b1" };
  const answer = { all: { lifetime_metrics: {}, daily_metrics: [{ date: "2026-11-01", data_status: "READY", metrics: { IMPRESSION: 10, OUTBOUND_CLICK: 1, PIN_CLICK: 2, SAVE: 1 } }], summary_metrics: { IMPRESSION: 240, OUTBOUND_CLICK: 20, PIN_CLICK: 37, SAVE: 12 } } };

  it("asks for the pin's analytics from the day it was published to today, and reads the summary", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-15T12:00:00Z"));
    const { fetcher, calls } = fake(() => answer);
    const result = await metricsOf("pinterest")({ id: "813744226420795884", publishedAt: "2026-11-01T08:00:00.000Z" }, c, { fetch: fetcher });
    expect(calls).toEqual([
      { url: "https://api.pinterest.com/v5/pins/813744226420795884/analytics?start_date=2026-11-01&end_date=2026-11-15&metric_types=IMPRESSION,OUTBOUND_CLICK,PIN_CLICK,SAVE", method: "GET", headers: { authorization: "Bearer pin-token" }, body: undefined },
    ]);
    expect(result.metrics).toEqual([m("impressions", "Impressions", 240), m("saves", "Saves", 12), m("clicks", "Pin clicks", 37)]);
    expect(result.note).toBeUndefined();
  });

  it("counts an older pin over the 90 days Pinterest allows, and says so", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-15T12:00:00Z"));
    const { fetcher, calls } = fake(() => answer);
    const result = await metricsOf("pinterest")({ id: "8", publishedAt: "2026-01-01T08:00:00.000Z" }, c, { fetch: fetcher });
    expect(new URL(calls[0].url).searchParams.get("start_date")).toBe("2026-08-18");
    expect(result.note).toBe("Pinterest reports the last 90 days only, so these numbers leave out anything earlier.");
  });

  it("passes on Pinterest's own refusal and names the permission", async () => {
    const { fetcher } = fake(() => refuse(403, { code: 7, message: "Not authorized to access the board or Pin." }));
    expect((await failure(metricsOf("pinterest")({ id: "8" }, c, { fetch: fetcher }))).message).toBe(
      "Pinterest answered 403: Not authorized to access the board or Pin. Reading numbers needs the permission pins:read. If this account was connected without it, reconnect it.",
    );
  });
});

describe("Reddit metrics", () => {
  const c = { client_id: "id", client_secret: "sec", username: "me", password: "pw", subreddit: "test" };

  it("signs in, asks for the post by its full name and reads its score and comment count", async () => {
    const { fetcher, calls } = fake(({ url }) =>
      url.endsWith("/access_token") ? { access_token: "rt", token_type: "bearer" } : { kind: "Listing", data: { children: [{ kind: "t3", data: { name: "t3_1abcde", score: 42, ups: 42, downs: 0, upvote_ratio: 0.93, num_comments: 7, view_count: null } }] } },
    );
    const result = await metricsOf("reddit")({ id: "t3_1abcde" }, c, { fetch: fetcher });
    expect(calls[1]).toEqual({ url: "https://oauth.reddit.com/api/info?id=t3_1abcde&raw_json=1", method: "GET", headers: { authorization: "Bearer rt", "user-agent": "broadside/0.1 (by /u/me)" }, body: undefined });
    // A score is not a count of likes, so it is its own kind.
    expect(result.metrics).toEqual([m("comments", "Comments", 7), m("score", "Score", 42)]);
  });

  it("says so when Reddit lists nothing for the id, and passes on its own error", async () => {
    const gone = fake(({ url }) => (url.endsWith("/access_token") ? { access_token: "rt" } : { kind: "Listing", data: { children: [] } }));
    expect((await failure(metricsOf("reddit")({ id: "t3_x" }, c, { fetch: gone.fetcher }))).message).toBe("Reddit returned no post for this id. It may have been deleted.");
    const limited = fake(({ url }) => (url.endsWith("/access_token") ? { access_token: "rt" } : refuse(429, { message: "Too Many Requests", error: 429 }, { "x-ratelimit-reset": "240" })));
    const error = await failure(metricsOf("reddit")({ id: "t3_x" }, c, { fetch: limited.fetcher }));
    expect(error.message).toBe("Reddit answered 429: Too Many Requests");
    expect(error.retryAfter).toBe(240);
  });
});

describe("Lemmy metrics", () => {
  const c = { instance: "https://lemmy.example/", username: "me", password: "pw", community: "tech" };

  it("signs in and reads the post's counts", async () => {
    const { fetcher, calls } = fake(({ url }) =>
      url.endsWith("/user/login") ? { jwt: "jwt" } : { post_view: { post: { id: 55, name: "A title" }, counts: { post_id: 55, comments: 3, score: 9, upvotes: 10, downvotes: 1, published: "2026-11-01T10:00:00Z" } }, community_view: {} },
    );
    const result = await metricsOf("lemmy")({ id: "55" }, c, { fetch: fetcher });
    expect(calls[1]).toEqual({ url: "https://lemmy.example/api/v3/post?id=55", method: "GET", headers: { authorization: "Bearer jwt" }, body: undefined });
    expect(result.metrics).toEqual([m("likes", "Upvotes", 10), m("comments", "Comments", 3), m("score", "Score", 9)]);
  });

  it("passes on Lemmy's own error", async () => {
    const { fetcher } = fake(({ url }) => (url.endsWith("/user/login") ? { jwt: "jwt" } : refuse(404, { error: "couldnt_find_post" })));
    expect((await failure(metricsOf("lemmy")({ id: "9" }, c, { fetch: fetcher }))).message).toBe("Lemmy answered 404: couldnt_find_post");
  });
});

describe("DEV metrics", () => {
  it("finds the article in the list of your published ones and reads its reaction count", async () => {
    const { fetcher, calls } = fake(() => [
      { type_of: "article", id: 150588, title: "Other", positive_reactions_count: 1, public_reactions_count: 1 },
      { type_of: "article", id: 150589, title: "Mine", positive_reactions_count: 12, public_reactions_count: 14, comments_count: 3, page_views_count: 900 },
    ]);
    const result = await metricsOf("devto")({ id: "150589" }, { api_key: "key" }, { fetch: fetcher });
    expect(calls).toEqual([{ url: "https://dev.to/api/articles/me/published?per_page=1000&page=1", method: "GET", headers: { "api-key": "key" }, body: undefined }]);
    // Only the count DEV documents is read. The other two fields are not in its documented answer.
    expect(result.metrics).toEqual([m("likes", "Reactions", 14)]);
  });

  it("says so when the article is not listed, and passes on DEV's own error", async () => {
    expect((await failure(metricsOf("devto")({ id: "1" }, { api_key: "key" }, { fetch: fake(() => []).fetcher }))).message).toBe("DEV did not list this article among your published ones. It may have been unpublished or deleted.");
    const refused = fake(() => refuse(401, { error: "unauthorized", status: 401 }));
    expect((await failure(metricsOf("devto")({ id: "1" }, { api_key: "bad" }, { fetch: refused.fetcher }))).message).toBe("DEV answered 401: unauthorized");
  });
});

describe("Discord metrics", () => {
  const c = { webhook_url: "https://discord.com/api/webhooks/1/tok", guild_id: "g" };

  it("reads back the webhook's own message and adds up its reactions", async () => {
    const { fetcher, calls } = fake(() => ({
      id: "9988",
      channel_id: "c1",
      content: "hi",
      reactions: [
        { count: 3, count_details: { burst: 0, normal: 3 }, me: false, emoji: { id: null, name: "🔥" } },
        { count: 2, count_details: { burst: 1, normal: 1 }, me: false, emoji: { id: null, name: "👍" } },
      ],
    }));
    const result = await metricsOf("discord")({ id: "9988" }, c, { fetch: fetcher });
    expect(calls).toEqual([{ url: "https://discord.com/api/webhooks/1/tok/messages/9988", method: "GET", headers: {}, body: undefined }]);
    expect(result.metrics).toEqual([m("likes", "Reactions", 5)]);
  });

  it("reports no reactions for a message that has none, and passes on Discord's own error", async () => {
    expect((await metricsOf("discord")({ id: "1" }, c, { fetch: fake(() => ({ id: "1", content: "hi" })).fetcher })).metrics).toEqual([m("likes", "Reactions", 0)]);
    const gone = fake(() => refuse(404, { message: "Unknown Message", code: 10008 }));
    expect((await failure(metricsOf("discord")({ id: "1" }, c, { fetch: gone.fetcher }))).message).toBe("Discord answered 404: Unknown Message");
  });
});

describe("networks with no numbers to read", () => {
  it("have no metrics method at all, and say why in a sentence", () => {
    const reasons = Object.fromEntries(connectors.filter((c) => !c.metrics).map((c) => [c.id, c.noMetrics]));
    expect(Object.keys(reasons).sort()).toEqual(["ghost", "kick", "linkedin", "nostr", "sandbox", "slack", "telegram", "tumblr", "twitch", "webhook", "wordpress"]);
    expect(reasons.linkedin).toBe("LinkedIn gives post statistics only to apps it has approved for its Community Management API. An app with Share on LinkedIn alone cannot read them.");
    expect(reasons.nostr).toMatch(/^Nostr keeps no count for a note\./);
    expect(reasons.sandbox).toBe("The sandbox publishes nowhere, so there is nothing to count.");
  });
});
