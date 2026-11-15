import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

process.env.BROADSIDE_DATA_DIR = mkdtempSync(path.join(tmpdir(), "broadside-images-"));
process.env.BROADSIDE_SECRET = "test-secret";
// The provider here is always a fake fetch, so nothing is resolved or reached.
process.env.BROADSIDE_ALLOW_PRIVATE_FETCH = "1";
delete process.env.BROADSIDE_PASSWORD;
delete process.env.BROADSIDE_API_KEY;
delete process.env.BROADSIDE_PUBLIC_URL;

const { InputError, connectAccount } = await import("@/lib/accounts");
const { all, get, migrate, run, SCHEMA } = await import("@/lib/db");
const images = await import("@/lib/images");
const { buildServer } = await import("@/lib/mcp");
const { deleteMedia, getMedia, listLibrary, readMedia, setAlt } = await import("@/lib/media");
const { createPost } = await import("@/lib/posts");
const route = await import("@/app/api/v1/media/generate/route");

/** Made up for these tests, long and unlike anything else in them, so finding it anywhere it should not be is a real finding. */
const KEY = "sk-test-broadside-unit-0123456789abcdefghijklmnopqrstuvwxyz";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]);

type Call = { url: string; method: string; headers: Record<string, string>; body: Record<string, unknown>; redirect: RequestRedirect | undefined; signal: AbortSignal | null | undefined };

/** A provider that answers from a function and keeps every request, so a test can state the exact wire format. */
function provider(answer: (call: Call, n: number) => Response | Promise<Response> = () => image()) {
  const calls: Call[] = [];
  const fetcher = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const call: Call = {
      url: String(input),
      method: init.method ?? "GET",
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      body: typeof init.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {},
      redirect: init.redirect,
      signal: init.signal,
    };
    calls.push(call);
    return answer(call, calls.length);
  }) as typeof fetch;
  return { fetcher, calls };
}

const image = (bytes: Uint8Array = JPEG) => Response.json({ created: 1763200000, data: [{ b64_json: Buffer.from(bytes).toString("base64") }], output_format: "jpeg", size: "1024x1024" });
const refusedWith = (status: number, error: unknown) => Response.json({ error }, { status });

/** The error a call ends in, with everything a caller could ever be shown from it. */
async function failure(promise: Promise<unknown>): Promise<{ message: string; details: unknown; shown: string }> {
  const error = await promise.then(
    () => null,
    (cause: unknown) => cause,
  );
  expect(error).toBeInstanceOf(InputError);
  const known = error as InstanceType<typeof InputError>;
  return { message: known.message, details: known.details, shown: JSON.stringify({ message: known.message, details: known.details, stack: known.stack }) };
}

const used = () => all("SELECT id FROM image_generations").length;

beforeEach(() => {
  process.env.OPENAI_API_KEY = KEY;
  process.env.BROADSIDE_IMAGE_MODEL = "";
  process.env.BROADSIDE_IMAGE_DAILY_LIMIT = "";
  run("DELETE FROM image_generations");
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.BROADSIDE_MCP_DRAFTS_ONLY;
});

