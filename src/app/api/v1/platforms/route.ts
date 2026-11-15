import { route } from "@/lib/http";
import { connectors, describe } from "@/lib/platforms";

export const GET = route({ role: "viewer" }, () => connectors.map(describe));
