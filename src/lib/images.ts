/**
 * Image generation with the operator's own OpenAI key.
 *
 * Built from OpenAI's documentation as read on 2026-11-15 (platform.openai.com/docs
 * now redirects to developers.openai.com):
 *   https://developers.openai.com/api/docs/guides/image-generation
 *   https://developers.openai.com/api/reference/resources/images/methods/generate
 *   https://developers.openai.com/api/docs/guides/error-codes
 *   https://developers.openai.com/api/docs/models
 *
 * What this file depends on, as those pages state it:
 *   - POST https://api.openai.com/v1/images/generations, JSON body, "Authorization: Bearer <key>".
 *   - Body: model, prompt, size, n, output_format. Everything else is left at the provider's default.
 *   - Models: "For new integrations, use GPT-Image-2.6 Sunburst or Flare"; Flare is the one described
 *     for everyday generation, so gpt-image-2.6-flare is the default here.
 *   - Sizes recommended for those models: 1024x1024 (square), 1536x1024 (landscape), 1024x1536 (portrait).
 *   - GPT Image models always answer with base64 in data[0].b64_json and never with a URL.
 *   - output_format is png (default), jpeg or webp. The guide says jpeg is faster than png.
 *   - A prompt may be up to 32,000 characters there. Broadside allows 2,000.
 *   - "Complex prompts may take up to 2 minutes to process."
 *   - Errors are { error: { message, type, param, code } } with the HTTP status. 401 is a key that
 *     was refused. 429 is either a rate limit or an account out of credit or over a spending limit
 *     (credit_balance_exhausted, insufficient_quota, organization_spend_limit_exceeded,
 *     project_spend_limit_exceeded, organization_usage_limit_exceeded). A prompt or picture refused
 *     by moderation is type image_generation_user_error with code moderation_blocked, and may
 *     carry moderation_details { moderation_stage, categories }.
 *
 * The key is read from OPENAI_API_KEY each time it is used. It is never stored,
 * never returned, and taken out of any provider text before that text is shown.
 */
import { InputError } from "./accounts";
import { newId } from "./crypto";
import { get, now, run } from "./db";
import { saveMedia, sniff, type Media } from "./media";
import { BlockedAddress, guardedFetch, readCapped } from "./net";

export const ENDPOINT = "https://api.openai.com/v1/images/generations";
export const DEFAULT_MODEL = "gpt-image-2.6-flare";
export const DEFAULT_DAILY_LIMIT = 20;
export const PROMPT_MAX = 2000;

export const SHAPES = ["square", "portrait", "landscape"] as const;
export type Shape = (typeof SHAPES)[number];
export const SIZES: Record<Shape, string> = { square: "1024x1024", portrait: "1024x1536", landscape: "1536x1024" };

/** The docs allow two minutes for a complex prompt. A minute on top, then the request is abandoned. */
const TIMEOUT_MS = 180_000;
/** The answer is one image as base64 inside JSON. Far above any picture at these sizes, far below what would hurt. */
const MAX_RESPONSE_BYTES = 48 * 1024 * 1024;
/** A claim whose call never finished (the process stopped in the middle) stops counting after this long. */
const STALE_CLAIM_MS = 15 * 60_000;

const key = (): string => (process.env.OPENAI_API_KEY ?? "").trim();

/** The model asked for: BROADSIDE_IMAGE_MODEL when it is a plain model name, else the default. */
export function imageModel(): string {
  const chosen = (process.env.BROADSIDE_IMAGE_MODEL ?? "").trim();
  return /^[\w.:-]{1,100}$/.test(chosen) ? chosen : DEFAULT_MODEL;
}

/** Images allowed per UTC day. Unset is 20. Anything that is not a whole number of zero or more is 0, so a typing mistake turns generation off and never on. */
export function dailyLimit(): number {
  const raw = process.env.BROADSIDE_IMAGE_DAILY_LIMIT;
  if (raw === undefined || raw.trim() === "") return DEFAULT_DAILY_LIMIT;
  return /^\d{1,6}$/.test(raw.trim()) ? Number(raw.trim()) : 0;
}

