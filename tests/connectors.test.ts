import { schnorr } from "@noble/curves/secp256k1.js";
import { describe, expect, it } from "vitest";
import { connector, connectors, measure, problems } from "@/lib/platforms";
import { facets } from "@/lib/platforms/bluesky";
import { apiVersion, escapeLittleText } from "@/lib/platforms/linkedin";
import { nostrEvent, nostrSecret, titleAndBody } from "@/lib/platforms/more";
import type { MediaItem, PublishInput } from "@/lib/platforms/types";
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
