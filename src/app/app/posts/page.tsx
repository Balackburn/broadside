import type { Metadata } from "next";
import { PostsList } from "@/components/posts-list";
import { numbersByTarget } from "@/lib/analytics";
import { listPosts } from "@/lib/posts";
import { listTags } from "@/lib/tags";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Posts" };

export default async function PostsPage({ searchParams }: PageProps<"/app/posts">) {
  const { post } = await searchParams;
  const posts = listPosts({ limit: 200 });
  return <PostsList posts={posts} tags={listTags()} numbers={numbersByTarget(posts.map((p) => p.id))} focus={typeof post === "string" ? post : undefined} />;
}
