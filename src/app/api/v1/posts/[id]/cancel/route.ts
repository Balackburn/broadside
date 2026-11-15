import { route } from "@/lib/http";
import { cancelPost } from "@/lib/posts";

export const POST = route<RouteContext<"/api/v1/posts/[id]/cancel">>(async (_request, { params }) => cancelPost((await params).id));
