import { InputError } from "@/lib/accounts";
import { HOST_REFUSED, hostAllowed } from "@/lib/hosts";
import { baseUrl } from "@/lib/http";
import { finishOAuth } from "@/lib/oauth";

export const dynamic = "force-dynamic";

/**
 * Where a network sends the browser back after you approve. The state value
 * must match a sign-in started here in the last ten minutes; without that,
 * nothing is exchanged and nothing is stored.
 */
export async function GET(request: Request, { params }: RouteContext<"/oauth/[platform]/callback">) {
  if (!hostAllowed(request)) return new Response(HOST_REFUSED, { status: 403 });
  const { platform } = await params;
  const query = new URL(request.url).searchParams;
  let back = new URL("/app/accounts", baseUrl(request));
  try {
    if (query.get("error")) throw new InputError(`The network refused the sign-in: ${query.get("error_description") ?? query.get("error")}.`);
    const done = await finishOAuth(platform, query.get("state") ?? "", query.get("code") ?? "");
    // Back to where the sign-in was started, which can be another name for this machine than the one the network redirected to.
    back = new URL("/app/accounts", done.base);
    if (done.choice) back.searchParams.set("choose", done.choice);
    else if (done.account) back.searchParams.set("connected", done.account.handle);
  } catch (error) {
    if (!(error instanceof InputError)) console.error("[broadside] sign-in callback failed:", error);
    back.searchParams.set("error", error instanceof InputError ? error.message : "The sign-in could not be completed. The server log has the details.");
  }
  return Response.redirect(back, 303);
}
