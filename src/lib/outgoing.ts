import { createHmac, randomBytes } from "node:crypto";
import { InputError } from "./accounts";
import { newId, open, seal } from "./crypto";
import { all, get, now, run } from "./db";
import { assertPublicUrl, BlockedAddress, guardedFetch } from "./net";
import type { Post, Target } from "./posts";

/**
 * Outgoing webhooks: addresses Broadside calls when something happens to a
 * post. They are the reverse of the "webhook" network in src/lib/platforms,
 * which is a destination that receives posts. Nothing here publishes.
 *
 * An event is queued as one row per webhook and nothing else, so the engine
 * that publishes never waits for a receiver and never fails because of one.
 * The scheduler sends what is queued. Each request carries a delivery id, the
 * time it was sent and an HMAC-SHA256 over `<time>.<delivery id>.<body>` made
 * with that webhook's own secret, so a receiver can tell who sent it and
 * refuse a copy replayed later. A delivery that fails is tried again a few
 * times, further apart each time, then given up on; a webhook whose
 * deliveries keep failing is paused and says why.
 */

export const EVENTS = ["post.published", "post.partial", "post.failed", "post.scheduled", "target.failed"] as const;
export type EventName = (typeof EVENTS)[number];
/** What "Send a test" sends. Nobody subscribes to it. */
export const TEST_EVENT = "webhook.test";

/** The headers every delivery carries. The signature covers the timestamp, the delivery id and the body. */
export const HEADERS = {
  event: "x-broadside-event",
  delivery: "x-broadside-delivery",
  timestamp: "x-broadside-timestamp",
  signature: "x-broadside-event-signature",
} as const;

/** A delivery is tried this many times in all. */
export const MAX_ATTEMPTS = 5;
/** The wait before each try after the first: 30 seconds, 2 minutes, 10 minutes, an hour. */
export const RETRY_AFTER_MS = [30_000, 120_000, 600_000, 3_600_000];
/** A webhook is paused once this many deliveries in a row have been given up on. */
export const PAUSE_AFTER = 5;
/** A receiver that has not answered by now is given up on for this try. */
export const DELIVERY_TIMEOUT_MS = 10_000;
/** How many deliveries the log keeps for each webhook. */
export const LOG_SIZE = 25;
/** How many deliveries one scheduler tick sends. */
const PER_SWEEP = 10;
/** A delivery left "delivering" by a process that died is picked up again after this long. A receiver may then see it twice, under the same delivery id. */
const STALE_MS = 2 * 60_000;
const MAX_WEBHOOKS = 20;
const MAX_NAME = 60;
const MAX_URL = 2000;
const PAUSED_NOTE = "Not sent: the webhook was paused.";

export type DeliveryStatus = "pending" | "delivering" | "retrying" | "delivered" | "failed";
export type Delivery = {
  id: string;
  event: string;
  post_id: string | null;
  status: DeliveryStatus;
  /** How many times it has been tried. */
  attempts: number;
  /** The receiver's last HTTP status, when it answered at all. */
  response_code: number | null;
  error: string | null;
  created_at: string;
  attempted_at: string | null;
  next_attempt_at: string | null;
};

export type OutgoingWebhook = {
  id: string;
  name: string;
  url: string;
  events: EventName[];
  status: "active" | "paused";
  /** Why Broadside paused it. Null when a person did, or when it is active. */
  paused_reason: string | null;
  created_at: string;
  updated_at: string;
  /** The latest deliveries, newest first. */
  deliveries: Delivery[];
};

type HookRow = { id: string; name: string; url: string; secret: string; events: string; status: "active" | "paused"; paused_reason: string | null; failures: number; created_at: string; updated_at: string };
type DeliveryRow = Delivery & { webhook_id: string; payload: string };

const DELIVERY_COLUMNS = "id, event, post_id, status, attempts, response_code, error, created_at, attempted_at, next_attempt_at";

/* Reading ------------------------------------------------------------------ */

/** Everything about a webhook except its secret, which is shown once when it is made and never again. */
function view(row: HookRow): OutgoingWebhook {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    events: (JSON.parse(row.events) as string[]).filter((e): e is EventName => EVENTS.includes(e as EventName)),
    status: row.status,
    paused_reason: row.paused_reason,
    created_at: row.created_at,
    updated_at: row.updated_at,
    deliveries: all<Delivery>(`SELECT ${DELIVERY_COLUMNS} FROM outgoing_deliveries WHERE webhook_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`, row.id, LOG_SIZE),
  };
}

export function listOutgoingWebhooks(): OutgoingWebhook[] {
  return all<HookRow>("SELECT * FROM outgoing_webhooks ORDER BY created_at, rowid").map(view);
}