describe("the request sent to OpenAI", () => {
  it("is one POST to the images endpoint with the key as a Bearer token and the documented body", async () => {
    const { fetcher, calls } = provider();
    await images.requestImage({ prompt: "A lighthouse at dusk", shape: "square" }, fetcher);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.openai.com/v1/images/generations");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].headers).toEqual({ authorization: `Bearer ${KEY}`, "content-type": "application/json" });
    expect(calls[0].body).toEqual({ model: "gpt-image-2.6-flare", prompt: "A lighthouse at dusk", size: "1024x1024", n: 1, output_format: "jpeg" });
    // Redirects are never followed by the fetch itself, and the wait is bounded.
    expect(calls[0].redirect).toBe("manual");
    expect(calls[0].signal).toBeInstanceOf(AbortSignal);
  });

  it("maps each shape to a size the docs list", async () => {
    expect(images.SIZES).toEqual({ square: "1024x1024", portrait: "1024x1536", landscape: "1536x1024" });
    for (const shape of images.SHAPES) {
      const { fetcher, calls } = provider();
      const made = await images.requestImage({ prompt: "x", shape }, fetcher);
      expect([shape, calls[0].body.size, made.size]).toEqual([shape, images.SIZES[shape], images.SIZES[shape]]);
    }
  });

  it("uses BROADSIDE_IMAGE_MODEL when it is a plain model name, and the default otherwise", async () => {
    process.env.BROADSIDE_IMAGE_MODEL = "gpt-image-2.6-sunburst";
    const chosen = provider();
    expect((await images.requestImage({ prompt: "x", shape: "square" }, chosen.fetcher)).model).toBe("gpt-image-2.6-sunburst");
    expect(chosen.calls[0].body.model).toBe("gpt-image-2.6-sunburst");
    process.env.BROADSIDE_IMAGE_MODEL = 'nonsense", "n": 10';
    expect(images.imageModel()).toBe(images.DEFAULT_MODEL);
    process.env.BROADSIDE_IMAGE_MODEL = "   ";
    expect(images.imageModel()).toBe("gpt-image-2.6-flare");
  });

  it("reads the key when it is used, and sends nothing without one", async () => {
    const { fetcher, calls } = provider();
    process.env.OPENAI_API_KEY = "";
    expect((await failure(images.requestImage({ prompt: "x", shape: "square" }, fetcher))).message).toBe("Image generation is not turned on. Set OPENAI_API_KEY on the server and restart Broadside.");
    expect(calls).toHaveLength(0);
    process.env.OPENAI_API_KEY = `  ${KEY}\n`;
    await images.requestImage({ prompt: "x", shape: "square" }, fetcher);
    expect(calls[0].headers.authorization).toBe(`Bearer ${KEY}`);
  });

  it("refuses a redirect and never sends the key after one", async () => {
    const { fetcher, calls } = provider(() => new Response(null, { status: 307, headers: { location: "https://elsewhere.example/v1/images/generations" } }));
    const sameHost = provider(() => new Response(null, { status: 308, headers: { location: "https://api.openai.com/v2/images" } }));
    expect((await failure(images.requestImage({ prompt: "x", shape: "square" }, fetcher))).message).toMatch(/answered with a redirect/);
    expect((await failure(images.requestImage({ prompt: "x", shape: "square" }, sameHost.fetcher))).message).toMatch(/answered with a redirect/);
    expect(calls).toHaveLength(1);
    expect(sameHost.calls).toHaveLength(1);
  });
});

