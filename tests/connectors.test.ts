import { schnorr } from "@noble/curves/secp256k1.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { connector, connectors, fits, measure, problems, threadProblems } from "@/lib/platforms";
import { facets } from "@/lib/platforms/bluesky";
import { apiVersion, escapeLittleText } from "@/lib/platforms/linkedin";
import { nostrEvent, nostrSecret, replyTags, titleAndBody } from "@/lib/platforms/more";
import type { MediaItem, PartRef, PublishInput, ReplyInput } from "@/lib/platforms/types";
import { PublishError } from "@/lib/platforms/types";
import { oauth1 } from "@/lib/platforms/x";

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };

/** A fetch that answers from a table and remembers every request, so a test can assert the exact wire format. */
function fake(answers: (call: Call) => unknown | Response) {
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
    else if (body instanceof FormData) body = Object.fromEntries([...body.entries()].map(([k, v]) => [k, typeof v === "string" ? v : `file:${(v as File).name}`]));
    const call = { url: String(input), method: init.method ?? "GET", headers, body };
    calls.push(call);
    const answer = answers(call);
    return answer instanceof Response ? answer : Response.json(answer);
  }) as typeof fetch;
  return { fetcher, calls };
}

const png: MediaItem = {
  id: "med_1",
  type: "image",
  contentType: "image/png",
  filename: "sheet.png",
  alt: "A printed sheet",
  read: async () => new Uint8Array([137, 80, 78, 71]),
  publicUrl: "https://files.example/sheet.png",
};
const mp4: MediaItem = { ...png, id: "med_2", type: "video", contentType: "video/mp4", filename: "clip.mp4", publicUrl: "https://files.example/clip.mp4" };
const post = (text: string, media: MediaItem[] = [], options: Record<string, unknown> = {}): PublishInput => ({ text, media, options });
const get = (id: string) => connector(id)!;
/** One later part of a thread. With only a root it is the first reply; with a parent it answers that part. */
const part = (text: string, root: PartRef, parent?: PartRef, options: Record<string, unknown> = {}): ReplyInput => ({ text, index: parent ? 2 : 1, root, parent: parent ?? root, options });

describe("registry", () => {
  it("lists every network once, each with setup steps and fields", () => {
    expect(new Set(connectors.map((c) => c.id)).size).toBe(connectors.length);
    expect(connectors.length).toBeGreaterThanOrEqual(19);
    for (const c of connectors) {
      expect(c.setup.length, c.id).toBeGreaterThan(0);
      expect(c.fields.length, c.id).toBeGreaterThan(0);
      expect(c.limits.maxChars, c.id).toBeGreaterThan(0);
    }
  });
});

describe("measuring and refusing", () => {
  it("counts graphemes, and weights links and wide characters the way X does", () => {
    expect(measure("héllo 👨‍👩‍👧", "graphemes")).toBe(7);
    expect(measure("read https://example.com/a/very/long/path/that/keeps/going", "weighted")).toBe(5 + 23);
    expect(measure("日本", "weighted")).toBe(4);
    expect(measure("ok 👍", "weighted")).toBe(5);
  });

  it("names the limit and the measured length instead of trimming", () => {
    expect(problems(get("x"), "a".repeat(281), [])).toEqual(["X allows 280 characters; this is 281."]);
    expect(problems(get("bluesky"), "a".repeat(300), [])).toEqual([]);
  });

  it("refuses missing or unsupported media in plain words", () => {
    expect(problems(get("instagram"), "caption", [])).toContain("Instagram needs an image or a video.");
    expect(problems(get("youtube"), "title", [])).toContain("YouTube needs a video.");
    expect(problems(get("reddit"), "t", [{ type: "image", hasPublicUrl: true }])).toContain("Reddit does not take images here.");
    expect(problems(get("bluesky"), "t", Array(5).fill({ type: "image", hasPublicUrl: false }))).toContain("Bluesky allows 4 images; this has 5.");
    expect(problems(get("threads"), "t", [{ type: "image", hasPublicUrl: false }])[0]).toMatch(/public URL/);
    expect(problems(get("mastodon"), "  ", [])).toEqual(["The post is empty."]);
  });
});

