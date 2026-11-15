import { InputError } from "./accounts";
import { sessionActor, tokenActor, type Actor } from "./actor";
import { HOST_REFUSED, hostAllowed, hostListed } from "./hosts";
import { presentedToken } from "./keys";
import { publicBase } from "./media";
import { teamMode } from "./members";
import { oauthStarter } from "./oauth";
import { atLeast, type Role } from "./roles";

export type { Actor } from "./actor";

/** The address people and agents reach this Broadside at. */
export function baseUrl(request: Request): string {
  const configured = publicBase();
  if (configured) return configured;
  // Forwarded headers are client-controlled unless a proxy you run sets them, so links come from the request's own address.
  const url = new URL(request.url);
  return `${url.protocol}//${request.headers.get("host") ?? url.host}`;
}

/**
 * An address for a link that someone else will open, such as an invite. The
 * configured public URL, or the request's own address when its Host header is
 * a name this Broadside knows as its own. Null otherwise: a link is never
 * built from a host name nothing has checked.
 */
export function linkBase(request: Request): string | null {
  const configured = publicBase();
  if (configured) return configured;
  return hostListed(request) ? baseUrl(request) : null;
}

/**
 * What a route asks of its caller. `role` is the least that may call it.
 *
 * `with` narrows how the caller may prove who they are:
 *   (unset)        an API key, or the app's own pages with a session
 *   "session"      a person in the app only. Used for the team itself, so no key can add a member or set a password
 *   "key"          an API key only. The MCP endpoint
 *   "oauth-state"  the browser coming back from a network. It arrives from another site and sometimes under another
 *                  name for this machine, so it has no cookie to show; the single-use state value stands for the
 *                  person who started the sign-in, and their role is read again now
 *
 * `refuse` lets a route that does not speak this API's JSON say no in its own format.
 */
export type Access = {
  role: Role;
  with?: "session" | "key" | "oauth-state";
  refuse?: (status: 401 | 403, message: string, request: Request) => Response;
};

type Refusal = { status: 401 | 403; code: string; message: string };

const NO_KEY = "Send a Broadside API key as a Bearer token. Create one under Connect in the app.";

/**
 * Who is calling, or why they may not. The web app calls the API from its own
 * origin; anything else needs a key. Browsers set Sec-Fetch-Site themselves and
 * pages cannot forge it, so a same-origin value means the request came from
 * Broadside's own UI, and the session cookie is what proves identity.
 */
export async function admit(request: Request, access: Access): Promise<{ actor: Actor } | { refusal: Refusal }> {
  const actor = await identify(request, access);
  if (!actor) return { refusal: { status: 401, code: "unauthorized", message: NO_KEY } };
  if (access.with === "session" && actor.via === "key") {
    return { refusal: { status: 403, code: "needs_person", message: "This is done by a person signed in to the app. An API key cannot do it." } };
  }
  if (!atLeast(actor.role, access.role)) {
    return { refusal: { status: 403, code: "forbidden", message: `This needs the ${access.role} role. ${actor.via === "key" ? "This key has" : "You have"} ${actor.role}.` } };
  }
  return { actor };
}

async function identify(request: Request, access: Access): Promise<Actor | null> {
  if (access.with === "oauth-state") {
    const starter = oauthStarter(new URL(request.url).searchParams.get("state") ?? "");
    // No such sign-in: let the route say so in its own words. It connects nothing without a state this Broadside issued.
    if (starter === undefined) return { role: access.role, member: null, via: "open", team: teamMode() };
    return starter;
  }
  const token = presentedToken(request);
  if (token) {
    const byKey = tokenActor(token);
    if (byKey) return byKey;
  }
  if (access.with === "key") return null;
  if (!hostAllowed(request)) return null;
  // Sec-Fetch-Site stops other sites driving the API through a visitor's browser.
  if (request.headers.get("sec-fetch-site") !== "same-origin") return null;
  return sessionActor(request);
}

/** True when the request may use the API at all, in any role. */
export async function allowed(request: Request): Promise<boolean> {
  return "actor" in (await admit(request, { role: "viewer" }));
}

type Handler<C> = (request: Request, context: C, actor: Actor) => Promise<unknown> | unknown;

/**
 * Wraps a route: checks who is calling against the role the route declares,
 * hands the handler that actor, returns { data }, and turns known errors into
 * { error } with a useful status. Every route file declares its access this
 * way; `npm run check:routes` fails for one that does not.
 */
export function route<C = unknown>(access: Access, handler: Handler<C>) {
  return async (request: Request, context: C): Promise<Response> => {
    if (access.with === "oauth-state" && !hostAllowed(request)) return new Response(HOST_REFUSED, { status: 403 });
    const admitted = await admit(request, access);
    if ("refusal" in admitted) {
      const { status, code, message } = admitted.refusal;
      return access.refuse ? access.refuse(status, message, request) : Response.json({ error: { code, message } }, { status });
    }
    try {
      const data = await handler(request, context, admitted.actor);
      if (data instanceof Response) return data;
      return Response.json({ data });
    } catch (error) {
      if (error instanceof InputError) {
        return Response.json({ error: { code: "invalid_request", message: error.message, details: error.details } }, { status: 400 });
      }
      console.error("[broadside] request failed:", error);
      return Response.json({ error: { code: "internal", message: "Broadside hit an unexpected error. The server log has the details." } }, { status: 500 });
    }
  };
}

/**
 * Marks a route that anyone may call, with the reason. It changes nothing
 * about the handler; it exists so that "open to everyone" is always written
 * down and never the result of forgetting to ask.
 */
export function open<H>(_why: string, handler: H): H {
  return handler;
}

/** The member a team route acts as. These routes take a session only, so in a team there is always one. */
export function asker(actor: Actor): { id: string; role: Role } {
  if (!actor.member) throw new InputError("This Broadside has no team yet. Set one up under Team.");
  return { id: actor.member.id, role: actor.role };
}

export async function body<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    throw new InputError("The request body is not valid JSON.");
  }
}