describe("what OpenAI answers", () => {
  const ask = (answer: () => Response | Promise<Response>) => failure(images.requestImage({ prompt: "x", shape: "square" }, provider(answer).fetcher));

  it("returns the picture's bytes, whatever kind of picture it turns out to be", async () => {
    const jpeg = await images.requestImage({ prompt: "x", shape: "square" }, provider(() => image(JPEG)).fetcher);
    expect([jpeg.type, Buffer.from(jpeg.bytes).equals(JPEG)]).toEqual(["image/jpeg", true]);
    const png = await images.requestImage({ prompt: "x", shape: "square" }, provider(() => image(PNG)).fetcher);
    expect(png.type).toBe("image/png");
  });

  it("says a refused key is refused, and repeats none of the answer, which quotes the key", async () => {
    const said = await ask(() => refusedWith(401, { message: `Incorrect API key provided: ${KEY.slice(0, 8)}****${KEY.slice(-4)}. You can find your API key at https://platform.openai.com/account/api-keys. (${KEY})`, type: "invalid_request_error", code: "invalid_api_key" }));
    expect(said.message).toBe("The key in OPENAI_API_KEY was refused by OpenAI. Check the key on the server, then restart Broadside.");
    expect(said.shown).not.toContain(KEY);
    expect(said.shown).not.toContain(KEY.slice(0, 8));
  });

  it("tells an account with no credit apart from one asking too fast", async () => {
    for (const code of ["credit_balance_exhausted", "insufficient_quota", "organization_spend_limit_exceeded", "project_spend_limit_exceeded", "organization_usage_limit_exceeded"]) {
      expect([code, (await ask(() => refusedWith(429, { message: "You exceeded your current quota.", type: "insufficient_quota", code }))).message]).toEqual([code, "The OpenAI account behind OPENAI_API_KEY has no credit left or has reached its spending limit. Add credit or raise the limit at OpenAI, then try again."]);
    }
    expect((await ask(() => refusedWith(429, { message: "Quota.", type: "insufficient_quota", code: null }))).message).toMatch(/no credit left/);
    expect((await ask(() => refusedWith(429, { message: "Rate limit reached for requests", type: "rate_limit_error", code: "slow_down" }))).message).toBe("OpenAI is limiting how fast this key may ask. Wait a minute and try again.");
    expect((await ask(() => refusedWith(429, { message: "Rate limit reached for requests" }))).message).toMatch(/limiting how fast/);
  });

  it("shows a content refusal in OpenAI's own words, as quoted text", async () => {
    const said = await ask(() =>
      refusedWith(400, { message: "Your request was rejected by the safety system.", type: "image_generation_user_error", code: "moderation_blocked", moderation_details: { moderation_stage: "input", categories: ["violence", 7, "harassment"] } }),
    );
    expect(said.message).toBe('OpenAI refused this prompt. It said: "Your request was rejected by the safety system." Change the prompt and try again.');
    expect(said.details).toEqual({ refused_by: "openai", stage: "input", categories: ["violence", "harassment"] });
    const bare = await ask(() => refusedWith(400, { type: "image_generation_user_error", code: "moderation_blocked" }));
    expect(bare.message).toBe("OpenAI refused this prompt because it did not meet its content rules. Change the prompt and try again.");
    expect(bare.details).toEqual({ refused_by: "openai" });
  });

  it("quotes any other refusal, with the key taken out, control characters dropped and the length held", async () => {
    const other = await ask(() => refusedWith(400, { message: `Invalid size.\n\u0007 Key ${KEY} and sk-proj-abc123def456 were seen. ${"z".repeat(900)}`, type: "invalid_request_error", param: "size" }));
    expect(other.message.startsWith('OpenAI did not accept the request. It said: "Invalid size. Key [key] and [key] were seen. zzz')).toBe(true);
    expect(other.message.length).toBeLessThan(500);
    expect(other.shown).not.toContain(KEY);
    expect((await ask(() => refusedWith(403, { message: "Country, region, or territory not supported" }))).message).toBe('OpenAI would not serve this request. It said: "Country, region, or territory not supported"');
    expect((await ask(() => new Response("nope", { status: 403 }))).message).toMatch(/may need verifying at OpenAI/);
    expect((await ask(() => new Response("<html>bad gateway</html>", { status: 502 }))).message).toBe("OpenAI had a problem of its own (it answered 502). Nothing was generated. Try again in a moment.");
    expect((await ask(() => refusedWith(503, { message: "overloaded", code: "server_is_overloaded" }))).message).toMatch(/answered 503/);
    expect((await ask(() => new Response("teapot", { status: 418 }))).message).toBe("OpenAI did not accept the request (it answered 418).");
  });

  it("says so when no picture comes back, or when what comes back is not a picture", async () => {
    expect((await ask(() => Response.json({ created: 1, data: [] }))).message).toBe("OpenAI answered without an image. Try again.");
    expect((await ask(() => Response.json({ created: 1, data: [{ url: "https://example.com/a.png" }] }))).message).toBe("OpenAI answered without an image. Try again.");
    expect((await ask(() => new Response("not json at all"))).message).toBe("OpenAI answered without an image. Try again.");
    expect((await ask(() => image(Buffer.from("<script>alert(1)</script>")))).message).toBe("OpenAI answered with something that is not an image, so it was not kept. Try again.");
    // A video is real media and still not what was asked for.
    expect((await ask(() => image(new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d])))).message).toMatch(/not an image/);
  });

  it("says so when OpenAI cannot be reached or takes too long, without the cause's own text", async () => {
    const down = await ask(() => {
      throw new TypeError(`fetch failed: connect ECONNREFUSED with header Bearer ${KEY}`);
    });
    expect(down.message).toBe("OpenAI could not be reached. Check that the server can reach api.openai.com, then try again.");
    expect(down.shown).not.toContain(KEY);
    const slow = await ask(() => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    });
    expect(slow.message).toBe("OpenAI did not answer within three minutes, so Broadside stopped waiting. Try again, or try a simpler prompt.");
  });
});