describe("Bluesky", () => {
  it("marks links and hashtags with UTF-8 byte offsets", () => {
    const found = facets("café https://a.co/x #news");
    expect(found[0]).toEqual({ index: { byteStart: 6, byteEnd: 20 }, features: [{ $type: "app.bsky.richtext.facet#link", uri: "https://a.co/x" }] });
    expect(found[1]).toEqual({ index: { byteStart: 21, byteEnd: 26 }, features: [{ $type: "app.bsky.richtext.facet#tag", tag: "news" }] });
  });

  it("logs in, uploads the blob and creates the record", async () => {
    const { fetcher, calls } = fake(({ url }) => {
      if (url.endsWith("createSession")) return { accessJwt: "jwt", did: "did:plc:abc", handle: "me.bsky.social" };
      if (url.endsWith("uploadBlob")) return { blob: { ref: "blobref" } };
      return { uri: "at://did:plc:abc/app.bsky.feed.post/3kxyz" };
    });
    const result = await get("bluesky").publish(post("hello", [png]), { identifier: "me.bsky.social", app_password: "pw" }, { fetch: fetcher });
    expect(result.url).toBe("https://bsky.app/profile/me.bsky.social/post/3kxyz");
    expect(calls[0].body).toEqual({ identifier: "me.bsky.social", password: "pw" });
    expect(calls[1].headers["content-type"]).toBe("image/png");
    const record = (calls[2].body as { repo: string; collection: string; record: Record<string, unknown> });
    expect(record.repo).toBe("did:plc:abc");
    expect(record.collection).toBe("app.bsky.feed.post");
    expect(record.record.text).toBe("hello");
    expect(record.record.embed).toEqual({ $type: "app.bsky.embed.images", images: [{ alt: "A printed sheet", image: { ref: "blobref" } }] });
    expect(calls[2].headers.authorization).toBe("Bearer jwt");
  });
});

describe("Mastodon", () => {
  it("uploads media then posts the status to the user's own instance", async () => {
    const { fetcher, calls } = fake(({ url }) => (url.endsWith("/api/v2/media") ? { id: "m1" } : { id: "9", url: "https://example.social/@me/9" }));
    const result = await get("mastodon").publish(post("hi", [png], { visibility: "unlisted" }), { instance: "https://example.social/", access_token: "tok" }, { fetch: fetcher });
    expect(result).toEqual({ id: "9", url: "https://example.social/@me/9" });
    expect(calls[0].url).toBe("https://example.social/api/v2/media");
    expect(calls[0].body).toEqual({ file: "file:sheet.png", description: "A printed sheet" });
    expect(calls[1].body).toEqual({ status: "hi", media_ids: ["m1"], visibility: "unlisted" });
    expect(calls[1].headers.authorization).toBe("Bearer tok");
  });
});

describe("X", () => {
  it("signs requests as OAuth 1.0a specifies (the published example vector)", () => {
    const header = oauth1(
      "POST",
      "https://api.twitter.com/1.1/statuses/update.json?include_entities=true&status=Hello%20Ladies%20%2B%20Gentlemen%2C%20a%20signed%20OAuth%20request%21",
      {
        api_key: "xvz1evFS4wEEPTGEFPHBog",
        api_secret: "kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw",
        access_token: "370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb",
        access_secret: "LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE",
      },
      { nonce: "kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg", timestamp: "1318622958" },
    );
    expect(header).toContain('oauth_signature="hCtSmYh%2BiHYCEqBWrE7C7hYmtUk%3D"');
  });

  it("uploads images then creates the post with their ids", async () => {
    const { fetcher, calls } = fake(({ url }) => (url.endsWith("/media/upload") ? { data: { id: "m7" } } : { data: { id: "1790" } }));
    const creds = { api_key: "k", api_secret: "s", access_token: "t", access_secret: "ts", username: "me" };
    const result = await get("x").publish(post("hello", [png]), creds, { fetch: fetcher });
    expect(result.url).toBe("https://x.com/me/status/1790");
    expect(calls[0].body).toEqual({ media: "file:sheet.png", media_category: "tweet_image" });
    expect(calls[1].url).toBe("https://api.x.com/2/tweets");
    expect(calls[1].body).toEqual({ text: "hello", media: { media_ids: ["m7"] } });
    expect(calls[1].headers.authorization).toMatch(/^OAuth oauth_consumer_key="k"/);
  });
});

describe("LinkedIn", () => {
  it("uses a released API version and escapes little-text syntax", () => {
    expect(apiVersion(new Date("2026-01-15T00:00:00Z"))).toBe("202511");
    expect(apiVersion(new Date("2026-11-15T00:00:00Z"))).toBe("202609");
    expect(escapeLittleText("C# (fast) @you")).toBe("C\\# \\(fast\\) \\@you");
  });

  it("uploads the image, posts, and reads the id from the response header", async () => {
    const { fetcher, calls } = fake(({ url, method }) => {
      if (url.includes("initializeUpload")) return { value: { uploadUrl: "https://upload.li/1", image: "urn:li:image:1" } };
      if (method === "PUT") return new Response(null, { status: 201 });
      return new Response(null, { status: 201, headers: { "x-restli-id": "urn:li:share:77" } });
    });
    const result = await get("linkedin").publish(post("Shipping (today)", [png]), { access_token: "t", author: "urn:li:person:p" }, { fetch: fetcher });
    expect(result).toEqual({ id: "urn:li:share:77", url: "https://www.linkedin.com/feed/update/urn:li:share:77/" });
    const body = calls[2].body as Record<string, unknown>;
    expect(body.author).toBe("urn:li:person:p");
    expect(body.commentary).toBe("Shipping \\(today\\)");
    expect(body.content).toEqual({ media: { id: "urn:li:image:1", altText: "A printed sheet" } });
    expect(calls[2].headers["linkedin-version"]).toMatch(/^\d{6}$/);
    expect(calls[2].headers["x-restli-protocol-version"]).toBe("2.0.0");
  });
});