export function getOutgoingWebhook(id: string): OutgoingWebhook | undefined {
  const row = get<HookRow>("SELECT * FROM outgoing_webhooks WHERE id = ?", id);
  return row && view(row);
}

/* Changing ----------------------------------------------------------------- */

function cleanName(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new InputError("An outgoing webhook needs a name.");
  const name = value.trim().replace(/\s+/g, " ");
  if ([...name].length > MAX_NAME) throw new InputError(`A name can be ${MAX_NAME} characters; this is ${[...name].length}.`);
  return name;
}

/** The address as it will be called. It is checked again, with every address it resolves to, each time a delivery is sent. */
async function cleanUrl(value: unknown): Promise<string> {
  if (typeof value !== "string" || !value.trim()) throw new InputError("An outgoing webhook needs an address to call.");
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new InputError("That is not a valid address. It should start with https:// or http://.");
  }
  if (!/^https?:$/.test(url.protocol)) throw new InputError("An outgoing webhook address must start with https:// or http://.");
  if (url.username || url.password) throw new InputError("Leave the user name and password out of the address. The signing secret is what proves a delivery came from Broadside.");
  if (url.href.length > MAX_URL) throw new InputError(`An address can be ${MAX_URL} characters long.`);
  await assertPublicUrl(url).catch((cause: Error) => {
    throw new InputError(cause.message);
  });
  return url.href;
}

function cleanEvents(value: unknown): EventName[] {
  if (value === undefined || value === null) return [...EVENTS];
  if (!Array.isArray(value) || value.some((e) => !EVENTS.includes(e as EventName))) throw new InputError(`events must be a list of these names: ${EVENTS.join(", ")}.`);
  const events = EVENTS.filter((e) => value.includes(e));
  if (!events.length) throw new InputError("Choose at least one event to be told about.");
  return events;
}

/** Makes a webhook and its signing secret. The secret is in the reply to this call only; what is stored is sealed. */
export async function createOutgoingWebhook(input: { name?: unknown; url?: unknown; events?: unknown }): Promise<{ webhook: OutgoingWebhook; secret: string }> {
  const name = cleanName(input.name);
  const url = await cleanUrl(input.url);
  const events = cleanEvents(input.events);
  if ((get<{ n: number }>("SELECT COUNT(*) AS n FROM outgoing_webhooks")?.n ?? 0) >= MAX_WEBHOOKS) throw new InputError(`Broadside keeps up to ${MAX_WEBHOOKS} outgoing webhooks. Delete one first.`);
  const id = newId("owh");
  const secret = `whsec_${randomBytes(32).toString("base64url")}`;
  const stamp = now();
  run("INSERT INTO outgoing_webhooks (id, name, url, secret, events, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)", id, name, url, seal(secret), JSON.stringify(events), stamp, stamp);
  return { webhook: getOutgoingWebhook(id)!, secret };
}

/** Renames a webhook, points it somewhere else, changes its events, or pauses and resumes it. What is left out stays as it is. */
export async function updateOutgoingWebhook(id: string, patch: { name?: unknown; url?: unknown; events?: unknown; paused?: unknown }): Promise<OutgoingWebhook> {
  const row = get<HookRow>("SELECT * FROM outgoing_webhooks WHERE id = ?", id);
  if (!row) throw new InputError(`No outgoing webhook with id ${id}.`);
  if (patch.paused !== undefined && typeof patch.paused !== "boolean") throw new InputError("paused must be true or false.");
  const name = patch.name === undefined ? row.name : cleanName(patch.name);
  const url = patch.url === undefined ? row.url : await cleanUrl(patch.url);
  const events = patch.events === undefined ? row.events : JSON.stringify(cleanEvents(patch.events));
  run("UPDATE outgoing_webhooks SET name = ?, url = ?, events = ?, updated_at = ? WHERE id = ?", name, url, events, now(), id);
  if (patch.paused === true && row.status === "active") pause(id, null);
  // Resuming starts the count again: what failed before the pause says nothing about the receiver now.
  if (patch.paused === false) run("UPDATE outgoing_webhooks SET status = 'active', paused_reason = NULL, failures = 0 WHERE id = ?", id);
  return getOutgoingWebhook(id)!;
}

export function deleteOutgoingWebhook(id: string): boolean {
  return run("DELETE FROM outgoing_webhooks WHERE id = ?", id) > 0;
}

/** Stops a webhook, and gives up on what was waiting to go to it, so resuming later does not send a backlog of stale news. */
function pause(id: string, reason: string | null): void {
  run("UPDATE outgoing_webhooks SET status = 'paused', paused_reason = ?, updated_at = ? WHERE id = ?", reason, now(), id);
  run("UPDATE outgoing_deliveries SET status = 'failed', error = ?, next_attempt_at = NULL WHERE webhook_id = ? AND status IN ('pending', 'retrying')", PAUSED_NOTE, id);
}

