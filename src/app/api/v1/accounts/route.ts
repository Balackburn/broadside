import { connectAccount, listAccounts } from "@/lib/accounts";
import { body, route } from "@/lib/http";

export const GET = route({ role: "viewer" }, () => listAccounts());

export const POST = route({ role: "admin" }, async (request) => {
  const input = await body<{ platform: string; credentials?: Record<string, string> }>(request);
  return connectAccount(input.platform, input.credentials ?? {});
});
