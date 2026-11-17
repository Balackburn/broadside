import type { Metadata } from "next";
import { PostsList } from "@/components/posts-list";
import { numbersByTarget } from "@/lib/analytics";
import { getFeed } from "@/lib/feeds";
import { connectors } from "@/lib/platforms";
import { listPosts } from "@/lib/posts";
import { atLeast } from "@/lib/roles";
import { listTags } from "@/lib/tags";
import { viewer } from "@/lib/viewer";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Posts" };

/** With ?feed=<feed id>, the list holds only the posts that feed made. */
export default async function PostsPage({ searchParams }: PageProps<"/app/posts">) {
  const { post, feed } = await searchParams;
  const me = await viewer();
  const feedId = typeof feed === "string" && feed ? feed : undefined;
  const posts = listPosts({ limit: 200, feed_id: feedId });
  const from = feedId ? { id: feedId, title: posts[0]?.feed?.title ?? getFeed(feedId)?.title ?? null } : undefined;
  // The options each network declares, so a target can say what was set for it under the network's own labels.
  const networks = Object.fromEntries(connectors.flatMap((c) => (c.options?.length ? [[c.id, { options: c.options }]] : [])));
  return <PostsList posts={posts} tags={listTags()} numbers={numbersByTarget(posts.map((p) => p.id))} focus={typeof post === "string" ? post : undefined} feed={from} canWrite={atLeast(me.role, "editor")} authors={me.team} networks={networks} />;
}