describe("Meta networks", () => {
  it("Threads: creates a text container, publishes it and returns the permalink", async () => {
    const { fetcher, calls } = fake(({ url }) => {
      if (url.endsWith("/u1/threads")) return { id: "c1" };
      if (url.endsWith("/threads_publish")) return { id: "t1" };
      if (url.includes("fields=permalink")) return { permalink: "https://www.threads.net/@me/post/abc" };
      return { access_token: "fresh" };
    });
    const result = await get("threads").publish(post("hello"), { access_token: "tok", user_id: "u1" }, { fetch: fetcher });
    expect(calls[0].body).toEqual({ media_type: "TEXT", text: "hello", access_token: "tok" });
    expect(calls[1].body).toEqual({ creation_id: "c1", access_token: "tok" });
    expect(result.url).toBe("https://www.threads.net/@me/post/abc");
    expect(result.credentials?.access_token).toBe("fresh");
  });

  it("Instagram: waits for the container, then publishes it", async () => {
    const { fetcher, calls } = fake(({ url }) => {
      if (url.endsWith("/ig1/media")) return { id: "c9" };
      if (url.includes("status_code")) return { status_code: "FINISHED" };
      if (url.endsWith("/media_publish")) return { id: "p9" };
      return { permalink: "https://www.instagram.com/p/xyz/" };
    });
    const result = await get("instagram").publish(post("caption", [png]), { ig_user_id: "ig1", access_token: "tok" }, { fetch: fetcher });
    expect(calls[0].body).toEqual({ image_url: "https://files.example/sheet.png", alt_text: "A printed sheet", caption: "caption", access_token: "tok" });
    expect(calls[2].body).toEqual({ creation_id: "c9", access_token: "tok" });
    expect(result).toEqual({ id: "p9", url: "https://www.instagram.com/p/xyz/" });
  });

  it("Instagram: says what to do when media has no public address", async () => {
    const { fetcher } = fake(() => ({}));
    await expect(get("instagram").publish(post("c", [{ ...png, publicUrl: undefined }]), { ig_user_id: "ig1", access_token: "t" }, { fetch: fetcher })).rejects.toThrow(/BROADSIDE_PUBLIC_URL/);
  });

  it("Facebook: uploads unpublished photos and attaches them to the feed post", async () => {
    const { fetcher, calls } = fake(({ url }) => (url.endsWith("/photos") ? { id: "ph1" } : { id: "pg_55", permalink_url: "https://www.facebook.com/pg/posts/55" }));
    const result = await get("facebook").publish(post("news", [png]), { page_id: "pg", access_token: "tok" }, { fetch: fetcher });
    expect(calls[0].body).toEqual({ source: "file:sheet.png", published: "false", access_token: "tok" });
    expect(calls[1].body).toEqual({ message: "news", access_token: "tok", "attached_media[0]": '{"media_fbid":"ph1"}' });
    expect(result.url).toBe("https://www.facebook.com/pg/posts/55");
  });
});

describe("chat and webhooks", () => {
  it("Telegram: sends a photo with the caption and builds the public link", async () => {
    const { fetcher, calls } = fake(() => ({ ok: true, result: { message_id: 42, chat: { username: "chan" } } }));
    const result = await get("telegram").publish(post("hi", [png]), { bot_token: "1:A", chat_id: "@chan" }, { fetch: fetcher });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.telegram.org/bot1:A/sendPhoto");
    expect(calls[0].body).toEqual({ chat_id: "@chan", photo: "file:sheet.png", caption: "hi" });
    expect(result).toEqual({ id: "42", url: "https://t.me/chan/42" });
  });

  it("Telegram: a caption too long for a photo goes out as its own message", async () => {
    const { fetcher, calls } = fake(() => ({ ok: true, result: { message_id: 1, chat: {} } }));
    await get("telegram").publish(post("a".repeat(1500), [png]), { bot_token: "1:A", chat_id: "-100" }, { fetch: fetcher });
    expect(calls.map((c) => c.url.split("/").pop())).toEqual(["sendPhoto", "sendMessage"]);
  });

  it("Discord: waits for the message and links to it", async () => {
    const { fetcher, calls } = fake(() => ({ id: "m1", channel_id: "c1" }));
    const result = await get("discord").publish(post("yo"), { webhook_url: "https://discord.com/api/webhooks/1/t", guild_id: "g1" }, { fetch: fetcher });
    expect(calls[0].url).toBe("https://discord.com/api/webhooks/1/t?wait=true");
    expect(calls[0].body).toEqual({ content: "yo" });
    expect(result.url).toBe("https://discord.com/channels/g1/c1/m1");
  });

  it("Slack: posts text, with image blocks when media is attached", async () => {
    const { fetcher, calls } = fake(() => new Response("ok"));
    await get("slack").publish(post("launch", [png]), { webhook_url: "https://hooks.slack.com/services/T/B/X" }, { fetch: fetcher });
    const body = calls[0].body as { text: string; blocks: { type: string }[] };
    expect(body.text).toBe("launch");
    expect(body.blocks.map((b) => b.type)).toEqual(["section", "image"]);
  });

  it("Webhook: signs the body and reads back the id and url", async () => {
    const { fetcher, calls } = fake(() => ({ id: "ext-1", url: "https://example.com/p/1" }));
    const result = await get("webhook").publish(post("hi"), { url: "https://example.com/hook", secret: "s3" }, { fetch: fetcher });
    expect(calls[0].headers["x-broadside-signature"]).toMatch(/^[0-9a-f]{64}$/);
    expect(result).toEqual({ id: "ext-1", url: "https://example.com/p/1" });
  });
});

