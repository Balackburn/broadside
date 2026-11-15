import type { Metadata } from "next";
import { PostsList } from "@/components/posts-list";
import { listPosts } from "@/lib/posts";
import { listTags } from "@/lib/tags";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Posts" };

export default async function PostsPage({ searchParams }: PageProps<"/app/posts">) {
  const { post } = await searchParams;
  return <PostsList posts={listPosts({ limit: 200 })} tags={listTags()} focus={typeof post === "string" ? post : undefined} />;
}
