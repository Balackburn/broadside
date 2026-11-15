import { InputError } from "@/lib/accounts";
import { body, route } from "@/lib/http";
import { choose, pendingChoice } from "@/lib/oauth";

/** What a sign-in that ended in a choice is waiting on: the Pages, Instagram accounts or boards on offer. Names only, never tokens. */
export const GET = route<RouteContext<"/api/v1/oauth/choices/[id]">>({ role: "admin" }, async (_request, { params }) => {
  const waiting = pendingChoice((await params).id);
  if (!waiting) throw new InputError("That choice has run out or was already made. Sign in again from Accounts.");
  return waiting;
});

/** Connects the ones picked, each as its own account. */
export const POST = route<RouteContext<"/api/v1/oauth/choices/[id]">>({ role: "admin" }, async (request, { params }) => {
  const input = await body<{ choices?: string[] }>(request);
  return choose((await params).id, Array.isArray(input.choices) ? input.choices.map(String) : []);
});