/** True when a key is set and the cap is above zero. Nothing is ever sent anywhere otherwise. */
export const generationAvailable = (): boolean => Boolean(key()) && dailyLimit() > 0;

const dayOf = (at: Date): string => at.toISOString().slice(0, 10);
/** Midnight UTC after `at`: when the day's count starts again. */
const resetAfter = (at: Date): string => new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate() + 1)).toISOString();

function usedOn(day: string, at: Date): number {
  const stale = new Date(at.getTime() - STALE_CLAIM_MS).toISOString();
  return get<{ n: number }>("SELECT COUNT(*) AS n FROM image_generations WHERE day = ? AND (status = 'done' OR created_at > ?)", day, stale)?.n ?? 0;
}

export type GenerationStatus = {
  /** True when OPENAI_API_KEY is set on the server and the daily cap is above zero. */
  available: boolean;
  /** How many more images may be made today (UTC), across everyone and every key. */
  remaining: number;
  limit: number;
  model: string;
  /** When today's count starts again: the next midnight UTC. */
  resets_at: string;
};

/** Whether images can be generated, and how many are left today. Says nothing about the key beyond whether one is set. */
export function generationStatus(at = new Date()): GenerationStatus {
  const limit = dailyLimit();
  const available = generationAvailable();
  return { available, remaining: available ? Math.max(0, limit - usedOn(dayOf(at), at)) : 0, limit, model: imageModel(), resets_at: resetAfter(at) };
}

const OFF = "Image generation is not turned on. Set OPENAI_API_KEY on the server and restart Broadside.";
const CAPPED_OFF = "Image generation is turned off on this Broadside: BROADSIDE_IMAGE_DAILY_LIMIT is 0.";

/** The prompt, trimmed, or the reason it cannot be used. It is never cut to fit. */
export function cleanPrompt(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new InputError("Write a prompt: a sentence or two describing the image.");
  const prompt = value.trim();
  if (prompt.length > PROMPT_MAX) throw new InputError(`The prompt is ${prompt.length} characters, and the most Broadside sends is ${PROMPT_MAX}. Shorten it and try again.`);
  return prompt;
}

export function cleanShape(value: unknown): Shape {
  if (value === undefined || value === null || value === "") return "square";
  if (typeof value !== "string" || !(SHAPES as readonly string[]).includes(value)) throw new InputError("The shape is one of square, portrait or landscape.");
  return value as Shape;
}

/** Text the provider sent, made safe to show: the key taken out if it is echoed, control characters dropped, and cut to a readable length. It is data, and is only ever quoted. */
function theirWords(value: unknown, secret: string): string {
  if (typeof value !== "string") return "";
  let text = value;
  if (secret) text = text.split(secret).join("[key]");
  // Anything shaped like an OpenAI key goes too, whole or masked in the middle, in case the provider quotes one back.
  text = text.replace(/\bsk-[\w*.-]{6,}/g, "[key]");
  text = text.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return text.length > 400 ? `${text.slice(0, 400)}…` : text;
}

/** The picture types the provider may answer with, and the ending each file name gets. */
const EXTENSIONS: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

const CREDIT_CODES = ["credit_balance_exhausted", "insufficient_quota", "organization_spend_limit_exceeded", "project_spend_limit_exceeded", "organization_usage_limit_exceeded", "billing_hard_limit_reached"];

type ProviderError = { message?: unknown; type?: unknown; code?: unknown; moderation_details?: { moderation_stage?: unknown; categories?: unknown } };