describe("long-form and communities", () => {
  it("takes the first line as the title unless one is given", () => {
    expect(titleAndBody("Title here\n\nBody text", {}, 100)).toEqual({ title: "Title here", body: "Body text" });
    expect(titleAndBody("Body only", { title: "Given" }, 100)).toEqual({ title: "Given", body: "Body only" });
  });

  it("Reddit: gets a token, then submits a self post", async () => {
    const { fetcher, calls } = fake(({ url }) =>
      url.includes("access_token") ? { access_token: "rt" } : { json: { errors: [], data: { name: "t3_abc", url: "https://www.reddit.com/r/test/comments/abc/" } } },
    );
    const creds = { client_id: "id", client_secret: "sec", username: "me", password: "pw", subreddit: "r/test" };
    const result = await get("reddit").publish(post("My title\nThe body"), creds, { fetch: fetcher });
    expect(calls[0].headers.authorization).toBe(`Basic ${Buffer.from("id:sec").toString("base64")}`);
    expect(calls[1].body).toEqual({ api_type: "json", kind: "self", sr: "test", title: "My title", text: "The body" });
    expect(result.id).toBe("t3_abc");
  });

  it("DEV: publishes an article with the key header", async () => {
    const { fetcher, calls } = fake(() => ({ id: 5, url: "https://dev.to/me/post-5" }));
    const result = await get("devto").publish(post("Hello DEV\nBody", [], { tags: "a, b" }), { api_key: "k" }, { fetch: fetcher });
    expect(calls[0].headers["api-key"]).toBe("k");
    expect(calls[0].body).toEqual({ article: { title: "Hello DEV", body_markdown: "Body", published: true, tags: ["a", "b"] } });
    expect(result.url).toBe("https://dev.to/me/post-5");
  });

  it("Lemmy: logs in, finds the community and posts", async () => {
    const { fetcher, calls } = fake(({ url }) => {
      if (url.endsWith("/user/login")) return { jwt: "j" };
      if (url.includes("/community?")) return { community_view: { community: { id: 12 } } };
      return { post_view: { post: { id: 99 } } };
    });
    const result = await get("lemmy").publish(post("Title\nBody"), { instance: "https://lemmy.example", username: "me", password: "pw", community: "tech" }, { fetch: fetcher });
    expect(calls[2].body).toEqual({ community_id: 12, name: "Title", body: "Body" });
    expect(result.url).toBe("https://lemmy.example/post/99");
  });

  it("Pinterest: sends the image as base64 to the chosen board", async () => {
    const { fetcher, calls } = fake(() => ({ id: "777" }));
    const result = await get("pinterest").publish(post("A pin", [png], { title: "T" }), { access_token: "t", board_id: "b1" }, { fetch: fetcher });
    const body = calls[0].body as { board_id: string; media_source: { source_type: string; data: string } };
    expect(body.board_id).toBe("b1");
    expect(body.media_source.source_type).toBe("image_base64");
    expect(body.media_source.data).toBe(Buffer.from([137, 80, 78, 71]).toString("base64"));
    expect(result.url).toBe("https://www.pinterest.com/pin/777");
  });
});

