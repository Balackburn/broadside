import { memberSecret } from "@/lib/actor";
import { open } from "@/lib/http";
import { nameKey, signIn, teamMode } from "@/lib/members";
import { memberSessionValue, passwordMatches, passwordRequired, SESSION_CLEARED, sessionHeader, sessionValue } from "@/lib/session";

/**
 * Guessing is slowed, never locked. After a few wrong passwords in five
 * minutes every attempt waits before it is checked, the wait doubling up to a
 * ceiling, and attempts are handled one at a time so a flood cannot run in
 * parallel. The right password always works; under attack it just takes a few
 * seconds. Nothing here depends on the caller's address, which a client can
 * fake, so there is no per-address rule to dodge and no one to lock out.
 *
 * With a team, wrong attempts are also counted per member name, so guessing
 * at one member slows attempts on that name first and everyone else's later.
 * A name nobody has is counted the same way as one somebody has.
 */
const WINDOW_MS = 5 * 60_000;
const FREE_ATTEMPTS = 5;
/** With a team, how many wrong attempts across all names are let through before every sign-in waits. */
const FREE_ATTEMPTS_ALL_NAMES = 20;
const BASE_DELAY_MS = Number(process.env.BROADSIDE_LOGIN_DELAY_MS ?? 500);
const MAX_WAITING = 30;
const MAX_NAMES = 2000;

let failures: number[] = [];
const failuresByName = new Map<string, number[]>();
let queue: Promise<unknown> = Promise.resolve();
let waiting = 0;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const wait = (over: number) => (over >= 0 ? sleep(Math.min(BASE_DELAY_MS * 2 ** over, BASE_DELAY_MS * 8)) : Promise.resolve());

function failed(name: string, at: number): void {
  failures.push(at);
  failuresByName.set(name, [...(failuresByName.get(name) ?? []), at]);
  // The table of names cannot be grown without limit by inventing names: the oldest go first.
  for (const key of failuresByName.keys()) {
    if (failuresByName.size <= MAX_NAMES) break;
    failuresByName.delete(key);
  }
}

/** Signing out clears the cookie in this browser. To end every session at once, change the password. */
export const DELETE = open("Signing out only clears this browser's own cookie.", async () => {
  return Response.json({ data: { signed_in: false } }, { headers: { "set-cookie": SESSION_CLEARED } });
});

export const POST = open("This is the sign-in itself: the password is what it checks.", async (request: Request) => {
  // A sign-in form posted from another site is not someone signing in here.
  if (request.headers.get("sec-fetch-site") === "cross-site") {
    return Response.json({ error: { code: "cross_site", message: "Sign in from Broadside's own page." } }, { status: 403 });
  }
  const { password, name } = (await request.json().catch(() => ({}))) as { password?: unknown; name?: unknown };
  const team = teamMode();
  if (!team && !passwordRequired()) return Response.json({ data: { signed_in: true } });

  if (waiting >= MAX_WAITING) {
    return Response.json({ error: { code: "busy", message: "Too many sign-in attempts are waiting. Try again in a moment." } }, { status: 429, headers: { "retry-after": "10" } });
  }
  waiting++;
  const turn = queue.then(async (): Promise<string | null> => {
    const now = Date.now();
    failures = failures.filter((at) => at > now - WINDOW_MS);
    if (!team) {
      await wait(failures.length - FREE_ATTEMPTS);
      const right = typeof password === "string" && Boolean(password) && (await passwordMatches(password));
      if (!right) failures.push(Date.now());
      return right ? await sessionValue() : null;
    }
    const key = (typeof name === "string" ? nameKey(name) : "").slice(0, 80);
    const mine = (failuresByName.get(key) ?? []).filter((at) => at > now - WINDOW_MS);
    if (mine.length) failuresByName.set(key, mine);
    else failuresByName.delete(key);
    await wait(Math.max(mine.length - FREE_ATTEMPTS, failures.length - FREE_ATTEMPTS_ALL_NAMES));
    // A wrong name and a wrong password take the same path from here: one password derivation, then the same answer.
    const member = await signIn(name, password);
    const secret = member && memberSecret(member.id);
    if (!member || !secret) {
      failed(key, Date.now());
      return null;
    }
    return memberSessionValue(member.id, secret);
  });
  queue = turn.catch(() => undefined);
  const session = await turn.finally(() => waiting--);

  if (!session) {
    return Response.json(
      { error: team ? { code: "wrong_password", message: "That name and password do not match a member of this Broadside." } : { code: "wrong_password", message: "That is not the password for this Broadside." } },
      { status: 401 },
    );
  }
  return Response.json({ data: { signed_in: true } }, { headers: { "set-cookie": sessionHeader(session, request) } });
});