/** A refusal from the provider, as a sentence about what happened and what to do. */
function refusal(status: number, error: ProviderError, secret: string): InputError {
  const said = theirWords(error.message, secret);
  const code = typeof error.code === "string" ? error.code : "";
  const type = typeof error.type === "string" ? error.type : "";
  // A refused key is answered with the key itself, partly masked. None of that answer is repeated.
  if (status === 401) return new InputError("The key in OPENAI_API_KEY was refused by OpenAI. Check the key on the server, then restart Broadside.");
  if (code === "moderation_blocked" || type === "image_generation_user_error") {
    const details = error.moderation_details;
    const categories = Array.isArray(details?.categories) ? details.categories.filter((c): c is string => typeof c === "string").map((c) => theirWords(c, secret)).slice(0, 10) : [];
    const stage = theirWords(details?.moderation_stage, secret);
    return new InputError(
      said ? `OpenAI refused this prompt. It said: "${said}" Change the prompt and try again.` : "OpenAI refused this prompt because it did not meet its content rules. Change the prompt and try again.",
      { refused_by: "openai", ...(stage ? { stage } : {}), ...(categories.length ? { categories } : {}) },
    );
  }
  if (status === 429 && (CREDIT_CODES.includes(code) || CREDIT_CODES.includes(type))) {
    return new InputError("The OpenAI account behind OPENAI_API_KEY has no credit left or has reached its spending limit. Add credit or raise the limit at OpenAI, then try again.");
  }
  if (status === 429) return new InputError("OpenAI is limiting how fast this key may ask. Wait a minute and try again.");
  if (status >= 500) return new InputError(`OpenAI had a problem of its own (it answered ${status}). Nothing was generated. Try again in a moment.`);
  if (status === 403) return new InputError(said ? `OpenAI would not serve this request. It said: "${said}"` : "OpenAI would not serve this request (it answered 403). The account may need verifying at OpenAI before it can use image models.");
  return new InputError(said ? `OpenAI did not accept the request. It said: "${said}"` : `OpenAI did not accept the request (it answered ${status}).`);
}

/**
 * Asks OpenAI for one image and returns its bytes. `fetcher` is injectable, as
 * in the connectors, so tests never reach the real API. The request goes
 * through guardedFetch, and a redirect is refused outright: the key goes to
 * api.openai.com and nowhere a redirect points.
 */
