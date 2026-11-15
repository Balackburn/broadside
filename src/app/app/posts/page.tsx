import type { Metadata } from "next";
import { PostsList } from "@/components/posts-list";
import { numbersByTarget } from "@/lib/analytics";
import { getFeed } from "@/lib/feeds";
import { listPosts } from "@/lib/posts";
import { listTags } from "@/lib/tags";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Posts" };

/** With ?feed=<feed id>, the list holds only the posts that feed made. */
export default async function PostsPage({ searchParams }: PageProps<"/app/posts">) {
  const { post, feed } = await searchParams;
  const feedId = typeof feed === "string" && feed ? feed : undefined;
  const posts = listPosts({ limit: 200, feed_id: feedId });
  const from = feedId ? { id: feedId, title: posts[0]?.feed?.title ?? getFeed(feedId)?.title ?? null } : undefined;
  return <PostsList posts={posts} tags={listTags()} numbers={numbersByTarget(posts.map((p) => p.id))} focus={typeof post === "string" ? post : undefined} feed={from} />;
}