describe("the prompt and the shape", () => {
  it("refuses a prompt that is missing, empty or too long, and never cuts one to fit", async () => {
    const { fetcher, calls } = provider();
    for (const prompt of [undefined, null, 7, "", "   \n\t "]) {
      expect((await failure(images.generateImage({ prompt }, { fetcher }))).message).toBe("Write a prompt: a sentence or two describing the image.");
    }
    expect((await failure(images.generateImage({ prompt: "p".repeat(2001) }, { fetcher }))).message).toBe("The prompt is 2001 characters, and the most Broadside sends is 2000. Shorten it and try again.");
    expect((await failure(images.generateImage({ prompt: "x", shape: "circle" }, { fetcher }))).message).toBe("The shape is one of square, portrait or landscape.");
    expect((await failure(images.generateImage({ prompt: "x", shape: 3 }, { fetcher }))).message).toMatch(/square, portrait or landscape/);
    // Nothing was sent and nothing was counted for any of them.
    expect(calls).toHaveLength(0);
    expect(used()).toBe(0);
  });

  it("sends a prompt of exactly 2000 characters whole, and trims the space around one", async () => {
    const { fetcher, calls } = provider();
    await images.generateImage({ prompt: "p".repeat(2000) }, { fetcher });
    await images.generateImage({ prompt: `  ${"q".repeat(2000)}\n`, shape: "landscape" }, { fetcher });
    expect((calls[0].body.prompt as string).length).toBe(2000);
    expect(calls[0].body.size).toBe("1024x1024");
    expect(calls[1].body.prompt).toBe("q".repeat(2000));
    expect(calls[1].body.size).toBe("1536x1024");
  });
});

describe("a generated image in the library", () => {
  it("goes through the media pipeline and says where it came from", async () => {
    // Asked for JPEG; what is stored is what the bytes are.
    const { fetcher } = provider(() => image(PNG));
    const { media, remaining, limit, resets_at } = await images.generateImage({ prompt: "  A paper boat on a pond  ", shape: "portrait" }, { fetcher });
    expect(media).toMatchObject({ origin: "generated", prompt: "A paper boat on a pond", model: "gpt-image-2.6-flare", alt: "A paper boat on a pond", content_type: "image/png", type: "image", source_url: null, made_by: null, size: PNG.length });
    expect(media.id).toMatch(/^med_/);
    expect(media.filename).toMatch(/^generated-\d{8}-\d{6}\.png$/);
    expect(media.url).toBe(`/media/${media.id}/${media.filename}`);
    expect(Buffer.from(readMedia(media.id)).equals(PNG)).toBe(true);
    expect([remaining, limit]).toEqual([19, 20]);
    expect(resets_at).toMatch(/T00:00:00\.000Z$/);
    expect(listLibrary()[0]).toMatchObject({ id: media.id, origin: "generated", used_by: [] });
    // The description starts as the prompt and is the person's to change.
    expect(setAlt(media.id, "A small boat").alt).toBe("A small boat");
    expect(getMedia(media.id)).toMatchObject({ alt: "A small boat", prompt: "A paper boat on a pond" });
    // Nothing about the key is kept beside it.
    expect(JSON.stringify([media, all("SELECT * FROM media"), all("SELECT * FROM image_generations")])).not.toContain(KEY);
  });

  it("marks an upload as an upload, and names the member who generated one", async () => {
    const { saveMedia } = await import("@/lib/media");
    expect(saveMedia(PNG, "plain.png", "image/png")).toMatchObject({ origin: "upload", prompt: null, model: null, made_by: null });
    run("INSERT INTO members (id, name, name_key, role, password_hash, session_nonce, created_at) VALUES ('mem_images_test', 'Eddie', 'eddie', 'editor', 'x', 'y', '2026-01-01T00:00:00.000Z')");
    const { media } = await images.generateImage({ prompt: "by a member" }, { fetcher: provider().fetcher, createdBy: "mem_images_test" });
    expect(media.made_by).toBe("Eddie");
    expect(media).not.toHaveProperty("created_by");
    expect(get("SELECT created_by FROM media WHERE id = ?", media.id)).toEqual({ created_by: "mem_images_test" });
    run("DELETE FROM members WHERE id = 'mem_images_test'");
    expect(getMedia(media.id)!.made_by).toBeNull();
  });

  it("can be attached to a post like any other file", async () => {
    const sandbox = await connectAccount("sandbox", { name: "Images" });
    const { media } = await images.generateImage({ prompt: "for a post" }, { fetcher: provider().fetcher });
    const post = await createPost({ content: "with a generated picture", targets: [{ account_id: sandbox.id }], media_ids: [media.id] });
    expect(post.status).toBe("published");
    expect(post.media[0]).toMatchObject({ id: media.id, origin: "generated" });
  });

  it("gives an older database the new columns and leaves its rows as uploads", () => {
    const old = new DatabaseSync(":memory:");
    old.exec(SCHEMA);
    expect(old.prepare("PRAGMA table_info(media)").all().map((c) => c.name)).not.toContain("origin");
    old.prepare("INSERT INTO media (id, filename, content_type, size, created_at) VALUES ('med_before', 'a.png', 'image/png', 1, '2026-01-01T00:00:00.000Z')").run();
    migrate(old);
    migrate(old);
    expect({ ...old.prepare("SELECT origin, prompt, model, created_by FROM media WHERE id = 'med_before'").get() }).toEqual({ origin: "upload", prompt: null, model: null, created_by: null });
    expect(old.prepare("SELECT COUNT(*) AS n FROM image_generations").get()?.n).toBe(0);
    old.close();
  });
});

