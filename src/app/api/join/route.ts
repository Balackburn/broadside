import { InputError } from "@/lib/accounts";
import { memberSecret } from "@/lib/actor";
import { HOST_REFUSED, hostAllowed } from "@/lib/hosts";
import { open } from "@/lib/http";
import { acceptInvite, touchMember } from "@/lib/members";
import { memberSessionValue, sessionHeader } from "@/lib/session";

/**
 * Uses a one-time join link: { token, password }. The person who was invited
 * chooses their own password here, becomes a member, and is signed in. The
 * token is 32 random bytes that only its holder has, it works once, and it
 * runs out after seven days.
 */
export const POST = open("The invite token is the credential: whoever holds the one-time link has not signed in yet.", async (request: Request) => {
  if (!hostAllowed(request)) return new Response(HOST_REFUSED, { status: 403 });
  // Like the sign-in form, this is only ever posted from Broadside's own page.
  if (request.headers.get("sec-fetch-site") === "cross-site") {
    return Response.json({ error: { code: "cross_site", message: "Open the join link itself and set your password there." } }, { status: 403 });
  }
  const { token, password } = (await request.json().catch(() => ({}))) as { token?: unknown; password?: unknown };
  try {
    const member = await acceptInvite(token, password);
    const secret = memberSecret(member.id);
    touchMember(member.id);
    if (!secret) throw new InputError("You are a member now, but could not be signed in. Sign in with your name and the password you just chose.");
    return Response.json({ data: { signed_in: true, name: member.name, role: member.role } }, { headers: { "set-cookie": sessionHeader(await memberSessionValue(member.id, secret), request) } });
  } catch (error) {
    if (error instanceof InputError) return Response.json({ error: { code: "invalid_request", message: error.message } }, { status: 400 });
    // The token is never part of what is logged.
    console.error("[broadside] joining failed:", (error as Error).message);
    return Response.json({ error: { code: "internal", message: "Broadside hit an unexpected error. The server log has the details." } }, { status: 500 });
  }
});