describe("video networks", () => {
  it("TikTok: refreshes the session, opens an upload and sends the bytes", async () => {
    const { fetcher, calls } = fake(({ url }) => {
      if (url.endsWith("/oauth/token/")) return { access_token: "at", refresh_token: "rt2" };
      if (url.includes("/video/init/")) return { data: { publish_id: "pub1", upload_url: "https://upload.tiktok.example/1" } };
      return {};
    });
    const result = await get("tiktok").publish(post("clip", [mp4], { publish_mode: "direct" }), { client_key: "ck", client_secret: "cs", refresh_token: "rt" }, { fetch: fetcher });
    expect(calls[1].url).toBe("https://open.tiktokapis.com/v2/post/publish/video/init/");
    const init = calls[1].body as { post_info: { title: string; privacy_level: string }; source_info: Record<string, unknown> };
    expect(init.post_info).toMatchObject({ title: "clip", privacy_level: "SELF_ONLY" });
    expect(init.source_info).toEqual({ source: "FILE_UPLOAD", video_size: 4, chunk_size: 4, total_chunk_count: 1 });
    expect(calls[2].headers["content-range"]).toBe("bytes 0-3/4");
    expect(result.id).toBe("pub1");
    expect(result.credentials?.refresh_token).toBe("rt2");
  });

  it("TikTok: a draft goes to the inbox endpoint", async () => {
    const { fetcher, calls } = fake(({ url }) => {
      if (url.endsWith("/oauth/token/")) return { access_token: "at" };
      if (url.includes("/inbox/video/init/")) return { data: { publish_id: "pub2", upload_url: "https://upload.tiktok.example/2" } };
      return {};
    });
    await get("tiktok").publish(post("clip", [mp4]), { client_key: "ck", client_secret: "cs", refresh_token: "rt" }, { fetch: fetcher });
    expect(calls[1].url).toBe("https://open.tiktokapis.com/v2/post/publish/inbox/video/init/");
  });

  it("YouTube: opens a resumable session and uploads to it", async () => {
    const { fetcher, calls } = fake(({ url, method }) => {
      if (url.includes("oauth2.googleapis.com")) return { access_token: "ya" };
      if (method === "POST") return new Response(null, { status: 200, headers: { location: "https://upload.youtube.example/session" } });
      return { id: "vid123" };
    });
    const result = await get("youtube").publish(post("My video\nAbout it", [mp4], { privacy: "unlisted" }), { client_id: "c", client_secret: "s", refresh_token: "r" }, { fetch: fetcher });
    expect(calls[1].body).toEqual({
      snippet: { title: "My video", description: "About it", categoryId: "22" },
      status: { privacyStatus: "unlisted", selfDeclaredMadeForKids: false },
    });
    expect(calls[1].headers["x-upload-content-length"]).toBe("4");
    expect(calls[2].url).toBe("https://upload.youtube.example/session");
    expect(result.url).toBe("https://www.youtube.com/watch?v=vid123");
  });
});

describe("Nostr", () => {
  it("builds a kind-1 event whose id and signature verify", () => {
    const secret = nostrSecret("0000000000000000000000000000000000000000000000000000000000000003");
    const event = nostrEvent(secret, "hello nostr", 1700000000);
    expect(event.kind).toBe(1);
    expect(event.pubkey).toBe("f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9");
    expect(schnorr.verify(Buffer.from(event.sig, "hex"), Buffer.from(event.id, "hex"), Buffer.from(event.pubkey, "hex"))).toBe(true);
  });

  it("rejects a key that is neither nsec nor hex", () => {
    expect(() => nostrSecret("not-a-key")).toThrow(PublishError);
  });
});

describe("errors", () => {
  it("quotes the network's own message and marks rate limits as retryable", async () => {
    const { fetcher } = fake(() => Response.json({ error: "Too many requests" }, { status: 429 }));
    const error = await get("mastodon").publish(post("hi"), { instance: "https://m.example", access_token: "t" }, { fetch: fetcher }).catch((e) => e);
    expect(error).toBeInstanceOf(PublishError);
    expect(error.message).toBe("Mastodon answered 429: Too many requests");
    expect(error.retryable).toBe(true);
  });

  it("does not retry a rejected post", async () => {
    const { fetcher } = fake(() => Response.json({ error: { message: "Invalid token" } }, { status: 401 }));
    const error = await get("facebook").publish(post("hi"), { page_id: "p", access_token: "t" }, { fetch: fetcher }).catch((e) => e);
    expect(error.message).toBe("Facebook answered 401: Invalid token");
    expect(error.retryable).toBe(false);
  });
});

describe("threads: which networks take one", () => {
  it("offers reply on the networks that can thread or comment, and names the ones that cannot", () => {
    expect(connectors.filter((c) => c.reply).map((c) => c.id)).toEqual(["x", "bluesky", "threads", "mastodon", "linkedin", "instagram", "facebook", "reddit", "telegram", "nostr", "lemmy", "sandbox"]);
    expect(threadProblems(fits(get("discord")), ["a comment"])).toEqual(["Discord cannot post a thread from a webhook."]);
    expect(threadProblems(fits(get("slack")), ["a comment"])).toEqual(["Slack cannot post a thread from an incoming webhook."]);
    for (const id of ["tiktok", "youtube", "pinterest", "devto", "webhook"]) expect(threadProblems(fits(get(id)), ["a comment"]), id).toEqual([`${get(id).name} cannot post a thread.`]);
    // No thread, no objection.
    expect(threadProblems(fits(get("discord")), [])).toEqual([]);
  });

  it("measures every part the way the network counts, against its limit for a reply", () => {
    expect(threadProblems(fits(get("x")), ["a".repeat(280), "a".repeat(281)])).toEqual(["X allows 280 characters in a reply; part 3 is 281."]);
    // X counts a link as 23 whatever its length, in a reply as in a post.
    expect(threadProblems(fits(get("x")), [`${"a".repeat(256)} https://example.com/${"p".repeat(80)}`])).toEqual([]);
    expect(threadProblems(fits(get("linkedin")), ["a".repeat(1251)])).toEqual(["LinkedIn allows 1250 characters in a reply; part 2 is 1251."]);
    expect(threadProblems(fits(get("mastodon")), ["fine", " "])).toEqual(["Part 3 of the thread is empty."]);
    // The composer lets a part stand empty while it is being written, and still measures the rest.
    expect(threadProblems(fits(get("mastodon")), ["", "a".repeat(501)], true)).toEqual(["Mastodon allows 500 characters in a reply; part 3 is 501."]);
    expect(threadProblems(fits(get("sandbox")), Array(25).fill("p"))).toEqual(["A thread can have 25 parts; this has 26."]);
  });
});