describe("the daily cap", () => {
  it("defaults to 20, takes a whole number, and reads anything else as off", () => {
    const limitFor = (value: string | undefined) => {
      if (value === undefined) delete process.env.BROADSIDE_IMAGE_DAILY_LIMIT;
      else process.env.BROADSIDE_IMAGE_DAILY_LIMIT = value;
      return images.dailyLimit();
    };
    expect([undefined, "", "5", " 7 ", "0", "-1", "ten", "3.5", "1e3"].map(limitFor)).toEqual([20, 20, 5, 7, 0, 0, 0, 0, 0]);
  });

  it("stops parallel requests at the cap, with none over", async () => {
    process.env.BROADSIDE_IMAGE_DAILY_LIMIT = "3";
    const { fetcher, calls } = provider(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return image();
    });
    const outcomes = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => images.generateImage({ prompt: `parallel ${i}` }, { fetcher })));
    const made = outcomes.filter((o) => o.status === "fulfilled");
    const turnedAway = outcomes.filter((o): o is PromiseRejectedResult => o.status === "rejected");
    expect([made.length, turnedAway.length, calls.length, used()]).toEqual([3, 5, 3, 3]);
    for (const { reason } of turnedAway) {
      expect(reason).toBeInstanceOf(InputError);
      expect(reason.message).toBe("Today's 3 images have been generated. The count starts again at 00:00 UTC. The limit is BROADSIDE_IMAGE_DAILY_LIMIT on the server.");
      expect(reason.details).toMatchObject({ remaining: 0, limit: 3 });
    }
    expect(images.generationStatus()).toMatchObject({ available: true, remaining: 0, limit: 3 });
  });

  it("gives the count back when OpenAI returns no image, and keeps it once it has", async () => {
    process.env.BROADSIDE_IMAGE_DAILY_LIMIT = "2";
    const failing = provider(() => refusedWith(500, { message: "The server had an error" }));
    for (let i = 0; i < 5; i++) await failure(images.generateImage({ prompt: "fails" }, { fetcher: failing.fetcher }));
    await failure(images.generateImage({ prompt: "refused" }, { fetcher: provider(() => refusedWith(400, { code: "moderation_blocked" })).fetcher }));
    await failure(
      images.generateImage(
        { prompt: "unreachable" },
        {
          fetcher: provider(() => {
            throw new Error("offline");
          }).fetcher,
        },
      ),
    );
    expect(failing.calls).toHaveLength(5);
    expect(used()).toBe(0);
    expect(images.generationStatus().remaining).toBe(2);
    // OpenAI answered with data that is not a picture: nothing is kept, and nothing is counted, since nothing usable was made.
    await failure(images.generateImage({ prompt: "junk" }, { fetcher: provider(() => image(Buffer.from("junk"))).fetcher }));
    expect(used()).toBe(0);
    const { media, remaining } = await images.generateImage({ prompt: "works" }, { fetcher: provider().fetcher });
    expect(remaining).toBe(1);
    // Deleting the file does not hand the image back: it was billed.
    expect(deleteMedia(media.id)).toBe(true);
    expect(images.generationStatus().remaining).toBe(1);
  });

  it("counts by UTC day, and starts again at midnight UTC", async () => {
    process.env.BROADSIDE_IMAGE_DAILY_LIMIT = "1";
    const late = new Date("2026-03-01T23:59:30.000Z");
    const { fetcher } = provider();
    await images.generateImage({ prompt: "last of the day" }, { fetcher, at: late });
    const full = await failure(images.generateImage({ prompt: "one too many" }, { fetcher, at: late }));
    expect(full.message).toBe("Today's one image has been generated. The count starts again at 00:00 UTC. The limit is BROADSIDE_IMAGE_DAILY_LIMIT on the server.");
    expect(full.details).toEqual({ remaining: 0, limit: 1, resets_at: "2026-03-02T00:00:00.000Z" });
    expect(images.generationStatus(late)).toMatchObject({ remaining: 0, resets_at: "2026-03-02T00:00:00.000Z" });
    const nextDay = new Date("2026-03-02T00:00:05.000Z");
    expect(images.generationStatus(nextDay).remaining).toBe(1);
    expect((await images.generateImage({ prompt: "first of the next" }, { fetcher, at: nextDay })).remaining).toBe(0);
  });

  it("stops counting a claim whose call never finished", () => {
    process.env.BROADSIDE_IMAGE_DAILY_LIMIT = "2";
    const at = new Date("2026-04-10T12:00:00.000Z");
    run("INSERT INTO image_generations (id, day, status, created_at) VALUES ('gen_stale', '2026-04-10', 'claimed', '2026-04-10T11:30:00.000Z')");
    run("INSERT INTO image_generations (id, day, status, created_at) VALUES ('gen_live', '2026-04-10', 'claimed', '2026-04-10T11:59:00.000Z')");
    run("INSERT INTO image_generations (id, day, status, created_at) VALUES ('gen_old_done', '2026-04-10', 'done', '2026-04-10T01:00:00.000Z')");
    expect(images.generationStatus(at).remaining).toBe(0);
    run("DELETE FROM image_generations WHERE id = 'gen_live'");
    expect(images.generationStatus(at).remaining).toBe(1);
  });

  it("is off with no key, and off with a cap of zero even with a key, and sends nothing either way", async () => {
    const { fetcher, calls } = provider();
    process.env.BROADSIDE_IMAGE_DAILY_LIMIT = "0";
    expect(images.generationStatus()).toMatchObject({ available: false, remaining: 0, limit: 0 });
    expect((await failure(images.generateImage({ prompt: "x" }, { fetcher }))).message).toBe("Image generation is turned off on this Broadside: BROADSIDE_IMAGE_DAILY_LIMIT is 0.");
    process.env.BROADSIDE_IMAGE_DAILY_LIMIT = "";
    process.env.OPENAI_API_KEY = "";
    expect(images.generationStatus()).toMatchObject({ available: false, remaining: 0, limit: 20, model: "gpt-image-2.6-flare" });
    expect((await failure(images.generateImage({ prompt: "x" }, { fetcher }))).message).toMatch(/Set OPENAI_API_KEY on the server/);
    expect(calls).toHaveLength(0);
    expect(used()).toBe(0);
  });
});

