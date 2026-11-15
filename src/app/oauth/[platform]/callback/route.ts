import { InputError } from "@/lib/accounts";
import { baseUrl, route } from "@/lib/http";
import { finishOAuth } from "@/lib/oauth";

export const dynamic = "force-dynamic";

const backToAccounts = (request: Request, message: string) => {
  const back = new URL("/app/accounts", baseUrl(request));
  back.searchParams.set("error", message);
  return Response.redirect(back, 303);
};

/**
 * Where a network sends the browser back after you approve. The state value
 * must match a sign-in started here in the last ten minutes; without that,
 * nothing is exchanged and nothing is stored.
 *
 * Connecting an account is an admin's job. The browser arrives here from the
 * network with no session to show, so the state stands for the person who
 * began the sign-in, and in a team their role is read again before anything
 * is exchanged.
 */
export const GET = route<RouteContext<"/oauth/[platform]/callback">>(
  {
    role: "admin",
    with: "oauth-state",
    refuse: (_status, _message, request) => backToAccounts(request, "Whoever started this sign-in can no longer connect accounts. Ask an admin to start it again."),
  },
  async (request, { params }) => {
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
      return backToAccounts(request, error instanceof InputError ? error.message : "The sign-in could not be completed. The server log has the details.");
    }
    return Response.redirect(back, 303);
  },
);
