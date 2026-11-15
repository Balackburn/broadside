import { NextResponse, type NextRequest } from "next/server";
import { HOST_REFUSED, hostAllowed } from "@/lib/hosts";
import { passwordRequired, signedIn } from "@/lib/session";

/** The app's pages: refused under an unexpected host name, and behind the password when one is set. API and MCP callers use keys. */
export async function proxy(request: NextRequest) {
  if (!hostAllowed(request)) return new NextResponse(HOST_REFUSED, { status: 403 });
  if (!passwordRequired() || (await signedIn(request))) return NextResponse.next();
  const login = new URL("/login", request.url);
  login.searchParams.set("next", request.nextUrl.pathname);
  return NextResponse.redirect(login);
}

export const config = { matcher: ["/app/:path*"] };