describe("the route", () => {
  const ask = (method: "GET" | "POST", payload?: unknown, headers: Record<string, string> = { "sec-fetch-site": "same-origin" }) =>
    (route[method] as (request: Request, context: unknown) => Promise<Response>)(new Request("http://localhost/api/v1/media/generate", { method, headers: { host: "localhost", "content-type": "application/json", ...headers }, body: payload === undefined ? undefined : JSON.stringify(payload) }), {});

  it("says whether generation is available and how many are left, and never the key", async () => {
    const on = await ask("GET");
    const said = await on.text();
    expect(JSON.parse(said).data).toEqual({ available: true, remaining: 20, limit: 20, model: "gpt-image-2.6-flare", resets_at: expect.stringMatching(/T00:00:00\.000Z$/) });
    expect(said).not.toContain(KEY);
    expect(said).not.toContain("sk-");
    process.env.OPENAI_API_KEY = "";
    expect((await (await ask("GET")).json()).data).toMatchObject({ available: false, remaining: 0 });
    expect((await ask("GET", undefined, {})).status).toBe(401);
  });

  it("generates for the app, answers with the file and what is left, and keeps the key out of every answer", async () => {
    const { fetcher, calls } = provider((call, n) => (n === 2 ? refusedWith(401, { message: `Incorrect API key provided: ${KEY}` }) : image()));
    vi.stubGlobal("fetch", fetcher);
    const made = await ask("POST", { prompt: "From the route", shape: "landscape" });
    const text = await made.text();
    expect(made.status).toBe(200);
    expect(JSON.parse(text).data).toMatchObject({ media: { origin: "generated", prompt: "From the route", alt: "From the route" }, remaining: 19, limit: 20 });
    expect(calls[0].body).toMatchObject({ prompt: "From the route", size: "1536x1024" });
    const refused = await ask("POST", { prompt: "the key is refused this time" });
    const refusedText = await refused.text();
    expect(refused.status).toBe(400);
    expect(JSON.parse(refusedText).error).toEqual({ code: "invalid_request", message: "The key in OPENAI_API_KEY was refused by OpenAI. Check the key on the server, then restart Broadside." });
    expect(text + refusedText).not.toContain(KEY);
    expect((await ask("POST", { prompt: "" })).status).toBe(400);
    expect((await ask("POST", { prompt: "no one asking" }, {})).status).toBe(401);
    expect((await ask("POST", { prompt: "another site" }, { "sec-fetch-site": "cross-site" })).status).toBe(401);
    expect(calls).toHaveLength(2);
  });
});

