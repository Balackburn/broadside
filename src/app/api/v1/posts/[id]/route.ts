import { InputError } from "@/lib/accounts";
import { body, route } from "@/lib/http";
import { deletePost, getPost, updatePost } from "@/lib/posts";

type Ctx = RouteContext<"/api/v1/posts/[id]">;

export const GET = route<Ctx>({ role: "viewer" }, async (_request, { params }) => {
  const { id } = await params;
  const post = getPost(id);
  if (!post) throw new InputError(`No post with id ${id}.`);
  return post;
});

export const PATCH = route<Ctx>({ role: "editor" }, async (request, { params }) => {
  const { id } = await params;
  return updatePost(id, await body(request));
});

export const DELETE = route<Ctx>({ role: "editor" }, async (_request, { params }) => {
  const { id } = await params;
  if (!deletePost(id)) throw new InputError(`No post with id ${id}.`);
  return { deleted: id };
});
