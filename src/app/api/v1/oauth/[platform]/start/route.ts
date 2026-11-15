import { baseUrl, body, route } from "@/lib/http";
import { startOAuth } from "@/lib/oauth";

/** Begins a sign-in with a network and returns the address to send the browser to. */
export const POST = route<RouteContext<"/api/v1/oauth/[platform]/start">>(async (request, { params }) => {
  const { platform } = await params;
  const input = await body<{ credentials?: Record<string, string> }>(request);
  return startOAuth(platform, input.credentials ?? {}, baseUrl(request));
});