describe("the generate_image tool", () => {
  type ToolReply = { content: { text: string }[]; isError?: boolean };
  async function agent() {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await buildServer({ baseUrl: "http://localhost:3000", local: false }).connect(serverSide);
    const client = new Client({ name: "images-test", version: "1.0.0" });
    await client.connect(clientSide);
    return { client, tool: async (name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as ToolReply };
  }

  it("is not offered without a key or with a cap of zero", async () => {
    process.env.OPENAI_API_KEY = "";
    expect((await (await agent()).client.listTools()).tools.map((t) => t.name)).not.toContain("generate_image");
    process.env.OPENAI_API_KEY = KEY;
    process.env.BROADSIDE_IMAGE_DAILY_LIMIT = "0";
    expect((await (await agent()).client.listTools()).tools.map((t) => t.name)).not.toContain("generate_image");
  });

  it("says what it costs, returns a media id for create_post, and counts against the same cap", async () => {
    process.env.BROADSIDE_IMAGE_DAILY_LIMIT = "2";
    const { fetcher, calls } = provider();
    vi.stubGlobal("fetch", fetcher);
    const { client, tool } = await agent();
    const offered = (await client.listTools()).tools.find((t) => t.name === "generate_image")!;
    expect(offered.description).toContain("billed to the OpenAI account of whoever runs this Broadside");
    expect(offered.description).toContain("counts against a daily cap");
    expect(offered.description).toContain("media_ids on create_post");
    expect(client.getInstructions()).toContain("generate_image is offered only when the operator has turned image generation on");

    const reply = await tool("generate_image", { prompt: "An owl, drawn in ink", shape: "portrait" });
    expect(reply.isError).toBeFalsy();
    const made = JSON.parse(reply.content[0].text);
    expect(made).toMatchObject({ media_id: expect.stringMatching(/^med_/), media: { origin: "generated", prompt: "An owl, drawn in ink" }, remaining_today: 1, daily_limit: 2 });
    expect(calls[0].body).toMatchObject({ prompt: "An owl, drawn in ink", size: "1024x1536" });
    expect(reply.content[0].text).not.toContain(KEY);

    const sandbox = await connectAccount("sandbox", { name: "Agent" });
    const post = JSON.parse((await tool("create_post", { content: "an owl", targets: [{ account_id: sandbox.id }], media_ids: [made.media_id], draft: true })).content[0].text);
    expect(post.media[0].id).toBe(made.media_id);

    // The route and the tool draw on one count.
    await images.generateImage({ prompt: "from the app" }, { fetcher });
    const over = await tool("generate_image", { prompt: "one too many" });
    expect(over.isError).toBe(true);
    expect(JSON.parse(over.content[0].text).error).toMatch(/^Today's 2 images have been generated\./);
    expect(calls).toHaveLength(2);
    const tooLong = await tool("generate_image", { prompt: "p".repeat(2001) });
    expect(JSON.parse(tooLong.content[0].text).error).toMatch(/2001 characters/);
  });

  it("is left alone by drafts-only mode, which is about publishing", async () => {
    process.env.BROADSIDE_MCP_DRAFTS_ONLY = "1";
    vi.stubGlobal("fetch", provider().fetcher);
    const { tool } = await agent();
    const reply = await tool("generate_image", { prompt: "in drafts-only mode" });
    expect(reply.isError).toBeFalsy();
    expect(JSON.parse(reply.content[0].text).media.origin).toBe("generated");
  });
});
