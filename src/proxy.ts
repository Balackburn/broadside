import { NextResponse, type NextRequest } from "next/server";
import { passwordRequired, signedIn } from "@/lib/session";

/** When a password is set, the app's pages ask for it; API and MCP callers still use keys. */
export async function proxy(request: NextRequest) {
  if (!passwordRequired() || (await signedIn(request))) return NextResponse.next();
  const login = new URL("/login", request.url);
  login.searchParams.set("next", request.nextUrl.pathname);
  return NextResponse.redirect(login);
}

export const config = { matcher: ["/app/:path*"] };
