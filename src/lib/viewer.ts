import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { sessionActor, type Actor } from "./actor";

/**
 * Who is looking at a page. The proxy has already turned away anyone who is
 * not signed in; each screen asks again here so it can leave out what this
 * member may not do. The API refuses those things whatever a screen shows.
 */
export async function viewer(): Promise<Actor> {
  const cookie = (await headers()).get("cookie") ?? "";
  const actor = await sessionActor(new Request("http://broadside.invalid/", { headers: { cookie } }));
  if (!actor) redirect("/login");
  return actor;
}
