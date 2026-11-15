import { passwordMatches, passwordRequired, SESSION_COOKIE, sessionValue } from "@/lib/session";

export async function POST(request: Request) {
  const { password } = (await request.json().catch(() => ({}))) as { password?: string };
  if (!passwordRequired()) return Response.json({ data: { signed_in: true } });
  if (!password || !(await passwordMatches(password))) {
    return Response.json({ error: { code: "wrong_password", message: "That is not the password for this Broadside." } }, { status: 401 });
  }
  const secure = new URL(request.url).protocol === "https:" || request.headers.get("x-forwarded-proto") === "https";
  return Response.json(
    { data: { signed_in: true } },
    { headers: { "set-cookie": `${SESSION_COOKIE}=${await sessionValue()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${secure ? "; Secure" : ""}` } },
  );
}
