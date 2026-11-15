import { NextResponse, type NextRequest } from "next/server";
import { sessionActor } from "@/lib/actor";
import { HOST_REFUSED, hostAllowed } from "@/lib/hosts";

/**
 * The app's pages: refused under an unexpected host name, and behind a
 * sign-in when one is needed. That is the password when one is set, and a
 * member's own session once the install has a team, on localhost too. API
 * and MCP callers use keys.
 */
export async function proxy(request: NextRequest) {
  if (!hostAllowed(request)) return new NextResponse(HOST_REFUSED, { status: 403 });
  if (await sessionActor(request)) return NextResponse.next();
  const login = new URL("/login", request.url);
  login.searchParams.set("next", request.nextUrl.pathname);
  return NextResponse.redirect(login);
}

export const config = { matcher: ["/app/:path*"] };
