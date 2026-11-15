import { InputError } from "./accounts";
import { hostAllowed } from "./hosts";
import { authorized } from "./keys";
import { publicBase } from "./media";
import { signedIn } from "./session";

/** The address people and agents reach this Broadside at. */
export function baseUrl(request: Request): string {
  const configured = publicBase();
  if (configured) return configured;
  // Forwarded headers are client-controlled unless a proxy you run sets them, so links come from the request's own address.
  const url = new URL(request.url);
  return `${url.protocol}//${request.headers.get("host") ?? url.host}`;
}

/**
 * The web app calls the API from its own origin; anything else needs a key.
 * Browsers set Sec-Fetch-Site themselves and pages cannot forge it, so a
 * same-origin value means the request came from Broadside's own UI.
 */
export async function allowed(request: Request): Promise<boolean> {
  if (authorized(request)) return true;
  if (!hostAllowed(request)) return false;
  // Sec-Fetch-Site stops other sites driving the API through a visitor's browser; the session cookie is what proves identity.
  return request.headers.get("sec-fetch-site") === "same-origin" && (await signedIn(request));
}

type Handler<C> = (request: Request, context: C) => Promise<unknown> | unknown;

/** Wraps a route: checks access, returns { data }, and turns known errors into { error } with a useful status. */
export function route<C = unknown>(handler: Handler<C>) {
  return async (request: Request, context: C): Promise<Response> => {
    if (!(await allowed(request))) {
      return Response.json({ error: { code: "unauthorized", message: "Send a Broadside API key as a Bearer token. Create one under Connect in the app." } }, { status: 401 });
    }
    try {
      const data = await handler(request, context);
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

export async function body<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    throw new InputError("The request body is not valid JSON.");
  }
}
