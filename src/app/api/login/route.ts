import { passwordMatches, passwordRequired, SESSION_COOKIE, SESSION_SECONDS, sessionValue } from "@/lib/session";

/**
 * Guessing is slowed, never locked. After a few wrong passwords in five
 * minutes every attempt waits before it is checked, the wait doubling up to a
 * ceiling, and attempts are handled one at a time so a flood cannot run in
 * parallel. The right password always works; under attack it just takes a few
 * seconds. Nothing here depends on the caller's address, which a client can
 * fake, so there is no per-address rule to dodge and no one to lock out.
 */
const WINDOW_MS = 5 * 60_000;
const FREE_ATTEMPTS = 5;
const BASE_DELAY_MS = Number(process.env.BROADSIDE_LOGIN_DELAY_MS ?? 500);
const MAX_WAITING = 30;

let failures: number[] = [];
let queue: Promise<unknown> = Promise.resolve();
let waiting = 0;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Signing out clears the cookie in this browser. To end every session at once, change the password. */
export async function DELETE() {
  return Response.json({ data: { signed_in: false } }, { headers: { "set-cookie": `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0` } });
}

export async function POST(request: Request) {
  // A sign-in form posted from another site is not someone signing in here.
  if (request.headers.get("sec-fetch-site") === "cross-site") {
    return Response.json({ error: { code: "cross_site", message: "Sign in from Broadside's own page." } }, { status: 403 });
  }
  const { password } = (await request.json().catch(() => ({}))) as { password?: string };
  if (!passwordRequired()) return Response.json({ data: { signed_in: true } });

  if (waiting >= MAX_WAITING) {
    return Response.json({ error: { code: "busy", message: "Too many sign-in attempts are waiting. Try again in a moment." } }, { status: 429, headers: { "retry-after": "10" } });
  }
  waiting++;
  const turn = queue.then(async () => {
    const now = Date.now();
    failures = failures.filter((at) => at > now - WINDOW_MS);
    const over = failures.length - FREE_ATTEMPTS;
    if (over >= 0) await sleep(Math.min(BASE_DELAY_MS * 2 ** over, BASE_DELAY_MS * 8));
    const right = Boolean(password) && (await passwordMatches(password!));
    if (!right) failures.push(Date.now());
    return right;
  });
  queue = turn.catch(() => undefined);
  const right = await turn.finally(() => waiting--);

  if (!right) {
    return Response.json({ error: { code: "wrong_password", message: "That is not the password for this Broadside." } }, { status: 401 });
  }
  const secure = new URL(request.url).protocol === "https:" || request.headers.get("x-forwarded-proto") === "https";
  return Response.json(
    { data: { signed_in: true } },
    { headers: { "set-cookie": `${SESSION_COOKIE}=${await sessionValue()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_SECONDS}${secure ? "; Secure" : ""}` } },
  );
}
