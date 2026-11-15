import { route } from "@/lib/http";
import { publishNow } from "@/lib/posts";

export const POST = route<RouteContext<"/api/v1/posts/[id]/publish">>({ role: "editor" }, async (_request, { params }) => publishNow((await params).id));
