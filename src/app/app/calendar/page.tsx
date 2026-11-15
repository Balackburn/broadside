import type { Metadata } from "next";
import { Calendar } from "@/components/calendar";
import { listPosts } from "@/lib/posts";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Calendar" };

export default function CalendarPage() {
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
