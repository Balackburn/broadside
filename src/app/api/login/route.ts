import { passwordMatches, passwordRequired, SESSION_COOKIE, SESSION_SECONDS, sessionValue } from "@/lib/session";

/**
 * Wrong guesses are counted per address and overall. Past the limit the route
 * answers 429 without checking the password, so a guesser gains nothing by
 * continuing, and a slow distributed attempt still runs into the overall cap.
 */
const WINDOW_MS = 5 * 60_000;
const PER_ADDRESS = 8;
const OVERALL = 60;
type Tally = { count: number; resets: number };
const failures = new Map<string, Tally>();

function tally(key: string, now: number): Tally {
  const found = failures.get(key);
  if (found && found.resets > now) return found;
  const fresh = { count: 0, resets: now + WINDOW_MS };
  failures.set(key, fresh);
  return fresh;
}

/** Signing out clears the cookie in this browser. */
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

  const now = Date.now();
  const address = (request.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "direct";
  const mine = tally(`a:${address}`, now);
  const everyone = tally("all", now);
  if (mine.count >= PER_ADDRESS || everyone.count >= OVERALL) {
    const wait = Math.ceil((Math.max(mine.resets, everyone.resets) - now) / 1000);
    return Response.json(
      { error: { code: "too_many_attempts", message: `Too many wrong passwords. Try again in ${Math.ceil(wait / 60)} minutes.` } },
      { status: 429, headers: { "retry-after": String(wait) } },
    );
  }

  if (!password || !(await passwordMatches(password))) {
    mine.count++;
    everyone.count++;
    return Response.json({ error: { code: "wrong_password", message: "That is not the password for this Broadside." } }, { status: 401 });
  }
  failures.delete(`a:${address}`);
  const secure = new URL(request.url).protocol === "https:" || request.headers.get("x-forwarded-proto") === "https";
  return Response.json(
    { data: { signed_in: true } },
    { headers: { "set-cookie": `${SESSION_COOKIE}=${await sessionValue()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_SECONDS}${secure ? "; Secure" : ""}` } },
  );
}
