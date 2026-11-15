import type { Metadata } from "next";
import { Calendar } from "@/components/calendar";
import { listPosts } from "@/lib/posts";
import { viewer } from "@/lib/viewer";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Calendar" };

/** Reading the calendar is open to every role. The page still asks who is looking, so no screen is served on the proxy's word alone. */
export default async function CalendarPage() {
  await viewer();
  const posts = listPosts({ limit: 500 }).map((p) => ({
    id: p.id,
    content: p.content,
    status: p.status,
    at: p.publish_at ?? p.created_at,
    platforms: p.targets.map((t) => t.platform),
    tags: p.tags,
  }));
  return <Calendar posts={posts} />;
}