export async function requestImage(input: { prompt: string; shape: Shape }, fetcher: typeof fetch = fetch): Promise<{ bytes: Uint8Array; type: string; model: string; size: string }> {
  const secret = key();
  if (!secret) throw new InputError(OFF);
  const model = imageModel();
  const size = SIZES[input.shape];
  const noRedirects = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const answer = await fetcher(url, init);
    if (answer.status >= 300 && answer.status < 400) throw new InputError("OpenAI answered with a redirect. Broadside does not follow one with your key, so nothing was generated.");
    return answer;
  }) as typeof fetch;

  let response: Response;
  let bytes: Uint8Array;
  try {
    response = await guardedFetch(noRedirects)(ENDPOINT, {
      method: "POST",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body: JSON.stringify({ model, prompt: input.prompt, size, n: 1, output_format: "jpeg" }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    bytes = await readCapped(response, MAX_RESPONSE_BYTES).catch((cause: Error) => {
      throw cause instanceof BlockedAddress ? new InputError("OpenAI's answer was larger than Broadside accepts, so it was dropped. Try again.") : cause;
    });
  } catch (cause) {
    if (cause instanceof InputError) throw cause;
    if (cause instanceof BlockedAddress) throw new InputError(theirWords(cause.message, secret));
    const name = (cause as Error)?.name;
    if (name === "TimeoutError" || name === "AbortError") throw new InputError("OpenAI did not answer within three minutes, so Broadside stopped waiting. Try again, or try a simpler prompt.");
    throw new InputError("OpenAI could not be reached. Check that the server can reach api.openai.com, then try again.");
  }

  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    payload = null;
  }
  const body = payload && typeof payload === "object" ? (payload as { error?: ProviderError; data?: unknown }) : {};
  if (!response.ok) throw refusal(response.status, body.error && typeof body.error === "object" ? body.error : {}, secret);
  const first = Array.isArray(body.data) ? (body.data[0] as { b64_json?: unknown } | undefined) : undefined;
  if (!first || typeof first.b64_json !== "string" || !first.b64_json) throw new InputError("OpenAI answered without an image. Try again.");
  const image = new Uint8Array(Buffer.from(first.b64_json, "base64"));
  // What it is comes from the bytes, as for any upload. Anything that is not a picture is dropped here and never stored.
  const type = sniff(image);
  if (!type || !(type in EXTENSIONS)) throw new InputError("OpenAI answered with something that is not an image, so it was not kept. Try again.");
  return { bytes: image, type, model, size };
}

/**
 * Takes one of today's images, or says there are none left. One statement
 * counts and inserts, so requests arriving together cannot take more than the
 * cap between them, in this process or another one sharing the database.
 */
function claim(limit: number, createdBy: string | null, at: Date): string | null {
  const id = newId("gen");
  const day = dayOf(at);
  const stale = new Date(at.getTime() - STALE_CLAIM_MS).toISOString();
  const taken = run(
    "INSERT INTO image_generations (id, day, status, created_by, created_at) SELECT ?, ?, 'claimed', ?, ? WHERE (SELECT COUNT(*) FROM image_generations WHERE day = ? AND (status = 'done' OR created_at > ?)) < ?",
    id,
    day,
    createdBy,
    at.toISOString(),
    day,
    stale,
    limit,
  );
  return taken ? id : null;
}

const utcTime = (iso: string): string => `${iso.slice(11, 16)} UTC`;

export type GenerateResult = { media: Media; remaining: number; limit: number; resets_at: string };

/**
 * One image from a prompt, kept in the media library. The day's count is
 * taken before OpenAI is called and given back if no picture comes back: a
 * refusal, an error, no answer, or an answer that is not a picture. Once a
 * picture has come back it stays counted, whatever happens to the file
 * afterwards (deleting it included): that image was billed.
 */
export async function generateImage(input: { prompt?: unknown; shape?: unknown }, options: { fetcher?: typeof fetch; createdBy?: string | null; at?: Date } = {}): Promise<GenerateResult> {
  const at = options.at ?? new Date();
  if (!key()) throw new InputError(OFF);
  const limit = dailyLimit();
  if (limit <= 0) throw new InputError(CAPPED_OFF);
  const prompt = cleanPrompt(input.prompt);
  const shape = cleanShape(input.shape);

  const claimed = claim(limit, options.createdBy ?? null, at);
  if (!claimed) {
    const resets = resetAfter(at);
    throw new InputError(`Today's ${limit === 1 ? "one image has" : `${limit} images have`} been generated. The count starts again at ${utcTime(resets)}. The limit is BROADSIDE_IMAGE_DAILY_LIMIT on the server.`, { remaining: 0, limit, resets_at: resets });
  }

  let made: Awaited<ReturnType<typeof requestImage>>;
  try {
    made = await requestImage({ prompt, shape }, options.fetcher);
  } catch (error) {
    run("DELETE FROM image_generations WHERE id = ?", claimed);
    throw error;
  }
  run("UPDATE image_generations SET status = 'done' WHERE id = ?", claimed);
  // From here it is an upload like any other: the type comes from the bytes, the size cap applies, and it is served sandboxed.
  const stamp = now().slice(0, 19).replace(/[-:]/g, "").replace("T", "-");
  const media = saveMedia(made.bytes, `generated-${stamp}.${EXTENSIONS[made.type]}`, made.type, { alt: prompt, generated: { prompt, model: made.model, createdBy: options.createdBy ?? null } });
  run("UPDATE image_generations SET media_id = ? WHERE id = ?", media.id, claimed);
  const status = generationStatus(at);
  return { media, remaining: status.remaining, limit: status.limit, resets_at: status.resets_at };
}