/* Queueing ----------------------------------------------------------------- */

/** True when some active webhook wants this event, so the engine can skip building a payload nobody will read. */
export function listening(event: EventName): boolean {
  return all<{ events: string }>("SELECT events FROM outgoing_webhooks WHERE status = 'active'").some((row) => (JSON.parse(row.events) as string[]).includes(event));
}

function enqueue(webhookId: string, event: string, postId: string | null, body: (deliveryId: string, at: string) => Record<string, unknown>): string {
  const id = newId("dlv");
  const stamp = now();
  run("INSERT INTO outgoing_deliveries (id, webhook_id, event, post_id, payload, status, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)", id, webhookId, event, postId, JSON.stringify(body(id, stamp)), stamp);
  // The log is short: finished deliveries beyond the newest few are dropped. One still waiting is never dropped.
  run(
    "DELETE FROM outgoing_deliveries WHERE webhook_id = ? AND status IN ('delivered', 'failed') AND id NOT IN (SELECT id FROM outgoing_deliveries WHERE webhook_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?)",
    webhookId,
    webhookId,
    LOG_SIZE,
  );
  return id;
}

/**
 * Queues an event for every active webhook that asked for it. This writes
 * rows and sends nothing. The post is the one the REST API returns, which
 * holds no credentials; `target` is the one that failed, for target.failed.
 */
export function queueEvent(event: EventName, post: Post, target?: Target): number {
  const hooks = all<HookRow>("SELECT * FROM outgoing_webhooks WHERE status = 'active'").filter((row) => (JSON.parse(row.events) as string[]).includes(event));
  for (const hook of hooks) enqueue(hook.id, event, post.id, (id, at) => ({ id, event, created_at: at, post, ...(target ? { target } : {}) }));
  return hooks.length;
}

/* Sending ------------------------------------------------------------------ */

/** The signature a delivery carries: HMAC-SHA256 over the time, the delivery id and the exact body, as hex after "v1=". */
export function signature(secret: string, timestamp: string, deliveryId: string, body: string): string {
  return `v1=${createHmac("sha256", secret).update(`${timestamp}.${deliveryId}.${body}`).digest("hex")}`;
}

/** Deliveries whose time has come: new ones, retries whose wait is over, and ones a dead process left half sent. Oldest first. */
export function dueDeliveries(limit = PER_SWEEP, at = Date.now()): string[] {
  return all<{ id: string }>(
    `SELECT d.id FROM outgoing_deliveries d JOIN outgoing_webhooks w ON w.id = d.webhook_id
     WHERE d.status = 'pending' OR (d.status = 'retrying' AND d.next_attempt_at <= ?) OR (d.status = 'delivering' AND d.attempted_at <= ?)
     ORDER BY d.created_at, d.rowid LIMIT ?`,
    new Date(at).toISOString(),
    new Date(at - STALE_MS).toISOString(),
    limit,
  ).map((row) => row.id);
}

class Redirected extends Error {}

const short = (text: string): string => [...text].slice(0, 300).join("");

/**
 * Sends one delivery and records how it went.
 *
 * The claim is a compare-and-set, so two clocks never send the same try
 * twice. The request goes through guardedFetch, which refuses an address on
 * this machine or a private network. A redirect is never followed: the signed
 * body goes to the address the operator typed and nowhere else. The answer's
 * body is not read, and nothing from it is kept but the status code.
 */
