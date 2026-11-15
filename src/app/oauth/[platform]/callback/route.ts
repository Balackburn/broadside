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
  const back = new URL("/app/accounts", baseUrl(request));
  try {
    if (query.get("error")) throw new InputError(`The network refused the sign-in: ${query.get("error_description") ?? query.get("error")}.`);
    const account = await finishOAuth(platform, query.get("state") ?? "", query.get("code") ?? "");
    back.searchParams.set("connected", account.handle);
  } catch (error) {
    if (!(error instanceof InputError)) console.error("[broadside] sign-in callback failed:", error);
    back.searchParams.set("error", error instanceof InputError ? error.message : "The sign-in could not be completed. The server log has the details.");
  }
  return Response.redirect(back, 303);
}
