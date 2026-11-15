import { baseUrl, body, route } from "@/lib/http";
import { startOAuth } from "@/lib/oauth";

/** Begins a sign-in with a network and returns the address to send the browser to. */
export const POST = route<RouteContext<"/api/v1/oauth/[platform]/start">>({ role: "admin" }, async (request, { params }, actor) => {
  const { platform } = await params;
  const input = await body<{ credentials?: Record<string, string> }>(request);
  // Who began it is kept with the pending sign-in, so the callback can check they are still an admin when the network sends the browser back.
  return startOAuth(platform, input.credentials ?? {}, baseUrl(request), actor.member ? { member_id: actor.member.id, role: actor.role } : null);
});
