import { memberSecret } from "@/lib/actor";
import { asker, body, route } from "@/lib/http";
import { changePassword } from "@/lib/members";
import { memberSessionValue, sessionHeader } from "@/lib/session";

/**
 * A member changes their own password with { current, next }. Every session
 * they had stops working, because sessions are signed with the old password's
 * hash; this browser is given a new one so they stay signed in here.
 */
export const POST = route({ role: "viewer", with: "session" }, async (request, _context, actor) => {
  const me = asker(actor);
  const input = await body<{ current?: unknown; next?: unknown }>(request);
  await changePassword(me.id, input.current, input.next);
  const secret = memberSecret(me.id);
  const headers = secret ? { "set-cookie": sessionHeader(await memberSessionValue(me.id, secret), request) } : undefined;
  return Response.json({ data: { changed: true } }, { headers });
});
