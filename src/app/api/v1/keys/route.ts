import { body, route } from "@/lib/http";
import { createKey, listKeys } from "@/lib/keys";

export const GET = route(() => listKeys());

export const POST = route(async (request) => {
  const { name } = await body<{ name?: string }>(request);
  return createKey(name ?? "");
});
