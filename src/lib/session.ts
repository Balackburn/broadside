import { serverSecret } from "./crypto";

/**
 * Optional password for the web app. With BROADSIDE_PASSWORD unset the app
 * answers on localhost only (see hosts.ts). A session is a signed expiry
 * time: it stops working after 30 days, when the password changes, or when
 * the server secret changes (BROADSIDE_SECRET, else the install's key file).
 *
 * Once the install has members, the cookie names one: "m1.<member>.<expiry>.<proof>".
 * This file only makes and checks that value from key material it is handed;
 * actor.ts reads the member and decides what the session may do.
 */
export const SESSION_COOKIE = "broadside_session";
export const SESSION_SECONDS = 30 * 24 * 3600;

export const passwordRequired = (): boolean => Boolean(process.env.BROADSIDE_PASSWORD);

const encoder = new TextEncoder();
const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");

async function sign(message: string): Promise<string> {
  // Keyed by the password and the server secret together, so a captured cookie is no way to guess the password offline.
  // The secret is the one members' cookies use: BROADSIDE_SECRET, else the install's key file. It is never empty.
  const material = encoder.encode(`${process.env.BROADSIDE_PASSWORD}\u0000${serverSecret()}`);
  const key = await crypto.subtle.importKey("raw", await crypto.subtle.digest("SHA-256", material), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
}

function same(a: string, b: string): boolean {
  let difference = a.length ^ b.length;
  for (let i = 0; i < a.length && i < b.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}

/** A fresh cookie value: when it expires, and proof this server issued it. */
export async function sessionValue(now = Date.now()): Promise<string> {
  const expires = Math.floor(now / 1000) + SESSION_SECONDS;
  return `${expires}.${await sign(`session:${expires}`)}`;
}

/** The session cookie's value as the request carries it, or "". */
export function sessionCookie(request: Request): string {
  const cookies = request.headers.get("cookie") ?? "";
  return cookies.split(/;\s*/).find((c) => c.startsWith(`${SESSION_COOKIE}=`))?.slice(SESSION_COOKIE.length + 1) ?? "";
}

/** The Set-Cookie header for a session value. The flags are the same for one operator and for a member. */
export function sessionHeader(value: string, request: Request): string {
  const secure = new URL(request.url).protocol === "https:" || request.headers.get("x-forwarded-proto") === "https";
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_SECONDS}${secure ? "; Secure" : ""}`;
}

export const SESSION_CLEARED = `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;

async function signMember(message: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", await crypto.subtle.digest("SHA-256", encoder.encode(`broadside member session\u0000${secret}`)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
}

/**
 * A member's cookie value. `secret` is the server secret with that member's
 * current password hash and session nonce, so the proof stops matching the
 * moment either changes: a new password or being disabled ends every session.
 * The role is not in here. It is read from the database on each request.
 */
export async function memberSessionValue(memberId: string, secret: string, now = Date.now()): Promise<string> {
  const expires = Math.floor(now / 1000) + SESSION_SECONDS;
  return `m1.${memberId}.${expires}.${await signMember(`member:${memberId}:${expires}`, secret)}`;
}

/** The member a cookie value claims to be for, before anything is checked. Null when it is not a member's cookie at all. */
export function claimedMember(value: string): string | null {
  const [version, memberId, expires, signature] = value.split(".");
  return version === "m1" && memberId && expires && signature && value.split(".").length === 4 ? memberId : null;
}

/** Whether a member's cookie value is one this server issued for that member, with their current secret, and still in date. */
export async function memberSessionValid(value: string, secret: string, now = Date.now()): Promise<boolean> {
  const parts = value.split(".");
  const [version, memberId, expires, signature] = parts;
  if (parts.length !== 4 || version !== "m1" || !memberId || !signature || !/^\d+$/.test(expires ?? "")) return false;
  const until = Number(expires) * 1000;
  if (until < now || until > now + (SESSION_SECONDS + 300) * 1000) return false;
  return same(signature, await signMember(`member:${memberId}:${expires}`, secret));
}

export async function passwordMatches(candidate: string): Promise<boolean> {
  const digest = async (value: string) => hex(await crypto.subtle.digest("SHA-256", encoder.encode(`check:${value}`)));
  return same(await digest(candidate), await digest(process.env.BROADSIDE_PASSWORD ?? ""));
}

export async function signedIn(request: Request, now = Date.now()): Promise<boolean> {
  if (!passwordRequired()) return true;
  const value = sessionCookie(request);
  const [expires, signature] = value.split(".");
  if (!expires || !signature || !/^\d+$/.test(expires)) return false;
  const until = Number(expires) * 1000;
  // Expired, or dated further ahead than this server ever issues: either way it is not one of ours to honour.
  if (until < now || until > now + (SESSION_SECONDS + 300) * 1000) return false;
  return same(signature, await sign(`session:${expires}`));
}