describe("threads: replying to a post", () => {
  const root: PartRef = { id: "100" };
  const previous: PartRef = { id: "101" };

  it("X: names the tweet being answered", async () => {
    const { fetcher, calls } = fake(() => ({ data: { id: "1791" } }));
    const creds = { api_key: "k", api_secret: "s", access_token: "t", access_secret: "ts", username: "me" };
    const result = await get("x").reply!(part("second", { id: "1789" }, { id: "1790" }), creds, { fetch: fetcher });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.x.com/2/tweets");
    expect(calls[0].body).toEqual({ text: "second", reply: { in_reply_to_tweet_id: "1790" } });
    expect(calls[0].headers.authorization).toMatch(/^OAuth oauth_consumer_key="k"/);
    expect(result).toEqual({ id: "1791", url: "https://x.com/me/status/1791" });
  });

  it("Bluesky: keeps the cid from createRecord, and a reply quotes root and parent by uri and cid", async () => {
    const { fetcher, calls } = fake(({ url }) => (url.endsWith("createSession") ? { accessJwt: "jwt", did: "did:plc:abc", handle: "me.bsky.social" } : { uri: "at://did:plc:abc/app.bsky.feed.post/3kzzz", cid: "bafy-new" }));
    const creds = { identifier: "me.bsky.social", app_password: "pw" };
    const first = await get("bluesky").publish(post("root"), creds, { fetch: fetcher });
    expect(first.ref).toEqual({ cid: "bafy-new" });

    const rootRef = { id: "at://did:plc:abc/app.bsky.feed.post/3kaaa", ref: { cid: "bafy-root" } };
    const parentRef = { id: "at://did:plc:abc/app.bsky.feed.post/3kbbb", ref: { cid: "bafy-parent" } };
    const result = await get("bluesky").reply!(part("third https://a.co/x", rootRef, parentRef), creds, { fetch: fetcher });
    const sent = calls.at(-1)!;
    expect(sent.url).toBe("https://bsky.social/xrpc/com.atproto.repo.createRecord");
    expect(sent.headers.authorization).toBe("Bearer jwt");
    const { repo, collection, record } = sent.body as { repo: string; collection: string; record: Record<string, unknown> };
    expect([repo, collection]).toEqual(["did:plc:abc", "app.bsky.feed.post"]);
    expect(record.text).toBe("third https://a.co/x");
    expect(record.reply).toEqual({
      root: { uri: "at://did:plc:abc/app.bsky.feed.post/3kaaa", cid: "bafy-root" },
      parent: { uri: "at://did:plc:abc/app.bsky.feed.post/3kbbb", cid: "bafy-parent" },
    });
    expect(record.facets).toHaveLength(1);
    expect(result).toEqual({ id: "at://did:plc:abc/app.bsky.feed.post/3kzzz", url: "https://bsky.app/profile/me.bsky.social/post/3kzzz", ref: { cid: "bafy-new" } });
  });

  it("Bluesky: will not guess a cid it was never given", async () => {
    const { fetcher, calls } = fake(() => ({}));
    await expect(get("bluesky").reply!(part("x", { id: "at://did/app.bsky.feed.post/1" }), { identifier: "me", app_password: "pw" }, { fetch: fetcher })).rejects.toThrow(/did not return a cid/);
    expect(calls).toHaveLength(0);
  });

  it("Mastodon: sets in_reply_to_id and keeps the post's visibility", async () => {
    const { fetcher, calls } = fake(() => ({ id: "102", url: "https://example.social/@me/102" }));
    const result = await get("mastodon").reply!(part("second", root, previous, { visibility: "unlisted" }), { instance: "https://example.social/", access_token: "tok" }, { fetch: fetcher });
    expect(calls[0].url).toBe("https://example.social/api/v1/statuses");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].body).toEqual({ status: "second", in_reply_to_id: "101", visibility: "unlisted" });
    expect(calls[0].headers.authorization).toBe("Bearer tok");
    expect(result).toEqual({ id: "102", url: "https://example.social/@me/102" });
  });

  it("Threads: makes a text container with reply_to_id, then publishes it", async () => {
    const { fetcher, calls } = fake(({ url }) => {
      if (url.endsWith("/u1/threads")) return { id: "c2" };
      if (url.endsWith("/threads_publish")) return { id: "t2" };
      return { permalink: "https://www.threads.net/@me/post/def" };
    });
    const result = await get("threads").reply!(part("second", root, previous), { access_token: "tok", user_id: "u1" }, { fetch: fetcher });
    expect(calls[0].url).toBe("https://graph.threads.net/v1.0/u1/threads");
    expect(calls[0].body).toEqual({ media_type: "TEXT", text: "second", reply_to_id: "101", access_token: "tok" });
    expect(calls[1].url).toBe("https://graph.threads.net/v1.0/u1/threads_publish");
    expect(calls[1].body).toEqual({ creation_id: "c2", access_token: "tok" });
    expect(result).toEqual({ id: "t2", url: "https://www.threads.net/@me/post/def" });
  });

  it("Telegram: replies to the message id in the same chat", async () => {
    const { fetcher, calls } = fake(() => ({ ok: true, result: { message_id: 43, chat: { username: "chan" } } }));
    const result = await get("telegram").reply!(part("second", { id: "41" }, { id: "42" }, { silent: true }), { bot_token: "1:A", chat_id: "@chan" }, { fetch: fetcher });
    expect(calls[0].url).toBe("https://api.telegram.org/bot1:A/sendMessage");
    expect(calls[0].body).toEqual({ chat_id: "@chan", text: "second", disable_notification: true, reply_parameters: { message_id: 42 } });
    expect(result).toEqual({ id: "43", url: "https://t.me/chan/43" });
  });

  it("Facebook Page: comments on the post, also for the parts after the first comment", async () => {
    const { fetcher, calls } = fake(() => ({ id: "pg_55_901" }));
    const result = await get("facebook").reply!(part("third", { id: "pg_55" }, { id: "pg_55_900" }), { page_id: "pg", access_token: "tok" }, { fetch: fetcher });
    expect(calls[0].url).toBe("https://graph.facebook.com/pg_55/comments");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].body).toEqual({ message: "third", access_token: "tok" });
    expect(result).toEqual({ id: "pg_55_901" });
  });

  it("Instagram: comments on the media", async () => {
    const { fetcher, calls } = fake(() => ({ id: "17870913679156914" }));
    const result = await get("instagram").reply!(part("first comment", { id: "17895695668004550" }), { ig_user_id: "ig1", access_token: "tok" }, { fetch: fetcher });
    expect(calls[0].url).toBe("https://graph.facebook.com/17895695668004550/comments");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].body).toEqual({ message: "first comment", access_token: "tok" });
    expect(result).toEqual({ id: "17870913679156914" });
  });

  it("LinkedIn: posts a comment to socialActions under the encoded post urn, as the same author", async () => {
    const { fetcher, calls } = fake(
      () =>
        new Response(JSON.stringify({ id: "6643206422739898368", commentUrn: "urn:li:comment:(urn:li:activity:66,6643206422739898368)" }), {
          status: 201,
          headers: { "x-restli-id": "6643206422739898368", "content-type": "application/json" },
        }),
    );
    const result = await get("linkedin").reply!(part("Thanks (all) #team", { id: "urn:li:share:77" }), { access_token: "t", author: "urn:li:person:p" }, { fetch: fetcher });
    expect(calls[0].url).toBe("https://api.linkedin.com/rest/socialActions/urn%3Ali%3Ashare%3A77/comments");
    expect(calls[0].method).toBe("POST");
    // Comment text is plain: it is not escaped the way a post's commentary is.
    expect(calls[0].body).toEqual({ actor: "urn:li:person:p", object: "urn:li:share:77", message: { text: "Thanks (all) #team" } });
    expect(calls[0].headers["linkedin-version"]).toMatch(/^\d{6}$/);
    expect(calls[0].headers["x-restli-protocol-version"]).toBe("2.0.0");
    expect(calls[0].headers.authorization).toBe("Bearer t");
    expect(result).toEqual({
      id: "urn:li:comment:(urn:li:activity:66,6643206422739898368)",
      url: "https://www.linkedin.com/feed/update/urn:li:share:77?commentUrn=urn%3Ali%3Acomment%3A(urn%3Ali%3Aactivity%3A66%2C6643206422739898368)",
    });
  });

  it("LinkedIn: falls back to the id in the response header", async () => {
    const { fetcher } = fake(() => new Response(null, { status: 201, headers: { "x-restli-id": "6643" } }));
    expect(await get("linkedin").reply!(part("ok", { id: "urn:li:ugcPost:9" }), { access_token: "t", author: "urn:li:person:p" }, { fetch: fetcher })).toEqual({ id: "6643", url: undefined });
  });

  it("Reddit: comments on the thing above it and reads back the comment's name and link", async () => {
    const { fetcher, calls } = fake(({ url }) =>
      url.includes("access_token") ? { access_token: "rt" } : { json: { errors: [], data: { things: [{ kind: "t1", data: { name: "t1_def", permalink: "/r/test/comments/abc/title/def/" } }] } } },
    );
    const creds = { client_id: "id", client_secret: "sec", username: "me", password: "pw", subreddit: "test" };
    const result = await get("reddit").reply!(part("second", { id: "t3_abc" }, { id: "t1_ccc" }), creds, { fetch: fetcher });
    expect(calls[1].url).toBe("https://oauth.reddit.com/api/comment");
    expect(calls[1].method).toBe("POST");
    expect(calls[1].body).toEqual({ api_type: "json", thing_id: "t1_ccc", text: "second" });
    expect(calls[1].headers.authorization).toBe("Bearer rt");
    expect(result).toEqual({ id: "t1_def", url: "https://www.reddit.com/r/test/comments/abc/title/def/" });
  });

  it("Reddit: reports a refused comment", async () => {
    const { fetcher } = fake(({ url }) => (url.includes("access_token") ? { access_token: "rt" } : { json: { errors: [["RATELIMIT", "you are doing that too much", "ratelimit"]] } }));
    const creds = { client_id: "id", client_secret: "sec", username: "me", password: "pw", subreddit: "test" };
    await expect(get("reddit").reply!(part("x", { id: "t3_abc" }), creds, { fetch: fetcher })).rejects.toThrow("Reddit refused the comment: RATELIMIT you are doing that too much ratelimit");
  });

  it("Lemmy: the first reply names the post, later ones also name the comment above", async () => {
    const { fetcher, calls } = fake(({ url }) => (url.endsWith("/user/login") ? { jwt: "j" } : { comment_view: { comment: { id: 501 } } }));
    const creds = { instance: "https://lemmy.example/", username: "me", password: "pw", community: "tech" };
    const result = await get("lemmy").reply!(part("first comment", { id: "99" }), creds, { fetch: fetcher });
    expect(calls[1].url).toBe("https://lemmy.example/api/v3/comment");
    expect(calls[1].body).toEqual({ content: "first comment", post_id: 99 });
    expect(calls[1].headers.authorization).toBe("Bearer j");
    expect(result).toEqual({ id: "501", url: "https://lemmy.example/comment/501" });
    // Post 99 and comment 99 are different things, so the parent is named only from the second reply on.
    await get("lemmy").reply!(part("second", { id: "99" }, { id: "99" }), creds, { fetch: fetcher });
    expect(calls[3].body).toEqual({ content: "second", post_id: 99, parent_id: 99 });
  });

  it("Sandbox: accepts a part, and fails one that asks to", async () => {
    expect((await get("sandbox").reply!(part("fine", root), { name: "Rehearsal" }, { fetch })).id).toMatch(/^sandbox-/);
    await expect(get("sandbox").reply!(part("no [fail]", root), { name: "Rehearsal" }, { fetch })).rejects.toThrow(/asked to fail/);
  });
});