export async function deliver(deliveryId: string, fetcher: typeof fetch = fetch, options: { timeoutMs?: number } = {}): Promise<Delivery | undefined> {
  const stale = new Date(Date.now() - STALE_MS).toISOString();
  const claimed = run(
    "UPDATE outgoing_deliveries SET status = 'delivering', attempts = attempts + 1, attempted_at = ?, error = NULL WHERE id = ? AND (status IN ('pending', 'retrying') OR (status = 'delivering' AND attempted_at <= ?))",
    now(),
    deliveryId,
    stale,
  );
  if (!claimed) return undefined;
  const row = get<DeliveryRow>("SELECT * FROM outgoing_deliveries WHERE id = ?", deliveryId)!;
  const hook = get<HookRow>("SELECT * FROM outgoing_webhooks WHERE id = ?", row.webhook_id);
  if (!hook) return undefined;
  const test = row.event === TEST_EVENT;
  const host = new URL(hook.url).host;
  const timeoutMs = options.timeoutMs ?? DELIVERY_TIMEOUT_MS;
  // Signed afresh on every try: the time is part of what is signed, so a receiver can refuse an old capture and still accept a late retry.
  const timestamp = String(Math.floor(Date.now() / 1000));
  const headers = {
    "content-type": "application/json",
    "user-agent": "Broadside (outgoing webhook)",
    [HEADERS.event]: row.event,
    [HEADERS.delivery]: row.id,
    [HEADERS.timestamp]: timestamp,
    [HEADERS.signature]: signature(open<string>(hook.secret), timestamp, row.id, row.payload),
  };

  let code: number | null = null;
  let failure: string | null = null;
  // Trying again cannot help when the address itself is refused or sends callers elsewhere.
  let final = false;
  let requests = 0;
  const once = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (requests++ > 0) throw new Redirected();
    return fetcher(input, init);
  }) as typeof fetch;
  try {
    const response = await guardedFetch(once)(hook.url, { method: "POST", headers, body: row.payload, signal: AbortSignal.timeout(timeoutMs) });
    code = response.status;
    await response.body?.cancel().catch(() => undefined);
    if (!response.ok) failure = `${host} answered ${code}.`;
  } catch (error) {
    const redirected = error instanceof Redirected || (requests > 0 && error instanceof BlockedAddress);
    if (redirected) {
      final = true;
      failure = `${host} answered with a redirect. Broadside does not follow redirects for an outgoing webhook, so the signed request went no further. Use the final address.`;
    } else if (error instanceof BlockedAddress) {
      final = true;
      failure = error.message;
    } else if ((error as Error).name === "TimeoutError" || (error as Error).name === "AbortError") {
      failure = `${host} did not answer within ${Math.round(timeoutMs / 1000)} seconds.`;
    } else {
      const cause = (error as { cause?: { code?: string } }).cause?.code;
      failure = short(`Could not reach ${host}: ${cause ?? (error as Error).message}`);
    }
  }

  if (!failure) {
    run("UPDATE outgoing_deliveries SET status = 'delivered', response_code = ?, error = NULL, next_attempt_at = NULL WHERE id = ?", code, row.id);
    if (!test) run("UPDATE outgoing_webhooks SET failures = 0 WHERE id = ?", hook.id);
  } else if (!test && !final && row.attempts < MAX_ATTEMPTS) {
    const next = new Date(Date.now() + RETRY_AFTER_MS[Math.min(row.attempts, RETRY_AFTER_MS.length) - 1]).toISOString();
    run("UPDATE outgoing_deliveries SET status = 'retrying', response_code = ?, error = ?, next_attempt_at = ? WHERE id = ?", code, failure, next, row.id);
  } else {
    run("UPDATE outgoing_deliveries SET status = 'failed', response_code = ?, error = ?, next_attempt_at = NULL WHERE id = ?", code, failure, row.id);
    // A test says how the receiver is doing now. It is one try, and it never counts toward a pause.
    if (!test) {
      run("UPDATE outgoing_webhooks SET failures = failures + 1 WHERE id = ?", hook.id);
      const failures = get<{ failures: number; status: string }>("SELECT failures, status FROM outgoing_webhooks WHERE id = ?", hook.id);
      if (failures && failures.status === "active" && failures.failures >= PAUSE_AFTER) pause(hook.id, short(`Paused after ${PAUSE_AFTER} deliveries in a row failed. The last one: ${failure}`));
    }
  }
  return get<Delivery>(`SELECT ${DELIVERY_COLUMNS} FROM outgoing_deliveries WHERE id = ?`, row.id);
}

/**
 * One background sweep: sends what is due, all at once, and waits for every
 * receiver or its timeout. The scheduler starts it beside publishing and
 * never waits for it.
 */
export async function deliverDue(fetcher: typeof fetch = fetch, options: { timeoutMs?: number; limit?: number } = {}): Promise<Delivery[]> {
  const sent = await Promise.all(dueDeliveries(options.limit ?? PER_SWEEP).map((id) => deliver(id, fetcher, options)));
  return sent.filter((d): d is Delivery => Boolean(d));
}

/** Sends a test delivery now and says how the receiver answered. It works on a paused webhook too, to check a receiver before resuming. */
export async function sendTest(id: string, fetcher: typeof fetch = fetch, options: { timeoutMs?: number } = {}): Promise<Delivery> {
  if (!get("SELECT 1 AS found FROM outgoing_webhooks WHERE id = ?", id)) throw new InputError(`No outgoing webhook with id ${id}.`);
  const deliveryId = enqueue(id, TEST_EVENT, null, (delivery, at) => ({ id: delivery, event: TEST_EVENT, created_at: at, post: null, message: "A test delivery from Broadside. Nothing was posted." }));
  const delivery = await deliver(deliveryId, fetcher, options);
  if (!delivery) throw new InputError("The test could not be sent. Try again.");
  return delivery;
}
