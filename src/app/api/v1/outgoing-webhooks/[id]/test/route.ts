import { route } from "@/lib/http";
import { sendTest } from "@/lib/outgoing";

/** Sends a signed test delivery now and returns how the receiver answered. */
export const POST = route<RouteContext<"/api/v1/outgoing-webhooks/[id]/test">>({ role: "admin" }, async (_request, { params }) => {
  const { id } = await params;
  return sendTest(id);
});