describe("threads: Nostr", () => {
  afterEach(() => vi.unstubAllGlobals());

  const secret = "0000000000000000000000000000000000000000000000000000000000000003";
  const author = "f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9";
  const rootId = "a".repeat(64);
  const parentId = "b".repeat(64);

  it("marks the root, and the note being answered once the thread is past its first reply", () => {
    expect(replyTags(rootId, null, author)).toEqual([["e", rootId, "", "root"], ["p", author]]);
    expect(replyTags(rootId, parentId, author)).toEqual([["e", rootId, "", "root"], ["e", parentId, "", "reply"], ["p", author]]);
  });

  it("sends relays a signed kind 1 note carrying those tags", async () => {
    const events: ReturnType<typeof nostrEvent>[] = [];
    const urls: string[] = [];
    /** A relay that accepts whatever it is sent. */
    class Relay {
      onopen?: () => void;
      onerror?: () => void;
      onmessage?: (message: { data: string }) => void;
      constructor(url: string) {
        urls.push(url);
        queueMicrotask(() => this.onopen?.());
      }
      send(data: string) {
        const [verb, event] = JSON.parse(data) as [string, ReturnType<typeof nostrEvent>];
        expect(verb).toBe("EVENT");
        events.push(event);
        this.onmessage?.({ data: JSON.stringify(["OK", event.id, true, ""]) });
      }
      close() {}
    }
    vi.stubGlobal("WebSocket", Relay);
    // An address literal, so the private-network check needs no name lookup.
    const creds = { private_key: secret, relays: "wss://93.184.216.34" };
    const result = await get("nostr").reply!(part("third", { id: rootId }, { id: parentId }), creds, { fetch });
    expect(urls).toEqual(["wss://93.184.216.34"]);
    const [event] = events;
    expect(event).toMatchObject({ kind: 1, content: "third", pubkey: author, tags: [["e", rootId, "", "root"], ["e", parentId, "", "reply"], ["p", author]] });
    // The id commits to the tags, so a relay or reader can check the note really answers that thread.
    expect(schnorr.verify(Buffer.from(event.sig, "hex"), Buffer.from(event.id, "hex"), Buffer.from(event.pubkey, "hex"))).toBe(true);
    expect(nostrEvent(nostrSecret(secret), "third", event.created_at, event.tags).id).toBe(event.id);
    expect(result.id).toBe(event.id);

    await get("nostr").reply!(part("second", { id: rootId }), creds, { fetch });
    expect(events[1].tags).toEqual([["e", rootId, "", "root"], ["p", author]]);
  });
});
